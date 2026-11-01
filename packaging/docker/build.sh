#!/usr/bin/env bash
# Build the Docker images from an install bundle (made by packaging/package.sh).
#   build.sh BUNDLE.tar.gz   → adrian-voice:<version>, adrian-voice-fetch:<version>
set -euo pipefail
B=${1:?usage: build.sh adrian-voice-<version>-linux-x64.tar.gz}
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -f "$B.sha256" ]; then
  (cd "$(dirname "$B")" && sha256sum -c --status "$(basename "$B").sha256") || { echo "bundle checksum mismatch" >&2; exit 1; }
fi
VERSION=$(tar -xzOf "$B" ./package.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
[[ $VERSION =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "bad version in bundle" >&2; exit 1; }
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
cp "$HERE/Dockerfile" "$HERE/entrypoint.sh" "$HERE/fetch-models.sh" "$HERE/../downloads.sh" "$CTX/"
cp "$B" "$CTX/adrian-voice.tar.gz"
docker build --target fetch -t "adrian-voice-fetch:$VERSION" "$CTX"
docker build -t "adrian-voice:$VERSION" "$CTX"
echo "Built adrian-voice:$VERSION. Start with: ADRIAN_VERSION=$VERSION docker compose up -d"
