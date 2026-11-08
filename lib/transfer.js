// Transfer execution for the pey.http transport plugin.
//
// Runs one validated transfer to completion under the shared flow pattern:
// input normalization, the manual redirect loop (with the same-origin and
// downgrade policy), progressive chunk delivery and the three-endings
// settle. Nothing here interprets the payload; nothing about headers,
// body or credentials ever enters an error.

import {
  DEFAULT_ACCEPTED_MEDIA_TYPES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
  SERVICE_UNAVAILABLE,
} from './constants.js';
import { createHttpError } from './error.js';
import { isAllowedHttpUrl } from './local-url.js';
import { decideRedirect, redactUrl } from './redirects.js';

// Step-by-step redirect control needs a manual redirect mode, which a
// browser cannot honor (it yields opaque responses). The capability is
// injectable (testable, overridable); without an explicit value it falls
// back to the environment detection, and where there is no step control
// the browser stack enforces its own policy — documented as best-effort in
// docs/reference.md.
export const SUPPORTS_MANUAL_REDIRECTS = typeof window === 'undefined' || typeof window.document === 'undefined';

function unavailableError() {
  return createHttpError(SERVICE_UNAVAILABLE, 'HTTP service is unavailable');
}

/**
 * Coerces one timeout config value, accepting the numeric strings the
 * Core delivers from environment sources (configuration.md). A present
 * but unusable value fails loudly at startup — silently running the
 * default would hide a broken configuration from the host.
 *
 * @param {unknown} value Configured value.
 * @param {number} fallback Default timeout.
 * @returns {number} Effective timeout.
 * @throws {object} HTTP_INPUT_INVALID (startup) when the value is present but unusable.
 */
function timeoutOf(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  throw createHttpError(ERROR_CODES.INPUT_INVALID, 'The configured timeout must be a positive number', 'startup', {
    value: String(value).slice(0, 32),
  });
}

/**
 * Validates the final plugin configuration.
 *
 * @param {object} config Merged plugin configuration.
 * @returns {{acceptedMediaTypes: string[], timeoutMs: number, streamIdleTimeoutMs: number}} Normalized configuration.
 */
export function normalizeConfig(config) {
  // Same fail-loud policy as the timeouts: a PRESENT but unusable value
  // breaks startup instead of silently running on the default list. An
  // absent value and an empty array both fall back to the default list.
  const configuredTypes = config.acceptedMediaTypes;
  if (configuredTypes !== undefined && configuredTypes !== null && !Array.isArray(configuredTypes)) {
    throw createHttpError(ERROR_CODES.INPUT_INVALID, 'The configured acceptedMediaTypes must be a non-empty array', 'startup', {
      value: String(configuredTypes).slice(0, 32),
    });
  }
  const acceptedMediaTypes = Array.isArray(configuredTypes) && configuredTypes.length > 0
    ? configuredTypes.map((type) => String(type).toLowerCase())
    : [...DEFAULT_ACCEPTED_MEDIA_TYPES];
  return {
    acceptedMediaTypes,
    timeoutMs: timeoutOf(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    streamIdleTimeoutMs: timeoutOf(config.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  };
}

/**
 * Validates and normalizes one transfer input before anything is sent.
 *
 * @param {unknown} raw Caller input.
 * @returns {object} Normalized transfer spec.
 * @throws {object} HTTP_URL_INVALID / HTTP_URL_FORBIDDEN / HTTP_INPUT_INVALID.
 */
export function normalizeTransferInput(raw) {
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
    if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, `A ${normalizedMethod} request cannot carry a body`);
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
 * Releases an intermediate redirect response body so the underlying
 * connection is not held until GC.
 * @param {object} response Intermediate 30x response.
 * @returns {Promise<void>}
 */
async function releaseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // An already-consumed or opaque body is harmless to release.
  }
}

/**
 * Runs the fetch through the redirect policy: with manual control each hop
 * is checked against the same-origin/downgrade rules; without it the
 * environment follows on its own. Intermediate bodies are released before
 * every hop so no unread connection is held until garbage collection.
 *
 * @param {object} spec Normalized transfer spec.
 * @param {AbortSignal} signal Abort signal of the transfer.
 * @param {object} io `{ fetchImpl, supportsManualRedirects, releaseBody }`.
 * @returns {Promise<object>} The final response.
 * @throws {object} HTTP_REDIRECT_FORBIDDEN / HTTP_URL_FORBIDDEN on policy violations.
 */
