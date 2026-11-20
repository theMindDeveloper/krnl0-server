# History

Every merge to `main` gets an entry here (AGENTS.md rule 2).

## 2026-11-20 — Real-browser forms, setup-code renewal, proxy defaults

**Type:** Bug Fix
**PRs/Commits:** `fix/browser-forms-and-proxy`
**Files changed:** src/http/headers.ts, src/http/app.ts, src/http/util.ts, src/config.ts, src/auth/store.ts, tests, docs/requirements/server.md

**Summary:** `Referrer-Policy: no-referrer` made browsers send `Origin: null` on the plain setup and login forms, which the Origin check refused; now `same-origin`, and a form with `Origin: null` passes only with `Sec-Fetch-Site: same-origin`. An expired setup code is renewed and printed on the next try. The client IP comes from the last `X-Forwarded-For` entry (the one the proxy added). `trustProxy` defaults on in proxy mode, so browser writes behind a proxy are not refused.

## 2026-11-20 — CI: smoke-test container name, shellcheck notes

**Type:** Chore
**PRs/Commits:** 78c7e16
**Files changed:** .github/workflows/ci.yml, install.sh, packaging/krnl0

**Summary:** The Docker smoke test used a one-letter container name Docker refuses; renamed. `install.sh` lists old versions with `find`; the wrapper's intentional single quotes are marked for shellcheck.

## 2026-11-20 — Repository started: server core, security, Docker and installer

**Type:** Feature (initial)
**PRs/Commits:** initial commits on `main`
**Files changed:** everything (new repository)

**Summary:** KRNL0's self-hosted server as its own repository (owner's decision; Decision S1 keeps it from drifting: the server stores documents with revisions and never reads boards). Built: config with Website/App sync switches, data folder, Argon2id login with setup code, TOTP, rate limits and back-off, cookie sessions with CSRF and Origin checks, device tokens, TLS in self-signed/files/proxy modes with CA fingerprint, documents with conflict and schema-downgrade answers, time log, assets with inert serving and ranges, WebSocket change notices with protocol handshake, backups/restore/export, update check, the `krnl0` CLI (plain text until the design is picked), Docker image and Compose file with a Caddy profile, `install.sh` + hardened systemd unit, CI and signed draft releases. Terminal and AI are not on the server (Decision S2). Web pages, the coloured terminal setup and the phone view wait for design drafts (Decision S8).
