# History

Every merge to `main` gets an entry here (AGENTS.md rule 2).

## 2026-11-22 — 0.2.4 published

**Type:** Release (published)
**PRs/Commits:** #21 (from the follow workflow after KRNL0 0.15.0)
**Files changed:** docs/history/HISTORY.md

**Summary:** The website is KRNL0 0.15.0: a Calendar you can read, events that happen once, one way to move everything onto the Calendar, the phone's Today and full-screen views, and the layout menu. Draft verified (`krnl0 updater verify`: signature from release.yml@v0.2.4, 9 files match; the Linux bundle is 0.2.4 and carries the 0.15.0 website) and published at 09:52 UTC; `:latest` was checked against `release.json`. The image was not started this time (Docker was not running on the release computer); its digest on GHCR equals `release.json`. The follow PR's own CI run shows "failure" with no jobs (it stops when the PR merges, as with 0.2.3); the follow workflow's typecheck and tests passed, and CI on `main` passed after the merge.

## 2026-11-22 — Release 0.2.4: the website is KRNL0 0.15.0

**Type:** Release
**PRs/Commits:** follow-krnl0 release PR
**Files changed:** web-version, package.json, package-lock.json, CHANGELOG.md, docs/releases/v0.2.4.md, docs/history/HISTORY.md

