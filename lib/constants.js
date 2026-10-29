// Shared constants for the pey.http transport plugin.

export const PLUGIN_NAME = 'pey.http';
export const PLUGIN_VERSION = '0.1.0';
export const SERVICE_NAME = 'pey.http.service';

export const ERROR_CODES = Object.freeze({
  URL_INVALID: 'HTTP_URL_INVALID',
  NOT_FOUND: 'HTTP_NOT_FOUND',
  REQUEST_FAILED: 'HTTP_REQUEST_FAILED',
  MEDIA_TYPE_UNEXPECTED: 'HTTP_MEDIA_TYPE_UNEXPECTED',
});

export const DEFAULT_ACCEPTED_MEDIA_TYPES = Object.freeze([
  'text/markdown',
  'text/plain',
  'text/html',
]);

export const DEFAULT_TIMEOUT_MS = 15000;
export const NOT_FOUND_STATUS = 404;
