# How sync works — states, failures and what happens

The contract between the KRNL0 app (desktop and web) and the server. Decisions [S1](decisions.md#decision-s1--a-separate-repo-the-server-is-a-document-store-that-never-reads-boards-2026-11-20) and [S11](decisions.md#decision-s11--real-time-sync-on-revisioned-documents-not-a-crdt-2026-11-20). Wire format: [protocol.md](protocol.md). App side: KRNL0 `docs/06-requirements/server-sync.md`.

## The model in one paragraph

The server holds documents with a revision number that only it increments. A client keeps, per document, the **base**: the last body and revision it agreed with the server on. A local change is uploaded as "base revision N, new body". If nobody else wrote since N, the server stores it as N+1 and tells every other connected client over the WebSocket. If someone did, the server answers 409 with the current body; the client merges three ways (base, its own, the server's) with the same `boardMerge` the desktop app already uses for the CLI and the AI terminal, and uploads again on top of the server's revision. Nothing waits on anything else: no locks are held across the network, so there is nothing to deadlock.

## Documents

| Document | What | Synced keys |
|---|---|---|
| `boards` | The list of boards (`boards.json`) | `boards[]` (id, name). **Not** `activeId`, `recording`, `notice`: those belong to one device. |
| `board:<id>` | One board (`board.json`) | Everything except per-device keys: `viewport`, `savedAt`, `layoutMode`, `layoutGeometry`, `activeCanvasId`. |
| time log `<boardId>/<YYYY-MM>` | Append-only entries | Every entry, deduplicated by its UUID `id`. |
| assets | Images and media by id | Uploaded once, immutable; fetched on first use. |

Per-device keys are removed before upload and put back from the local copy after download, so a phone's zoom never moves a desktop's canvas.

## Client state per document

```
            local edit                       server says rev > base
   ┌────────────────────┐            ┌──────────────────────────────┐
   ▼                    │            ▼                              │
 IDLE ──edit──▶ DIRTY ──debounce──▶ UPLOADING ──200──▶ IDLE         │
   ▲                                   │                            │
   │                                   ├──409 conflict──▶ MERGING ──┘ (re-upload on server rev)
   │                                   ├──409 schema────▶ READ-ONLY (app too old: "update KRNL0")
   │                                   ├──network error─▶ OFFLINE  (keep DIRTY; retry with backoff)
   │                                   └──401──────────▶ SIGNED-OUT (pairing revoked: stop, say so)
   │
   └──── change notice (rev > base) and not DIRTY ──▶ DOWNLOADING ──▶ apply ──▶ IDLE
         change notice while DIRTY ──▶ upload first; the 409 brings the server's version into the merge
```

- **Debounce:** 300 ms after the last local change, at most one upload in flight per document. Further edits during an upload mark it DIRTY again.
- **Echo:** a notice whose `by` is this client's own connection id is ignored.
- **Retry:** network errors back off 1 s, 2 s, 4 s … 60 s with ±20% jitter. Merge conflicts retry at once (they make progress); after 8 merges in a row on one document the client stops, shows "Sync paused — tap to retry", and logs it. It never loops silently.
- **Catch-up:** after any reconnect the client lists documents (`GET /api/v1/docs`) and downloads every one whose server revision differs from its base, uploads every DIRTY one, and replays time-log entries not yet acknowledged.

## Where the base lives

| Client | Base and pending changes | Survives |
|---|---|---|
| Desktop | `<board dir>/sync/` — `base-<docId>.json` (body + rev), `pending-timelog.jsonl` | Restart, crash (atomic writes), weeks offline |
| Web | IndexedDB (`krnl0-sync`): base per doc, pending body, pending time log | Reload, closing the tab, offline |

On start the desktop compares `board.json` with the base: if the `sys` CLI changed the board while the app was closed, that change is uploaded like any other.

## Failures and what happens

| Situation | What the system does | Why it is safe |
|---|---|---|
| Two devices edit different things at once | Second upload gets 409, merges, uploads; both edits survive | Three-way merge per item and per field |
| Two devices change the same field | The server's value (the first to arrive) wins; the other device's value stays one undo step away | Documented rule, identical everywhere |
| Device offline for days | Keeps working locally; on reconnect: catch-up, merge, upload | Base persisted on disk / IndexedDB |
| Connection drops mid-upload | The upload either landed (rev advanced: next notice/catch-up shows it, the client's base is updated) or not (retry). The server never half-applies | Server writes are atomic (one file per revision, then rename) |
| Server crashes or restarts mid-write | On start the newest complete revision is the document; a half-written temp file is ignored | Write body as `<doc>.<rev>.json`, then flip the pointer atomically |
| Server unreachable | Status "offline · changes kept"; everything works locally | Local file is always the working copy |
| App older than the board's schema | Server answers 409 `schema`; the app stops uploading that board and says "update KRNL0" | `schemaVersion` never goes down |
| App and server speak different protocols | WebSocket hello refused with a message naming the side to update | Version handshake (F14) |
| Device revoked / password changed | 401; the app stops syncing and asks to pair again; local data stays | Revocation is immediate |
| Board deleted on another device | Doc tombstone arrives; this device moves the board's files to `boards/.deleted/` (kept), and if it was open, switches to another board first | Nothing is destroyed by sync |
| Board created/renamed on another device | `boards` doc merges by board id; the board appears in the menu | Merge by id |
| Same time-log entry sent twice (retry) | Stored once | Dedupe by UUID |
| Image on a board missing on this device | Fetched by id on first display; upload of new images happens before the board that uses them | Assets are immutable by id |
| Device clocks differ | Order comes only from server revisions. Timer displays use `startedAt`; each client measures its offset to the server clock (hello/pong) and shows a warning above 5 s | Wall clocks never decide a merge |
| Many quick edits (dragging) | Debounce + one upload in flight; the last state wins locally, intermediate states are never sent | Bounded traffic |
| Large board | JSON bodies gzip-compressed both ways (typically 5–10× smaller) | Built-in zlib |
| Board over 20 MB, file over its limit | Refused (413 / 400 invalid); the client pauses only that board, or keeps that file local, with the reason — never a retry loop | Limits are fixed and stated |
| Server restored from a backup | Revisions go back; on reconnect every client takes the restored version and merges its own unsent edits on top | Catch-up compares revisions, not "newer" |
| Server certificate changed (self-signed) | The desktop's pinned CA no longer matches: it stops and asks to connect again (fingerprint check) | Pinning is the identity; a mismatch is never retried blindly |
| A browser page from before a server update | The WebSocket hello is refused; the page says to reload (the server serves the matching website) | Protocol handshake |
| A web session ends with unsent edits | They stay in the browser's IndexedDB and are sent after the next login; logging out sends them first or asks | Logout waits for the base to match |

## Speed

- A change reaches other devices in about the debounce (300 ms) plus one round trip plus one download: well under a second on a home network.
- Notices are tiny (`{doc, rev, by}`); only devices that need a document download it.
- Bodies are compressed; time-log entries and assets move separately from boards, so a timer tick never re-sends images.

## Privacy and security

Everything above runs inside the encrypted, authenticated connection (requirements F3–F8). The server stores bodies as the client sent them and reads nothing but `schemaVersion`. Per-device keys never leave the device.
