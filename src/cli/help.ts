// `krnl0 help <topic>` — the same words as docs/guides, for people at the terminal.

export const COMMANDS = `KRNL0 server — your own KRNL0 website and sync

Usage: krnl0 <command> [options]        (every command takes --data <folder>)

Running
  start                     Run the server
  setup                     Choose website / app sync, encryption, password
  status                    What runs, where to open it, the fingerprint
  doctor                    Check everything and say how to fix what is wrong
  version                   Show the version

Settings
  config get [key]          Show settings
  config set <key> <value>  Change a setting (restart to apply)
  config unset <key>        Back to the default

Security
  fingerprint               The certificate fingerprint the app shows when pairing
  reset-password            Choose a new password (signs out every browser)
  2fa enable|disable|status Two-factor codes from an authenticator app
  devices [list]            Paired desktop apps
  devices revoke <id|--all> Stop a device from syncing
  sessions [list]           Logged-in browsers
  sessions revoke <id|--all>

Your data
  backup                    Make a backup now
  backups                   List backups
  restore <name>            Bring a backup back (stop the server first)
  export <folder>           Copy all your data out as plain files

Help
  help certificates | install | updates | backups | security | docker
`

const TOPICS: Record<string, string> = {
  certificates: `Encryption and certificates

Every connection to your KRNL0 server is encrypted (HTTPS). What you choose is
only whether your browser already knows the certificate. Change it any time:
krnl0 setup, or krnl0 config set tls.mode <mode>, then restart.

  self-signed  (default, nothing to do)
    The server makes its own certificate.
    - The desktop app: no warning. When you pair it shows the fingerprint;
      compare it with "krnl0 fingerprint" once.
    - A browser: shows a warning the first time on each device. Choose
      "Advanced" then "Continue". The connection is still encrypted.
    - To remove the browser warning, install the server's certificate on the
      device: open https://<server>/ca.crt and follow docs/guides/certificates.md.
      Adding KRNL0 to a phone's home screen and reminders with the tab closed
      need this (or one of the options below).
    - In Docker, set KRNL0_HOSTS to the address you open (e.g. 192.168.1.20).

  files  (your own certificate: Tailscale, certbot, your CA)
    krnl0 config set tls.mode files
    krnl0 config set tls.certFile /path/fullchain.pem
    krnl0 config set tls.keyFile  /path/privkey.pem
    Tailscale: run "tailscale cert <name>.ts.net" on the server and point the
    two files at what it writes. Renewed files are picked up within an hour.

  proxy  (your reverse proxy does HTTPS: Caddy, Traefik, Nginx Proxy Manager)
    krnl0 config set tls.mode proxy
    krnl0 config set trustProxy on
    The server then listens on plain HTTP on 127.0.0.1:8443 (only your proxy
    can reach it). The compose file has a ready Caddy option for a domain.
`,
  install: `Installing

Docker (recommended):
  docker run -d --name krnl0 --restart unless-stopped -p 8443:8443 \\
    -v krnl0-data:/data -e KRNL0_HOSTS=192.168.1.20 \\
    ghcr.io/theminddeveloper/krnl0-server:latest
  then: docker logs krnl0      (shows the address and the setup code)

Docker Compose: download compose.yml from the release, then
  docker compose up -d

Linux without Docker (systemd):
  curl -fsSL https://github.com/theMindDeveloper/krnl0-server/releases/latest/download/install.sh | sh
  It checks the download's checksum, installs to /opt/krnl0, keeps data in
  /var/lib/krnl0 and runs as its own user "krnl0".
`,
  updates: `Updates

The server checks GitHub once a day and "krnl0 status" tells you when a new
version is out (turn off: krnl0 config set updateCheck off). It never updates
itself.

  Docker Compose:  docker compose pull && docker compose up -d
  docker run:      docker pull ghcr.io/theminddeveloper/krnl0-server:latest,
                   then remove and start the container again (data stays in the volume)
  Linux service:   run the install command again; it keeps your data

A new version backs up your data before its first start. Open browser tabs are
told to reload; the desktop app checks the version when it connects.
`,
  backups: `Backups

A backup is made every 24 hours and before a new version runs for the first
time. The last 14 are kept (krnl0 config set backupsKept <n>). They live in
<data>/backups/. Images and media are hard-linked, so backups take little space.

  krnl0 backup            make one now
  krnl0 backups           list them
  krnl0 restore <name>    stop the server first; your current data is backed up
                          as "before-restore" before anything is replaced
  krnl0 export <folder>   plain copies of every board, time log and file

Keep a copy somewhere else too: copy <data>/backups/<name> to another disk.
`,
  security: `Security, in short

- Every connection is encrypted. Passwords are stored as Argon2id hashes;
  sessions, device tokens and recovery codes only as hashes.
- Logins are limited: 10 tries per address per 15 minutes, and after 5 wrong
  passwords in a row the account waits, up to an hour.
- Turn on two-factor codes: krnl0 2fa enable
- Lost a laptop? krnl0 devices revoke <id>
- Do not forward the port on your router. Use Tailscale or WireGuard to reach
  KRNL0 from outside.
- Nothing is sent anywhere except the daily update check (switchable).
`,
  docker: `Docker notes

- Data lives in the /data volume. Back it up like any volume.
- Set KRNL0_HOSTS to the address you open, so the certificate covers it.
- Settings can also be environment variables: KRNL0_WEBSITE=on|off,
  KRNL0_APP_SYNC=on|off, KRNL0_TLS=self-signed|files|proxy, KRNL0_PORT, TZ.
- Run any krnl0 command inside the container:
    docker exec -it krnl0 krnl0 status
    docker exec -it krnl0 krnl0 setup
- The container runs as a non-root user with a read-only file system.
`,
}

export function helpTopic(topic: string | undefined): string | null {
  if (!topic) return COMMANDS
  return TOPICS[topic] ?? null
}

export const TOPIC_NAMES = Object.keys(TOPICS)
