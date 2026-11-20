# Updates

The KRNL0 server checks GitHub Releases once a day for a newer version (turn it off with `krnl0 config set updateCheck off`, Docker `KRNL0_UPDATE_CHECK=off`; it sends nothing but a plain request for the newest release). The KRNL0 app shows it in the **saved** badge's menu, and `krnl0 update` and `krnl0 doctor` show it on the server.

## One click (Decision S12)

| Installed with | How it updates |
|---|---|
| The Docker one-command installer (`docker.sh` / `docker.ps1`) or `compose.yml` from 0.2.0 on | **One click** in the app, or `docker exec krnl0 krnl0 update now`. The `updater` container does it. |
| The Linux installer (`install.sh`) from 0.2.0 on | **One click** in the app, or `sudo krnl0 update now`. `krnl0-update.service` does it. |
| Plain `docker run`, or an install from 0.1.0 | Run the installer once (it keeps your data and adds the updater): Docker `curl -fsSL https://github.com/theMindDeveloper/krnl0-server/releases/latest/download/docker.sh | sh` (Windows: `irm …/docker.ps1 | iex`), Linux the `install.sh` command. From then on: one click. |
| A pinned `KRNL0_VERSION` in `.env` | No one click: change the pin, then `docker compose pull && docker compose up -d`. |

**Update by itself at night:** `krnl0 update auto on` (or the switch in the app, or the installer's question). At 04:00 server time the updater installs a newer signed release the same way. Off unless you turn it on.

**What the updater checks:** it installs only the newest *published* release of `theMindDeveloper/krnl0-server`, never an older or equal one, and only when `SHA256SUMS` carries a Sigstore signature by exactly this repository's `release.yml` at that release's tag. `release.json` (in `SHA256SUMS`) names the image by its digest; Docker pulls exactly that. The server itself only *asks* (a request file); it can't choose what gets installed.

**What happens on an update:**

1. A backup of your data (`krnl0 backup`), then the new version is downloaded and checked.
2. The switch: the new version starts (Linux: `/opt/krnl0/current` points at it; Docker: the `krnl0` container is created again from the new image, with the same settings).
3. It has 90 seconds to answer `/api/v1/health` with its new version. If it doesn't, the updater switches back by itself; if the new version already moved the data on, the backup from step 1 is restored first. The app says "Nothing was lost" with the reason.
4. Open browser tabs are told to reload; desktop apps reconnect. Edits made meanwhile wait on each device and sync afterwards.

A crash or power cut halfway is finished or undone the next time the updater runs (Docker: within a minute; Linux: at the next start or the daily timer).

## By hand

| Installed with | Update |
|---|---|
| Docker Compose | `cd ~/krnl0 && docker compose pull && docker compose up -d` |
| `docker run` | `docker pull ghcr.io/theminddeveloper/krnl0-server:latest`, then `docker rm -f krnl0` and the same `docker run` again (the data stays in the volume) — or run the one-command installer once |
| Linux installer | run the install command again |

**Every new version also** backs up your data on its first start:

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
