// Redirect policy for pey.http.
//
// A redirect is followed only inside the same origin, at most the cap set
// in constants.js. Anything else is refused: a cross-origin redirect
// (even https to https) would re-send the request body — the caller's
// private text — to another server, and an https-to-plain-http hop to a
// non-local host would downgrade confidentiality. The refusal message
// names the destination origin (no query, no credentials) so the caller
// can enter the final address directly.

import { isLocalHttpHost } from './local-url.js';

/**
 * Decides whether one redirect hop may be followed.
 *
 * @param {string} currentUrl Absolute URL the request went to.
 * @param {string} locationHeader Raw Location header value.
 * @returns {object} `{ allowed: true, url, dropBody? }` or
 *   `{ allowed: false, code, message }`.
 */
export function decideRedirect(currentUrl, locationHeader) {
  let target;
  try {
    target = new URL(locationHeader, currentUrl);
  } catch {
    return {
      allowed: false,
      code: 'HTTP_REDIRECT_FORBIDDEN',
      message: 'The server sent a redirect with an unusable Location address',
    };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return {
      allowed: false,
      code: 'HTTP_REDIRECT_FORBIDDEN',
      message: `The server redirected to an unsupported address scheme (${target.protocol})`,
    };
  }
  const current = new URL(currentUrl);
  // The downgrade check comes first: an https-to-plain-http hop to a
  // non-local host is an address-policy failure even when the hop is
  // also cross-origin, so the caller can tell the two apart.
  if (current.protocol === 'https:' && target.protocol === 'http:' && !isLocalHttpHost(target.hostname)) {
    return {
      allowed: false,
      code: 'HTTP_URL_FORBIDDEN',
      message: 'The server redirected from https to a non-local plain-http address',
    };
  }
  if (target.origin !== current.origin) {
    return {
      allowed: false,
      code: 'HTTP_REDIRECT_FORBIDDEN',
      message: `The server redirected to another origin (${target.origin}); enter the final address directly`,
    };
  }
  return { allowed: true, url: target.toString() };
}

/**
 * Builds the log-safe address used inside error messages: scheme, host and
 * path only — no query, no fragment, no credentials.
 *
 * @param {URL|string} url Request address.
 * @returns {string} Redacted address.
 */
export function redactUrl(url) {
  try {
    const parsed = url instanceof URL ? url : new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // A relative URL has no host to hide: the caller's own text minus its
    // query and fragment is already as safe as the absolute redaction.
    if (typeof url === 'string' && url.length > 0) {
      return url.split(/[?#]/)[0];
    }
    return '';
  }
}
