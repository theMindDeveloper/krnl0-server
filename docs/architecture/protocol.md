# Protocol 1 — for KRNL0 clients

How the KRNL0 desktop app and the KRNL0 web app talk to a KRNL0 server (Decision S9). Everything is HTTPS; JSON bodies; errors are `{ "error": { "code", "message", ... } }`.

## Authentication

| Client | How | Writes also need |
|---|---|---|
| Web app (same origin) | Cookie `__Host-krnl0` from `POST /api/v1/auth/login` | `X-KRNL0-CSRF: <csrf>` and the browser's `Origin` |
| Desktop app | `Authorization: Bearer k0d_…` from `POST /api/v1/devices/pair` | nothing else |

**Pairing the desktop app (self-signed servers):** first `GET /api/v1/health` without verifying the certificate, show `tls.fingerprint` to the owner ("Does it match `krnl0 fingerprint` on your server?"), then download `/ca.crt`, check its SHA-256 equals that fingerprint, and from then on verify every connection against that CA only (pin it). Host names do not need to match: the pinned CA is the identity. For `files`/`proxy` servers (`tls.fingerprint` is null) use normal certificate checks.

## Endpoints

| Method and path | Auth | Body → answer |
|---|---|---|
| `GET /api/v1/health` | none | `{ ok, name, version, protocol, website, appSync, needsSetup, timeZone, tls: { mode, fingerprint } }` |
| `POST /api/v1/setup` | setup code | `{ code, password }` → 201. 401 `bad-code`, 400 `weak-password`, 409 `claimed` |
| `POST /api/v1/auth/login` | password | `{ password, code? }` → `{ csrf, session }` + cookie. 401 `bad-login` / `totp-required`, 429 `locked` / `rate-limited` (`Retry-After`) |
| `POST /api/v1/auth/logout` | session | → `{ ok }` |
| `GET /api/v1/auth/session` | session | → `{ csrf, session, createdAt }` (after a page reload) |
| `POST /api/v1/devices/pair` | password | `{ password, code?, name, platform }` → 201 `{ deviceId, token, protocol, version, timeZone, fingerprint }` |
| `GET /api/v1/devices` · `DELETE /api/v1/devices/:id` | any | list (with `current`) · revoke (a device may revoke itself: "Stop syncing") |
| `GET /api/v1/sessions` · `DELETE /api/v1/sessions/:id` | any | list · revoke |
| `GET /api/v1/server` | any | health + `update`, `tls.notAfter`, `tls.names`, `lastBackupAt` |
| `GET /api/v1/docs` | any | `{ docs: [{ name, rev, schemaVersion, updatedAt, size, deleted? }] }` |
| `GET /api/v1/docs/:name` | any | `{ name, rev, schemaVersion, updatedAt, body }`; 404 `not-found` / `deleted` with `rev` |
| `PUT /api/v1/docs/:name` | any | `{ baseRev, body }` → `{ rev }`. 409 `conflict` `{ rev, body, deleted }`; 409 `schema` `{ storedSchemaVersion }` |
| `DELETE /api/v1/docs/:name?baseRev=N` | any | → `{ rev }` (a tombstone); 409 `conflict` |
| `GET /api/v1/timelog` | any | `{ boards: [{ id, months }] }` |
| `POST /api/v1/timelog/:boardId` | any | `{ entries: [{ month: "YYYY-MM", entry }] }` → `{ written, skipped }` (an `entry.id` already stored is skipped) |
| `GET /api/v1/timelog/:boardId?from=YYYY-MM&to=YYYY-MM` | any | `{ months: { "YYYY-MM": [entry, …] } }` (at most 60 months) |
| `DELETE /api/v1/timelog/:boardId` | any | the board's log is moved aside |
| `GET /api/v1/assets` | any | `{ assets: [{ id, ext, size }] }` |
| `PUT /api/v1/assets/:id.:ext` | any | raw bytes → 201 `{ id, ext, size }` (25 MB images, 500 MB media, 100 MB other) |
| `GET /api/v1/assets/:id` | any | the file; `Range` supported |
| `DELETE /api/v1/assets/:id` | any | → `{ ok }` |
| `GET /ca.crt` | none | the server's CA certificate (self-signed mode) |

`X-KRNL0-Connection: <connectionId>` on a write marks the change as yours, so you can ignore its echo.

## Document names (what the app stores)

The server does not care, but the KRNL0 app uses: `boards` (the list of boards: `boards.json`), `board:<boardId>` (one board, `board.json`), `prefs` (app preferences). Board ids come from `boards.json`, never from file paths (the app moves files when switching boards).

## Merging (the client's job)

1. Keep the `rev` and body you last read as **base**.
2. `PUT` with `baseRev = base.rev`.
3. On 409 `conflict`: `merged = mergeBoards(base, mine, theirs = error.body)` (KRNL0 `shared/boardMerge.ts`), then `PUT` with `baseRev = error.rev`. Repeat.
4. On 409 `schema`: this app is older than the board — tell the owner to update the app; never retry.

Offline: queue the board as it is and do steps 2–3 on reconnect. Same-value edits on both sides: the server's value wins, the local one stays one undo step away (as the app does today).

## WebSocket `/api/v1/sync`

Auth as above (the browser sends its cookie and `Origin`; the desktop app sends `Authorization`). Messages are JSON text, at most 64 KB.

```
→ { "type": "hello", "protocol": 1, "client": "web" | "desktop", "version": "0.13.0" }
← { "type": "hello", "protocol": 1, "version": "0.1.0", "connectionId": "…", "timeZone": "Europe/Berlin" }
← { "type": "change", "kind": "doc", "name": "board:b1", "rev": 7, "deleted": false, "by": "…" | null }
← { "type": "change", "kind": "timelog", "boardId": "b1", "month": "2026-11", "by": … }
← { "type": "change", "kind": "asset", "id": "01H…", "deleted": false, "by": … }
→ { "type": "ping" }   ← { "type": "pong", "at": 1763… }
```

Send `hello` within 10 seconds. Another protocol number gets `{ type: "error", code: "protocol", message }` and close code 4000 — show the message, it says which side to update. Close 4001 means signed out or revoked: go back to login / pairing. On reconnect, `GET /api/v1/docs` and compare revisions to catch up on what you missed.
