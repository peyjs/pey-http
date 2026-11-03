// Provides the outbound HTTP transport service for pey.http.
//
// The plugin moves bytes and interprets nothing: the caller owns the
// address, method, headers and body. Every transfer runs through the
// shared flow pattern — the caller hands in data handlers and receives a
// handle whose done promise resolves exactly one of three endings
// (completed, interrupted, cancelled); input-validation and availability
// failures throw the standard structured error. A server error status is
// an ordinary result, never an error. Nothing about headers, body or
// credentials ever enters an error, a log or an event; error messages
// carry at most the address without its query.

import {
  DEFAULT_ACCEPTED_MEDIA_TYPES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  MAX_REDIRECTS,
  NOT_FOUND_STATUS,
  REDIRECT_STATUSES,
  SERVICE_UNAVAILABLE,
} from './constants.js';
import { createHttpError } from './error.js';
import { isAllowedHttpUrl } from './local-url.js';
import { decideRedirect, redactUrl } from './redirects.js';

// Step-by-step redirect control needs a manual redirect mode, which a
// browser cannot honor (it yields opaque responses). Where there is no
// step control the browser stack enforces its own policy and the rule is
// documented as best-effort in docs/reference.md.
const SUPPORTS_MANUAL_REDIRECTS = typeof window === 'undefined' || typeof window.document === 'undefined';

function unavailableError() {
  return createHttpError(SERVICE_UNAVAILABLE, 'HTTP service is unavailable');
}

/**
 * Validates a same-origin relative document URL (the getText contract).
 *
 * @param {string} url Candidate URL.
 * @returns {string} The validated URL.
 * @throws {object} Standard HTTP_URL_INVALID error for non-string, absolute, or fragment-bearing URLs.
 */
function validateRelativeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw createHttpError(ERROR_CODES.URL_INVALID, 'Document URL must be a non-empty string');
  }

  let parsed;
  try {
    parsed = new URL(url, 'http://pey.invalid');
  } catch {
    throw createHttpError(ERROR_CODES.URL_INVALID, 'Document URL is not a valid URL');
  }

  if (url.includes(':') && !url.startsWith('./') && !url.startsWith('../')) {
    // A colon before any '/' means an absolute URL or a scheme like mailto:.
    const colonIndex = url.indexOf(':');
    const slashIndex = url.indexOf('/');
    if (colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)) {
      throw createHttpError(ERROR_CODES.URL_INVALID, 'Document URL must be relative to the application origin');
    }
  }

  if (parsed.protocol !== 'http:' || parsed.host !== 'pey.invalid') {
    throw createHttpError(ERROR_CODES.URL_INVALID, 'Document URL must be relative to the application origin');
  }

  if (parsed.hash !== '') {
    throw createHttpError(ERROR_CODES.URL_INVALID, 'Document URL must not include a fragment');
  }

  return url;
}

/**
 * Extracts the media type from a Content-Type header value.
 *
 * @param {string|null} contentType Response Content-Type header.
 * @returns {string} Lowercased media type without parameters, or '' when absent.
 */
function extractMediaType(contentType) {
  if (typeof contentType !== 'string' || contentType.trim().length === 0) {
    return '';
  }
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Validates the final plugin configuration.
 *
 * @param {object} config Merged plugin configuration.
 * @returns {{acceptedMediaTypes: string[], timeoutMs: number, streamIdleTimeoutMs: number}} Normalized configuration.
 */
function normalizeConfig(config) {
  const acceptedMediaTypes = Array.isArray(config.acceptedMediaTypes)
    && config.acceptedMediaTypes.length > 0
    ? config.acceptedMediaTypes.map((type) => String(type).toLowerCase())
    : [...DEFAULT_ACCEPTED_MEDIA_TYPES];
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const streamIdleTimeoutMs = Number.isFinite(config.streamIdleTimeoutMs) && config.streamIdleTimeoutMs > 0
    ? config.streamIdleTimeoutMs
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return { acceptedMediaTypes, timeoutMs, streamIdleTimeoutMs };
}

/**
 * Validates and normalizes one transfer input before anything is sent.
 *
 * @param {unknown} raw Caller input.
 * @returns {object} Normalized transfer spec.
 * @throws {object} HTTP_URL_INVALID / HTTP_URL_FORBIDDEN / HTTP_INPUT_INVALID.
 */
function normalizeTransferInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request input must be an object');
  }
  const { url, method, headers, body, timeoutMs } = raw;

  if (typeof url !== 'string' || url.length === 0) {
    throw createHttpError(ERROR_CODES.URL_INVALID, 'Request URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createHttpError(ERROR_CODES.URL_INVALID, 'Request URL must be an absolute URL');
  }
  if (!isAllowedHttpUrl(parsed)) {
    throw createHttpError(
      ERROR_CODES.URL_FORBIDDEN,
      'Plain http is allowed only for the defined local addresses',
    );
  }

  const normalizedMethod = method === undefined || method === null ? 'GET' : String(method).trim().toUpperCase();
  if (normalizedMethod.length === 0) {
    throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request method must be a non-empty string');
  }

  let normalizedHeaders = {};
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request headers must be an object');
    }
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key] = String(value);
    }
  }

  let normalizedBody = null;
  if (body !== undefined && body !== null) {
    if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request body must be a string or a Uint8Array');
    }
    normalizedBody = body;
  }

  let normalizedTimeout = null;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request timeout must be a positive number');
    }
    normalizedTimeout = timeoutMs;
  }

  return {
    url: parsed.toString(),
    method: normalizedMethod,
    headers: normalizedHeaders,
    body: normalizedBody,
    timeoutMs: normalizedTimeout,
  };
}

