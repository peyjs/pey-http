# Changelog

## [2.1.0] - 1405-08-17

Round-2 through round-19 review fixes (all unpublished; one release). MINOR: one behavior change plus a packaging-level removal.

### Changed

- **Invalid configuration now fails startup** instead of being silently replaced: a present but unusable `timeoutMs` / `streamIdleTimeoutMs` / `acceptedMediaTypes` (non-string, blank, padded or parameterized entries included) throws `HTTP_INPUT_INVALID` with the offending value; the media-type pattern uses the full RFC 7230 token charset. Absent values and an empty array still take the defaults.
- **Package exports tightened** to the public surface (`.` / `manifest.json` / `package.json`); the previously exported `./lib/*` paths are gone — import the service, not its internals.
- The redirect loop's method rewrite mirrors the platform's follow behavior: a 301/302 answered for POST (and any non-HEAD on 303) re-issues as GET without a body in both redirect modes; intermediate 30x bodies are released before every refusal path.
- The manual-redirect capability is injectable: `createHttpService({ supportsManualRedirects })` forces either mode for tests and exotic hosts.

### Fixed

- **Poisoned-input containment**: every property read on caller input — request fields, the headers object and its enumeration, configuration keys, array elements, timeouts — and every render of a caller value into an error detail is guarded; failures cross as structured `HTTP_INPUT_INVALID` (startup for configuration, operational for requests) naming the broken field, never as a raw code-less rejection or a detail-less `HTTP_TRANSPORT_UNAVAILABLE` downgrade.
- **Header fidelity**: the header container is null-prototype (a declared `__proto__` header survives at the plugin boundary — undici-based runtimes drop it before the wire, documented); platform containers (`Headers`/`Map`/`URLSearchParams`) are read through the built-in prototype `entries` applied via `Reflect` — an own `entries()` never shadows it, cross-realm Maps included; a positive brand whose slot probe fails (a transparent Proxy over a real container) is refused with the loud structured error; a Symbol value is refused instead of coerced to the lying `'Symbol(v)'`, while ordinary non-strings stringify as documented.
- **Header/method validation before any byte leaves**: names and the method must be RFC 7230 tokens, values must stay inside the field-content set (TAB, printable ASCII, the full obs-text range); rejections carry the header's POSITION, never its name or value, so a caller typo can no longer surface as `HTTP_NETWORK_FAILED` ("the server was unreachable").
- **Async receiving handler**: `onChunk` may return a promise — it is awaited (real backpressure: the next chunk is read only after it settles), a rejection takes the documented handler-stop path (`HTTP_REQUEST_FAILED`, `stage: 'chunk-handler'`), a never-settling promise is cut by the idle budget (`HTTP_TIMEOUT`), and no unhandled rejection can escape and kill the host process.
- Reference and error-table sync for all of the above (122 tests).

## [2.0.1] - 1405-08-15

Review-fix release; no contract change.

### Fixed

- Intermediate redirect responses are released (`body.cancel()`) before the next hop — an unread 30x body held its connection until garbage collection.
- A throwing `onChunk` handler now ends the stream as `HTTP_REQUEST_FAILED` with `detail.stage: 'chunk-handler'` instead of a misleading `HTTP_STREAM_INTERRUPTED`, and the reader is always released (`finally`) on every exit path.
- `getText` redirects actually work now: the relative document URL resolves against the environment origin before the transfer, so the redirect loop's same-origin checks see absolute addresses (previously any redirect on a `getText` request was refused as an unusable Location).
- `getText('?a:b')` is accepted — the scheme heuristic no longer reads the query as a scheme.
- Numeric-string config values (`timeoutMs: "60000"` from environment sources) are converted instead of silently ignored.
- `redactUrl` keeps relative addresses (minus query/fragment) instead of an empty string in network error messages.

### Changed

- Transfer execution moved to `lib/transfer.js`; `HTTP_TRANSPORT_UNAVAILABLE` is a declared constant and listed in the errors reference.
- Timeout tests run on `t.mock.timers`; per-source test files added (`local-url`, `redirects`, `error`); new tests for concurrent transfers with independent cancel, same-origin `getText` redirect, intermediate-body release, handler-error mapping, request-timeout-as-idle-budget and idle re-arming; test names normalized to `should_…_when_…` (74 tests).

## [2.0.0] - 1405-08-13

Breaking redesign of the transport contract per the new `docs/requirements.md` (the generic outbound transport needed by the chat/voice capability stack), while keeping the legacy text-document fetch working on the same core.

### Added

- `request(input)`: arbitrary method/headers/body transfer returning `{ status, headers, body: Uint8Array }`; a server error status is an ordinary result, never an error.
- `stream(input, { onChunk })`: progressive delivery of raw ordered byte chunks, undecoded (a multi-byte character split across chunks stays intact); an error status never starts a stream.
- Per-request cancellation through the shared flow pattern: every operation returns a handle (`cancel()` + `done`) whose result states exactly one of three endings — completed, interrupted, cancelled; no data is delivered after a cancel.
- Timeouts: whole-request budget for `request`, no-data idle budget for `stream` (defaults configurable, per-request override).
- The plain-http local-address rule: plain http only for localhost, loopback and private ranges (IPv4 and IPv6); IPv4-mapped IPv6 and `.local` names rejected.
- The redirect policy: same-origin redirects followed up to five hops; cross-origin and https→plain-http (non-local) redirects refused with the destination origin named; 303 re-issued as GET without a body. Best-effort in a browser, which cannot control redirect steps (documented).
- New error codes: `HTTP_URL_FORBIDDEN`, `HTTP_REDIRECT_FORBIDDEN`, `HTTP_INPUT_INVALID`, `HTTP_NETWORK_FAILED`, `HTTP_TIMEOUT`, `HTTP_STREAM_INTERRUPTED`.

### Changed

- **Breaking:** `getText` error codes for network failures — delivery failures now surface as `HTTP_NETWORK_FAILED` / `HTTP_TIMEOUT` in the transport methods; `getText` keeps its original fold-into-`HTTP_REQUEST_FAILED` contract. `getText` now follows same-origin redirects (up to the cap) instead of refusing all redirects.
- **Breaking:** config `timeoutMs` default is 60000 (was 15000) and `streamIdleTimeoutMs` was added.
- Input-validation and availability failures reject the `request`/`stream` call with the standard structured error; mid-stream failures of any kind always end as `interrupted`, never as a hang or a fake completion.
- `request`/`stream` are async methods; the handle arrives after awaiting the call.

## [1.0.0] - 1405-08-08

Initial pey release: same-origin text document transport — `getText(url)` returning `{ status, body }` on success or a standard Bonyan error on failure (`HTTP_URL_INVALID`, `HTTP_NOT_FOUND`, `HTTP_REQUEST_FAILED`, `HTTP_MEDIA_TYPE_UNEXPECTED`, `SERVICE_UNAVAILABLE`), configurable `acceptedMediaTypes` and `timeoutMs`, redirects refused, injectable fetch for tests, and `docs/requirements.md` as the construction source of truth.

> Derived from the `shirazeh.http` plugin (Shirazeh, incubated as 0.1.0): renamed to `pey.http` / `pey.http.service` and generalized to the host application. That history stays with the source project — the pey release lineage starts here.
