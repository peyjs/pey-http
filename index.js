// Wires the HTTP transport service into Bonyan's two-phase plugin lifecycle.

import { ERROR_CODES, SERVICE_NAME } from './lib/constants.js';
import { createHttpError } from './lib/error.js';
import { createHttpService } from './lib/http-service.js';

let lifecycleControls = null;

/**
 * Prepares the declared HTTP transport service.
 *
 * @param {object} prepareContext Bonyan preparation context.
 * @returns {Promise<Array<{name: string, object: object}>>} Declared service registrations.
 * @throws {object} Structured startup error when the transport is unavailable.
 */
export async function prepare(prepareContext) {
  lifecycleControls = null;
  prepareContext.onDeactivated = () => lifecycleControls?.deactivate();
  prepareContext.onShutdown = async () => lifecycleControls?.deactivate();

  let http;
  try {
    http = createHttpService({ config: prepareContext.config });
  } catch (error) {
    // Structured startup errors (unavailable fetch, invalid config values)
    // pass through with their code and detail intact — the host needs to
    // know WHICH configuration key is broken. Only something truly raw is
    // normalized, so nothing unstructured crosses the boundary.
    throw typeof error?.code === 'string' && error.code.startsWith('HTTP_')
      ? error
      : createHttpError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'The HTTP transport could not start', 'startup');
  }

  lifecycleControls = http;
  return [{ name: SERVICE_NAME, object: http.service }];
}

/**
 * Activates the dependency-free HTTP transport plugin after settlement.
 *
 * @param {Record<string, object>} services Bound declared dependencies; always empty here.
 * @returns {Promise<void>}
 */
export async function activate(services) {
  void services;
}
