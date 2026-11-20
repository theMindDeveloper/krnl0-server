# Decisions (binding)

Numbered S1, S2… to keep them apart from the app's Decisions in the KRNL0 repo.

## Decision S1 — A separate repo; the server is a document store that never reads boards (2026-11-20)

**Context.** The owner wants the server in its own repo. The risk of a separate repo is drift: the board schema changes in the app every few weeks.

**Decision.** The server stores opaque JSON documents with a revision number and never interprets them. Clients already own the three-way merge (`shared/boardMerge.ts` in KRNL0): a write names its base revision; a stale write gets 409 with the current document; the client merges and retries. The only field the server reads is the top-level `schemaVersion`, to refuse a downgrade by an old client. The server imports no KRNL0 code.

**Consequences.** Board schema changes need no server release. The web build comes from the KRNL0 repo (`build:web`) and is installed into `webDir`; the server pins nothing in the app. Board migrations run in clients, as today.

## Decision S2 — No terminal, no AI, no board CLI on the server (2026-11-20)

Owner decision. The website is the board, plans, timer, habits and calendar. The terminal and Claude stay in the desktop app, which syncs through the server. This removes the server's largest risk (a shell reachable from a browser), and its native build (node-pty).

## Decision S3 — Always TLS; four modes; trust by fingerprint for the app (2026-11-20)

Modes `self-signed` (default), `files`, `proxy` (see requirements F7). There is no built-in ACME client: it would add a large dependency tree (axios, node-forge) for a case that rarely works at home (port 80 open to the internet). An own domain is the compose `domain` profile instead: Caddy gets and renews the certificate and forwards to KRNL0 over HTTPS, trusting only KRNL0's CA from `public/ca.crt` (it never sees a private key).

- **self-signed**: on first start the server creates an ECDSA P-256 CA (10 years) and a leaf certificate (397 days, renewed 30 days before expiry or when the names change) for `localhost`, the host name, every local IP and `KRNL0_HOSTS`. The CA certificate can be downloaded (`/ca.crt`) and installed on devices for warning-free browsers. The desktop app pins the CA's SHA-256 fingerprint, so it never needs the install.
- **HSTS only with publicly trusted certificates** (`files` mode; in `proxy` mode the proxy decides). With a self-signed certificate HSTS would make the browser's "continue anyway" impossible.
- **proxy** binds `127.0.0.1` by default; in Docker the image binds `0.0.0.0` inside the container and the docs say not to publish the port. `trustProxy` must be set for the client IP (rate limits) to come from `X-Forwarded-For`.

## Decision S4 — Authentication (2026-11-20)

- **Argon2id from Node's own crypto** (Node ≥ 24.7): no native add-on, the same on every architecture. Parameters m=19 MiB, t=2, p=1 (OWASP), stored with each hash so they can be raised later.
- Browser: random 256-bit session id in a `__Host-` cookie (`HttpOnly; Secure; SameSite=Strict`), stored as SHA-256. CSRF: a per-session token in a header, plus an `Origin` check. Both, not one.
- App: device token `k0d_…` (256-bit), stored as SHA-256, sent as `Authorization: Bearer`.
- Setup code: single use, 60 minutes, kept in memory only, new each start until an owner exists, compared in constant time. The password is checked before the code is spent.
- Rate limits and account back-off in memory (they reset on restart, which a remote attacker cannot cause).
- Auth files are re-read when they change on disk, so the `krnl0` CLI can revoke a device while the server runs, without an admin socket.

## Decision S5 — One owner per server for now (2026-11-20)

v0.x has one account. Data lives under `/data/users/owner/` so several users later means more folders, not a migration.

## Decision S6 — Plain files, no database (2026-11-20)

Documents are `<name>.json` plus `<name>.meta.json` (rev, schemaVersion, updatedAt). Writes are atomic (temp + rename) and serialised per document. The data is small (a board is kilobytes to a few MB), backups are folder copies, and the owner can read their own data with any editor.

## Decision S7 — One release, two installs; updates never through the Docker socket (2026-11-20)

A tag `vX.Y.Z` builds a multi-arch image (Alpine, npm removed) (`ghcr.io/theminddeveloper/krnl0-server`) and Linux bundles (x64, arm64) with checksums, as one draft release. Docker users update with `docker compose pull && docker compose up -d` (or opt-in Watchtower); bundle users with `krnl0 update`. The server never gets access to the Docker socket. A new version backs up before its first start.

## Decision S8 — UI waits for design drafts (2026-11-20)

The browser setup/login pages, the coloured terminal setup and the phone view are new UI. Until the owner picks drafts, the server serves plain unstyled notice pages and the CLI prints plain text. The API and the CLI are complete without them.

## Decision S9 — Protocol 1 (2026-11-20)

HTTP JSON under `/api/v1`, a WebSocket at `/api/v1/sync` for change notices only (writes go over HTTP). The protocol number is in `/api/v1/health` and the WebSocket hello; a different major is refused with a message naming the side to update. See [protocol.md](protocol.md).

## Decision S10 — Few runtime dependencies (2026-11-20)

Runtime dependencies are `ws`, `zod` and `@peculiar/x509` (and their asn1 helpers). HTTP routing, cookies, rate limits, TOTP, Argon2id (Node's own crypto) and the CLI are written here. Every new runtime dependency needs a line in this file saying why.

## Decision S11 — Real-time sync on revisioned documents, not a CRDT (2026-11-20)

**Context.** The owner asked for near-real-time sync between the desktop app and the website, without conflicts or deadlocks, using the best open-source tools. The candidates were a CRDT (Yjs, Automerge) or the revisioned documents of protocol 1 with the app's existing three-way merge.

**Decision.** Keep protocol 1 and harden it. Clients merge with KRNL0's `boardMerge` (the same code that already merges the CLI and the AI terminal into the open board); the server orders writes with revisions; the WebSocket pushes change notices immediately. Full state machine and failure table: [sync.md](sync.md).

**Why not a CRDT.** KRNL0's state is plain JSON written whole by the app, the CLI and the AI. A CRDT would need a JSON↔CRDT bridge running next to `boardMerge` — two merge systems, and a bridge is where silent loss comes from (concurrent reorders of id lists, tombstone growth from whole-board re-diffs, old clients writing old shapes past migrations). CRDTs pay off for several people typing in the same text; KRNL0 is one owner on a few devices.

**Hardening that comes with it.** (1) A document write is one atomic step: the body is written under its revision's file name, then the meta pointer is replaced, so a crash never pairs a new body with an old revision. (2) JSON bodies are gzip-compressed both ways (built-in zlib). (3) The protocol carries the server time in `hello`/`pong` so clients can measure clock offset.
