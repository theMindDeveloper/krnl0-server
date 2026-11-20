# KRNL0 Server — self-hosted website and sync

*Decisions: [S1–S9](../architecture/decisions.md). Threats: [threat-model.md](../architecture/threat-model.md). Protocol: [protocol.md](../architecture/protocol.md).*

One program on your own server (home lab, NAS, Raspberry Pi, VPS). It can do two things, and the owner picks either or both:

- **Website** — KRNL0 in any browser, including a phone.
- **App sync** — the KRNL0 desktop app on several computers shares one board.

The server has **no terminal, no AI and no board CLI** for the website (owner decision, 2026-11-20). Those stay in the desktop app.

## Functional Requirements

| # | Requirement |
|---|---|
| F1 | **Two switches.** `website` and `appSync` are each on or off, at least one on. Set by `krnl0 setup`, `krnl0 config set`, `/data/config.json` or env (`KRNL0_WEBSITE`, `KRNL0_APP_SYNC`). A change applies on restart. With Website off, no web page or browser login is served. With App sync off, no device can pair and device tokens are refused. |
| F2 | **First run is claimed with a setup code.** While no owner exists, every start prints a fresh single-use setup code (10 characters, valid 60 minutes) in the log and terminal; a try after it ran out prints a new one. Creating the owner needs that code (browser setup) or a shell on the server (`krnl0 setup` / `krnl0 reset-password`). |
| F3 | **Password login.** Passwords are 12–256 characters, stored only as Argon2id hashes. Optional TOTP two-factor (RFC 6238) with 10 one-time recovery codes. |
| F4 | **Rate limits.** Login, setup and pairing allow 10 attempts per IP per 15 minutes. After 5 wrong passwords in a row the account waits 1 minute, doubling to at most 1 hour. A correct login resets it. |
| F5 | **Browser sessions.** Cookie `__Host-krnl0` — `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. Expires after 14 days unused or 30 days total. Every state-changing request also needs the session's CSRF token in `X-KRNL0-CSRF` and a matching `Origin`. Sessions can be listed and revoked (`krnl0 sessions`). |
| F6 | **Device pairing.** With App sync on, the desktop app pairs with the password (and 2FA code if on) and gets a device token, stored on the server only as a hash. Devices can be listed and revoked (`krnl0 devices`); a revoked token stops working at once. |
| F7 | **Always encrypted.** Every connection is TLS. Modes: `self-signed` (default: the server makes its own certificate authority), `files` (your certificate files, e.g. from `tailscale cert` or certbot; renewed files are picked up within an hour), `proxy` (your reverse proxy does TLS; the server listens on plain HTTP on 127.0.0.1 by default). An own domain with automatic Let's Encrypt certificates is the compose file's `domain` profile (Caddy in front, trusting only the server's CA). Plain HTTP is used only to redirect to HTTPS (optional `httpPort`). |
| F8 | **Fingerprint.** In `self-signed` mode the SHA-256 fingerprint of the server's CA is printed at start, by `krnl0 fingerprint`, and returned by `/api/v1/health`. The desktop app shows it when pairing and pins it. |
| F9 | **Documents with revisions.** Boards, the boards list and preferences are stored as JSON documents with a revision number. A write names the revision it was based on; a stale write is refused with the current document (409) so the client merges and retries. A write whose top-level `schemaVersion` is lower than the stored one is refused (no downgrade by an old client). |
| F10 | **Live changes.** A WebSocket tells every connected client which document, time-log month or asset changed, with its new revision. |
| F11 | **Time log.** Entries are appended per board and month (`YYYY-MM`) and queried by month range. An entry with an `id` already stored is not stored twice. |
| F12 | **Assets.** Images and media are uploaded and downloaded by id, with size limits (25 MB images, 500 MB media). SVG and unknown types are never served as active content. |
| F13 | **Website hosting.** With Website on, the server serves the KRNL0 web build from `webDir` (single-page app). Until a web build is installed, it serves a plain notice page. |
| F14 | **Version handshake.** `/api/v1/health` and the WebSocket hello carry the server version and protocol number. A client with another protocol major is refused with a message that says which side to update. |
| F15 | **Backups.** A backup is made every 24 hours and before the server runs a new version for the first time; the last 14 are kept. `krnl0 backup`, `krnl0 backups`, `krnl0 restore <name>` (server stopped). Assets are hard-linked, so backups cost little space. |
| F16 | **Update check.** Once a day the server asks GitHub Releases for the newest version (switchable off: `KRNL0_UPDATE_CHECK=off`). `krnl0 status` and the API report it; nothing updates by itself unless the owner chose it (Watchtower or a timer). |
| F17 | **Admin CLI** `krnl0`: `start`, `setup`, `status`, `doctor`, `config get/set`, `fingerprint`, `reset-password`, `2fa enable/disable/status`, `devices list/revoke`, `sessions list/revoke`, `backup`, `backups`, `restore`, `export`, `help <topic>`, `version`. |
| F18 | **Install, two ways.** (a) One Docker image (amd64 + arm64), one `docker run`, or the `compose.yml`. (b) One command (`install.sh`) that installs a self-contained Linux bundle as a locked-down systemd service, after checking its checksum. |
| F19 | **Time zone.** The server's time zone is set in setup (`TZ`) and reported to clients, so day boundaries never fall back to UTC by accident. |
| F20 | **Your data.** `krnl0 export <folder>` copies every document, time log and asset in plain files. Deleting `/data` removes everything; nothing is kept elsewhere. |

## Non-Functional Requirements

| # | Requirement |
|---|---|
| NF1 | No secret is stored in plain text: passwords, session ids, device tokens and recovery codes are hashes. The one exception is the TOTP secret, which must be readable to check codes. Private keys and auth files are mode 0600; the CA certificate alone is copied to `public/` for a proxy to trust. |
| NF2 | Every write is atomic (temp file + rename); a crash never leaves a half-written file. Writes to one document are serialised. |
| NF3 | The server never reads board content beyond the top-level `schemaVersion` (Decision S1). |
| NF4 | The container runs as a non-root user with a read-only root file system, no capabilities and `no-new-privileges`; only `/data` is writable, and npm is removed from the image. The systemd unit runs as its own user with `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, an empty capability set and a system-call filter. |
| NF5 | Security headers on every response: CSP without inline scripts, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: same-origin` (no-referrer would make browsers send `Origin: null` on our own forms), a restrictive `Permissions-Policy`, COOP/CORP same-origin. HSTS only with a publicly trusted certificate of our own (`files`); the proxy decides in `proxy` mode (Caddy in the `domain` profile sends it); never in `self-signed` mode. |
| NF6 | Request bodies have limits (JSON 20 MB, assets as F12); WebSocket messages are capped at 64 KB. |
| NF7 | Logs never contain board content, passwords, tokens, session ids or recovery codes. |
| NF8 | No outgoing connection except the update check (switchable). No telemetry. (Caddy, when the owner adds it, talks to Let's Encrypt.) |
| NF9 | Each checkout uses its own data folder and port in development. |
| NF10 | A release has zero known vulnerabilities in runtime dependencies (`npm audit --omit=dev`). Bundles have SHA-256 checksums; the checksums and the image are signed (Sigstore keyless), and the image carries an SBOM and build provenance. |

## Not in this version

Terminal and AI on the website (dropped by the owner) · several users per server (layout is ready) · encryption at rest by the app (use disk encryption; later) · reminders with the tab closed (Web Push; later) · the designed web pages, terminal look and phone view (waiting for design drafts, Decision S8).

## Use Cases

- **UC-S1:** A home-lab owner runs one `docker run`, reads the setup code in the log, opens the address on their laptop, clicks past the browser warning once, sets a password, and turns on Website and App sync.
- **UC-S2:** The owner pairs the desktop app on two computers: the app shows the fingerprint, the owner compares it with `krnl0 fingerprint`, logs in, and both computers share one board.
- **UC-S3:** The owner opens KRNL0 on their phone through Tailscale (`files` mode with `tailscale cert`): no warning, the same board.
- **UC-S4:** A laptop is stolen. The owner runs `krnl0 devices revoke <id>`; the laptop's next sync is refused.
- **UC-S5:** The owner updates with `docker compose pull && docker compose up -d`. The server backs up, starts the new version, and open tabs are told to reload.
- **UC-S6:** A Raspberry Pi owner without Docker runs the one-line installer; KRNL0 runs as a service and `krnl0 doctor` shows everything green.

## User Stories

- As a home-lab owner, I want one command to run KRNL0 on my server, so that setup takes minutes.
- As a user, I want to choose website, app sync or both, so that I only run what I use.
- As a user, I want every connection encrypted without being forced to buy a domain, so that my plans stay private at home.
- As a phone user, I want to open KRNL0 in my browser, so that I do not need a phone app.
- As an owner, I want to revoke a lost device, so that a stolen laptop cannot read my board.

## Gherkin Scenarios (ATDD)

```gherkin
Feature: Two switches (F1)
  Scenario: Website off
    Given the server runs with website off and appSync on
    When a browser requests "/"
    Then it gets 404
    And a browser login request is refused

