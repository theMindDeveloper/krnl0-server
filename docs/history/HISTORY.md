# History

Every merge to `main` gets an entry here (AGENTS.md rule 2).

## 2026-11-20 — The terminal look: setup, doctor and the start screen

**Type:** Feature
**PRs/Commits:** `feat/realtime-sync`
**Files changed:** src/cli/look.ts, src/cli/setup.ts, src/cli/main.ts, src/server.ts, package.json (uqr), tests/look.test.ts, docs

**Summary:** `krnl0 setup` on a real terminal in the owner's mix of the three drafts: the KRNL0 block letters, one boxed question at a time with arrow keys and space (Website / App sync, encryption, the address the certificate names — with Docker and Tailscale said plainly — and the time zone, the owner password), the path of answered steps, and a finish screen with DONE, a QR code of the address to open it on a phone, the facts and the `krnl0 doctor` checks. `krnl0 doctor` and the start screen (with the setup-code card) use the same colours. Logs, pipes, `--yes` and flags keep the plain typed setup. QR codes by `uqr` (MIT, no dependencies). Checked by driving the real setup in a pseudo-terminal and rendering it in xterm.js.

## 2026-11-20 — Designed pages, the web app in releases, sync hardening

**Type:** Feature
**PRs/Commits:** `feat/realtime-sync`
**Files changed:** src/http/pages.ts, src/http/app.ts, public/k0/*, Dockerfile, package.json, scripts/bundle.sh, .github/workflows/release.yml, src/store/docs.ts, src/sync/hub.ts, tests, docs

**Summary:** Setup, login and notice pages in the KRNL0 look (designs *Setup*, *PhoneLogin*), still script-free; fonts (OFL), the app icon and the cube are served from `/_k0/` before login (allow-listed). The release bundles the KRNL0 web app only when its SHA-256 matches KRNL0's. Sync hardening found by the KRNL0 simulations: atomic revision-named document writes swept on start, gzip in both directions with an output limit, the server time in the WebSocket hello and pong, `X-KRNL0-Asset` on asset downloads, URL-decoded path segments (`board%3Ab1`). Requirements F21–F22; sync protocol and state machine in `docs/architecture/sync.md` (S11).

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
