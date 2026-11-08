// Verifies the HTTP text document service behavior with a fake fetch.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpService } from '../lib/http-service.js';

function createTextResponse(body, { status = 200, contentType = 'text/markdown' } = {}) {
  const encoded = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', contentType]]),
    arrayBuffer: async () => encoded.slice().buffer,
    text: async () => body,
  };
}

function createFakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const responder = responses.shift();
    if (responder === undefined) {
      throw new Error('unexpected fetch call');
    }
    if (typeof responder === 'function') {
      return responder(url, options);
    }
    return responder;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('should_return_status_and_body_when_document_is_fetched', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('# سلام')]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/readme.md');

  assert.deepEqual(result, { status: 200, body: '# سلام' });
});

test('should_send_get_when_relative_url_is_resolved_against_the_origin', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('x')]);
  const { service } = createHttpService({ config: { timeoutMs: 250 }, fetchImpl });

  await service.getText('docs/readme.md');

  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  // The transfer loop works on absolute addresses; the relative document
  // URL resolves against the environment origin (the validation base in
  // non-browser runs).
  assert.equal(fetchImpl.calls[0].url, 'http://pey.invalid/docs/readme.md');
});

test('should_hand_redirects_to_the_environment_when_manual_support_is_injected_off', async () => {
  // The injected override forces follow mode even on Node: the fetch call
  // carries redirect: 'follow' and a redirect response surfaces untouched —
  // the plugin never loops manually.
  const redirectResponse = createTextResponse('', { status: 302, contentType: 'text/plain' });
  redirectResponse.headers.set('location', 'https://origin.test/b');
  const fetchImpl = createFakeFetch([redirectResponse]);
  const { service } = createHttpService({ config: {}, fetchImpl, supportsManualRedirects: false });

  const handle = await service.request({ url: 'https://origin.test/a' });
  const final = await handle.done;

  assert.equal(fetchImpl.calls[0].options.redirect, 'follow');
  assert.equal(final.status, 302);
  assert.equal(fetchImpl.calls.length, 1, 'no manual hop happens in follow mode');
});

test('should_follow_redirects_manually_when_manual_support_is_injected_on', async () => {
  // The injected override forces the step-by-step loop even where the
  // environment would follow: the same-origin 302 is rewritten to the
  // destination and re-issued, still in manual mode.
  const first = createTextResponse('', { status: 302, contentType: 'text/plain' });
  first.headers.set('location', '/b');
  const fetchImpl = createFakeFetch([
    (url, options) => {
      void url;
      void options;
      return first;
    },
    createTextResponse('مقصد'),
  ]);
  const { service } = createHttpService({ config: {}, fetchImpl, supportsManualRedirects: true });

  const handle = await service.request({ url: 'https://origin.test/a' });
  const final = await handle.done;

  assert.equal(fetchImpl.calls[0].options.redirect, 'manual');
  assert.equal(fetchImpl.calls[1].url, 'https://origin.test/b');
  assert.equal(fetchImpl.calls[1].options.method, 'GET');
  assert.equal(new TextDecoder().decode(final.body), 'مقصد');
});

test('should_return_not_found_error_when_server_responds_404', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('missing', { status: 404 })]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/missing.md');

  assert.equal(result.code, 'HTTP_NOT_FOUND');
  assert.equal(result.type, 'operational');
  assert.equal(result.source, 'pey.http');
  assert.equal(Number.isNaN(Date.parse(result.timestamp)), false);
});

test('should_return_request_failed_error_when_server_responds_500', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('boom', { status: 500 })]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/readme.md');

  assert.equal(result.code, 'HTTP_REQUEST_FAILED');
});

test('should_return_request_failed_error_when_redirect_has_no_location', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('', { status: 304 })]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/readme.md');

  assert.equal(result.code, 'HTTP_REQUEST_FAILED');
});

