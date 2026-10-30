# pey.http

## Purpose

Transport plugin of the Pey ecosystem: moves text documents over HTTP. It fetches same-origin relative URLs and returns their bodies; it never interprets document content.

## Structure

- `docs/requirements.md` — requirements; the construction source of truth.
- `manifest.json` — plugin contract (identity, service, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin names, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/http-service.js` — the HTTP text document service.
- `tests/` — unit tests (`node:test`).

## Dependencies

- **Required:** none.
- **Optional:** none.

## See Also

- [docs/requirements.md](docs/requirements.md) for the "what and why", written before the implementation.
- [docs/reference.md](docs/reference.md) for the full API, events, errors, config, business rules, and constraints.
