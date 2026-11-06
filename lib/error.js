// Creates safe Bonyan errors at the pey.http plugin boundary.

import { ERROR_CODES, PLUGIN_NAME } from './constants.js';

const ERROR_TYPES = new Set(['startup', 'operational', 'critical']);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Creates a standard Bonyan error owned by this plugin.
 *
 * @param {string} code Stable machine-readable error code.
 * @param {string} message Safe human-readable message.
 * @param {'startup'|'operational'|'critical'} [type='operational'] Error category.
 * @param {object|null} [detail=null] Optional safe machine-readable metadata.
 * @returns {{code: string, message: string, source: string, type: string, timestamp: string, detail?: object}}
 * @throws {TypeError} When the error type is unsupported.
 */
export function createHttpError(code, message, type = 'operational', detail = null) {
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new TypeError(`Unsupported error code: ${code}`);
  }
  if (!ERROR_TYPES.has(type)) {
    throw new TypeError(`Unsupported Bonyan error type: ${type}`);
  }

  return {
    code,
    message,
    source: PLUGIN_NAME,
    type,
    timestamp: new Date().toISOString(),
    ...(detail !== null ? { detail } : {}),
  };
}
