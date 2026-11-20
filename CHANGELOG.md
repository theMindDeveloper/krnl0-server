# Changelog

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
