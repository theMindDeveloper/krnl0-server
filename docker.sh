#!/bin/sh
# KRNL0 server with Docker, in one command (F28) — Linux and macOS.
#
#   curl -fsSL https://github.com/theMindDeveloper/krnl0-server/releases/latest/download/docker.sh | sh
#
# What it does (read it first if you like):
#   1. checks Docker and Docker Compose
#   2. downloads compose.yml and env.example and checks them against SHA256SUMS
#   3. writes ~/krnl0/compose.yml and ~/krnl0/.env (your address and time zone)
#   4. keeps your data: a server started with "docker run" moves over with its volume
#   5. starts KRNL0 and its updater (one-click updates from the KRNL0 app)
#   6. prints the address and the one-time setup code
#
# Run it again any time: it updates the files and keeps your data and settings.
# Options (environment): KRNL0_DIR (~/krnl0), KRNL0_HOSTS, TZ, KRNL0_PORT (8443),
# KRNL0_AUTO_UPDATE=on|off, KRNL0_YES=1 (no questions).

set -eu

REPO="theMindDeveloper/krnl0-server"
BASE="https://github.com/$REPO/releases/latest/download"
DIR="${KRNL0_DIR:-$HOME/krnl0}"
PORT="${KRNL0_PORT:-}"

say() { printf '%s\n' "$*"; }
fail() { printf 'krnl0: %s\n' "$*" >&2; exit 1; }
tty_ok() { [ "${KRNL0_YES:-0}" != "1" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; }
ask_yes() { # ask_yes "question" default(y|n)
  if ! tty_ok; then [ "$2" = "y" ]; return; fi
  if [ "$2" = "y" ]; then printf '%s [Y/n] ' "$1" >/dev/tty; else printf '%s [y/N] ' "$1" >/dev/tty; fi
  read -r a </dev/tty || a=""
  case "$a" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; *) [ "$2" = "y" ] ;; esac
}

# ── Checks ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "Docker is needed. Install it from https://docs.docker.com/get-docker/ and run this again."
if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running, or this user may not use it. Start Docker (Docker Desktop on a Mac), or run: curl -fsSL $BASE/docker.sh | sudo sh"
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is needed (the 'docker compose' command). Update Docker and run this again."
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
else
  fail "curl or wget is needed."
fi
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "sha256sum or shasum is needed."
fi

# ── Download and check ────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
say "Downloading the KRNL0 server files..."
for f in SHA256SUMS compose.yml env.example; do
  fetch "$BASE/$f" "$TMP/$f" || fail "could not download $f from $BASE"
done
for f in compose.yml env.example; do
  want="$(grep -E "^[0-9a-f]{64}[ *]+$f\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
  if [ -z "$want" ] || [ "$want" != "$(sha "$TMP/$f")" ]; then
    fail "$f does not match SHA256SUMS: the download is damaged or was changed. Nothing was installed."
  fi
done

# ── Your data: keep the volume a server already uses ──────────────────────
VOLUME="krnl0-data"
OLD_PORT=""; OLD_HOSTS=""; OLD_TZ=""
if docker container inspect krnl0 >/dev/null 2>&1; then
  project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' krnl0 2>/dev/null || true)"
  used="$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' krnl0 2>/dev/null || true)"
  mtype="$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Type }}{{ end }}{{ end }}' krnl0 2>/dev/null || true)"
  if [ "$mtype" = "bind" ]; then
    src="$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Source }}{{ end }}{{ end }}' krnl0)"
    say "Your server keeps its data in the folder $src, not in a Docker volume."
    say "Copy it into the volume once (the old server stops first), then run this again:"
    say "  docker stop krnl0 && docker run --rm -v \"$src\":/from:ro -v krnl0-data:/to alpine sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'"
    fail "Stopped. Nothing was changed."
  fi
  if [ -n "$used" ]; then VOLUME="$used"; fi
  # Keep what the old server was reached by: its port, address and time zone.
  OLD_PORT="$(docker port krnl0 8443/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
  OLD_HOSTS="$(docker inspect -f '{{ range .Config.Env }}{{ println . }}{{ end }}' krnl0 2>/dev/null | sed -n 's/^KRNL0_HOSTS=//p' | head -n1)"
  OLD_TZ="$(docker inspect -f '{{ range .Config.Env }}{{ println . }}{{ end }}' krnl0 2>/dev/null | sed -n 's/^TZ=//p' | head -n1)"
  if [ "$project" != "krnl0" ]; then
    say ""
    say "A KRNL0 server is already running here (data in the volume $VOLUME)."
    ask_yes "Move it to the new setup with one-click updates? Your data stays." y || fail "Stopped. Nothing was changed."
    docker stop krnl0 >/dev/null 2>&1 || true
    docker rm krnl0 >/dev/null
    say "Stopped the old container; the volume $VOLUME is kept."
  fi
