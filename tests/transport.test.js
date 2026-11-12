// Verifies the generic transport contract (request/stream) against the
// acceptance criteria of docs/requirements.md — with a fake fetch, never
// a real network call.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpService } from '../lib/http-service.js';

/**
 * Advances the mocked clock and drains the microtask queue once, so a
 * resolved reader promise can continue its loop before the next tick.
 * @param {object} timers Node's t.mock.timers.
 * @param {number} [ms] Clock advance per step.
 * @returns {Promise<void>}
 */
async function tickStep(timers, ms = 5) {
  timers.tick(ms);
  await Promise.resolve();
  await Promise.resolve();
}

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
  assert.deepEqual({ ...fetchImpl.calls[0].options.headers }, { 'content-type': 'application/json' });
  assert.equal(fetchImpl.calls[0].options.body, '{"a":1}');
});

test('should_reject_relative_url_when_request_url_is_not_absolute', async () => {
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

test('should_reject_body_when_request_uses_get_or_head', async () => {
  const fetchImpl = createFakeFetch(() => textResponse('x'));
  const { service } = createHttpService({ config: {}, fetchImpl });

  await assert.rejects(
    () => service.request({ url: 'https://api.example.com/v1/x', method: 'GET', body: 'nope' }),
    (error) => error.code === 'HTTP_INPUT_INVALID',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('should_reject_input_invalid_when_request_fields_are_malformed', async () => {
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

test('should_accept_local_addresses_over_plain_http_when_host_is_defined_local', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  for (const url of LOCAL_URLS) {
    const final = await (await service.request({ url })).done;
    assert.equal(final.ending, 'completed', url);
  }
});

test('should_reject_url_forbidden_when_plain_http_targets_a_non_local_host', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  for (const url of FORBIDDEN_URLS) {
    await assert.rejects(
      () => service.request({ url }),
      (error) => error.code === 'HTTP_URL_FORBIDDEN',
      url,
    );
  }
});

test('should_accept_any_host_when_request_uses_https', async () => {
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

test('should_settle_exactly_one_ending_when_done_is_awaited_repeatedly', async () => {
  const fetchImpl = createFakeFetch(() => textResponse('done'));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.request({ url: 'https://api.example.com/v1/x' });
  const first = await handle.done;
  const second = await handle.done;

  assert.equal(first, second);
  assert.equal(first.ending, 'completed');
});

test('should_reject_input_invalid_through_the_call_promise_when_validation_fails', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  await assert.rejects(
    () => service.request({}),
    (error) => error.code === 'HTTP_URL_INVALID',
  );
});

// --- timeout -------------------------------------------------------------

test('should_report_timeout_when_request_exceeds_its_budget', async (t) => {
  // Mocked clock: the deadline is deterministic, never CI-flaky.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { timeoutMs: 20 }, fetchImpl });

  const handle = await service.request({ url: 'https://api.example.com/v1/x' });
  const settled = handle.done;
  t.mock.timers.tick(20);
  const final = await settled;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});

test('should_use_per_request_timeout_when_it_overrides_the_config_default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { timeoutMs: 60000 }, fetchImpl });

  const handle = await service.request({ url: 'https://api.example.com/v1/x', timeoutMs: 20 });
  const settled = handle.done;
  t.mock.timers.tick(20);
  const final = await settled;

  assert.equal(final.error.code, 'HTTP_TIMEOUT');
  assert.notEqual(final.error.code, 'HTTP_NETWORK_FAILED');
});

// --- network failure and secrecy -----------------------------------------

test('should_report_network_failed_without_secrets_when_the_server_is_unreachable', async () => {
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

test('should_map_unknown_throwables_to_request_failed_when_fetch_throws', async () => {
  const fetchImpl = createFakeFetch(() => { throw new Error('something odd'); });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/v1/x' })).done;

  assert.equal(final.error.code, 'HTTP_REQUEST_FAILED');
});

// --- streaming -----------------------------------------------------------

test('should_reach_the_structured_input_error_when_the_onChunk_getter_throws', async () => {
  // Reading handlers.onChunk runs a caller getter: a throwing one must be
  // structured HTTP_INPUT_INVALID, never a raw rejection carrying the
  // caller's text (round-10 P1, third poisoned-read site).
  const { service } = createHttpService({ config: {}, fetchImpl: async () => { throw new Error('unused'); } });
  await assert.rejects(
    () => service.stream({ url: 'https://example.com/a' }, { get onChunk() { throw new Error('caller text'); } }),
    (error) => error.code === 'HTTP_INPUT_INVALID' && error.type === 'operational',
  );
});

test('should_deliver_chunks_in_order_when_the_stream_completes', async (t) => {
  // Mocked clock: the fake reader paces its chunks with setTimeout, so the
  // delivery order is deterministic without wall-clock sleeps.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [];
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('ب'), bytes('c')]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) });
  const settled = handle.done;
  for (let step = 0; step < 6; step += 1) {
    await tickStep(t.mock.timers, 5);
  }
  const final = await settled;

  assert.equal(final.ending, 'completed');
  assert.equal(final.status, 200);
  assert.equal(final.body, undefined);
  assert.deepEqual(received, [bytes('a'), bytes('ب'), bytes('c')]);
});

test('should_deliver_raw_bytes_undecoded_even_when_multibyte_char_is_split', async (t) => {
  const received = [];
  const full = bytes('سلام');
  // The two bytes of "س" (0xD8 0xB3) are deliberately torn apart.
  const fetchImpl = createFakeFetch(streamResponder([full.slice(0, 1), full.slice(1)]));
  const { service } = createHttpService({ config: {}, fetchImpl });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) });
  const settled = handle.done;
  for (let step = 0; step < 6; step += 1) {
    await tickStep(t.mock.timers, 5);
  }
  await settled;

  assert.deepEqual(concatBytes(received), full);
  assert.equal(new TextDecoder().decode(concatBytes(received)), 'سلام');
});

