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

// RFC 7230 token: the bare `type/subtype` an acceptedMediaTypes entry must
// be — the full token charset, so the positive pattern rejects exactly what
// can never match the comparison side and nothing that can. The same token
// charset pre-validates the request's header NAMES and METHOD (round 11):
// malformed ones otherwise reach fetch and die as a TypeError that the
// ending mapper can only read as "the server was unreachable" — an
// environment verdict on a caller-side typo, which also derails retry
// logic keyed on network codes. Header VALUES are validated against the
// field-content set (see the pattern below). Error messages carry
// POSITION, never header content: nothing about headers or bodies enters
// an error (documented privacy contract).
const TOKEN_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/i;
// Header FIELD-CONTENT (round 12, widening the round-11 line-break-only
// check; round 13 fixed the range): TAB plus printable ASCII plus the FULL
// obs-text range %x80-FF — exactly the set fetch itself accepts (undici's
// headerCharRegex admits the whole high half, C1 controls included), so
// the plugin refuses exactly what can never cross the wire and nothing
// that can. Anything else (control characters like NUL, characters beyond
// Latin-1 — Persian header text included) dies INSIDE fetch as a raw
// TypeError misreported as NETWORK_FAILED, so it is refused here with the
// structured code.
const FIELD_CONTENT_PATTERN = /^[\t\x20-\x7E\x80-\xFF]*$/;

/**
 * Renders a configured value for an error detail without letting a poisoned
 * `toString`/`valueOf` break the fail-loud path itself: a raw render error
 * would cross normalizeConfig without a code and the entry point would
 * downgrade it to HTTP_TRANSPORT_UNAVAILABLE, losing code, type and value.
 *
 * @param {unknown} value The configured value.
 * @returns {string} A short, always-renderable description.
 */
function describeValue(value) {
  try {
    return String(value).slice(0, 32);
  } catch {
    return '[unrenderable value]';
  }
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
    value: describeValue(value),
  });
}

/**
 * Validates the final plugin configuration.
 *
 * @param {object} config Merged plugin configuration.
 * @returns {{acceptedMediaTypes: string[], timeoutMs: number, streamIdleTimeoutMs: number}} Normalized configuration.
 */
