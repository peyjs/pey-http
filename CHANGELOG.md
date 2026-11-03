# Changelog

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