test('should_deliver_body_instead_of_stream_when_the_status_is_an_error', async () => {
  const received = [];
  const fetchImpl = createFakeFetch(() => textResponse('unauthorized', { status: 401 }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(final.status, 401);
  assert.deepEqual(new TextDecoder().decode(final.body), 'unauthorized');
  assert.deepEqual(received, []);
});

test('should_report_cancelled_and_no_further_chunks_when_cancelled_mid_stream', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [];
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')], { delayMs: 30 }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: (chunk) => received.push(chunk) });
  await tickStep(t.mock.timers, 30);
  handle.cancel();
  const settled = handle.done;
  const final = await settled;

  assert.equal(final.ending, 'cancelled');
  const countAtCancel = received.length;
  for (let step = 0; step < 6; step += 1) {
    await tickStep(t.mock.timers, 30);
  }
  assert.equal(received.length, countAtCancel, 'no chunk may arrive after the cancel');
});

test('should_report_stream_interrupted_when_body_reader_fails_midway', async () => {
  const fetchImpl = createFakeFetch(streamResponderCutAfterFirst([bytes('a'), bytes('b')]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_STREAM_INTERRUPTED');
});

test('should_report_timeout_when_no_data_arrives_within_idle_budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { streamIdleTimeoutMs: 20 }, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} });
  const settled = handle.done;
  t.mock.timers.tick(20);
  const final = await settled;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});

test('should_use_request_timeout_as_idle_budget_when_stream_overrides_it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = createFakeFetch(hangingResponder());
  const { service } = createHttpService({ config: { streamIdleTimeoutMs: 60000 }, fetchImpl });

  // The documented behavior: a per-request timeoutMs doubles as the idle
  // budget for streaming, so a hung stream honors the caller's budget.
  const handle = await service.stream({ url: 'https://api.example.com/v1/x', timeoutMs: 25 }, { onChunk: () => {} });
  const settled = handle.done;
  t.mock.timers.tick(25);
  const final = await settled;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});

test('should_keep_active_streams_alive_when_chunks_keep_rearming_the_idle_timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A reader that delivers one chunk per clock step, forever — a healthy
  // slow stream must never be cut by its own idle timer.
  let reads = 0;
  const endlessResponder = () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/event-stream']]),
    body: {
      getReader() {
        return {
          read: async () => {
            reads += 1;
            return { done: false, value: bytes('x') };
          },
          cancel: async () => {},
        };
      },
    },
  });
  const fetchImpl = createFakeFetch(endlessResponder);
  const { service } = createHttpService({ config: { streamIdleTimeoutMs: 20 }, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} });
  for (let step = 0; step < 5; step += 1) {
    t.mock.timers.tick(10);
    await Promise.resolve();
  }

  assert.equal(reads >= 3, true, 'chunks kept flowing across idle re-arms');
  assert.notEqual(handle.done, null);
  handle.cancel();
  await handle.done;
});