/**
 * Creates the HTTP transport service.
 *
 * @param {object} options Service options.
 * @param {object} options.config Plugin configuration.
 * @param {Function} [options.fetchImpl=globalThis.fetch] Transport fetch implementation, injectable for tests.
 * @returns {{service: object, deactivate: Function}} Service and its lifecycle control.
 */
export function createHttpService({ config, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const { acceptedMediaTypes, timeoutMs, streamIdleTimeoutMs } = normalizeConfig(config);
  let available = true;
  const activeTransfers = new Set();

  if (typeof fetchImpl !== 'function') {
    throw createHttpError('HTTP_TRANSPORT_UNAVAILABLE', 'No fetch implementation is available', 'startup');
  }

  function assertAvailable() {
    if (!available) {
      throw unavailableError();
    }
  }

  /**
   * Runs one validated transfer to completion under the shared flow
   * pattern. Never rejects: every failure lands as an interrupted ending
   * carrying the structured error, cancellation as the cancelled ending.
   *
   * @param {object} spec Normalized transfer spec.
   * @param {Function|null} onChunk Chunk handler for progressive delivery, or null.
   * @returns {{cancel: Function, done: Promise<object>}} Transfer handle.
   */
  function beginTransfer(spec, onChunk) {
    assertAvailable();

    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let deactivated = false;
    const controller = new AbortController();
    let deadlineTimer = null;
    let idleTimer = null;

    const settle = (result) => {
      if (settled) {
        return result;
      }
      settled = true;
      activeTransfers.delete(abortTransfer);
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      return result;
    };

    const abortTransfer = () => {
      deactivated = true;
      try {
        controller.abort();
      } catch {
        // Aborting an already-settled transfer is harmless.
      }
    };
    activeTransfers.add(abortTransfer);

    const cancel = () => {
      if (settled || cancelled) {
        return;
      }
      cancelled = true;
      try {
        controller.abort();
      } catch {
        // Aborting an already-settled transfer is harmless.
      }
    };

    const armIdleTimer = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        idleTimer = null;
        timedOut = true;
        try {
          controller.abort();
        } catch {
          // Already aborted.
        }
      }, spec.timeoutMs ?? streamIdleTimeoutMs);
    };

    const interrupted = (error) => settle({ ending: 'interrupted', error });

    const done = (async () => {
      try {
        if (!onChunk) {
          deadlineTimer = setTimeout(() => {
            deadlineTimer = null;
            timedOut = true;
            try {
              controller.abort();
            } catch {
              // Already aborted.
            }
          }, spec.timeoutMs ?? timeoutMs);
        } else {
          armIdleTimer();
        }

        // Redirect loop: with manual control each hop is checked against
        // the policy; without it the environment follows on its own.
        let currentUrl = spec.url;
        let method = spec.method;
        let body = spec.body;
        let hops = 0;
        let response;
        while (true) {
          response = await fetchImpl(currentUrl, {
            method,
            headers: spec.headers,
            body: body === null ? undefined : body,
            signal: controller.signal,
            redirect: SUPPORTS_MANUAL_REDIRECTS ? 'manual' : 'follow',
          });
          const location = response.headers?.get?.('location');
          if (SUPPORTS_MANUAL_REDIRECTS && REDIRECT_STATUSES.includes(response.status) && location) {
            hops += 1;
            if (hops > MAX_REDIRECTS) {
              throw createHttpError(
                ERROR_CODES.REDIRECT_FORBIDDEN,
                `The server redirected more than the allowed ${MAX_REDIRECTS} times`,
              );
            }
            const decision = decideRedirect(currentUrl, location);
            if (!decision.allowed) {
              throw createHttpError(decision.code, decision.message);
            }
            // 303 semantically re-issues the request as a GET without a body.
            if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
              method = 'GET';
              body = null;
            }
            currentUrl = decision.url;
            continue;
          }
          break;
        }

        const headers = Object.fromEntries(response.headers?.entries?.() ?? []);

        if (!onChunk || !response.ok) {
          // Delivery failed vs. the server said no: both are an ordinary
          // full response. The server's error status is a result, not an error.
          const buffer = await response.arrayBuffer();
          if (cancelled) {
            return settle({ ending: 'cancelled' });
          }
          return settle({ ending: 'completed', status: response.status, headers, body: new Uint8Array(buffer) });
        }

        const reader = response.body?.getReader?.() ?? null;
        if (!reader) {
          return settle({ ending: 'completed', status: response.status, headers });
        }
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (cancelled) {
            try {
              await reader.cancel();
            } catch {
              // Cancelling a closed reader is harmless.
            }
            return settle({ ending: 'cancelled' });
          }
          if (streamDone) {
            return settle({ ending: 'completed', status: response.status, headers });
          }
          if (value) {
            armIdleTimer();
            onChunk(value);
          }
        }
      } catch (error) {
        if (cancelled) {
          return settle({ ending: 'cancelled' });
        }
        if (timedOut) {
          return interrupted(createHttpError(ERROR_CODES.TIMEOUT, 'The transfer ran out of its time budget'));
        }
        if (deactivated || !available) {
          return interrupted(unavailableError());
        }
        if (error && typeof error.code === 'string' && error.code.startsWith('HTTP_')) {
          return interrupted(error);
        }
        if (error instanceof TypeError) {
          // fetch reports unreachable servers and (in a browser) CORS
          // blocks the same way; the message names both possibilities.
          return interrupted(createHttpError(
            ERROR_CODES.NETWORK_FAILED,
            `The request could not reach ${redactUrl(spec.url)} — the server was unreachable or the environment blocked the request`,
          ));
        }
        return interrupted(createHttpError(ERROR_CODES.REQUEST_FAILED, 'The transfer could not be completed'));
      }
    })();

    return { cancel, done };
  }

  return {
    service: {
      /**
       * Sends one HTTP request and waits for the complete response.
       *
       * @param {object} input { url, method?, headers?, body?, timeoutMs? }.
       * @returns {{cancel: Function, done: Promise<object>}} Transfer handle.
       * @throws {object} Structured validation or availability error.
       */
      request(input) {
        return beginTransfer(normalizeTransferInput(input), null);
      },

      /**
       * Sends one HTTP request and delivers a success body progressively
       * as raw ordered Uint8Array chunks. An error status never starts a
       * stream; the status and body arrive as an ordinary completed result.
       *
       * @param {object} input { url, method?, headers?, body?, timeoutMs? }.
       * @param {object} handlers { onChunk(chunk: Uint8Array) }.
       * @returns {{cancel: Function, done: Promise<object>}} Transfer handle.
       * @throws {object} Structured validation or availability error.
       */
      stream(input, handlers) {
        if (!handlers || typeof handlers !== 'object' || typeof handlers.onChunk !== 'function') {
          throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Streaming needs an onChunk handler');
        }
        return beginTransfer(normalizeTransferInput(input), handlers.onChunk);
      },

      /**
       * Fetches a text document over HTTP (the legacy same-origin contract:
       * the structured error is returned as the resolved value, not thrown).
       *
       * @param {string} url Same-origin relative URL.
       * @returns {Promise<{status: number, body: string}|object>} Result or standard Bonyan error.
       */
      async getText(url) {
        try {
          assertAvailable();
          validateRelativeUrl(url);
        } catch (error) {
          return error;
        }

        try {
          const transfer = beginTransfer({
            url,
            method: 'GET',
            headers: {},
            body: null,
            timeoutMs: null,
          }, null);
          const final = await transfer.done;
          if (final.ending === 'interrupted') {
            // The legacy contract folds every delivery failure — network,
            // timeout, refused redirect — into one code.
            return createHttpError(ERROR_CODES.REQUEST_FAILED, 'The document could not be fetched from the server');
          }
          if (final.ending === 'cancelled') {
            return createHttpError(ERROR_CODES.REQUEST_FAILED, 'The document request was cut short');
          }
          if (final.status === NOT_FOUND_STATUS) {
            return createHttpError(ERROR_CODES.NOT_FOUND, 'The document was not found on the server');
          }
          if (final.status >= 400) {
            return createHttpError(ERROR_CODES.REQUEST_FAILED, 'The server refused to return the document');
          }
          const mediaType = extractMediaType(final.headers['content-type']);
          if (mediaType !== '' && !acceptedMediaTypes.includes(mediaType)) {
            return createHttpError(
              ERROR_CODES.MEDIA_TYPE_UNEXPECTED,
              'The server returned a document type this application does not render',
            );
          }
          return { status: final.status, body: new TextDecoder().decode(final.body) };
        } catch (error) {
          if (error && typeof error.code === 'string' && error.code.startsWith('HTTP_')) {
            return error;
          }
          return createHttpError(ERROR_CODES.REQUEST_FAILED, 'The document could not be fetched from the server');
        }
      },
    },

    deactivate() {
      available = false;
      // Mid-stream deactivation ends every open transfer as interrupted,
      // never as a silent hang or a fake completion.
      for (const abortTransfer of [...activeTransfers]) {
        abortTransfer();
      }
    },
  };
}
