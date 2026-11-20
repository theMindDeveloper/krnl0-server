# Threat model

## What we protect

1. **The owner's plans** — boards, time log, assets. Private by default.
2. **The ability to change them** — nobody but the owner and their paired devices writes.
3. **The server machine** — KRNL0 must not become a way into the home lab.

## Who we defend against

| Actor | Can | Main defences |
|---|---|---|
| Someone on the same network (guest Wi-Fi, a compromised IoT device) | See and alter traffic, reach the port, race the owner to a new server | TLS always (F7); setup code from the server's log (F2); fingerprint pinning for the app (S3) |
| Someone on the internet (if the owner exposes the port) | Guess passwords, scan, flood | Argon2id, rate limits and back-off (F4), optional 2FA (F3); docs recommend Tailscale/WireGuard over port forwarding |
| A malicious website the owner visits | Make the owner's browser send requests (CSRF), embed the site (clickjacking), open a WebSocket | `SameSite=Strict` + CSRF header + Origin check (F5); `frame-ancestors 'none'`; Origin check on the WebSocket upgrade |
| Hostile content in a board (an SVG with script, an HTML file) | Run script in the KRNL0 origin (XSS) | Assets served with `nosniff`, a sandboxing CSP, and `Content-Disposition: attachment` for anything not image/audio/video/PDF (F12); strict page CSP (NF5) |
| A stolen laptop with a paired app | Use its device token | Revocation takes effect immediately (F6); tokens are hashed on the server |
| Someone who copies the `/data` folder (backup drive, NAS share) | Read plans; try to use stored secrets | Passwords/tokens/sessions are hashes (NF1); private keys 0600; plans themselves are readable — use disk encryption (app-level encryption is planned) |
| A compromised dependency | Run code in the server | Three direct runtime dependencies (S10), lockfile, no install scripts, `npm audit` gate and Dependabot (NF10), non-root read-only container (NF4), no Docker socket in the server container (S7) |
| A tampered download | Install a changed server | SHA-256 checks in `install.sh`; Sigstore signatures on the checksums and the image (NF10) |
| A compromised server process (a bug in it) | Ask for an update, read the updater's status | It can't choose what is installed: the updater takes only the newest signed release of this repository at its exact tag, never lower, pulled by digest (F25, NF11, S12); the root helper never opens files in the data folder as root; the Docker updater never mounts `/data` |
| Someone with the owner's browser session or a device token, not the password | Start an update or switch night updates | Both need the password (and 2FA code) every time, under the login limits (F24) |
| Someone who takes over the owner's GitHub account | Publish a signed release that updaters accept | Out of the updater's reach by design (it trusts this repository's release workflow). Defences: 2FA on GitHub, protected tags, the owner's Publish click as the gate (drafts are never installed, `:latest` moves only on Publish), night updates off unless turned on, backup and automatic way back |
| An old client | Overwrite a newer board with an older schema | `schemaVersion` downgrade guard (F9); protocol handshake (F14) |

## Out of scope

- An attacker with root on the server machine.
- End-to-end encryption against the server itself: the server stores readable data so it can be backed up and exported (the owner runs the server).
- Denial of service beyond basic limits.

## Rules that keep this true

- Every route: auth (or a written reason it has none: `health`, `setup` (setup code), `auth/login` and `devices/pair` (password), `/ca.crt` (public by nature), the plain login and setup pages), zod validation, size limit, and a line in `tests/server.test.ts` "every route refuses a stranger".
- No secrets in logs. The setup code banner is the single exception, by design.
- New outgoing connections need a decision entry and a switch.