Feature: Setup code (F2)
  Scenario: Claiming a new server
    Given no owner exists and the server printed setup code "ABCD-EFGH-JK"
    When someone posts the setup with that code and a 12-character password
    Then the owner is created and the code no longer works
  Scenario: Wrong code
    When someone posts the setup with a wrong code
    Then it is refused and no owner exists

Feature: Password login (F3, F4)
  Scenario: Wrong passwords lock the account for a while
    Given the owner exists
    When 5 wrong passwords are sent in a row
    Then the next login, even with the right password, is refused for 1 minute

Feature: Sessions and CSRF (F5)
  Scenario: A write without the CSRF token
    Given a logged-in browser session
    When it writes a document without "X-KRNL0-CSRF"
    Then the write is refused with 403

Feature: Devices (F6)
  Scenario: Revoked device
    Given a paired device token
    When the owner revokes it
    Then the next request with that token is refused with 401

Feature: TLS (F7, F8)
  Scenario: Self-signed by default
    Given a new data folder
    When the server starts
    Then it serves HTTPS with a certificate issued by its own CA
    And the health endpoint reports the CA fingerprint
    And no HSTS header is sent

Feature: Documents (F9, F10)
  Scenario: Stale write
    Given document "board:b1" is at revision 3
    When a client writes it with base revision 2
    Then it gets 409 with revision 3 and its body
  Scenario: No downgrade
    Given document "board:b1" has schemaVersion 3
    When a client writes it with schemaVersion 2
    Then the write is refused with 409 "schema"
  Scenario: Live change
    Given two connected clients
    When one writes "board:b1"
    Then the other receives a change for "board:b1" with the new revision

Feature: Time log (F11)
  Scenario: Same entry twice
    When a client appends an entry with id "e1" twice
    Then the month holds it once

Feature: Assets (F12)
  Scenario: SVG is not active
    Given an uploaded SVG asset
    When it is downloaded
    Then it is served with a sandboxing Content-Security-Policy and nosniff

Feature: Version handshake (F14)
  Scenario: Old client
    When a client says protocol 0
    Then the server answers with "update the app" and closes

Feature: Backups (F15)
  Scenario: Keep 14
    Given 14 backups exist
    When a new backup is made
    Then the oldest is removed and 14 remain
```
