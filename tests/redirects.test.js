// Unit tests for lib/redirects.js — the redirect policy and log-safe
// address redaction.

import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRedirect, redactUrl } from '../lib/redirects.js';

test('should_follow_same_origin_redirect_when_location_stays_local', () => {
  const decision = decideRedirect('https://app.example.com/docs/a', '/docs/b');

  assert.equal(decision.allowed, true);
  assert.equal(decision.url, 'https://app.example.com/docs/b');
});

test('should_refuse_cross_origin_redirect_and_name_the_destination_when_hop_leaves_the_origin', () => {
  const decision = decideRedirect('https://app.example.com/a', 'https://other.example.com/b');

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'HTTP_REDIRECT_FORBIDDEN');
  assert.ok(decision.message.includes('https://other.example.com'), 'the destination origin is named');
  assert.ok(!decision.message.includes('/b'), 'no path beyond the origin leaks either');
});

test('should_refuse_https_to_non_local_http_downgrade_before_the_origin_check_when_protocol_downgrades', () => {
  const decision = decideRedirect('https://app.example.com/a', 'http://remote.example.com/b');

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'HTTP_URL_FORBIDDEN', 'downgrade reads as an address-policy failure');
});

test('should_refuse_https_to_local_http_downgrade_by_origin_when_target_is_local', () => {
  // A local plain-http target passes the downgrade check but is still
  // another origin: it is refused as cross-origin (HTTP_REDIRECT_FORBIDDEN),
  // not as an address-policy failure.
  const decision = decideRedirect('https://app.example.com/a', 'http://127.0.0.1:8080/b');

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'HTTP_REDIRECT_FORBIDDEN');
});

test('should_refuse_redirect_when_location_scheme_is_unusable_or_not_http', () => {
  const broken = decideRedirect('https://app.example.com/a', 'http://');
  const ftp = decideRedirect('https://app.example.com/a', 'ftp://app.example.com/file');

  assert.equal(broken.allowed, false);
  assert.equal(broken.code, 'HTTP_REDIRECT_FORBIDDEN');
  assert.equal(ftp.allowed, false);
  assert.ok(ftp.message.includes('ftp:'), 'the unsupported scheme is named');
});

test('should_strip_query_and_credentials_when_redacting_absolute_urls', () => {
  assert.equal(
    redactUrl('https://user:pass@app.example.com/docs/x?token=sk-secret'),
    'https://app.example.com/docs/x',
  );
  assert.equal(redactUrl(new URL('https://app.example.com/y?q=1')), 'https://app.example.com/y');
});

test('should_keep_relative_text_when_redacting_relative_urls', () => {
  // A relative URL has no host: the input minus query and fragment is
  // already as safe as the absolute redaction, and an empty message
  // address helps nobody.
  assert.equal(redactUrl('docs/x.md?token=sk-secret'), 'docs/x.md');
  assert.equal(redactUrl('docs/x.md#frag'), 'docs/x.md');
});
