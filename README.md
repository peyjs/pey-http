# pey.http

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-2.1.0-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## Purpose

Transport plugin of the Pey ecosystem: moves requests out and responses back without interpreting them — plain requests, raw-byte progressive responses, per-request cancellation and timeouts. Keeps the legacy same-origin `getText` document fetch on the same core.

## Structure

- `docs/requirements.md` — requirements; the construction source of truth.
- `manifest.json` — plugin contract (identity, service, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin names, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/local-url.js` — the plain-http local-address rule.
- `lib/redirects.js` — the redirect policy decisions.
- `lib/http-service.js` — the transport service (request, stream, getText).
- `lib/transfer.js` — the transfer machinery (input, redirect loop, flow endings).
- `tests/` — unit tests (`node:test`, fake fetch only).

## Dependencies

- **Required:** none.
- **Optional:** none.

## See Also

- [docs/requirements.md](docs/requirements.md) for the "what and why", written before the implementation.
- [docs/reference.md](docs/reference.md) for the full API, events, errors, config, business rules, and constraints.