export function normalizeConfig(config) {
  // Every property read below runs on CONFIGURATION input too (round 11:
  // the request-side `read` guard's counterpart): a throwing getter on a
  // config key, an array element or a timeout would escape as a raw
  // code-less error and the entry point would downgrade it to
  // HTTP_TRANSPORT_UNAVAILABLE — losing code, type and WHICH key broke.
  const read = (field) => {
    try {
      return config[field];
    } catch {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, `Reading the "${field}" configuration failed`, 'startup', {
        field,
        value: '[unrenderable value]',
      });
    }
  };
  const readEntry = (field, index) => {
    try {
      return configuredTypes[index];
    } catch {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, `Reading the "${field}" configuration entry ${index} failed`, 'startup', {
        field: `${field}[${index}]`,
        value: '[unrenderable value]',
      });
    }
  };
  // Same fail-loud policy as the timeouts: a PRESENT but unusable value
  // breaks startup instead of silently running on the default list. An
  // absent value and an empty array both fall back to the default list.
  const configuredTypes = read('acceptedMediaTypes');
  if (configuredTypes !== undefined && configuredTypes !== null && !Array.isArray(configuredTypes)) {
    throw createHttpError(ERROR_CODES.INPUT_INVALID, 'The configured acceptedMediaTypes must be a non-empty array', 'startup', {
      value: describeValue(configuredTypes),
    });
  }
  if (Array.isArray(configuredTypes) && configuredTypes.length > 0) {
    // Same fail-loud policy as the timeouts, applied to the ELEMENTS: a
    // non-string (or blank) entry would silently coerce into a media-type
    // list that accepts nothing.
    let bad;
    for (let index = 0; index < configuredTypes.length; index += 1) {
      const type = readEntry('acceptedMediaTypes', index);
      if (typeof type !== 'string' || type.trim() === '') {
        bad = type;
        break;
      }
    }
    if (bad !== undefined) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Every configured acceptedMediaTypes entry must be a non-empty string', 'startup', {
        value: describeValue(bad),
      });
    }
    // extractMediaType compares the header's PARAMETER-FREE media type, so
    // any entry that is not a bare `type/subtype` token pair can never
    // match anything — parameters (`'text/html; charset=utf-8'`), inner
    // spaces (`'text / html'`), full-width look-alikes — the same silent
    // "list that accepts nothing" class as a blank entry. Fail loud at
    // startup with a positive pattern instead of blacklisting one shape.
    let malformed;
    for (let index = 0; index < configuredTypes.length; index += 1) {
      const type = readEntry('acceptedMediaTypes', index);
      if (!MEDIA_TYPE_PATTERN.test(type.trim())) {
        malformed = type;
        break;
      }
    }
    if (malformed !== undefined) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Every configured acceptedMediaTypes entry must be a bare media type of the form type/subtype (parameters live on the response Content-Type, not in this list)', 'startup', {
        value: describeValue(malformed),
      });
    }
  }
  const acceptedMediaTypes = Array.isArray(configuredTypes) && configuredTypes.length > 0
    // trim() matches extractMediaType's header-side comparison: a padded
    // entry must never silently become a list that accepts nothing.
    ? configuredTypes.map((type, index) => readEntry('acceptedMediaTypes', index).trim().toLowerCase())
    : [...DEFAULT_ACCEPTED_MEDIA_TYPES];
  return {
    acceptedMediaTypes,
    timeoutMs: timeoutOf(read('timeoutMs'), DEFAULT_TIMEOUT_MS),
    streamIdleTimeoutMs: timeoutOf(read('streamIdleTimeoutMs'), DEFAULT_STREAM_IDLE_TIMEOUT_MS),
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
  // Every property read below runs on CALLER input: a throwing getter on
  // any field would escape as a raw code-less rejection (the same class as
  // the poisoned `toString` renders guarded further down).
  const read = (field) => {
    try {
      return raw[field];
    } catch {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, `Reading the request "${field}" field failed`, 'operational', {
        field,
        value: '[unrenderable value]',
      });
    }
  };
  const url = read('url');
  const method = read('method');
  const headers = read('headers');
  const body = read('body');
  const timeoutMs = read('timeoutMs');

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

  // The renders below run on CALLER input in the per-request path: a value
  // whose own toString throws must cross as a structured HTTP_INPUT_INVALID
  // — a raw error here reaches the caller's rejection un-normalized (there
  // is no prepare-time network in front of these methods).
  let normalizedMethod = 'GET';
  if (method !== undefined && method !== null) {
    try {
      normalizedMethod = String(method).trim().toUpperCase();
    } catch {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request method must be a plain string', 'operational', {
        value: describeValue(method),
      });
    }
    if (normalizedMethod.length === 0) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request method must be a non-empty string');
    }
    // Same pre-flight as the header names (round 11): a non-token method
    // dies inside fetch as a TypeError misreported as a network failure.
    if (!TOKEN_PATTERN.test(normalizedMethod)) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request method is not a valid HTTP token');
    }
  }

  // A NULL-PROTOTYPE container (round 11): on a plain `{}`, the `__proto__`
  // key's assignment silently hits the inherited setter and the header the
  // caller explicitly declared VANISHES before fetch — an undetectable data
  // loss, against the documented contract ("the plugin never adds, removes
  // or logs a header"). A null prototype makes every assignment an own
  // property; `__proto__` is a valid RFC token header name.
  const normalizedHeaders = Object.create(null);
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request headers must be an object');
    }
    let entries;
    try {
      // A standard PLATFORM container (a `Headers`, `Map` or
      // `URLSearchParams` instance) keeps its entries in internal slots —
      // `Object.entries` sees NOTHING, so the old plain-object path
      // silently sent the request with ZERO headers (the same "silent
      // declared-data loss" class the `__proto__` fix closed, entering
      // through the platform's own types; round 13). The container path is
      // restricted to REAL platform types (round 14): an arbitrary
      // entries()-bearing object (or one inheriting the method from its
      // prototype) would have run caller CODE inside the normalizer, the
      // one seam the everything-is-own-keys style avoids elsewhere. The
      // check is a BRAND check, not instanceof (round 15): a real `Map`
      // from ANOTHER REALM (vm frame, iframe) fails every instanceof and
      // would have silently fallen to the zero-header Object.entries path
      // — the brand check reads the internal slot tag without executing
      // any caller code.
      const brand = Object.prototype.toString.call(headers);
      const isPlatformContainer = brand === '[object Map]'
        || brand === '[object Headers]'
        || brand === '[object URLSearchParams]';
      entries = isPlatformContainer ? [...headers.entries()] : Object.entries(headers);
    } catch {
      // Enumerating the headers object runs its own getters too.
      throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Reading the request headers failed', 'operational', {
        value: '[unrenderable value]',
      });
    }
    for (let index = 0; index < entries.length; index += 1) {
      // Destructuring and the key check stay INSIDE the guard (round 14):
      // a container's entries() output is NOT the guaranteed [string,
      // string] shape of Object.entries — a non-pair member or a Symbol
      // key (legal in a `Map`) must cross as the structured input error,
      // never as a raw TypeError (nothing raw crosses the boundary).
      let key;
      let value;
      try {
        const entry = entries[index];
        // The VALUE half: only a Symbol is refused here — its String
        // coercion produces the LYING string 'Symbol(v)' on the wire
        // (round 15); every other type stringifies as documented (numbers
        // → digits, objects → their toString).
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] === 'symbol') {
          throw createHttpError(ERROR_CODES.INPUT_INVALID, `Request header ${index + 1} is not a name/value string pair`, 'operational', {
            headerPosition: index + 1,
          });
        }
        [key, value] = entry;
        normalizedHeaders[key] = String(value);
      } catch (error) {
        if (error && typeof error.code === 'string' && error.code.startsWith('HTTP_')) {
          throw error;
        }
        // Same privacy rule as the token rejections below: the header's
        // POSITION, never its name (an `authorization` name in a host log
        // is still an authentication-structure leak) and never its value.
        throw createHttpError(ERROR_CODES.INPUT_INVALID, 'Request header values must be plain strings', 'operational', {
          headerPosition: index + 1,
          value: '[unrenderable value]',
        });
      }
      // Pre-flight token validation (round 11): a malformed NAME or a value
      // with a line break would otherwise die inside fetch as a raw
      // TypeError that the ending mapper can only report as NETWORK_FAILED —
      // blaming the server for a caller-side typo and derailing retry logic.
      // Messages carry the header's POSITION, never its name or value.
      if (!TOKEN_PATTERN.test(key)) {
        throw createHttpError(ERROR_CODES.INPUT_INVALID, `Request header ${index + 1} has a name that is not a valid HTTP token`, 'operational', {
          headerPosition: index + 1,
        });
      }
      if (!FIELD_CONTENT_PATTERN.test(normalizedHeaders[key])) {
        throw createHttpError(ERROR_CODES.INPUT_INVALID, `Request header ${index + 1} has a value outside the field-content character set (a control character other than TAB, or a character beyond Latin-1)`, 'operational', {
          headerPosition: index + 1,
        });
      }
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
      // The body of an intermediate 30x is never consumed again — release it
      // BEFORE any rejection path (hop cap, policy refusal), or a refused
      // redirect would hold its connection until garbage collection (the
      // same leak the follow path fixed in 2.0.1).
      await releaseBody(response);
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
 * @param {boolean} [options.supportsManualRedirects] Forces the redirect
 *   mode: `true` enables the step-by-step loop, `false` hands redirects to
 *   the environment's `redirect: 'follow'`; unset, the mode is detected
 *   from the environment.
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
                const delivered = onChunk(value);
                // An ASYNC handler reports its failure as a rejected
                // Promise, not a throw (round 13): ignoring the return left
                // the rejection as an unhandledRejection that kills the
                // host process under Node's default mode, while the stream
                // reported `completed`. The await is RACED (round 14):
                // a never-settling thenable would otherwise hang `done`
                // FOREVER — the idle timer and abort only reach
                // reader.read(), and neither cancel() nor deactivate()
                // could settle the transfer, breaking the "one of three
                // endings, never a silent hang" contract. The budget is
                // the same idle budget; cancel/deactivate settle the race
                // through the abort signal.
                if (delivered && typeof delivered.then === 'function') {
                  await new Promise((resolve, reject) => {
                    // The race is against the ABORT SIGNAL only: the armed
                    // idle timer aborts on its budget (mapping to the
                    // TIMEOUT ending), while cancel() and deactivate()
                    // settle as their own endings — every exit path that
                    // used to hang behind an unsettled handler promise is
                    // a settler again.
                    const onAbort = () => {
                      reject(new Error('the transfer was aborted while the handler promise was pending'));
                    };
                    if (controller.signal.aborted) {
                      reject(new Error('the transfer was aborted while the handler promise was pending'));
                      return;
                    }
                    controller.signal.addEventListener('abort', onAbort, { once: true });
                    Promise.resolve(delivered).then(
                      () => {
                        controller.signal.removeEventListener('abort', onAbort);
                        resolve();
                      },
                      () => {
                        controller.signal.removeEventListener('abort', onAbort);
                        reject(new Error('the receiving handler promise rejected'));
                      },
                    );
                  });
                }
              } catch {
                // A broken receiving handler — a sync throw, a rejected
                // promise, a never-settling promise hitting its budget — is
                // a caller bug, not a network cut; cancel and timeout keep
                // THEIR endings. The reader is released before reporting.
                await releaseReader();
                if (cancelled) {
                  return settle({ ending: 'cancelled' });
                }
                if (timedOut) {
                  return interrupted(createHttpError(ERROR_CODES.TIMEOUT, 'The transfer ran out of its time budget'));
                }
                if (deactivated || !isAvailable()) {
                  return interrupted(unavailableError());
                }
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
