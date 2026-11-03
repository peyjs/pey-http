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

test('should_pass_get_method_and_timeout_when_request_is_sent', async () => {
  const fetchImpl = createFakeFetch([createTextResponse('x')]);
  const { service } = createHttpService({ config: { timeoutMs: 250 }, fetchImpl });

  await service.getText('docs/readme.md');

  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.equal(fetchImpl.calls[0].url, 'docs/readme.md');
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