async function fetchFollowingPolicy(spec, signal, { fetchImpl, supportsManualRedirects, releaseBody }) {
  let currentUrl = spec.url;
  let method = spec.method;
  let body = spec.body;
  let hops = 0;
  while (true) {
    const response = await fetchImpl(currentUrl, {
      method,
      headers: spec.headers,
      body: body === null ? undefined : body,
      signal,
      redirect: supportsManualRedirects ? 'manual' : 'follow',
    });
    const location = response.headers?.get?.('location');
    if (supportsManualRedirects && REDIRECT_STATUSES.includes(response.status) && location) {
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
      await releaseBody(response);
      // The manual loop mirrors the platform's follow behavior so a request
      // behaves identically in both redirect modes: 303 (any non-HEAD) and
      // a 301/302 answered for POST re-issue as a GET without a body — a
      // private body is never replayed onto the redirected address.
      if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = null;
      } else if ((response.status === 301 || response.status === 302) && method === 'POST') {
        method = 'GET';
        body = null;
      }
      currentUrl = decision.url;
      continue;
    }
    return response;
  }
}

/**
 * Creates the transfer runner closing over the transport and timeouts.
 *
 * @param {object} options Runner options.
 * @param {Function} options.fetchImpl Transport fetch implementation.
 * @param {number} options.timeoutMs Configured request timeout.
 * @param {number} options.streamIdleTimeoutMs Configured stream idle timeout.
 * @param {Set} options.activeTransfers Registry of in-flight abort handles,
 *   shared with the service's deactivate().
 * @param {Function} options.assertAvailable Throws when the service is unavailable.
 * @param {Function} options.isAvailable Availability getter for mid-stream checks.
 * @returns {Function} `beginTransfer(spec, onChunk)` returning the handle.
 */
export function createTransferRunner({ fetchImpl, timeoutMs, streamIdleTimeoutMs, activeTransfers, assertAvailable, isAvailable, supportsManualRedirects = SUPPORTS_MANUAL_REDIRECTS }) {
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

    /**
     * Maps one failure onto its flow-pattern ending: cancellation, timeout
     * and deactivation keep their own codes; coded HTTP_ errors pass
     * through; a TypeError reads as unreachable/blocked; anything else is
     * a generic request failure (or the stream-cut variant when the stream
     * had already started).
     * @param {unknown} error Caught error.
     * @param {{streamStarted: boolean}} stage Where the failure happened.
     * @returns {object} Settled ending.
     */
    const failureEnding = (error, { streamStarted }) => {
      if (cancelled) {
        return settle({ ending: 'cancelled' });
      }
      if (timedOut) {
        return interrupted(createHttpError(ERROR_CODES.TIMEOUT, 'The transfer ran out of its time budget'));
      }
      if (deactivated || !isAvailable()) {
        return interrupted(unavailableError());
      }
      if (error && typeof error.code === 'string' && error.code.startsWith('HTTP_')) {
        return interrupted(error);
      }
      if (!streamStarted && error instanceof TypeError) {
        // fetch reports unreachable servers and (in a browser) CORS
        // blocks the same way; the message names both possibilities.
        return interrupted(createHttpError(
          ERROR_CODES.NETWORK_FAILED,
          `The request could not reach ${redactUrl(spec.url)} — the server was unreachable or the environment blocked the request`,
        ));
      }
      if (streamStarted) {
        return interrupted(createHttpError(
          ERROR_CODES.STREAM_INTERRUPTED,
          'The response stream was cut off before it finished',
        ));
      }
      return interrupted(createHttpError(ERROR_CODES.REQUEST_FAILED, 'The transfer could not be completed'));
    };

    const done = (async () => {
      let reader = null;
      let readerReleased = false;
      const releaseReader = async () => {
        if (!readerReleased) {
          readerReleased = true;
          try {
            await reader?.cancel();
          } catch {
            // Cancelling a closed reader is harmless.
          }
        }
      };
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

        const response = await fetchFollowingPolicy(spec, controller.signal, { fetchImpl, supportsManualRedirects, releaseBody });

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

        reader = response.body?.getReader?.() ?? null;
        if (!reader) {
          return settle({ ending: 'completed', status: response.status, headers });
        }
        try {
          while (true) {
            const { done: streamDone, value } = await reader.read();
            if (cancelled) {
              return settle({ ending: 'cancelled' });
            }
            if (streamDone) {
              return settle({ ending: 'completed', status: response.status, headers });
            }
            if (value) {
              armIdleTimer();
              try {
                onChunk(value);
              } catch {
                // A broken receiving handler is a caller bug, not a network
                // cut: a distinct stage keeps the interruption traceable,
                // and the reader is released before reporting.
                await releaseReader();
                return interrupted(createHttpError(
                  ERROR_CODES.REQUEST_FAILED,
                  'The transfer was stopped by the receiving handler',
                  'operational',
                  { stage: 'chunk-handler' },
                ));
              }
            }
          }
        } catch (error) {
          // The stream had started, so any failure here is a mid-stream cut.
          return failureEnding(error, { streamStarted: true });
        } finally {
          await releaseReader();
        }
      } catch (error) {
        return failureEnding(error, { streamStarted: false });
      }
    })();

    return { cancel, done };
  }

  return beginTransfer;
}

export { unavailableError };
