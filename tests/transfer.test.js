// Unit tests for lib/transfer.js — configuration normalization (the
// fail-loud startup policy) and transfer-input validation boundaries.
// The transfer loop itself is covered end-to-end from the service level
// (tests/transport.test.js, tests/http-service.test.js).

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, normalizeTransferInput } from '../lib/transfer.js';
import { ERROR_CODES } from '../lib/constants.js';

// --- poisoned per-request input -------------------------------------------

test('should_reach_the_structured_input_error_when_a_request_field_getter_throws', () => {
  // Reading the input runs caller getters: a throwing getter on any of the
  // five fields is the same poisoned-input class as a poisoned toString —
  // structured, never a raw code-less rejection carrying the caller's text.
  const poison = (field) => {
    const input = field === 'url' ? {} : { url: 'https://example.com/a' };
    Object.defineProperty(input, field, { get() { throw new Error('caller text'); }, enumerable: true });
    return input;
  };
  // Every field's read is guarded — including url itself, whose read runs
  // BEFORE the URL validation.
  for (const field of ['url', 'method', 'headers', 'body', 'timeoutMs']) {
    assert.throws(
      () => normalizeTransferInput(poison(field)),
      (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'operational',
    );
  }
});

test('should_reach_the_structured_input_error_when_the_headers_object_enumeration_throws', () => {
  assert.throws(
    () => normalizeTransferInput({ url: 'https://example.com/a', headers: { get 'x-a'() { throw new Error('caller text'); }, 'x-b': 'v' } }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'operational',
  );
});

test('should_accept_media_type_entries_with_the_full_rfc_token_charset', () => {
  // The positive pattern uses the FULL RFC 7230 token charset: entries with
  // %-encoding, ~, *, | or ` in experimental type names can genuinely match
  // the comparison side and must not be refused (round-10 P2).
  for (const good of ['application/x-a~b', 'application/x-a*b', 'application/vnd|x', 'application/x-`p', 'application/x-%41']) {
    normalizeConfig({ acceptedMediaTypes: [good] });
  }
});

test('should_reach_the_structured_input_error_when_the_request_method_cannot_render_itself', () => {
  // The per-request path has no prepare-time network in front of it: a
  // poisoned toString on the method must cross as HTTP_INPUT_INVALID, never
  // as a raw code-less rejection carrying the caller's own message.
  const poisoned = { toString() { throw new Error('caller text'); } };
  assert.throws(
    () => normalizeTransferInput({ url: 'https://example.com/a', method: poisoned }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID
      && error.type === 'operational'
      && error.detail?.value === '[unrenderable value]',
  );
});

test('should_reach_the_structured_input_error_when_a_header_value_cannot_render_itself', () => {
  const poisoned = { toString() { throw new Error('caller text'); } };
  assert.throws(
    () => normalizeTransferInput({ url: 'https://example.com/a', headers: { 'x-bad': poisoned } }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID
      && error.type === 'operational'
      // Round-12 privacy fix: the NAME never enters the error (an
      // `authorization` name in a host log is still an authentication
      // leak) — the header's POSITION carries the diagnosis, same as the
      // token rejections.
      && error.detail?.headerPosition === 1
      && error.detail?.header === undefined
      && error.detail?.value === '[unrenderable value]',
  );
});

test('should_refuse_control_characters_and_non_latin1_values_before_any_fetch', () => {
  // Round-12 regression: the round-11 value check only covered line
  // breaks. A NUL byte or Persian header text passed it, died INSIDE fetch
  // as a raw TypeError, and got misreported as HTTP_NETWORK_FAILED — the
  // server blamed for a caller-side typo. The field-content set (TAB +
  // printable ASCII + obs-text) is what fetch itself accepts; anything
  // else is refused with the structured code before a single byte leaves.
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-ok': 'v\x00evil' } }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.detail?.headerPosition === 1,
  );
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-ok': 'سلام' } }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.detail?.headerPosition === 1,
  );
  // TAB and the obs-text high range stay legal.
  normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-ok': 'col1\tcol2', 'x-sig': 'caf\xe9' } });
});

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

test('should_fail_startup_when_a_media_type_entry_cannot_ever_match_the_comparison_side', () => {
  // extractMediaType compares the header's bare type/subtype: ANY entry
  // that is not a bare token pair — parameters ('text/html; charset=utf-8',
  // the most common way servers WRITE a Content-Type), inner spaces
  // ('text / html'), full-width look-alikes from a Persian IME — would
  // pass validation yet match nothing, the same silent "list that accepts
  // nothing" class as a blank entry. A positive pattern rejects them all.
  for (const bad of ['text/html; charset=utf-8', 'text / html', 'text/html；charset=utf-8', 'texthtml', '/html', 'text/']) {
    assert.throws(
      () => normalizeConfig({ acceptedMediaTypes: [bad] }),
      (error) => error.code === ERROR_CODES.INPUT_INVALID
        && error.type === 'startup'
        && error.detail?.value === bad,
    );
  }
  for (const good of ['text/html', 'application/vnd.api+json', 'TEXT/PLAIN']) {
    normalizeConfig({ acceptedMediaTypes: [good] });
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
  // The container is null-prototype (the `__proto__` regression): compare
  // own entries, not prototypes.
  assert.deepEqual(
    { ...normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-a': 5 } }).headers },
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

test('should_keep_a_proto_header_as_an_own_property_when_headers_are_normalized', () => {
  // Round-11 regression: the header container is null-prototype. On a plain
  // `{}` the `__proto__` key's assignment silently hit the inherited setter
  // and the header the caller explicitly declared vanished before fetch —
  // `JSON.parse('{"__proto__":"v"}')` builds a real own property, so this
  // shape reaches the normalizer through Object.entries legitimately.
  const declared = JSON.parse('{"__proto__":"v","x-real":"r"}');
  assert.ok(Object.prototype.hasOwnProperty.call(declared, '__proto__'));
  const spec = normalizeTransferInput({ url: 'https://x.test/a', headers: declared });
  assert.equal(Object.getPrototypeOf(spec.headers), null, 'the container has no prototype to hijack');
  assert.ok(Object.prototype.hasOwnProperty.call(spec.headers, '__proto__'), 'the declared header survives');
  assert.equal(spec.headers.__proto__, 'v');
  assert.equal(spec.headers['x-real'], 'r');
});

test('should_reach_structured_startup_errors_when_config_property_reads_throw', () => {
  // Round-11 regression: configuration reads are guarded like the request
  // side — a throwing getter on a config key, an array element or a timeout
  // must cross as HTTP_INPUT_INVALID (startup, named field), never as a raw
  // error the entry point downgrades to HTTP_TRANSPORT_UNAVAILABLE without
  // any detail.
  const poisonedKey = Object.defineProperties({}, {
    acceptedMediaTypes: { get() { throw new Error('config text'); }, enumerable: true },
  });
  assert.throws(
    () => normalizeConfig(poisonedKey),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'startup' && error.detail?.field === 'acceptedMediaTypes',
  );
  const poisonedEntry = Object.defineProperties({}, {
    acceptedMediaTypes: { value: ['text/html'], enumerable: true },
    timeoutMs: { get() { throw new Error('config text'); }, enumerable: true },
  });
  assert.throws(
    () => normalizeConfig(poisonedEntry),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'startup' && error.detail?.field === 'timeoutMs',
  );
  const poisonedElement = ['text/html'];
  Object.defineProperty(poisonedElement, 0, { get() { throw new Error('config text'); }, enumerable: true });
  assert.throws(
    () => normalizeConfig({ acceptedMediaTypes: poisonedElement }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.type === 'startup' && error.detail?.field === 'acceptedMediaTypes[0]',
  );
});

test('should_reject_malformed_header_names_values_and_methods_before_any_fetch', () => {
  // Round-11 regression: pre-flight token validation. These shapes used to
  // die INSIDE fetch as a raw TypeError, misreported as HTTP_NETWORK_FAILED
  // ("the server was unreachable") — blaming the server for a caller-side
  // typo and derailing retry logic keyed on network codes.
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x bad name': 'v' } }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.detail?.headerPosition === 1,
  );
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-ok': 'v\nevil' } }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID && error.detail?.headerPosition === 1,
  );
  assert.throws(
    () => normalizeTransferInput({ url: 'https://x.test/a', method: 'G ET' }),
    (error) => error.code === ERROR_CODES.INPUT_INVALID,
  );
  // Valid token names, values and methods still pass — including the full
  // RFC token charset and the (odd but legal) `__proto__` name.
  const spec = normalizeTransferInput({ url: 'https://x.test/a', method: 'POST', headers: { 'x-a~b': 'plain value', 'content-type': 'application/json' } });
  assert.equal(spec.method, 'POST');
});

test('should_accept_the_full_obs_text_range_when_header_values_are_validated', () => {
  // Round-13 regression: obs-text per RFC 7230 is the WHOLE %x80-FF range
  // and undici's own header validator admits it (C1 controls included) —
  // the round-12 pattern cut the 0x80-0x9F half and refused values that
  // genuinely cross the wire.
  normalizeTransferInput({ url: 'https://x.test/a', headers: { 'x-sig': 'a\x85b', 'x-sel': 'caf\xe9' } });
});

test('should_read_a_platform_headers_container_when_the_host_passes_one', () => {
  // Round-13 regression: a `Headers` (or `Map`) instance keeps its entries
  // in internal slots — `Object.entries` saw NOTHING and the request was
  // silently sent with ZERO headers, the same silent declared-data-loss
  // class the `__proto__` fix closed. Containers exposing `entries()` are
  // read through it.
  const container = new Headers({ 'x-a': '1', 'x-b': '2' });
  assert.equal(Object.entries(container).length, 0, 'the platform container really hides its entries from Object.entries');
  const spec = normalizeTransferInput({ url: 'https://x.test/a', headers: container });
  assert.equal(spec.headers['x-a'], '1');
  assert.equal(spec.headers['x-b'], '2');
  const mapped = normalizeTransferInput({ url: 'https://x.test/a', headers: new Map([['x-c', '3']]) });
  assert.equal(mapped.headers['x-c'], '3');
});
