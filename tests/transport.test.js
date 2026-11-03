// Verifies the generic transport contract (request/stream) against the
// acceptance criteria of docs/requirements.md — with a fake fetch, never
// a real network call.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpService } from '../lib/http-service.js';

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function bytes(text) {
  return new TextEncoder().encode(text);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function textResponse(body, { status = 200, headers = [] } = {}) {
  const encoded = bytes(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(headers),
    arrayBuffer: async () => encoded.slice().buffer,
  };
}

// A never-settling fetch that rejects only when the caller's signal
// aborts — the shape a real fetch shows on cancel and on timeout.
function hangingResponder() {
  return (url, options) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

// A success response whose body streams out one chunk per macrotask and
// rejects the pending read when the caller's signal aborts — the shape a
// real body reader shows on cancellation.
function streamResponder(chunks, { delayMs = 0 } = {}) {
  return (url, options) => {
    let index = 0;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      arrayBuffer: async () => concatBytes(chunks).buffer,
      body: {
        getReader() {
          return {
            read: () => new Promise((resolve, reject) => {
              const onAbort = () => reject(abortError());
              if (options.signal?.aborted) {
                reject(abortError());
                return;
              }
              options.signal?.addEventListener('abort', onAbort, { once: true });
              setTimeout(() => {
                options.signal?.removeEventListener('abort', onAbort);
                if (index < chunks.length) {
                  resolve({ done: false, value: chunks[index] });
                  index += 1;
                } else {
                  resolve({ done: true, value: undefined });
                }
              }, delayMs);
            }),
            cancel: async () => {},
          };
        },
      },
    };
  };
}

// A reader that fails after the first delivered chunk.
function streamResponderCutAfterFirst(chunks) {
  const responder = streamResponder(chunks);
  return (url, options) => {
    const response = responder(url, options);
    const reader = response.body.getReader();
    let reads = 0;
    response.body = {
      getReader() {
        return {
          read: () => {
            reads += 1;
            if (reads > 1) {
              return Promise.reject(new Error('connection reset'));
            }
            return reader.read();
          },
          cancel: reader.cancel.bind(reader),
        };
      },
    };
    return response;
  };
}

function redirectResponder(hops, { loop = false, final = null } = {}) {
  const seen = [];
  return (url) => {
    seen.push(url);
    if (!loop && seen.length > hops) {
      return final;
    }
    return {
      ok: false,
      status: 302,
      headers: new Map([['location', '/next-hop']]),
      arrayBuffer: async () => new Uint8Array().buffer,
    };
  };
}

function createFakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- plain requests ------------------------------------------------------

test('should_return_status_headers_body_when_request_completes', async () => {
  const fetchImpl = createFakeFetch(() => textResponse('{"ok":true}', { headers: [['x-a', '1']] }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/v1/x' })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(final.status, 200);
  assert.equal(final.headers['x-a'], '1');
  assert.deepEqual(final.body, bytes('{"ok":true}'));
});

test('should_treat_error_statuses_as_ordinary_results_when_requested', async () => {
  const { service } = createHttpService({
    config: {},
    fetchImpl: createFakeFetch((url) => textResponse(
      url.includes('one') ? 'unauthorized' : url.includes('two') ? 'slow down' : 'boom',
      { status: url.includes('one') ? 401 : url.includes('two') ? 429 : 500 },
    )),
  });

  for (const [path, status] of [['/one', 401], ['/two', 429], ['/three', 500]]) {
    const final = await (await service.request({ url: `https://api.example.com${path}` })).done;
    assert.equal(final.ending, 'completed', path);
    assert.equal(final.status, status, path);
    assert.ok(final.body instanceof Uint8Array, path);
  }
});

test('should_pass_method_headers_body_when_request_is_sent', async () => {
  const fetchImpl = createFakeFetch(() => textResponse('ok'));
  const { service } = createHttpService({ config: {}, fetchImpl });

  await (await service.request({
    url: 'https://api.example.com/v1/chat',
    method: 'post',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  })).done;

  assert.equal(fetchImpl.calls[0].options.method, 'POST');
  assert.deepEqual(fetchImpl.calls[0].options.headers, { 'content-type': 'application/json' });
  assert.equal(fetchImpl.calls[0].options.body, '{"a":1}');
});

test('should_reject_relative_url_for_request', async () => {
  const fetchImpl = createFakeFetch(() => textResponse('x'));
  const { service } = createHttpService({ config: {}, fetchImpl });

  await assert.rejects(
    () => service.request({ url: 'docs/guide.md' }),
    (error) => error.code === 'HTTP_URL_INVALID',
  );
  await assert.rejects(
    () => service.request({ url: '' }),
    (error) => error.code === 'HTTP_URL_INVALID',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('should_reject_malformed_input_fields_for_request', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  await assert.rejects(() => service.request('https://api.example.com'), (error) => error.code === 'HTTP_INPUT_INVALID');
  await assert.rejects(() => service.request({ url: 'https://api.example.com', headers: 'nope' }), (error) => error.code === 'HTTP_INPUT_INVALID');
  await assert.rejects(() => service.request({ url: 'https://api.example.com', body: 42 }), (error) => error.code === 'HTTP_INPUT_INVALID');
  await assert.rejects(() => service.request({ url: 'https://api.example.com', timeoutMs: -1 }), (error) => error.code === 'HTTP_INPUT_INVALID');
});

// --- the plain-http local-address rule ----------------------------------

const LOCAL_URLS = [
  'http://localhost:1234/v1',
  'http://127.0.0.1:8080/v1',
  'http://192.168.1.5/v1',
  'http://10.0.0.1/v1',
  'http://172.16.0.1/v1',
  'http://172.31.5.5/v1',
  'http://[::1]:9000/v1',
  'http://[fd00::1]/v1',
  'http://[fe80::1]/v1',
];

const FORBIDDEN_URLS = [
  'http://8.8.8.8/v1',
  'http://172.32.0.1/v1',
  'http://docs.local/v1',
  'http://[::ffff:192.168.1.1]/v1',
  'http://example.com/v1',
];

test('should_accept_defined_local_addresses_over_plain_http', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  for (const url of LOCAL_URLS) {
    const final = await (await service.request({ url })).done;
    assert.equal(final.ending, 'completed', url);
  }
});

test('should_reject_non_local_addresses_over_plain_http', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  for (const url of FORBIDDEN_URLS) {
    await assert.rejects(
      () => service.request({ url }),
      (error) => error.code === 'HTTP_URL_FORBIDDEN',
      url,
    );
  }
});

test('should_accept_any_host_over_https', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  const final = await (await service.request({ url: 'https://8.8.8.8/v1' })).done;
  assert.equal(final.ending, 'completed');
});

// --- cancellation and endings -------------------------------------------

test('should_report_cancelled_and_stop_delivery_when_cancelled', async () => {
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.request({ url: 'https://api.example.com/v1/x' });
  handle.cancel();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
});

test('should_give_exactly_one_ending_per_request', async () => {
  const fetchImpl = createFakeFetch(() => textResponse('done'));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.request({ url: 'https://api.example.com/v1/x' });
  const first = await handle.done;
  const second = await handle.done;

  assert.equal(first, second);
  assert.equal(first.ending, 'completed');
});

test('should_reject_validation_failures_through_the_call_promise', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  await assert.rejects(
    () => service.request({}),
    (error) => error.code === 'HTTP_URL_INVALID',
  );
});

// --- timeout -------------------------------------------------------------

test('should_report_timeout_when_request_exceeds_its_budget', async () => {
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { timeoutMs: 20 }, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/v1/x' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});

test('should_honor_per_request_timeout_over_config_default', async () => {
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { timeoutMs: 60000 }, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/v1/x', timeoutMs: 20 })).done;

  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});

// --- network failure and secrecy -----------------------------------------

test('should_report_network_failure_without_leaking_query_or_headers', async () => {
  const fetchImpl = createFakeFetch(() => {
    throw new TypeError('fetch failed: token=sk-secret value');
  });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({
    url: 'https://api.example.com/v1/chat?token=sk-secret',
    headers: { authorization: 'Bearer sk-secret' },
  })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_NETWORK_FAILED');
  const leak = JSON.stringify(final.error);
  assert.equal(leak.includes('sk-secret'), false);
  assert.equal(final.error.message.includes('?'), false);
  assert.ok(final.error.message.includes('api.example.com/v1/chat'));
});

test('should_map_other_throwables_to_request_failed', async () => {
  const fetchImpl = createFakeFetch(() => { throw new Error('something odd'); });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/v1/x' })).done;

  assert.equal(final.error.code, 'HTTP_REQUEST_FAILED');
});

// --- streaming -----------------------------------------------------------

test('should_deliver_chunks_in_order_and_announce_completion', async () => {
  const received = [];
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('ب'), bytes('c')]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) });
  const final = await handle.done;

  assert.equal(final.ending, 'completed');
  assert.equal(final.status, 200);
  assert.equal(final.body, undefined);
  assert.deepEqual(received, [bytes('a'), bytes('ب'), bytes('c')]);
});