test('should_return_request_failed_error_when_network_fails', async () => {
  const fetchImpl = createFakeFetch([() => { throw new TypeError('network down token=secret'); }]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/readme.md');

  assert.equal(result.code, 'HTTP_REQUEST_FAILED');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('should_return_url_invalid_error_when_url_is_absolute', async () => {
  const fetchImpl = createFakeFetch([]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('https://example.com/docs/readme.md');

  assert.equal(result.code, 'HTTP_URL_INVALID');
  assert.equal(fetchImpl.calls.length, 0);
});

test('should_return_url_invalid_error_when_url_is_empty', async () => {
  const fetchImpl = createFakeFetch([]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('');

  assert.equal(result.code, 'HTTP_URL_INVALID');
});

test('should_return_url_invalid_error_when_url_is_not_a_string', async () => {
  const fetchImpl = createFakeFetch([]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText(null);

  assert.equal(result.code, 'HTTP_URL_INVALID');
});

test('should_return_url_invalid_error_when_url_uses_fragment', async () => {
  const fetchImpl = createFakeFetch([]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/readme.md#section');

  assert.equal(result.code, 'HTTP_URL_INVALID');
});

test('should_return_media_type_error_when_content_type_is_unexpected', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('{"a":1}', { contentType: 'application/json' })]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/data.json');

  assert.equal(result.code, 'HTTP_MEDIA_TYPE_UNEXPECTED');
});

test('should_accept_document_when_content_type_is_absent', async () => {
  const body = new TextEncoder().encode('plain');
  const fetchImpl = createFakeFetch([{
    ok: true,
    status: 200,
    headers: new Map(),
    arrayBuffer: async () => body.slice().buffer,
    text: async () => 'plain',
  }]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/no-type');

  assert.deepEqual(result, { status: 200, body: 'plain' });
});

test('should_accept_document_when_media_type_matches_custom_config', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('x', { contentType: 'application/xml' })]);
  const { service } = createHttpService({
    config: { acceptedMediaTypes: ['application/xml'] },
    fetchImpl,
  });

  const result = await service.getText('docs/data.xml');

  assert.deepEqual(result, { status: 200, body: 'x' });
});

test('should_return_service_unavailable_when_deactivated', async () => {
  const fetchImpl = createFakeFetch([]);
  const { service, deactivate } = createHttpService({ config: {}, fetchImpl });

  deactivate();
  const result = await service.getText('docs/readme.md');

  assert.equal(result.code, 'SERVICE_UNAVAILABLE');
});

test('should_reject_startup_error_when_no_fetch_implementation_exists', () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });

  try {
    assert.throws(
      () => createHttpService({ config: {} }),
      (error) => error.code === 'HTTP_TRANSPORT_UNAVAILABLE' && error.type === 'startup',
    );
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true });
  }
});

test('should_follow_same_origin_redirect_when_document_moves', async () => {
  // The 2.0.0 breaking change: getText now follows same-origin redirects.
  const redirect = {
    ok: false,
    status: 302,
    headers: new Map([['location', '/docs/moved.md']]),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const fetchImpl = createFakeFetch([redirect, createTextResponse('# محتوا')]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('docs/original.md');

  assert.deepEqual(result, { status: 200, body: '# محتوا' });
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[1].url.endsWith('/docs/moved.md'));
});

test('should_accept_query_only_relative_url_when_document_url_has_no_path', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('ok')]);
  const { service } = createHttpService({ config: {}, fetchImpl });

  const result = await service.getText('?a:b');

  assert.deepEqual(result, { status: 200, body: 'ok' }, 'a query with a colon is a valid relative URL');
});

test('should_use_numeric_string_config_when_environment_delivers_strings', async (t) => {
  // configuration.md: environment values are strings; the plugin owns the
  // type conversion — the string value must really become the timeout
  // budget, not silently fall back to the default.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A fetch that hangs but honors the abort signal: the mocked deadline is
  // the only way out, exactly like a real stalled request.
  const fetchImpl = (url, options = {}) => new Promise((resolve, reject) => {
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    if (options.signal?.aborted) {
      reject(abortError);
      return;
    }
    options.signal?.addEventListener('abort', () => reject(abortError), { once: true });
  });
  const { service } = createHttpService({
    config: { timeoutMs: '20' },
    fetchImpl,
  });

  const handle = await service.request({ url: 'https://api.example.com/v1/x' });
  const settled = handle.done;
  t.mock.timers.tick(20);
  const final = await settled;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT', 'the string config became the real budget');
});

test('should_fail_startup_when_the_timeout_config_is_present_but_unusable', () => {
  for (const bad of ['abc', 0, -5, true]) {
    assert.throws(
      () => createHttpService({ config: { timeoutMs: bad }, fetchImpl: createFakeFetch([]) }),
      (error) => error.code === 'HTTP_INPUT_INVALID' && error.type === 'startup',
      `timeoutMs ${JSON.stringify(bad)} must fail loudly, not fall back silently`,
    );
  }
});

test('should_fall_back_to_default_media_types_when_accepted_media_types_is_empty', async () => {
  const { service } = createHttpService({
    config: { acceptedMediaTypes: [] },
    fetchImpl: createFakeFetch([createTextResponse('# سلام', { contentType: 'application/octet-stream' })]),
  });

  // The empty array falls back to the defaults, and octet-stream is not
  // among them: the document is refused with the media-type code.
  const result = await service.getText('docs/x.md');
  assert.equal(result.code, 'HTTP_MEDIA_TYPE_UNEXPECTED');
});

test('should_refuse_every_call_when_shutdown_hook_runs_at_the_entry_level', async () => {
  const context = {
    config: {},
    events: { publish: () => {}, subscribe: () => () => {} },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: () => {},
  };
  const { prepare } = await import('../index.js');
  const registrations = await prepare(context);

  // The hooks must really deactivate the service, not just exist.
  await context.onShutdown();

  await assert.rejects(
    () => registrations[0].object.request({ url: 'https://api.example.com/v1/x' }),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
});
