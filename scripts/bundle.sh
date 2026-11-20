#!/bin/sh
# Builds the self-contained Linux bundle (F18b): Node.js runtime + server + web app.
#   scripts/bundle.sh <x64|arm64>      -> out/krnl0-server-<version>-linux-<arch>.tar.gz
# Node.js is downloaded from nodejs.org and checked against its SHASUMS256.txt.
set -eu
ARCH="$1"
case "$ARCH" in x64|arm64) ;; *) echo "arch is x64 or arm64" >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="$(cat "$ROOT/.node-version")"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="krnl0-server-$VERSION-linux-$ARCH"
WORK="$ROOT/out/work-$ARCH"
rm -rf "$WORK" && mkdir -p "$WORK/$NAME/app" "$ROOT/out"

TARBALL="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$WORK/$TARBALL"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
( cd "$WORK" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c - )
mkdir -p "$WORK/$NAME/node/bin"
tar -xJf "$WORK/$TARBALL" -C "$WORK"
cp "$WORK/node-v$NODE_VERSION-linux-$ARCH/bin/node" "$WORK/$NAME/node/bin/node"
cp "$WORK/node-v$NODE_VERSION-linux-$ARCH/LICENSE" "$WORK/$NAME/node/LICENSE"

# The server (no native modules: the same JS runs on every architecture).
cd "$ROOT"
npm ci --ignore-scripts --no-audit --no-fund
npm run build
cp -R package.json package-lock.json dist bin docs "$WORK/$NAME/app/"
mkdir -p "$WORK/$NAME/app/web" && cp -R web/. "$WORK/$NAME/app/web/"
( cd "$WORK/$NAME/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -f package-lock.json && find dist -name '*.map' -delete )
cp packaging/krnl0 packaging/krnl0.service README.md LICENSE "$WORK/$NAME/"
chmod 0755 "$WORK/$NAME/krnl0"

tar -czf "$ROOT/out/$NAME.tar.gz" -C "$WORK" "$NAME"
rm -rf "$WORK"
echo "out/$NAME.tar.gz"
