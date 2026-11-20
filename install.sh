#!/bin/sh
# KRNL0 server — one-command install for Linux (F18b).
#
#   curl -fsSL https://github.com/theMindDeveloper/krnl0-server/releases/latest/download/install.sh | sh
#
# What it does (read it first if you like — it is short):
#   1. downloads the bundle for your CPU (x64 or arm64) and SHA256SUMS from GitHub Releases
#   2. checks the bundle's SHA-256 against SHA256SUMS (and its signature, if cosign is installed)
#   3. creates the system user "krnl0" and installs to /opt/krnl0, data in /var/lib/krnl0
#   4. installs a locked-down systemd service and starts it
#   5. adds the updater (krnl0-update.path/.service/.timer): one-click updates from
#      the KRNL0 app, signed releases only, with a backup and an automatic way back
#   6. runs "krnl0 setup" when you are at a terminal
#
# Run it again to update; your data stays. Options (environment):
#   KRNL0_VERSION=0.1.0   install that version instead of the latest
#   KRNL0_NO_START=1      install, but do not start the service
#   KRNL0_AUTO_UPDATE=on  update by itself at night (04:00); off unless you say so

set -eu

REPO="theMindDeveloper/krnl0-server"
PREFIX="/opt/krnl0"
DATA="/var/lib/krnl0"
VERSION="${KRNL0_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'krnl0 install: %s\n' "$*" >&2; exit 1; }

# ── Checks ────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux. On other systems use Docker: see the README."

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) fail "no bundle for $(uname -m). Use Docker, or build from source." ;;
esac

command -v systemctl >/dev/null 2>&1 || fail "systemd is needed for the service. Use Docker instead."
command -v tar >/dev/null 2>&1 || fail "tar is needed."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is needed (coreutils)."

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
else
  fail "curl or wget is needed."
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || fail "run as root, or install sudo."
  SUDO="sudo"
fi

# ── Download and verify ───────────────────────────────────────────────────
if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading KRNL0 server ($VERSION, linux-$ARCH)..."
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || fail "could not download SHA256SUMS from $BASE"
FILE="$(grep -E " (\*)?krnl0-server-[0-9.]+-linux-$ARCH\.tar\.gz$" "$TMP/SHA256SUMS" | awk '{print $2}' | tr -d '*' | head -n 1)"
[ -n "$FILE" ] || fail "no linux-$ARCH bundle in this release."
fetch "$BASE/$FILE" "$TMP/$FILE" || fail "could not download $FILE"

say "Checking the download..."
( cd "$TMP" && grep " \*\{0,1\}$FILE\$" SHA256SUMS | sha256sum -c - >/dev/null ) || fail "checksum mismatch: the download is damaged or was changed. Nothing was installed."

if command -v cosign >/dev/null 2>&1; then
  if fetch "$BASE/SHA256SUMS.sigstore.json" "$TMP/SHA256SUMS.sigstore.json" 2>/dev/null; then
    cosign verify-blob --bundle "$TMP/SHA256SUMS.sigstore.json" \
      --certificate-identity-regexp "^https://github.com/$REPO/\.github/workflows/release\.yml@refs/tags/v" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$TMP/SHA256SUMS" >/dev/null 2>&1 || fail "the release signature does not match. Nothing was installed."
    say "Signature checked."
  fi
fi

NEW_VERSION="$(printf '%s' "$FILE" | sed -E 's/^krnl0-server-([0-9.]+)-linux-.*/\1/')"

# ── Install ───────────────────────────────────────────────────────────────
if ! id krnl0 >/dev/null 2>&1; then
  say "Creating the system user krnl0..."
  if command -v useradd >/dev/null 2>&1; then
    $SUDO useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin krnl0
  else
    $SUDO adduser -S -H -h "$DATA" -s /sbin/nologin krnl0
  fi
fi

$SUDO mkdir -p "$PREFIX/versions" "$DATA"
$SUDO chown krnl0:krnl0 "$DATA"
$SUDO chmod 0700 "$DATA"

DEST="$PREFIX/versions/$NEW_VERSION"
$SUDO rm -rf "$DEST.partial"
$SUDO mkdir -p "$DEST.partial"
$SUDO tar -xzf "$TMP/$FILE" -C "$DEST.partial" --strip-components=1 --no-same-owner
$SUDO chown -R root:root "$DEST.partial"
$SUDO rm -rf "$DEST"
$SUDO mv "$DEST.partial" "$DEST"
$SUDO ln -sfn "$DEST" "$PREFIX/current"

$SUDO install -m 0755 "$DEST/krnl0" /usr/local/bin/krnl0
$SUDO install -m 0644 "$DEST/krnl0.service" /etc/systemd/system/krnl0.service
for unit in krnl0-update.service krnl0-update.path krnl0-update.timer; do
  if [ -f "$DEST/$unit" ]; then $SUDO install -m 0644 "$DEST/$unit" "/etc/systemd/system/$unit"; fi
done
$SUDO systemctl daemon-reload

# Keep the three newest versions for a quick roll-back.
find "$PREFIX/versions" -mindepth 1 -maxdepth 1 -type d ! -name "*.partial" -exec basename {} \; | sort -V | head -n -3 | while read -r old; do
  [ "$PREFIX/versions/$old" = "$DEST" ] || $SUDO rm -rf "$PREFIX/versions/$old"
done

say "Installed KRNL0 server $NEW_VERSION."

# ── First setup and start ─────────────────────────────────────────────────
FIRST=0
[ -f "$DATA/config.json" ] || FIRST=1

if [ "$FIRST" = "1" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
  say ""
  $SUDO /usr/local/bin/krnl0 setup </dev/tty >/dev/tty 2>&1 || say "Setup stopped. Run it any time: sudo krnl0 setup"
fi

if [ "${KRNL0_NO_START:-0}" != "1" ]; then
  $SUDO systemctl enable krnl0 >/dev/null 2>&1
  $SUDO systemctl restart krnl0
  sleep 2
  say ""
  $SUDO /usr/local/bin/krnl0 status || true
  if [ "$FIRST" = "1" ] && [ ! -f "$DATA/auth/owner.json" ]; then
    say ""
    say "Finish in your browser with the setup code: sudo journalctl -u krnl0 -n 30"
  fi
fi

# ── The updater (one click from the app from now on) ──────────────────────
if [ -f /etc/systemd/system/krnl0-update.path ]; then
  $SUDO systemctl enable --now krnl0-update.path krnl0-update.timer >/dev/null 2>&1 || true
  AUTO="${KRNL0_AUTO_UPDATE:-}"
  if [ -z "$AUTO" ] && [ "$FIRST" = "1" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf 'Update the server by itself at night, signed releases only? [y/N] ' >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in [Yy]*) AUTO=on ;; *) AUTO=off ;; esac
  fi
  if [ -n "$AUTO" ]; then $SUDO /usr/local/bin/krnl0 update auto "$AUTO" >/dev/null 2>&1 || true; fi
  # One run now, so the app sees the updater (and a crash halfway is repaired).
  $SUDO systemctl start krnl0-update.service >/dev/null 2>&1 || true
fi

say ""
say "Updates: one click in the KRNL0 app (saved › Update server), or: sudo krnl0 update now"
say "Next: sudo krnl0 doctor     (checks everything)"
say "      krnl0 help            (all commands)"
