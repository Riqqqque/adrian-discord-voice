#!/usr/bin/env bash
# Build the install bundle: compiled app + production node_modules for
# linux-x64 (native modules included), the web UI and the packaging files.
# Run on Linux x86_64 with Node >= 22.12 on PATH.
#
#   packaging/package.sh [OUT_DIR]   → OUT_DIR/adrian-voice-<version>-linux-x64.tar.gz (+ .sha256)

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/release}" && cd "${1:-$ROOT/release}" && pwd)
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || { echo "build on Linux x86_64 (native modules)" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' || { echo "need Node >= 22.12" >&2; exit 1; }

VERSION=$(node -p "require('$ROOT/package.json').version")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp -r "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/tsconfig.json" "$ROOT/scripts" "$ROOT/src" "$ROOT/web" "$ROOT/packaging" "$STAGE/"
cp "$ROOT/LICENSE" "$ROOT/README.md" "$STAGE/" 2>/dev/null || true
cd "$STAGE"
# onnxruntime-node (Smart Turn) would otherwise fetch CUDA libraries from NuGet.
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
npm prune --omit=dev --no-audit --no-fund --loglevel=error
rm -rf src tsconfig.json packaging/package.sh
# The bundle is Linux x64 only; onnxruntime-node ships every platform (~250 MB).
find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 3 -type d ! -path "*/linux" ! -path "*/linux/x64" -prune -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -empty -delete
chmod 0755 . packaging/adrian packaging/install.sh packaging/upgrade-prep.sh  # mktemp dirs are 0700

NAME=adrian-voice-$VERSION-linux-x64.tar.gz
tar --owner=0 --group=0 --numeric-owner -czf "$OUT/$NAME" .
(cd "$OUT" && sha256sum "$NAME" >"$NAME.sha256")
echo "$OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1))"
cat "$OUT/$NAME.sha256"
