# Backups

- **Automatic:** every 24 hours, and before a new version runs for the first time. The newest 14 are kept (`krnl0 config set backupsKept <n>`).
- **Where:** `<data>/backups/<date>_<reason>/` — Docker: inside the `krnl0-data` volume; Linux: `/var/lib/krnl0/backups`.
- **What:** your boards, time log, settings, login data and certificates. Images and media are hard-linked (they never change in place), so a backup takes almost no extra space.

```sh
krnl0 backup             # one now
krnl0 backups            # list
krnl0 restore <name>     # stop the server first
krnl0 export <folder>    # plain copies of everything, to keep or move
```

Restore in Docker:

```sh
docker compose stop krnl0
docker compose run --rm krnl0 restore 2026-11-20_031500_daily
docker compose start krnl0
```

Before replacing anything, restore backs up the current data as `…_before-restore`.

**Keep a copy elsewhere.** Backups live on the same disk as the data. Copy a backup folder (or `krnl0 export`) to another disk or machine now and then. The data is readable by whoever has the files — use disk encryption on that disk.
