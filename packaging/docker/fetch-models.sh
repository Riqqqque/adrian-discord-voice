#!/usr/bin/env bash
# One-shot model downloader for the Docker install: fills the models volume
# (checksums verified; already-present models are skipped).
set -euo pipefail
. /usr/local/lib/adrian/downloads.sh
dir=${1:-/models}
mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
install_models "$dir" "$tmp"
chmod -R a+rX,go-w "$dir"
say "Models ready in $dir"