test('should_reject_input_invalid_when_stream_has_no_chunk_handler', async () => {
  const { service } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  await assert.rejects(
    () => service.stream({ url: 'https://api.example.com/v1/x' }, {}),
    (error) => error.code === 'HTTP_INPUT_INVALID',
  );
});

// --- redirect policy -----------------------------------------------------

test('should_follow_same_origin_redirect_up_to_the_cap_when_hops_stay_allowed', async () => {
  const fetchImpl = createFakeFetch(redirectResponder(2, { final: textResponse('arrived') }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(new TextDecoder().decode(final.body), 'arrived');
  assert.equal(fetchImpl.calls.length, 3);
});

test('should_refuse_cross_origin_redirect_and_name_the_destination_when_hop_leaves_the_origin', async () => {
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

test('should_refuse_https_to_plain_http_redirect_when_the_target_is_not_local', async () => {
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

test('should_refuse_redirect_when_hops_exceed_the_allowed_cap', async () => {
  const fetchImpl = createFakeFetch(redirectResponder(0, { loop: true }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_REDIRECT_FORBIDDEN');
});

test('should_reissue_303_as_get_without_body_when_method_carries_one', async () => {
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

test('should_keep_method_and_body_when_a_post_is_redirected_with_307_and_308_in_manual_mode', async () => {
  // The security rationale of the redirect policy rests on 307/308: a
  // private body IS replayed on a same-origin 307/308 — the manual loop
  // must not rewrite the method or drop the body for them.
  for (const status of [307, 308]) {
    const fetchImpl = createFakeFetch((url, options) => {
      if (url.endsWith('/start')) {
        return {
          ok: false,
          status,
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

    assert.equal(final.ending, 'completed', String(status));
    assert.equal(fetchImpl.calls[1].options.method, 'POST', String(status));
    assert.equal(fetchImpl.calls[1].options.body, 'private-text', String(status));
    assert.equal(fetchImpl.calls[1].url, 'https://api.example.com/next', String(status));
  }
});

test('should_reissue_301_and_302_of_a_post_as_get_without_body_when_redirecting_in_manual_mode', async () => {
  // The manual loop mirrors the platform's follow behavior: a 301/302
  // answered for POST re-issues as GET without a body, so a private body is
  // never replayed onto the redirected address and both redirect modes
  // behave identically.
  for (const status of [301, 302]) {
    const fetchImpl = createFakeFetch((url, options) => {
      if (url.endsWith('/start')) {
        return {
          ok: false,
          status,
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

    assert.equal(final.ending, 'completed', String(status));
    assert.equal(fetchImpl.calls[1].options.method, 'GET', String(status));
    assert.equal(fetchImpl.calls[1].options.body, undefined, String(status));
    assert.equal(fetchImpl.calls[1].url, 'https://api.example.com/next', String(status));
  }
});

test('should_release_the_body_of_a_refused_cross_origin_redirect_before_the_policy_error', async () => {
  // The rejection paths run BEFORE the old releaseBody call: a refused hop
  // must still release its 30x body, or the connection hangs until GC.
  let released = false;
  const fetchImpl = createFakeFetch((url) => {
    if (url.endsWith('/start')) {
      return {
        ok: false,
        status: 302,
        headers: new Map([['location', 'https://elsewhere.test/x']]),
        arrayBuffer: async () => new Uint8Array().buffer,
        body: { cancel: () => { released = true; } },
      };
    }
    return textResponse('arrived');
  });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_REDIRECT_FORBIDDEN');
  assert.equal(released, true, 'the refused hop body was released');
});

test('should_release_every_body_when_a_redirect_loop_exceeds_the_hop_cap', async () => {
  // The release-before-rejection rule covers the hop-cap path: every
  // surplus hop's 30x body is released, none holds a connection to GC.
  let released = 0;
  const loopResponse = () => ({
    ok: false,
    status: 302,
    headers: new Map([['location', '/next']]),
    arrayBuffer: async () => new Uint8Array().buffer,
    body: { cancel: () => { released += 1; } },
  });
  const fetchImpl = createFakeFetch(() => loopResponse());
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_REDIRECT_FORBIDDEN');
  assert.ok(released >= 5, `every surplus hop body was released (released: ${released})`);
});

test('should_release_the_body_when_a_redirect_location_is_unusable', async () => {
  // An unusable Location (plain-http public target) refuses the hop — the
  // 30x body must still be released before the error.
  let released = false;
  const fetchImpl = createFakeFetch((url) => {
    if (url.endsWith('/start')) {
      return {
        ok: false,
        status: 302,
        headers: new Map([['location', 'http://public.example.com/x']]),
        arrayBuffer: async () => new Uint8Array().buffer,
        body: { cancel: () => { released = true; } },
      };
    }
    return textResponse('arrived');
  });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/start' })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_URL_FORBIDDEN');
  assert.equal(released, true, 'the refused hop body was released');
});

// --- lifecycle -----------------------------------------------------------

test('should_reject_service_unavailable_when_called_after_deactivation', async () => {
  const { service, deactivate } = createHttpService({ config: {}, fetchImpl: createFakeFetch(() => textResponse('x')) });

  deactivate();

  await assert.rejects(() => service.request({ url: 'https://api.example.com/v1/x' }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  await assert.rejects(() => service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  const text = await service.getText('docs/x.md');
  assert.equal(text.code, 'SERVICE_UNAVAILABLE');
});

test('should_end_in_flight_stream_as_interrupted_when_deactivated_mid_stream', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')], { delayMs: 30 }));
  const { service, deactivate } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream({ url: 'https://api.example.com/v1/x' }, { onChunk: () => {} });
  await tickStep(t.mock.timers, 30);
  deactivate();

  const final = await handle.done;
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
});

// --- concurrency ---------------------------------------------------------

test('should_run_concurrent_transfers_independently_when_cancel_one_of_two', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [];
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')], { delayMs: 5 }));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const cancelledHandle = await service.stream({ url: 'https://api.example.com/v1/cancelled' }, { onChunk: () => {} });
  const liveHandle = await service.stream(
    { url: 'https://api.example.com/v1/live' },
    { onChunk: (chunk) => received.push(chunk) },
  );

  cancelledHandle.cancel();
  const cancelledFinal = await cancelledHandle.done;
  for (let step = 0; step < 6; step += 1) {
    await tickStep(t.mock.timers, 5);
  }
  const liveFinal = await liveHandle.done;

  assert.equal(cancelledFinal.ending, 'cancelled');
  assert.equal(liveFinal.ending, 'completed', 'cancelling one transfer must not touch the other');
  assert.deepEqual(concatBytes(received), bytes('abc'));
});

test('should_settle_both_concurrent_transfers_when_they_complete_together', async () => {
  const responses = [textResponse('first'), textResponse('second')];
  const fetchImpl = createFakeFetch(() => {
    const responder = responses.shift();
    if (responder === undefined) {
      throw new Error('unexpected fetch call');
    }
    return responder;
  });
  const { service } = createHttpService({ config: {}, fetchImpl });

  const firstHandle = await service.request({ url: 'https://api.example.com/v1/a' });
  const secondHandle = await service.request({ url: 'https://api.example.com/v1/b' });
  const [first, second] = await Promise.all([firstHandle.done, secondHandle.done]);

  assert.equal(first.ending, 'completed');
  assert.equal(second.ending, 'completed');
  assert.equal(new TextDecoder().decode(first.body), 'first');
  assert.equal(new TextDecoder().decode(second.body), 'second');
});

// --- redirect body hygiene -----------------------------------------------

test('should_release_intermediate_body_before_following_redirect', async () => {
  let released = false;
  const redirectResponse = {
    ok: false,
    status: 302,
    headers: new Map([['location', '/v1/final']]),
    body: {
      cancel: async () => {
        released = true;
      },
    },
  };
  const fetchImpl = createFakeFetch((url) => (url.endsWith('/v1/start') ? redirectResponse : textResponse('final body')));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (await service.request({ url: 'https://api.example.com/v1/start' })).done;

  assert.equal(final.ending, 'completed');
  assert.equal(new TextDecoder().decode(final.body), 'final body');
  assert.equal(released, true, 'the intermediate 30x body must be released, not held until GC');
});

test('should_report_request_failed_when_chunk_handler_throws', async () => {
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b')]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const final = await (
    await service.stream(
      { url: 'https://api.example.com/v1/x' },
      { onChunk: () => { throw new Error('consumer bug'); } },
    )
  ).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_REQUEST_FAILED', 'a handler bug is not a stream interruption');
  assert.deepEqual(final.error.detail, { stage: 'chunk-handler' });
});

test('should_report_request_failed_and_never_reject_unhandled_when_an_async_chunk_handler_fails', async () => {
  // Round-13 P1 regression: an ASYNC receiving handler reports its failure
  // as a rejected Promise, not a throw. The old call ignored the return
  // value, so the rejection escaped as unhandledRejection (Node's default
  // mode KILLS the host process) while the stream reported `completed`.
  // A thenable failure takes the same documented chunk-handler path.
  const unhandled = [];
  const previousListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
  try {
    const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')]));
    const { service } = createHttpService({ config: {}, fetchImpl });

    const final = await (
      await service.stream(
        { url: 'https://api.example.com/v1/x' },
        { onChunk: async () => { throw new Error('async consumer bug'); } },
      )
    ).done;
    // Let any stray rejection surface before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(final.ending, 'interrupted');
    assert.equal(final.error.code, 'HTTP_REQUEST_FAILED', 'an async handler bug is the same handler bug');
    assert.deepEqual(final.error.detail, { stage: 'chunk-handler' });
    assert.equal(unhandled.length, 0, 'no unhandledRejection may escape the plugin');
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of previousListeners) {
      process.on('unhandledRejection', listener);
    }
  }
});

test('should_deliver_the_next_chunk_only_after_the_async_handler_settles_when_backpressure_is_applied', async () => {
  // Round-13 semantics, locked by round 14: an async handler's promise is
  // awaited, so the next chunk is read only after it settles — the
  // handler applies real backpressure (documented in the reference).
  const handled = [];
  let resolveFirst = null;
  const fetchImpl = createFakeFetch(streamResponder([bytes('a'), bytes('b'), bytes('c')]));
  const { service } = createHttpService({ config: {}, fetchImpl });

  const handle = await service.stream(
    { url: 'https://api.example.com/v1/x' },
    {
      onChunk: (chunk) => {
        handled.push(new TextDecoder().decode(chunk));
        if (handled.length === 1) {
          return new Promise((resolve) => { resolveFirst = resolve; });
        }
      },
    },
  );
  // Deterministic bounded wait: the first chunk has been handed to the
  // handler (whose promise is parked), and chunk two has NOT been read.
  for (let i = 0; i < 200 && handled.length < 1; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ['a'], 'chunk two waits behind the unsettled handler promise');
  resolveFirst();
  const final = await handle.done;

  assert.equal(final.ending, 'completed');
  assert.deepEqual(handled, ['a', 'b', 'c'], 'the stream resumed in order after the settle');
});

test('should_end_interrupted_by_the_handler_budget_when_a_thenable_never_settles', async () => {
  // Round-14 regression: a never-settling handler promise used to hang
  // `done` FOREVER — the idle timer and abort only reach reader.read(),
  // and neither cancel() nor deactivate() could settle the transfer. The
  // handler await now races its own budget (the request timeoutMs), so the
  // transfer ends interrupted with the handler-stage code.
  const fetchImpl = createFakeFetch(streamResponder([bytes('a')]));
  const { service } = createHttpService({ config: { streamIdleTimeoutMs: 50 }, fetchImpl });

  const final = await (
    await service.stream(
      { url: 'https://api.example.com/v1/x' },
      { onChunk: () => new Promise(() => {}) },
    )
  ).done;

  // The idle timer aborts on its budget; the abort settles the handler
  // race, and the timedOut flag maps the ending to HTTP_TIMEOUT — a
  // bounded ending, never a silent hang.
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_TIMEOUT');
});
