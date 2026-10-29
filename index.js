// Wires the HTTP transport service into Bonyan's two-phase plugin lifecycle.

import { SERVICE_NAME } from './lib/constants.js';
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
    // createHttpService throws raw only for the unavailable-fetch startup case;
    // normalize anything unexpected so nothing raw crosses the boundary.
    throw error.code === 'HTTP_TRANSPORT_UNAVAILABLE'
      ? error
      : createHttpError('HTTP_TRANSPORT_UNAVAILABLE', 'The HTTP transport could not start', 'startup');
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
