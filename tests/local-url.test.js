// Unit tests for lib/local-url.js — the local-address policy for plain http.

import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedHttpUrl, isLocalHttpHost } from '../lib/local-url.js';

function url(text) {
  return new URL(text);
}

test('should_accept_loopback_and_private_ipv4_hosts_when_checking', () => {
  const local = ['127.0.0.1', '127.254.0.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1'];
  for (const host of local) {
    assert.equal(isLocalHttpHost(host), true, host);
  }
});

test('should_reject_non_local_and_mapped_ipv4_hosts_when_checking', () => {
  const remote = ['example.com', '8.8.8.8', '172.32.0.1', '192.167.0.1', '169.254.1.1', '[::ffff:192.168.1.1]', 'host.local'];
  for (const host of remote) {
    assert.equal(isLocalHttpHost(host), false, host);
  }
});

test('should_accept_local_ipv6_hosts_when_checking', () => {
  const local = ['::1', 'fc00::1', 'fd00::1', 'fd12:3456:789a::1', 'fe80::1'];
  for (const host of local) {
    assert.equal(isLocalHttpHost(host), true, host);
  }
});

test('should_reject_remote_ipv6_and_mapped_forms_when_checking', () => {
  const remote = ['2001:db8::1', '::ffff:192.168.1.1', '0:0:0:0:0:ffff:c0a8:101'];
  for (const host of remote) {
    assert.equal(isLocalHttpHost(host), false, host);
  }
});

test('should_allow_https_everywhere_and_local_http_when_validating_urls', () => {
  assert.equal(isAllowedHttpUrl(url('https://example.com/x')), true);
  assert.equal(isAllowedHttpUrl(url('http://127.0.0.1:8080/x')), true);
  assert.equal(isAllowedHttpUrl(url('http://[::1]:9000/x')), true);
  assert.equal(isAllowedHttpUrl(url('http://192.168.1.5/data')), true);
});

test('should_reject_plain_http_to_remote_hosts_when_validating_urls', () => {
  assert.equal(isAllowedHttpUrl(url('http://example.com/x')), false);
  assert.equal(isAllowedHttpUrl(url('http://8.8.8.8/x')), false);
  assert.equal(isAllowedHttpUrl(url('ftp://127.0.0.1/x')), false);
});
