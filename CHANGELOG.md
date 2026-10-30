# Changelog

## [1.0.0] - 2026-10-30

Initial pey release: same-origin text document transport — `getText(url)` returning `{ status, body }` on success or a standard Bonyan error on failure (`HTTP_URL_INVALID`, `HTTP_NOT_FOUND`, `HTTP_REQUEST_FAILED`, `HTTP_MEDIA_TYPE_UNEXPECTED`, `SERVICE_UNAVAILABLE`), configurable `acceptedMediaTypes` and `timeoutMs`, redirects refused, injectable fetch for tests, and `docs/requirements.md` as the construction source of truth.

> Derived from the `shirazeh.http` plugin (Shirazeh, incubated as 0.1.0): renamed to `pey.http` / `pey.http.service` and generalized to the host application. That history stays with the source project — the pey release lineage starts here.
