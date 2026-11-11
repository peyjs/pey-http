# Changelog

## [2.1.0] - 1405-08-17

Round-2 through round-7 review fixes (all unpublished; one release). MINOR: one behavior change plus a packaging-level removal.

### Changed

- **Invalid configuration now fails startup** instead of being silently replaced: a present but unusable `timeoutMs` / `streamIdleTimeoutMs` / `acceptedMediaTypes` throws `HTTP_INPUT_INVALID` (type `startup`, with the offending value in `detail`). Absent values and an empty `acceptedMediaTypes` array still take the defaults.
- **Package exports tightened** to the public surface (`.` / `manifest.json` / `package.json`); the five previously exported `./lib/*` paths are gone — import the service, not its internals.
- The redirect loop's method rewrite now mirrors the platform's follow behavior: a 301/302 answered for POST (and any non-HEAD on 303) re-issues as GET without a body, so both redirect modes behave identically and a private body is never replayed onto the redirected address (documented in the reference).
- The manual-redirect capability is injectable: `createHttpService({ supportsManualRedirects })` forces either mode for tests and exotic hosts (documented; covered by both injection tests).

### Fixed

- The prepare entry passes structured startup errors through with their code and detail intact (a broken config key is diagnosable from the host log); only truly raw errors are normalized to `HTTP_TRANSPORT_UNAVAILABLE` (entry test added).
- `tests/transfer.test.js` added: per-source unit coverage of `normalizeConfig` (fail-loud startup policy, defaults) and `normalizeTransferInput` (url/method/header/body boundaries).
- Dedicated tests for the 301/302 POST→GET rewrite (both statuses, manual mode) and its follow-mode counterpart (the environment performs the rewrite there).
- The body of an intermediate 30x is released BEFORE the hop-cap and policy-refusal paths too — a refused redirect (the security policy's main path) used to hold its connection until garbage collection, the same leak the follow path fixed in 2.0.1 (regression test added).
- The fail-loud policy now covers `acceptedMediaTypes` ELEMENTS: a non-string or empty entry fails startup with `HTTP_INPUT_INVALID` instead of silently coercing into a list that accepts nothing (regression test added).
- The dead `PLUGIN_VERSION` constant is gone (the manifest is the single version source); the `supportsManualRedirects` option is documented in both factory JSDocs; the reference structure lists `tests/transfer.test.js` and the errors table reflects the `startup` face of `HTTP_INPUT_INVALID`.
- `acceptedMediaTypes` entries are TRIMMED at intake (matching the header-side comparison): a padded entry like `' text/html '` previously passed validation yet matched no real Content-Type, silently making `getText` refuse everything; the Config table documents the element-level rule; two more release-before-rejection tests lock the hop-cap and unusable-Location paths (99 tests).
- Parameterized `acceptedMediaTypes` entries (`'text/html; charset=utf-8'` — the most common way servers write a Content-Type) now FAIL STARTUP instead of passing validation yet matching nothing: `extractMediaType` compares the header's parameter-free media type, so such an entry was the same silent "list that accepts nothing" class as a blank one (documented in the Config table; tests added). And the fail-loud path itself can no longer die raw: rendering a config value into `detail.value` is wrapped, so a poisoned `toString` still reaches `HTTP_INPUT_INVALID` with the same code/type/detail instead of being downgraded by the entry point to a detail-less `HTTP_TRANSPORT_UNAVAILABLE` (tests added).
- Dedicated 307/308 tests: a POST body is replayed on a same-origin 307/308 in manual mode (the security rationale's other half), and follow mode hands method and body untouched to the environment; `null` config values are documented and locked as "absent" (defaults); the new 301/302 test name follows the `should_..._when_...` convention (96 tests).

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
