# History

Every merge to `main` gets an entry here (AGENTS.md rule 2).

## 2026-11-20 — Repository started: server core, security, Docker and installer

**Type:** Feature (initial)
**PRs/Commits:** initial commits on `main`
**Files changed:** everything (new repository)

**Summary:** KRNL0's self-hosted server as its own repository (owner's decision; Decision S1 keeps it from drifting: the server stores documents with revisions and never reads boards). Built: config with Website/App sync switches, data folder, Argon2id login with setup code, TOTP, rate limits and back-off, cookie sessions with CSRF and Origin checks, device tokens, TLS in self-signed/files/proxy modes with CA fingerprint, documents with conflict and schema-downgrade answers, time log, assets with inert serving and ranges, WebSocket change notices with protocol handshake, backups/restore/export, update check, the `krnl0` CLI (plain text until the design is picked), Docker image and Compose file with a Caddy profile, `install.sh` + hardened systemd unit, CI and signed draft releases. Terminal and AI are not on the server (Decision S2). Web pages, the coloured terminal setup and the phone view wait for design drafts (Decision S8).
