# KRNL0 server

Run KRNL0 on your own server — a home lab, a NAS, a Raspberry Pi, a VPS. Choose what it does:

- **Website** — open KRNL0 in any browser, also on your phone.
- **App sync** — the KRNL0 desktop app on several computers shares one board.
- Or both.

Everything is encrypted, nothing is sent anywhere, and your data stays in one folder you own.

> 0.1.0, the first version. Works with the KRNL0 app 0.13 or newer. A step-by-step guide with pictures: [theminddev.com/krnl0/server.html](https://theminddev.com/krnl0/server.html).

## Install

### Docker (recommended)

```sh
docker run -d --name krnl0 --restart unless-stopped \
  -p 8443:8443 -v krnl0-data:/data \
  -e KRNL0_HOSTS=192.168.1.20 -e TZ=Europe/Berlin \
  ghcr.io/theminddeveloper/krnl0-server:latest

docker logs krnl0
```

The log shows the address and a one-time **setup code**. Open the address, click past the browser's warning once, enter the code and choose a password.

Docker Compose: get [`compose.yml`](compose.yml) and [`.env.example`](.env.example) (save as `.env`), then `docker compose up -d`.

### Linux without Docker

```sh
curl -fsSL https://github.com/theMindDeveloper/krnl0-server/releases/latest/download/install.sh | sh
```

It checks the download, installs a locked-down systemd service running as its own user, and walks you through setup. Run it again to update. Read [install.sh](install.sh) first if you like; it is short.

## Everyday commands

```sh
krnl0 status          # what runs, the address, the fingerprint
krnl0 doctor          # checks everything, says how to fix what is wrong
krnl0 setup           # website / app sync, encryption, password
krnl0 2fa enable      # two-factor codes
krnl0 devices         # paired apps; krnl0 devices revoke <id>
krnl0 backup          # backups are also made daily
krnl0 help            # everything else
```

In Docker: `docker exec -it krnl0 krnl0 status`.

## Encryption

Every connection is HTTPS. By default the server makes its own certificate: the desktop app needs nothing (it checks the server's fingerprint once), and a browser asks you to continue once per device. For no warnings at all use Tailscale, your own domain or your own proxy — see [certificates](docs/guides/certificates.md).

## Security and privacy

- Passwords: Argon2id. Sessions, device tokens and recovery codes are stored only as hashes.
- Login limits and lock-out, optional two-factor codes, revocable devices and sessions.
- Strict browser security headers; uploaded files can never run as a page.
- The container runs as a non-root user on a read-only file system; the Linux service is sandboxed by systemd.
- No telemetry. The only outgoing request is a daily update check, which you can switch off.
- Releases are signed (Sigstore), with checksums, an SBOM and build provenance.

Details: [threat model](docs/architecture/threat-model.md) · report a problem: [SECURITY.md](SECURITY.md).

## Updates

The server tells you when a new version is out (`krnl0 status`); it never updates itself. Docker: `docker compose pull && docker compose up -d`. Linux: run the install command again. Every new version backs up your data before it starts. See [updates](docs/guides/updates.md).

## Docs

- [Requirements](docs/requirements/server.md) · [Decisions](docs/architecture/decisions.md) · [Threat model](docs/architecture/threat-model.md) · [Protocol for clients](docs/architecture/protocol.md)
- Guides: [certificates](docs/guides/certificates.md) · [updates](docs/guides/updates.md) · [backups](docs/guides/backups.md)

## Develop

```sh
npm ci
npm run dev        # own data folder and port for this checkout
npm test
npm run typecheck
```

MIT licence. KRNL0 itself: [theMindDeveloper/KRNL0](https://github.com/theMindDeveloper/KRNL0).
