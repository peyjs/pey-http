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
//
// The transfer machinery (input normalization, redirect loop, streaming)
// lives in lib/transfer.js; this file owns configuration, the getText
// legacy contract and the service surface.

import {
  ERROR_CODES,
  NOT_FOUND_STATUS,
} from './constants.js';
import { createHttpError } from './error.js';
import {
  createTransferRunner,
  normalizeConfig,
  normalizeTransferInput,
  unavailableError,
} from './transfer.js';

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

  // A colon before any '/' in the path part means an absolute URL or a
  // scheme like mailto:. The query and fragment never carry a scheme, so
  // they are excluded — '?a:b' is a valid relative URL.
  const pathPart = url.split(/[?#]/)[0];
  if (pathPart.includes(':') && !url.startsWith('./') && !url.startsWith('../')) {
    const colonIndex = pathPart.indexOf(':');
    const slashIndex = pathPart.indexOf('/');
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
    throw createHttpError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'No fetch implementation is available', 'startup');
  }

  const assertAvailable = () => {
    if (!available) {
      throw unavailableError();
    }
  };
  const beginTransfer = createTransferRunner({
    fetchImpl,
    timeoutMs,
    streamIdleTimeoutMs,
    activeTransfers,
    assertAvailable,
    isAvailable: () => available,
  });

  return {
    service: {
      /**
       * Sends one HTTP request and waits for the complete response.
       *
       * @param {object} input { url, method?, headers?, body?, timeoutMs? }.
       * @returns {Promise<{cancel: Function, done: Promise<object>}>} Transfer handle.
       * @throws {object} Structured validation or availability error (as a rejection).
       */
      async request(input) {
        return beginTransfer(normalizeTransferInput(input), null);
      },

      /**
       * Sends one HTTP request and delivers a success body progressively
       * as raw ordered Uint8Array chunks. An error status never starts a
       * stream; the status and body arrive as an ordinary completed result.
       *
       * @param {object} input { url, method?, headers?, body?, timeoutMs? }.
       * @param {object} handlers { onChunk(chunk: Uint8Array) }.
       * @returns {Promise<{cancel: Function, done: Promise<object>}>} Transfer handle.
       * @throws {object} Structured validation or availability error (as a rejection).
       */
      async stream(input, handlers) {
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

        // The transfer loop works on absolute addresses; the browser origin
        // resolves the same-origin relative contract. Outside a browser
        // (tests, tools) the validation base keeps the URL absolute and
        // deterministic.
        const absoluteUrl = new URL(url, globalThis.location?.href ?? 'http://pey.invalid/').toString();
        try {
          const transfer = beginTransfer({
            url: absoluteUrl,
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
          // The legacy contract only succeeds on a 2xx document response.
          if (final.status < 200 || final.status >= 300) {
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