test('should_deliver_raw_bytes_undecoded_even_when_multibyte_char_is_split', async () => {
  const received = [];
  const full = bytes('سلام');
  // The two bytes of "س" (0xD8 0xB3) are deliberately torn apart.
  const fetchImpl = createFakeFetch(streamResponder([full.slice(0, 1), full.slice(1)]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  await (await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) })).done;

  assert.deepEqual(concatBytes(received), full);
  assert.equal(new TextDecoder().decode(concatBytes(received)), 'سلام');
});

test('should_not_start_stream_on_error_status_and_deliver_body_instead', async () => {
  const received = [];
  const fetchImpl = createFakeFetch(() => textResponse('unauthorized', { status: 401 }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(final.status, 401);
  assert.deepEqual(new TextDecoder().decode(final.body), 'unauthorized');
  assert.deepEqual(received, []);
});

test('should_report_cancelled_and_no_further_chunks_when_cancelled_mid_stream', async () => {
  const received = [];
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')], { delayMs: 30 }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  handle.cancel();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  const countAtCancel = received.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(received.length, countAtCancel);
});

test('should_report_stream_interrupted_when_body_reader_fails_midway', async () => {
  const fetchImpl = createFakeFetch(streamResponderCutAfterFirst([bytes('a'), bytes('b')]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_STREAM_INTERRUPTED');
});

test('should_report_timeout_when_no_data_arrives_within_idle_budget', async () => {
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { streamIdleTimeoutMs: 20 }, fetchImpl });

  const final = await (await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});

test('should_reject_input_invalid_when_stream_has_no_chunk_handler', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  await assert.rejects(
    () => service.stream({ url: 'https://api.example.com/v1/x' }, {}),
    (error) => error.code === 'HTTP_INPUT_INVALID',
  );
});

// --- redirect policy -----------------------------------------------------

test('should_follow_same_origin_redirect_up_to_the_cap', async () => {
  const fetchImpl = createFakeFetch(redirectResponder(2, { final: textResponse('arrived') }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(new TextDecoder().decode(final.body), 'arrived');
  assert.equal(fetchImpl.calls.length, 3);
});

test('should_refuse_cross_origin_redirect_and_name_destination_origin', async () => {
  const fetchImpl = createFakeFetch(() => ({
    ok: false,
    status: 302,
    headers: new Map([['location', 'https://other.example.com/catch?token=xyz']]),
    arrayBuffer: async () => new Uint8Array().buffer,
  }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_REDIRECT_FORBIDDEN');
  assert.ok(final.error.message.includes('https://other.example.com'));
  assert.equal(final.error.message.includes('token'), false);
});

test('should_refuse_https_to_plain_http_redirect_for_non_local_host', async () => {
  const fetchImpl = createFakeFetch(() => ({
    ok: false,
    status: 302,
    headers: new Map([['location', 'http://other.example.com/catch']]),
    arrayBuffer: async () => new Uint8Array().buffer,
  }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_URL_FORBIDDEN');
});

test('should_refuse_redirects_beyond_the_cap', async () => {
  const fetchImpl = createFakeFetch(redirectResponder(0, { loop: true }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_REDIRECT_FORBIDDEN');
});

test('should_reissue_303_as_get_without_body', async () => {
  const fetchImpl = createFakeFetch((url, options) => {
    if (url.endsWith('/start')) {
      return {
        ok: false,
        status: 303,
        headers: new Map([['location', '/next']]),
        arrayBuffer: async () => new Uint8Array().buffer,
      };
    }
    return textResponse('arrived');
  });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({
    url: 'https://api.example.com/start',
    method: 'POST',
    body: 'private-text',
  })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(fetchImpl.calls[1].options.method, 'GET');
  assert.equal(fetchImpl.calls[1].options.body, undefined);
});

// --- lifecycle -----------------------------------------------------------

test('should_reject_service_unavailable_after_deactivation', async () => {
  const { service, deactivate } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  deactivate();

  await assert.rejects(() => service.request({ url: 'https://api.example.com/v1/x' }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  await assert.rejects(() => service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  const text = await service.getText('docs/x.md');
  assert.equal(text.code, 'SERVICE_UNAVAILABLE');
});

test('should_end_in_flight_stream_as_interrupted_when_deactivated_mid_stream', async () => {
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')], { delayMs: 30 }));
  const { service, deactivate } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  deactivate();

  const final = await handle.done;
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
});
