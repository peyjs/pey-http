# pey.http — Reference

Self-contained reference for the `pey.http` transport plugin. The manifest (`manifest.json`) is always the authoritative contract; this document explains it.

## Purpose

Moves text documents over HTTP for the host application. It fetches same-origin relative URLs and returns their bodies as text. It does not parse, validate, or interpret document content — that belongs to the product plugin consuming this service.

## Structure

- `manifest.json` — plugin contract (identity, service, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin name, service name, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/http-service.js` — the HTTP text document service.
- `tests/http-service.test.js` — service behavior with a fake fetch.
- `tests/entry.test.js` — lifecycle wiring and manifest contract.

## Dependencies

- **Required:** none.
- **Optional:** none.

## Public API

The service `pey.http.service` provides one method.

### `getText(url)`

Fetches a text document with GET and resolves to `{ status, body }`. Every failure resolves to a standard Bonyan error object (never a thrown raw error, never a rejected promise).

```js
const result = await httpService.getText('docs/guide.md');

if (result.code !== undefined) {
  // standard Bonyan error: result.code, result.message, result.source, result.type
  return;
}

console.log(result.status); // 200
console.log(result.body);   // '# راهنما ...'
```

- `url` must be a relative URL on the application origin. Absolute URLs, URLs with a scheme, and URLs containing a fragment are rejected with `HTTP_URL_INVALID` before any request is sent.
- `redirect: 'error'` is used, so a redirecting document fails with `HTTP_REQUEST_FAILED`.
- The request has a configurable timeout (`timeoutMs`); a timeout or network failure returns `HTTP_REQUEST_FAILED`.

## Events

The plugin publishes no events.

## Errors Reference

| Code | Situation | Type |
|---|---|---|
| `HTTP_URL_INVALID` | The URL is not a string, is empty, is absolute, carries a scheme, or contains a fragment. | operational |
| `HTTP_NOT_FOUND` | The server responded 404. | operational |
| `HTTP_REQUEST_FAILED` | Network failure, timeout, redirect, non-2xx status (other than 404), or an unreadable body. | operational |
| `HTTP_MEDIA_TYPE_UNEXPECTED` | The response `Content-Type` is present and not in `acceptedMediaTypes`. | operational |
| `SERVICE_UNAVAILABLE` | The plugin has been deactivated or shut down; the method call is refused. | operational |

## Config

| Key | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `acceptedMediaTypes` | `string[]` | No | `['text/markdown', 'text/plain', 'text/html']` | Allowed response media types (an absent Content-Type is always accepted). |
| `timeoutMs` | `number` | No | `15000` | Request timeout in milliseconds. |

## Business Rules

- Only same-origin relative URLs are accepted; anything else is refused before a request is made.
- A 404 is reported as its own error code so callers can distinguish "document missing" from "transport broken".
- Media-type checking protects the viewer: a server returning unexpected content is refused rather than rendered.
- Raw network errors never leave the plugin boundary; they are converted to the standard Bonyan error structure with a safe message.

## Constraints

- Do not use this service for binary downloads or APIs expecting JSON parsing — it is a text document transport only.
- Do not rely on error `message` text; branch on `code`.
- This plugin must not gain document-parsing or business logic; content interpretation belongs to the product plugin.
