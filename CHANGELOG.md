# Changelog

## Unreleased — 0.1.0

First version.

- One server, two switches: Website and App sync.
- Always encrypted: self-signed (default, with a fingerprint the app pins), your own certificate files (Tailscale, certbot), or behind your reverse proxy; Caddy profile for an own domain.
- Owner account claimed with a one-time setup code; Argon2id passwords; optional two-factor codes with recovery codes; login limits and lock-out.
- Browser sessions (CSRF-protected) and paired devices, both revocable.
- Sync API: documents with revisions and conflict answers, time log, images and media, live change notices over WebSocket, version handshake.
- Daily backups (14 kept), backup before every new version, restore and export.
- `krnl0` command: setup, status, doctor, config, fingerprint, 2fa, devices, sessions, backup, restore, export, help.
- Docker image (non-root, read-only), Compose file, one-command Linux installer with a sandboxed systemd service.
