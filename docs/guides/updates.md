# Updates

KRNL0 server checks GitHub Releases once a day and tells you when a new version is out: `krnl0 status`, `krnl0 doctor`, and the website's settings. **It never updates itself.** Turn the check off with `krnl0 config set updateCheck off` (Docker: `KRNL0_UPDATE_CHECK=off`); it sends nothing but a plain request for the latest release.

| Installed with | Update |
|---|---|
| Docker Compose | `docker compose pull && docker compose up -d` |
| `docker run` | `docker pull ghcr.io/theminddeveloper/krnl0-server:latest`, then `docker rm -f krnl0` and the same `docker run` again (the data stays in the volume) |
| Linux installer | run the install command again |
| Hands-off (opt-in) | add [Watchtower](https://containrrr.dev/watchtower/) for the `krnl0` container |

What happens on an update:

1. The new version backs up your data (`<data>/backups/…_before-vX.Y.Z`) before it touches anything.
2. It starts; open browser tabs are told to reload.
3. The desktop app checks the version when it connects. If the app and server speak different protocol versions, the message says which one to update.

Going back: Docker — set `KRNL0_VERSION=<old>` in `.env` and `docker compose up -d`; Linux — the installer keeps the three newest versions in `/opt/krnl0/versions` (`sudo ln -sfn /opt/krnl0/versions/<old> /opt/krnl0/current && sudo systemctl restart krnl0`). If the newer version changed the data, restore its `before-v…` backup.

Verify an image yourself:

```sh
cosign verify ghcr.io/theminddeveloper/krnl0-server:<version> \
  --certificate-identity-regexp '^https://github.com/theMindDeveloper/krnl0-server/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
