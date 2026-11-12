# pey.http — Reference

Self-contained reference for the `pey.http` transport plugin. The manifest (`manifest.json`) is always the authoritative contract; this document explains it.

## Purpose

Moves requests out and responses back without interpreting them. The caller owns the address, method, headers and body; the plugin transfers bytes. A server error status (401, 429, 500, …) is an ordinary result — the caller interprets it. Errors only mean the delivery itself failed. The legacy same-origin `getText` document fetch (this plugin's origin) rides on the same core as a convenience method.

## Structure

- `manifest.json` — plugin contract (identity, service, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin name, service name, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/local-url.js` — the plain-http local-address rule.
- `lib/redirects.js` — the redirect policy decisions.
- `lib/http-service.js` — the transport service (request, stream, getText).
- `lib/transfer.js` — the transfer machinery: input normalization, config, the redirect loop and the shared-flow endings.
- `tests/transport.test.js` — transport contract behavior with a fake fetch.
- `tests/http-service.test.js` — legacy `getText` behavior with a fake fetch.
- `tests/local-url.test.js` — the local-address policy unit tests.
- `tests/redirects.test.js` — the redirect policy unit tests.
- `tests/error.test.js` — the boundary error factory unit tests.
- `tests/transfer.test.js` — per-source unit coverage of `normalizeConfig` (the fail-loud startup policy) and `normalizeTransferInput` (url/method/header/body boundaries).
- `tests/entry.test.js` — lifecycle wiring and manifest contract.

## Dependencies

- **Required:** none.
- **Optional:** none.

## Public API

The service `pey.http.service` provides three methods. `request` and `stream` follow the shared flow pattern: the caller passes data handlers (stream only) and receives a handle `{ cancel, done }`. `done` never rejects and resolves exactly one of three endings:

- `{ ending: 'completed', status, headers, body? }` — the transfer finished; `body` (a `Uint8Array`) is present for `request` always, and for `stream` only when the stream never started (error status).
- `{ ending: 'interrupted', error }` — delivery failed; `error` is the standard structured Bonyan error (network, timeout, mid-stream cut, refused redirect).
- `{ ending: 'cancelled' }` — the caller cancelled; no data was delivered after the cancel.

Input-validation and availability failures reject the method call itself with the standard structured error — nothing raw ever crosses the boundary.

### `request(input)`

`input`: `{ url, method?, headers?, body?, timeoutMs? }`.

```js
const handle = await http.request({
  url: 'https://api.example.com/v1/chat/completions',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
const final = await handle.done;
if (final.ending === 'completed') {
  const text = new TextDecoder().decode(final.body);
}
```

- `url` must be an absolute `https` URL, or plain `http` to one of the defined local addresses (see below).
- `headers` values are stringified as given; the plugin never adds, removes or logs a header. Header NAMES and the `method` must be valid HTTP tokens (RFC 7230) and values must not contain line breaks — malformed ones are refused with `HTTP_INPUT_INVALID` before anything is sent (the error names the header's position, never its content); a declared `__proto__` header is kept like any other AT THE PLUGIN BOUNDARY — but undici-based runtimes (Node's fetch, and browsers that route header records the same way) drop it before the wire in every form (record or pairs), a runtime limitation outside the plugin's control; a runtime that must carry this header needs a transport that does not filter it.

### `stream(input, { onChunk })`

Same input; on a success status the body is delivered as ordered raw `Uint8Array` chunks through `onChunk`, undecoded — a multi-byte character split across chunks stays intact and decoding is the caller's job (e.g. `TextDecoder` with `{ stream: true }`). For an error status no stream starts; the status and body arrive as a completed result. The timeout applies to the interval with no incoming data, so a long but active response is never cut.

```js
const decoder = new TextDecoder();
const handle = await http.stream(input, {
  onChunk: (chunk) => feed(decoder.decode(chunk, { stream: true })),
});
const final = await handle.done;
```

### `getText(url)` — legacy

The original text-document contract, kept unchanged for its consumers: GETs a same-origin **relative** URL and resolves to `{ status, body: string }`, or resolves to the standard error object (never throws, never rejects). Absolute URLs, scheme-bearing URLs and fragments are `HTTP_URL_INVALID`; 404 is `HTTP_NOT_FOUND`; the content type is checked against `acceptedMediaTypes`. Unlike version 1, a same-origin redirect is now followed (up to the cap) instead of failing.

## The plain-http local-address rule

Plain `http` is accepted only for hosts that are provably local, so a local model server works while arbitrary plaintext traffic stays impossible:

- `localhost`, loopback `127.0.0.0/8` and `::1`
- private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- IPv6 unique-local `fc00::/7` and link-local `fe80::/10`

Rejected over plain http: any public address, IPv4-mapped IPv6 forms (`::ffff:a.b.c.d` — they route as plain IPv4), and names like `something.local` (a name cannot be trusted as local without resolving it). `https` is allowed for any host.

## Redirect policy

With step-by-step redirect control (non-browser environments): a redirect is followed only within the same origin, at most five hops. A cross-origin redirect — even https to https — is refused with `HTTP_REDIRECT_FORBIDDEN`, naming the destination origin (no query) so the caller can enter the final address directly, because the request body (private text) is re-sent on 307/308. An https→plain-http hop to a non-local host is refused with `HTTP_URL_FORBIDDEN`. The method rewrite mirrors the platform's follow behavior so both redirect modes behave identically: a 303 (any non-HEAD) and a 301/302 answered for POST re-issue as GET without a body — a private body is never replayed onto the redirected address.

**Browser limitation (documented per the requirements):** a browser cannot control redirect steps (`redirect: 'manual'` yields opaque responses), so there the environment's own redirect behavior applies and the rules above cannot be enforced. Everywhere else they are enforced.

**Injected override (for tests and exotic hosts):** `createHttpService({ supportsManualRedirects })` forces the mode — `true` enables the step-by-step loop above even where environment detection would choose `follow`, and `false` hands redirect handling to the environment's `redirect: 'follow'` even on Node. Unset, the mode is detected from the environment.

## Events

The plugin publishes no events.

## Errors Reference

| Code | Situation | Type |
|---|---|---|
| `HTTP_URL_INVALID` | Malformed or (for `request`/`stream`) non-absolute URL; for `getText`, an absolute, scheme-bearing or fragment-bearing URL. | operational |
| `HTTP_URL_FORBIDDEN` | Plain http to a non-local address, or an https→plain-http redirect to a non-local host. | operational |
| `HTTP_REDIRECT_FORBIDDEN` | Cross-origin redirect, more than five redirects, or an unusable Location header. | operational |
| `HTTP_INPUT_INVALID` | Malformed input (non-object input, bad headers/body/timeout, missing `onChunk`); or a present-but-unusable configuration value (timeouts, `acceptedMediaTypes`) with type `startup` and `detail.value`. | operational / startup |
| `HTTP_NETWORK_FAILED` | The request could not reach the server, or the environment blocked it (in a browser this includes CORS blocks, which cannot be distinguished). | operational |
| `HTTP_TIMEOUT` | The time budget ran out (whole request) or no data arrived within the idle budget (stream). | operational |
| `HTTP_STREAM_INTERRUPTED` | The response stream was cut off before it finished. | operational |
| `HTTP_REQUEST_FAILED` | Any other delivery failure, or the receiving `onChunk` handler threw (detail `stage: 'chunk-handler'`). | operational |
| `HTTP_NOT_FOUND` | `getText` only: the server responded 404. | operational |
| `HTTP_MEDIA_TYPE_UNEXPECTED` | `getText` only: the response Content-Type is present and not in `acceptedMediaTypes`. | operational |
| `SERVICE_UNAVAILABLE` | Called after deactivation/shutdown (thrown for `request`/`stream`, resolved as the error value for `getText`); an in-flight stream ends interrupted with this code. | operational |
| `HTTP_TRANSPORT_UNAVAILABLE` | Startup only: no usable `fetch` implementation exists, or the transport failed to start. | startup |

## Config

| Key | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `timeoutMs` | `number` | No | `60000` | Default whole-request timeout in milliseconds; per-request `timeoutMs` overrides it (and is the idle budget for streams). |
| `streamIdleTimeoutMs` | `number` | No | `60000` | Default no-data interval budget for streams. |
| `acceptedMediaTypes` | `string[]` | No | `['text/markdown', 'text/plain', 'text/html']` | `getText` content-type allow-list (an absent Content-Type is always accepted). A present but non-array value — or an array whose element is a non-string, blank, or anything other than a bare `type/subtype` token pair (parameters, inner spaces, look-alike separators: none of them can ever match the comparison side) — fails startup with `HTTP_INPUT_INVALID`; entries are trimmed and lowercased on intake (never silently replaced). An explicit `null` reads as absent and takes the default (locked by tests). |

## Business Rules

- A server error status is a result, not an error; the caller interprets it.
- After `cancel()` no data is delivered, and the ending is `cancelled` — never a network error.
- Raw bytes are never decoded or transformed for `stream`; chunks arrive strictly in order.
- Headers, body and credentials never appear in errors, logs or events (there are none); error messages carry at most the address without its query.
- The plugin holds no secrets and no state between requests; every request is independent and parallel requests do not interfere.
- A GET/HEAD request with a body is refused (`HTTP_INPUT_INVALID`) before anything is sent.
- `getText` succeeds only on a 2xx response; 404 maps to `HTTP_NOT_FOUND`, every other non-2xx folds into `HTTP_REQUEST_FAILED` (its original contract).
- Startup sends nothing. After deactivation every call is refused, and an in-flight stream ends as interrupted with `SERVICE_UNAVAILABLE`.

## Constraints

- Do not use this service as a key vault or a retry queue; the caller owns authentication and repetition.
- Do not rely on error `message` text; branch on `code`.
- This plugin must not gain content interpretation (SSE parsing, JSON handling) — that belongs to its consumers.
