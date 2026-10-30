# Changelog

All notable changes to `pey.http` are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows the Bonyan architecture rules.

## [0.1.1] - 2026-10-30

### Added

- `docs/requirements.md` — the requirements document, the construction source of truth for the plugin. No behavioral change.

## [0.1.0] - 2026-10-29

Initial pey release, derived from the `shirazeh.http` plugin (Shirazeh, 2026-10-25): renamed to `pey.http` / `pey.http.service` and generalized to the host application; no behavioral changes. The 0.x range marks a plugin whose contract may still change.

### Added

- `pey.http.service` with `getText(url)`: fetches same-origin relative text documents and returns `{ status, body }`; every failure resolves to a standard Bonyan error (`HTTP_URL_INVALID`, `HTTP_NOT_FOUND`, `HTTP_REQUEST_FAILED`, `HTTP_MEDIA_TYPE_UNEXPECTED`, `SERVICE_UNAVAILABLE`).
- Config keys `acceptedMediaTypes` (default `text/markdown`, `text/plain`, `text/html`) and `timeoutMs` (default `15000`).
- Bonyan two-phase entry point (`prepare`/`activate`) with lifecycle hooks assigned during preparation.
- Unit tests (fake fetch, no real network) and the manifest contract test.
