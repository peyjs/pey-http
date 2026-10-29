// Provides the HTTP text document service for pey.http.

import {
  DEFAULT_ACCEPTED_MEDIA_TYPES,
  DEFAULT_TIMEOUT_MS,
  ERROR_CODES,
  NOT_FOUND_STATUS,
} from './constants.js';
import { createHttpError } from './error.js';

const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

function unavailableError() {
  return createHttpError(SERVICE_UNAVAILABLE, 'HTTP service is unavailable');
}

/**
 * Validates a same-origin relative document URL.
 *
 * @param {string} url Candidate URL.
 * @returns {string} The validated URL.
 * @throws {object} Standard HTTP_URL_INVALID error for non-string, absolute, or protocol-bearing URLs.
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
 * @returns {{acceptedMediaTypes: string[], timeoutMs: number}} Normalized configuration.
 */
function normalizeConfig(config) {
  const acceptedMediaTypes = Array.isArray(config.acceptedMediaTypes)
    && config.acceptedMediaTypes.length > 0
    ? config.acceptedMediaTypes.map((type) => String(type).toLowerCase())
    : [...DEFAULT_ACCEPTED_MEDIA_TYPES];
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  return { acceptedMediaTypes, timeoutMs };
}

/**
 * Creates the HTTP text document service.
 *
 * @param {object} options Service options.
 * @param {object} options.config Plugin configuration.
 * @param {Function} [options.fetchImpl=globalThis.fetch] Transport fetch implementation, injectable for tests.
 * @returns {{service: object, deactivate: Function}} Service and its lifecycle control.
 */
export function createHttpService({ config, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const { acceptedMediaTypes, timeoutMs } = normalizeConfig(config);
  let available = true;

  if (typeof fetchImpl !== 'function') {
    throw createHttpError('HTTP_TRANSPORT_UNAVAILABLE', 'No fetch implementation is available', 'startup');
  }

  function assertAvailable() {
    if (!available) {
      throw unavailableError();
    }
  }

  return {
    service: {
      /**
       * Fetches a text document over HTTP.
       *
       * @param {string} url Same-origin relative URL.
       * @returns {Promise<{status: number, body: string}|object>} Result or standard Bonyan error.
       */
      async getText(url) {
        try {
          assertAvailable();
        } catch (error) {
          return error;
        }

        let validatedUrl;
        try {
          validatedUrl = validateRelativeUrl(url);
        } catch (error) {
          return error;
        }

        let response;
        try {
          response = await fetchImpl(validatedUrl, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          return createHttpError(
            ERROR_CODES.REQUEST_FAILED,
            'The document could not be fetched from the server',
          );
        }

        if (response.status === NOT_FOUND_STATUS) {
          return createHttpError(ERROR_CODES.NOT_FOUND, 'The document was not found on the server');
        }

        if (!response.ok) {
          return createHttpError(
            ERROR_CODES.REQUEST_FAILED,
            'The server refused to return the document',
          );
        }

        const mediaType = extractMediaType(response.headers?.get?.('content-type'));
        if (mediaType !== '' && !acceptedMediaTypes.includes(mediaType)) {
          return createHttpError(
            ERROR_CODES.MEDIA_TYPE_UNEXPECTED,
            'The server returned a document type this application does not render',
          );
        }

        let body;
        try {
          body = await response.text();
        } catch {
          return createHttpError(ERROR_CODES.REQUEST_FAILED, 'The document body could not be read');
        }

        return { status: response.status, body };
      },
    },

    deactivate() {
      available = false;
    },
  };
}