**Summary:** KRNL0 0.15.0 was published; this release pins its web app (checked against KRNL0's SHA-256 when the release is built). Merging tags v0.2.4 and builds the draft; the owner's Publish ships it to updaters.

## 2026-11-21 — 0.2.3 published

**Type:** Release (published)
**PRs/Commits:** #19 (from the follow workflow after KRNL0 0.14.2)
**Files changed:** docs/history/HISTORY.md

**Summary:** The website is KRNL0 0.14.2: the board menu shows in Easy mode too and follows sync, so a board started on the website is always reachable. Draft verified (signature from release.yml@v0.2.3, 9 files, image runs 0.2.3 with the 0.14.2 website) and published; `:latest` was checked against `release.json`.

## 2026-11-21 — Release 0.2.3: the website is KRNL0 0.14.2

**Type:** Release
**PRs/Commits:** follow-krnl0 release PR
**Files changed:** web-version, package.json, package-lock.json, CHANGELOG.md, docs/releases/v0.2.3.md, docs/history/HISTORY.md

**Summary:** KRNL0 0.14.2 was published; this release pins its web app (checked against KRNL0's SHA-256 when the release is built). Merging tags v0.2.3 and builds the draft; the owner's Publish ships it to updaters.

## 2026-11-21 — 0.2.2 published

**Type:** Release (published)
**PRs/Commits:** #17 (from the follow workflow after KRNL0 0.14.1)
**Files changed:** docs/history/HISTORY.md

**Summary:** The website is KRNL0 0.14.1, which keeps the later edit when two devices changed the same value (KRNL0 Decision 53; its edit stamps travel inside the documents as `syncStamps`, which this server stores as part of the body). The draft verified (`krnl0 updater verify`: signature from release.yml@v0.2.2, 9 files, image runs 0.2.2 with the 0.14.1 website) and was published at 01:41 UTC; `:latest` was checked against `release.json`.

## 2026-11-21 — Release 0.2.2: the website is KRNL0 0.14.1

**Type:** Release
**PRs/Commits:** follow-krnl0 release PR
**Files changed:** web-version, package.json, package-lock.json, CHANGELOG.md, docs/releases/v0.2.2.md, docs/history/HISTORY.md

**Summary:** KRNL0 0.14.1 was published; this release pins its web app (checked against KRNL0's SHA-256 when the release is built). Merging tags v0.2.2 and builds the draft; the owner's Publish ships it to updaters.

## 2026-11-21 — 0.2.0 and 0.2.1 published

**Type:** Release (published)
**PRs/Commits:** #12, #13 (0.2.0), #15 (0.2.1, from the follow workflow)
**Files changed:** docs/history/HISTORY.md

**Summary:** 0.2.0 published after a real test of its draft: the Docker updater ran against the draft's signed files (Sigstore bundle v0.3, exact release.yml@v0.2.0 identity), pulled the image from GHCR by the digest in `release.json` and swapped 0.1.9 → 0.2.0 with its settings and a backup. `published.yml` then moved `:latest`, checked equal to `release.json`. KRNL0 0.14.0's Publish started `follow-krnl0.yml`, which opened 0.2.1 (website = KRNL0 0.14.0). Merging tagged it (`tag.yml` → `release.yml`); the draft verified (`krnl0 updater verify`: signature, 9 files, image runs 0.2.1 with the 0.14.0 website) and was published. Real one-click test: a 0.2.0 Docker server updated itself to 0.2.1 through `POST /api/v1/server/update` in 90 s, updater included, settings and backup kept. Note: the server checks for new versions once a day; Settings › Updates › Check now in the app asks at once.

## 2026-11-21 — Release 0.2.1: the website is KRNL0 0.14.0

**Type:** Release
**PRs/Commits:** follow-krnl0 release PR
**Files changed:** web-version, package.json, package-lock.json, CHANGELOG.md, docs/releases/v0.2.1.md, docs/history/HISTORY.md

**Summary:** KRNL0 0.14.0 was published; this release pins its web app (checked against KRNL0's SHA-256 when the release is built). Merging tags v0.2.1 and builds the draft; the owner's Publish ships it to updaters.

## 2026-11-21 — Sync design: the latest edit wins a clash

**Type:** Docs
**PRs/Commits:** `docs/sync-latest-edit-wins`
**Files changed:** docs/architecture/sync.md, docs/history/HISTORY.md

**Summary:** The failure table follows KRNL0 Decision 53: two devices changing the same value while apart now keep the later edit (stamps in server time inside the document, `syncStamps`), an edit beats a delete, and a polling browser takes the server's time from the `Date` header. The server itself does not change: it stores the stamps as part of the body and checks only size and `schemaVersion`.

## 2026-11-21 — Release 0.2.0

**Type:** Release
**PRs/Commits:** #12 (merged), release PR on `chore/release-v0.2.0`
**Files changed:** package.json, package-lock.json, CHANGELOG.md, docs/history/HISTORY.md

**Summary:** Version 0.1.0 → 0.2.0: one-click updates, Docker in one command, releases that follow KRNL0. Merging this tags v0.2.0 (`tag.yml`, its first real run) and builds the draft; the owner's Publish ships it. The website inside stays KRNL0 0.13.0 (`web-version`) until the follow workflow pins 0.14.0.

## 2026-11-21 — One-click updates, Docker in one command, releases that follow KRNL0

**Type:** Feature
**PRs/Commits:** `feat/server-updates`
**Files changed:** src/update/{files,release,info,linux,docker,runner}.ts, src/update/check.ts, src/http/app.ts, src/server.ts, src/cli/main.ts, packaging/{krnl0,krnl0.service,krnl0-update.*}, install.sh, docker.sh, docker.ps1, compose.yml, .env.example, Dockerfile, .github/workflows/{release,published,tag,follow-krnl0,ci}.yml, scripts/{release-json,follow-krnl0}.mjs, web-version, package.json (sigstore), docs, tests/update.test.ts

**Summary:** `POST /api/v1/server/update` and `PUT …/auto` with the owner's password under the login limits; `GET /api/v1/server` reports how the server updates. The privileged side (Decision S12) is a root systemd helper (path unit on the request, daily timer) or an `updater` container with the Docker socket and its own volume; both install only the newest published release, verified with Sigstore against `release.yml@refs/tags/vX.Y.Z`, Docker by the digest in the signed `release.json`; backup first, 90 s health check, automatic way back (restoring the backup when the data moved on), crash repair. `docker.sh`/`docker.ps1` install with Compose in one command and move a `docker run` server over with its volume, port, address and time zone. Releases (Decision S13): `web-version` file, `:latest` only on Publish, `tag.yml` and `follow-krnl0.yml`. Review fixes before any release: the updater's group access to its volume, unversioned Docker API (Engine 29 refuses 1.41), heartbeat during long pulls, Linux one-click from the CLI, install.sh's cosign for bundle v0.3 (checked in CI), night updates never on without a yes, release PRs authored by the owner. Tested for real on Docker Desktop 29.7 (Windows): a real image build (caught a Dockerfile line break), the updater's status and permissions, a request answered from GitHub, crash repair, the container swap with settings and labels kept, and both installers moving a `docker run` server over (data, port 28443, address and time zone kept; `.env` without BOM). The data volume became external after Compose warned about it. Linux, for real in a systemd container (Debian 12): a bundle built by `scripts/bundle.sh` installed by `install.sh` (it failed at the night question without a usable terminal: fixed by opening /dev/tty to test it, in docker.sh too), the units enabled, the helper writing its status as `krnl0` under its sandbox, a request firing the path unit, a real update 0.1.0 → 0.2.0 (backup, unpack, switch, units, restart, health) and a broken 0.2.1 rolled back to 0.2.0 by itself; and `krnl0 update` now trusts the Linux helper over looking like Docker.

## 2026-11-20 — 0.1.0 published; the repository and image are public

**Type:** Release
**PRs/Commits:** #10 (merged to `main`), tag `v0.1.0`
**Files changed:** README.md, CHANGELOG.md, docs/releases/v0.1.0.md, docs/history/HISTORY.md

**Summary:** Repository variable `KRNL0_WEB_VERSION=0.13.0` set after KRNL0 0.13.0 was published; tag `v0.1.0` built the Linux bundles (x64, arm64, each with the KRNL0 web app checked against its SHA-256), the signed `SHA256SUMS`, and the amd64/arm64 image with SBOM and provenance. The owner approved the draft and it was published. The repository was made public, and the owner made the GHCR package public in its settings (GitHub has no API for that). Checked logged out: the install script, both bundles, the Compose files and an anonymous pull of `:0.1.0` and `:latest`. The website's step-by-step guide went live at theminddev.com/krnl0/server.html.

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
