// Unit tests for lib/transfer.js — configuration normalization (the
// fail-loud startup policy) and transfer-input validation boundaries.
// The transfer loop itself is covered end-to-end from the service level
// (tests/transport.test.js, tests/http-service.test.js).

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, normalizeTransferInput } from '../lib/transfer.js';
import { ERROR_CODES } from '../lib/constants.js';

// --- normalizeConfig ------------------------------------------------------

test('should_default_the_media_types_when_config_leaves_them_out', () => {
  assert.deepEqual(normalizeConfig({}).acceptedMediaTypes.length > 0, true);
  assert.equal(normalizeConfig({ acceptedMediaTypes: [] }).acceptedMediaTypes.length > 0, true, 'an empty list falls back to the default');
});

test('should_treat_an_explicit_null_as_absent_when_config_values_are_normalized', () => {
  // null = absent, by decision: both keys take the defaults instead of
  // failing startup (documented in the reference config table).
  const normalized = normalizeConfig({ acceptedMediaTypes: null, timeoutMs: null, streamIdleTimeoutMs: null });
  assert.equal(normalized.acceptedMediaTypes.length > 0, true);
  assert.equal(normalized.timeoutMs > 0, true);
  assert.equal(normalized.streamIdleTimeoutMs > 0, true);
});

test('should_fail_startup_when_the_media_types_are_present_but_not_an_array', () => {
  // Same fail-loud policy as the timeouts: a present unusable value never
  // silently runs on the default list.
  for (const bad of ['text/html', 42, {}]) {
    assert.throws(
      () => normalizeConfig({ acceptedMediaTypes: bad }),
      (error) => error.code === ERROR_CODES.INPUT_INVALID
        && error.type === 'startup'
        && typeof error.detail?.value === 'string',
    );
  }
});

test('should_trim_media_type_entries_when_normalizing_the_list', () => {
  // extractMediaType compares against a trimmed header value: a padded
  // entry must be trimmed at intake, or the list silently accepts nothing.
  assert.deepEqual(
    normalizeConfig({ acceptedMediaTypes: [' text/html '] }).acceptedMediaTypes,
    ['text/html'],
  );
});

test('should_fail_startup_when_a_media_type_entry_is_not_a_non_empty_string', () => {
  // The fail-loud policy applies to the ELEMENTS too: a non-string entry
  // would silently coerce into a list that accepts nothing.
  for (const bad of [[42], [null], [{}], [''], ['text/html', '']]) {
    assert.throws(
      () => normalizeConfig({ acceptedMediaTypes: bad }),
      (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'startup',
    );
  }
  assert.deepEqual(
    normalizeConfig({ acceptedMediaTypes: ['Text/Markdown'] }).acceptedMediaTypes,
    ['text/markdown'],
  );
});

test('should_fail_startup_when_a_media_type_entry_carries_parameters', () => {
  // extractMediaType compares the header's parameter-free media type: an
  // entry like 'text/html; charset=utf-8' — the most common way servers
  // WRITE a Content-Type — would pass validation yet match nothing, the
  // same silent "list that accepts nothing" class as a blank entry.
  for (const bad of [['text/html; charset=utf-8'], ['text/html', 'application/json;q=0.9']]) {
    assert.throws(
      () => normalizeConfig({ acceptedMediaTypes: bad }),
      (error) => error.code === ERROR_CODES.INPUT_INVALID
        && error.type === 'startup'
        && error.detail?.value === bad.find((type) => type.includes(';')),
    );
  }
});

test('should_reach_the_structured_input_error_when_a_configured_value_cannot_render_itself', () => {
  // The fail-loud path renders config values into detail.value: a poisoned
  // toString must not break THAT path — the raw code-less error would be
  // downgraded to HTTP_TRANSPORT_UNAVAILABLE and lose the code, type and
  // detail the host needs to find the offending key.
  const poisoned = { toString() { throw new Error('boom'); } };
  for (const config of [
    { acceptedMediaTypes: [poisoned] },
    { acceptedMediaTypes: poisoned },
    { timeoutMs: poisoned },
    { streamIdleTimeoutMs: poisoned },
  ]) {
    assert.throws(
      () => normalizeConfig(config),
      (error) => error.code === ERROR_CODES.INPUT_INVALID
        && error.type === 'startup'
        && error.detail?.value === '[unrenderable value]',
    );
  }
});

test('should_lowercase_the_media_type_list_when_it_is_valid', () => {
  assert.deepEqual(
    normalizeConfig({ acceptedMediaTypes: ['Text/Markdown', 'APPLICATION/JSON'] }).acceptedMediaTypes,
    ['text/markdown', 'application/json'],
  );
});

test('should_fail_startup_when_a_timeout_is_present_but_unusable', () => {
  for (const key of ['timeoutMs', 'streamIdleTimeoutMs']) {
    for (const bad of [0, -5, 'fast', Infinity]) {
      assert.throws(
        () => normalizeConfig({ [key]: bad }),
        (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'startup',
      );
    }
  }
  assert.equal(normalizeConfig({}).timeoutMs > 0, true, 'absent timeouts take the defaults');
});

// --- normalizeTransferInput ----------------------------------------------

test('should_reject_non_object_request_input_with_a_structured_error', () => {
  for (const bad of [null, 'https://x.test', 42, []]) {
    assert.throws(() => normalizeTransferInput(bad), (error) => error.code === ERROR_CODES.INPUT_INVALID);
  }
});

test('should_reject_missing_relative_or_forbidden_urls_with_their_own_codes', () => {
  assert.throws(() => normalizeTransferInput({}), (error) => error.code === ERROR_CODES.URL_INVALID);
  assert.throws(() => normalizeTransferInput({ url: 'not a url' }), (error) => error.code === ERROR_CODES.URL_INVALID);
  assert.throws(
    () => normalizeTransferInput({ url: 'http://public.example.com/x' }),
    (error) => error.code === ERROR_CODES.URL_FORBIDDEN,
  );
});

test('should_default_the_method_to_get_and_uppercase_it_when_given', () => {
  assert.equal(normalizeTransferInput({ url: 'https://x.test/a' }).method, 'GET');
  assert.equal(normalizeTransferInput({ url: 'https://x.test/a', method: 'post' }).method, 'POST');
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', method: '   ' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
});

test('should_reject_non_object_headers_and_stringify_their_values', () => {
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', headers: 'a=b' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  assert.deepEqual(
    normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-a': 5 } }).headers,
    { 'x-a': '5' },
  );
});

test('should_reject_a_body_on_get_and_head_and_non_text_bodies_otherwise', () => {
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', body: 'x' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', method: 'HEAD', body: 'x' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', method: 'POST', body: 42 }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  const input = normalizeTransferInput({ url: 'https://x.test/a', method: 'POST', body: 'سلام' });
  assert.equal(input.body, 'سلام');
});