elif docker volume inspect krnl0_krnl0-data >/dev/null 2>&1 && ! docker volume inspect krnl0-data >/dev/null 2>&1; then
  VOLUME="krnl0_krnl0-data"
fi

# ── Address, time zone, night updates ─────────────────────────────────────
if [ -z "$PORT" ]; then PORT="${OLD_PORT:-8443}"; fi
HOSTS="${KRNL0_HOSTS:-$OLD_HOSTS}"
if [ -z "$HOSTS" ]; then
  if command -v ip >/dev/null 2>&1; then HOSTS="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"; fi
  if [ -z "$HOSTS" ] && command -v ipconfig >/dev/null 2>&1; then HOSTS="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"; fi
  if [ -z "$HOSTS" ] && command -v hostname >/dev/null 2>&1; then HOSTS="$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)"; fi
fi
ZONE="${TZ:-$OLD_TZ}"
if [ -z "$ZONE" ] && command -v timedatectl >/dev/null 2>&1; then ZONE="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; fi
if [ -z "$ZONE" ] && [ -f /etc/timezone ]; then ZONE="$(head -n1 /etc/timezone)"; fi
if [ -z "$ZONE" ] && [ -L /etc/localtime ]; then ZONE="$(readlink /etc/localtime | sed 's|.*zoneinfo/||')"; fi
[ -n "$ZONE" ] || ZONE="UTC"
AUTO="${KRNL0_AUTO_UPDATE:-}"
if [ -z "$AUTO" ]; then
  if [ -f "$DIR/.env" ] && grep -q '^KRNL0_AUTO_UPDATE=' "$DIR/.env"; then AUTO="$(sed -n 's/^KRNL0_AUTO_UPDATE=//p' "$DIR/.env" | head -n1)"
  elif ask_yes "Update the server by itself at night (04:00), signed releases only?" n; then AUTO="on"
  else AUTO="off"; fi
fi
SOCKET=""
case "${DOCKER_HOST:-}" in unix://*) SOCKET="${DOCKER_HOST#unix://}" ;; esac

# ── Write the files ───────────────────────────────────────────────────────
mkdir -p "$DIR"
if [ -f "$DIR/compose.yml" ] && ! cmp -s "$TMP/compose.yml" "$DIR/compose.yml"; then
  cp "$DIR/compose.yml" "$DIR/compose.yml.before-$(date +%Y%m%d-%H%M%S)"
fi
cp "$TMP/compose.yml" "$DIR/compose.yml"
[ -f "$DIR/.env" ] || cp "$TMP/env.example" "$DIR/.env"
setenv() { # setenv KEY VALUE — replace or add, keep everything else
  if grep -q "^$1=" "$DIR/.env"; then
    sed "s|^$1=.*|$1=$2|" "$DIR/.env" > "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"
  else
    printf '%s=%s\n' "$1" "$2" >> "$DIR/.env"
  fi
}
if [ -n "$HOSTS" ]; then setenv KRNL0_HOSTS "$HOSTS"; fi
setenv TZ "$ZONE"
setenv KRNL0_AUTO_UPDATE "$AUTO"
setenv KRNL0_VOLUME "$VOLUME"
setenv KRNL0_PUBLISH_PORT "$PORT"
if [ -n "$SOCKET" ]; then setenv KRNL0_DOCKER_SOCKET "$SOCKET"; fi
chmod 0600 "$DIR/.env"

# ── Start ─────────────────────────────────────────────────────────────────
say "Starting KRNL0 (the first time downloads about 100 MB)..."
cd "$DIR"
docker compose pull --quiet
docker compose up -d --remove-orphans

i=0
while [ $i -lt 60 ]; do
  state="$(docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}{{ .State.Status }}{{ end }}' krnl0 2>/dev/null || true)"
  [ "$state" = "healthy" ] && break
  i=$((i + 1)); sleep 2
done

CODE="$(docker compose logs krnl0 2>/dev/null | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}' | tail -n1 || true)"
ADDR="https://${HOSTS:-localhost}:$PORT"
say ""
say "KRNL0 server is running."
say "  Open        $ADDR"
if [ -n "$CODE" ] && ! docker exec krnl0 test -f /data/auth/owner.json 2>/dev/null; then
  say "  Setup code  $CODE"
  say ""
  say "Open the address, continue past the browser's warning once (Advanced, then Continue),"
  say "type the setup code and choose your password."
fi
say ""
say "Files:    $DIR (compose.yml, .env)"
say "Updates:  one click in the KRNL0 app (saved > Update server). At night: $AUTO."
say "Status:   docker exec krnl0 krnl0 status"
say "Guide:    https://theminddev.com/krnl0/server.html"
