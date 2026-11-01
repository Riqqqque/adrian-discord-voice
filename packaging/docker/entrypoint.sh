#!/bin/sh
# First start: write a minimal config (the setup wizard fills in the rest)
# and an empty secrets file, then run the service.
set -eu
umask 077
if [ ! -f "$ADRIAN_CONFIG" ]; then
  cat >"$ADRIAN_CONFIG" <<EOF
{
  "server": { "host": "0.0.0.0", "port": 8790 },
  "timezone": "${TZ:-UTC}",
  "secretsFile": "/etc/adrian/secrets.env"
}
EOF
fi
[ -f /etc/adrian/secrets.env ] || printf '# A.D.R.I.A.N. secrets\n' >/etc/adrian/secrets.env
exec node /opt/adrian/current/dist/app/main.js "$@"
