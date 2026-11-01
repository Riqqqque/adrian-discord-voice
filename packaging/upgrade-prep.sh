#!/usr/bin/env bash
# Steps a release needs before it starts: its speech models and its service
# file. Run from the NEW release (by `adrian update`, or by hand when
# upgrading from a version whose `adrian` predates this script):
#
#   sudo ADRIAN_DOWNLOAD_CACHE=/dir bash <release>/packaging/upgrade-prep.sh
#
# Models are checked against their pinned SHA-256; present ones are skipped.

set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
VAR=/var/lib/adrian
UNIT=/etc/systemd/system/adrian-voice.service

# shellcheck source=downloads.sh
. "$HERE/downloads.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
refuse_symlinks "$VAR" "$VAR/models"
install -d -m 0750 -o adrian -g adrian "$VAR" "$VAR/models"
install_models "$VAR/models" "$tmp"
chown -R root:adrian "$VAR/models"
chmod -R u=rwX,g=rX,o= "$VAR/models"

if [ -f "$UNIT" ] && ! cmp -s "$HERE/adrian-voice.service" "$UNIT"; then
  cp "$UNIT" /opt/adrian/adrian-voice.service.previous
  install -m 0644 "$HERE/adrian-voice.service" "$UNIT"
  systemctl daemon-reload
  say "Service file updated (previous copy: /opt/adrian/adrian-voice.service.previous)"
fi
# Auto-update turned on: keep its timer and service current too.
for u in adrian-update.service adrian-update.timer; do
  if [ -f "/etc/systemd/system/$u" ] && [ -f "$HERE/$u" ] && ! cmp -s "$HERE/$u" "/etc/systemd/system/$u"; then
    install -m 0644 "$HERE/$u" "/etc/systemd/system/$u"
    systemctl daemon-reload
  fi
done
say "Models and service file ready"
