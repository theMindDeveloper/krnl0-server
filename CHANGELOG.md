# Changelog

## 0.2.1 — 2026-11-21

- The website is KRNL0 0.14.0.

## 0.2.0 — 2026-11-21

- One-click updates (F24–F31, Decision S12): the update API with the owner's password, a Linux helper (systemd path, service and timer) and a Docker updater container; signed releases only (Sigstore, exact release.yml@tag identity), backup first, health check, automatic way back, crash repair; night updates (off unless turned on); `krnl0 update`.
- Docker in one command: `docker.sh` and `docker.ps1`, including moving a `docker run` server over with its data and settings; the data volume is external.
- Releases follow KRNL0 (Decision S13): `web-version`, `release.json`, `:latest` moves on Publish, `tag.yml`, `follow-krnl0.yml`.

## 0.1.0 — 2026-11-20

First version.

- One server, two switches: Website and App sync.
- Always encrypted: self-signed (default, with a fingerprint the app pins), your own certificate files (Tailscale, certbot), or behind your reverse proxy; Caddy profile for an own domain.
- Owner account claimed with a one-time setup code; Argon2id passwords; optional two-factor codes with recovery codes; login limits and lock-out.
- Browser sessions (CSRF-protected) and paired devices, both revocable.
- Sync API: documents with revisions and conflict answers, time log, images and media, live change notices over WebSocket, version handshake.
- Daily backups (14 kept), backup before every new version, restore and export.
- `krnl0` command: setup, status, doctor, config, fingerprint, 2fa, devices, sessions, backup, restore, export, help.
- Docker image (non-root, read-only), Compose file, one-command Linux installer with a sandboxed systemd service.
- Serves the KRNL0 web app (phone, iPad and computer layouts) after login; the app's version is pinned per release and its SHA-256 checked.
- Setup, login and notice pages in the KRNL0 look, with no scripts.
- `krnl0 setup` in the terminal: the KRNL0 header, questions you answer with the arrow keys, and a finish screen with a QR code for your phone. Plain text when it is not a terminal.
- Real-time sync: atomic document writes, gzip both ways, server time in the handshake.
