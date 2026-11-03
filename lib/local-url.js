// The plain-http local-address rule for pey.http.
//
// A request over plain http is allowed only when the host is provably
// local: the loopback ranges and the private ranges a device assigns
// itself. Everything else (a public address, a mapped IPv4-in-IPv6 form,
// a .local name that was never resolved) is rejected, so a local model
// server works while arbitrary plaintext traffic stays impossible.
// https is always allowed.

const LOCAL_HOSTNAMES = new Set(['localhost']);

function ipv4ToBytes(host) {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return bytes;
}

// Loopback 127.0.0.0/8 and the private ranges 10/8, 172.16/12, 192.168/16.
function isLocalIpv4(host) {
  const bytes = ipv4ToBytes(host);
  if (!bytes) {
    return false;
  }
  if (bytes[0] === 127 || bytes[0] === 10) {
    return true;
  }
  if (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) {
    return true;
  }
  if (bytes[0] === 192 && bytes[1] === 168) {
    return true;
  }
  return false;
}

// Expands a textual IPv6 address (compressed forms included) to eight
// 16-bit groups, or null when it is not valid IPv6.
function expandIpv6(host) {
  const halves = host.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) {
    return null;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0) {
    return null;
  }
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => '0'), ...tail];
  if (groups.length !== 8) {
    return null;
  }
  const numbers = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
    numbers.push(parseInt(group, 16));
  }
  return numbers;
}

function ipv6HasPrefix(numbers, prefixNumbers, prefixBits) {
  for (let bit = 0; bit < prefixBits; bit += 1) {
    const group = Math.floor(bit / 16);
    const mask = 0x8000 >> (bit % 16);
    if ((numbers[group] & mask) !== (prefixNumbers[group] & mask)) {
      return false;
    }
  }
  return true;
}

const FC00_PREFIX = expandIpv6('fc00::');
const FE80_PREFIX = expandIpv6('fe80::');

function isLocalIpv6(host) {
  // IPv4-mapped forms (::ffff:a.b.c.d) must never pass as local: the
  // device routes them as plain IPv4, so the IPv4 rule decides instead.
  if (host.startsWith('::ffff:')) {
    return false;
  }
  const numbers = expandIpv6(host);
  if (!numbers) {
    return false;
  }
  const isLoopback = numbers.slice(0, 7).every((group) => group === 0) && numbers[7] === 1;
  return isLoopback
    || ipv6HasPrefix(numbers, FC00_PREFIX, 7)
    || ipv6HasPrefix(numbers, FE80_PREFIX, 10);
}

/**
 * Decides whether the host of a URL may be reached over plain http.
 *
 * @param {string} hostname Parsed URL hostname (brackets stripped for IPv6).
 * @returns {boolean} True for localhost, loopback and private-range hosts.
 */
export function isLocalHttpHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    return false;
  }
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (LOCAL_HOSTNAMES.has(host)) {
    return true;
  }
  if (host.includes(':')) {
    return isLocalIpv6(host);
  }
  return isLocalIpv4(host);
}

/**
 * Decides whether a URL is reachable under the plain-http policy: https
 * anywhere, plain http only for the defined local addresses.
 *
 * @param {URL} parsed Parsed absolute URL.
 * @returns {boolean} True when the address is allowed.
 */
export function isAllowedHttpUrl(parsed) {
  if (parsed.protocol === 'https:') {
    return true;
  }
  if (parsed.protocol !== 'http:') {
    return false;
  }
  return isLocalHttpHost(parsed.hostname);
}
