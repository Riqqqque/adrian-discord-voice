#!/usr/bin/env bash
# A.D.R.I.A.N. Discord voice installer (native mode, systemd).
#
#   sudo ./install.sh --bundle adrian-voice-<version>-linux-x64.tar.gz [options]
#
# Options:
#   --yes                 don't ask questions; use the Recommended choices
#   --mode native         install mode (native is the only one so far)
#   --profile recommended local speech, cloud language model
#   --bundle FILE         app bundle made by packaging/package.sh
#   --port N              admin UI port (default: first free of 8790-8799)
#   --lan                 let other machines on the network reach the admin UI
#   --no-start            install but don't start the service
#   --uninstall           remove everything this installer added
#   --keep-data           with --uninstall: keep /etc/adrian and /var/lib/adrian
#
# Downloads are checked against the SHA-256 sums below. Set
# ADRIAN_DOWNLOAD_CACHE=/dir to reuse files already downloaded there.
#
# What it creates (all recorded in /var/lib/adrian/install-manifest.json):
#   user and group "adrian" (system, no login)
#   /opt/adrian            Node.js runtime and app releases (current -> releases/<version>)
#   /etc/adrian            config.json, secrets.env (0600)
#   /var/lib/adrian        state and speech models
#   /etc/systemd/system/adrian-voice.service
#   /usr/local/bin/adrian  command-line tool

set -euo pipefail
umask 022

HERE=$(cd "$(dirname "$0")" && pwd)

OPT=/opt/adrian
ETC=/etc/adrian
VAR=/var/lib/adrian
UNIT=/etc/systemd/system/adrian-voice.service
CLI=/usr/local/bin/adrian
MANIFEST=$VAR/install-manifest.json
SERVICE=adrian-voice

YES=0 MODE=native PROFILE=recommended BUNDLE="" PORT="" LAN=0 START=1 UNINSTALL=0 KEEP_DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --mode) MODE="$2"; shift ;;
    --profile) PROFILE="$2"; shift ;;
    --bundle) BUNDLE="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --lan) LAN=1 ;;
    --no-start) START=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# shellcheck source=downloads.sh
. "$HERE/downloads.sh"
ask() { # ask "question" default(y/n)
  [ "$YES" = 1 ] && return 0 # --yes answers yes
  local a; read -r -p "$1 [$( [ "$2" = y ] && echo Y/n || echo y/N )] " a || true
  a=${a:-$2}; [[ $a =~ ^[Yy] ]]
}

[ "$(id -u)" = 0 ] || die "run as root (sudo $0 ...)"

# --- uninstall -------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$MANIFEST" ] || [ -d "$OPT" ] || die "A.D.R.I.A.N. is not installed (no $MANIFEST)"
  what=", its config, keys and data"; [ "$KEEP_DATA" = 1 ] && what=" (keeping config and data)"
  ask "Remove A.D.R.I.A.N.$what?" n || exit 1
  created_user=0
  [ -f "$MANIFEST" ] && grep -q '"createdUser": true' "$MANIFEST" && created_user=1
  if command -v systemctl >/dev/null && [ -f "$UNIT" ]; then
    say "Stopping and removing the service"
    systemctl disable --now "$SERVICE" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl daemon-reload || true
    systemctl reset-failed "$SERVICE" 2>/dev/null || true
  fi
  if command -v systemctl >/dev/null && [ -f /etc/systemd/system/adrian-update.timer ]; then
    systemctl disable --now adrian-update.timer 2>/dev/null || true
    rm -f /etc/systemd/system/adrian-update.timer /etc/systemd/system/adrian-update.service
    systemctl daemon-reload || true
  fi
  rm -f "$CLI"
  rm -rf "$OPT"
  if [ "$KEEP_DATA" = 1 ]; then
    rm -f "$MANIFEST"
    say "Kept $ETC and $VAR"
  else
    rm -rf "$ETC" "$VAR"
    if [ "$created_user" = 1 ] && id adrian >/dev/null 2>&1; then
      say "Removing user adrian"
      userdel adrian 2>/dev/null || true
      getent group adrian >/dev/null && groupdel adrian 2>/dev/null || true
    fi
  fi
  say "A.D.R.I.A.N. removed."
  exit 0
fi

# --- preflight -------------------------------------------------------------
[ "$MODE" = native ] || die "only --mode native is supported so far"
[ "$PROFILE" = recommended ] || die "only --profile recommended is supported so far"
[ "$(uname -m)" = x86_64 ] || die "x86_64 only for now (found $(uname -m))"
[ -n "$BUNDLE" ] || die "--bundle FILE is required (made by packaging/package.sh)"
[ -f "$BUNDLE" ] || die "bundle not found: $BUNDLE"
[ -d /run/systemd/system ] || die "systemd is not running; native mode needs it"
for c in tar xz bzip2 sha256sum curl ss useradd runuser systemd-analyze; do
  command -v "$c" >/dev/null || die "missing command: $c (Debian/Ubuntu: apt install curl xz-utils bzip2 iproute2)"
done
glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
[ -n "$glibc" ] || die "glibc not found (musl/Alpine isn't supported)"
avail_kb=$(df -Pk /opt | awk 'NR==2{print $4}')
[ "$avail_kb" -gt $((3 * 1024 * 1024)) ] || die "need at least 3 GB free under /opt"
mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
[ "$mem_kb" -gt $((3 * 1024 * 1024)) ] || say "warning: less than 3 GB of memory; speech models need about 2 GB"
command -v ffmpeg >/dev/null || say "warning: ffmpeg not found; music stays off until it is installed (Debian/Ubuntu: sudo apt install ffmpeg)"
CPUS=$(nproc)

if [ -z "$PORT" ]; then
  for p in $(seq 8790 8799); do
    if ! ss -Hltn "sport = :$p" | grep -q .; then PORT=$p; break; fi
  done
  [ -n "$PORT" ] || die "ports 8790-8799 are all in use; pass --port N"
fi
HOST=127.0.0.1; [ "$LAN" = 1 ] && HOST=0.0.0.0
[ "$LAN" = 1 ] && say "warning: --lan serves the admin login over plain HTTP on your network. Add a TLS cert/key under \"server.tls\" in $ETC/config.json, or use an SSH tunnel instead."

say "Installing A.D.R.I.A.N. voice (native, $CPUS CPU threads, glibc $glibc) with admin UI on $HOST:$PORT"

# --- manifest bookkeeping ---------------------------------------------------
CREATED_USER=false
if [ -f "$MANIFEST" ] && grep -q '"createdUser": true' "$MANIFEST"; then CREATED_USER=true; fi

# --- downloads (verified) ---------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- user and directories ----------------------------------------------------
if ! id adrian >/dev/null 2>&1; then
  say "Creating system user adrian"
  useradd --system --user-group --home-dir "$VAR" --no-create-home --shell /usr/sbin/nologin adrian
  CREATED_USER=true
fi
install -d -m 0755 "$OPT" "$OPT/releases"
refuse_symlinks "$ETC" "$VAR" "$VAR/models"
install -d -m 0750 -o adrian -g adrian "$ETC" "$VAR" "$VAR/models"

# --- Node.js runtime -----------------------------------------------------------
if [ ! -x "$OPT/node-v$NODE_VERSION/bin/node" ]; then
  fetch "$NODE_URL" "$NODE_SHA256" "$TMP/node.tar.xz"
  mkdir -p "$OPT/node-v$NODE_VERSION"
  tar -xJf "$TMP/node.tar.xz" -C "$OPT/node-v$NODE_VERSION" --strip-components=1 --no-same-owner
fi
ln -sfn "node-v$NODE_VERSION" "$OPT/node"

# --- app release ---------------------------------------------------------------
say "Unpacking the app"
if [ -f "$BUNDLE.sha256" ]; then
  (cd "$(dirname "$BUNDLE")" && sha256sum -c --status "$(basename "$BUNDLE").sha256") || die "bundle checksum mismatch"
fi
mkdir -p "$TMP/app"
tar -xzf "$BUNDLE" -C "$TMP/app" --no-same-owner
VERSION=$("$OPT/node/bin/node" -p "require('$TMP/app/package.json').version")
[[ $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ && $VERSION != *..* ]] || die "bad version in bundle"
rm -rf "$OPT/releases/$VERSION"
mv "$TMP/app" "$OPT/releases/$VERSION"
chown -R root:root "$OPT/releases/$VERSION"
chmod -R go-w "$OPT/releases/$VERSION"
chmod 0755 "$OPT/releases/$VERSION"
ln -sfn "releases/$VERSION" "$OPT/current"

# --- speech models ---------------------------------------------------------------
install_models "$VAR/models" "$TMP"
chown -R root:adrian "$VAR/models"
chmod -R u=rwX,g=rX,o= "$VAR/models"

# --- config ------------------------------------------------------------------------
TZ_NAME=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
[ -n "$TZ_NAME" ] || TZ_NAME=UTC
if [ ! -f "$ETC/config.json" ]; then
  cat >"$ETC/config.json" <<EOF
{
  "server": { "host": "$HOST", "port": $PORT },
  "timezone": "$TZ_NAME",
  "secretsFile": "$ETC/secrets.env"
}
EOF
else
  # Keep everything; only update the listen address if asked on the command line.
  "$OPT/node/bin/node" -e '
    const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));
    c.server={...(c.server||{}),host:process.argv[2],port:Number(process.argv[3])};
    fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$ETC/config.json" "$HOST" "$PORT"
fi
refuse_symlinks "$ETC/config.json" "$ETC/secrets.env"
[ -f "$ETC/secrets.env" ] || (umask 077; printf '# A.D.R.I.A.N. secrets\n' >"$ETC/secrets.env")
chown adrian:adrian "$ETC/config.json" "$ETC/secrets.env"
chmod 0640 "$ETC/config.json"
chmod 0600 "$ETC/secrets.env"

# --- CLI and service -------------------------------------------------------------------
ln -sfn "$OPT/current/packaging/adrian" "$CLI"
install -m 0644 "$OPT/current/packaging/adrian-voice.service" "$UNIT"
systemd-analyze verify "$UNIT" 2>&1 | grep -v -e '^$' >&2 || true
systemctl daemon-reload

cat >"$MANIFEST" <<EOF
{
  "version": "$VERSION",
  "installedAt": "$(date -u +%FT%TZ)",
  "mode": "$MODE",
  "createdUser": $CREATED_USER,
  "paths": ["$OPT", "$ETC", "$VAR", "$UNIT", "$CLI"],
  "service": "$SERVICE",
  "node": "$NODE_VERSION",
  "adminUi": "$HOST:$PORT"
}
EOF
chmod 0644 "$MANIFEST"

if [ "$START" = 1 ]; then
  say "Starting the service"
  systemctl enable --now --quiet "$SERVICE"
  ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = 1 ] || { journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true; die "the service did not come up; see the log above"; }
fi

echo
say "Installed A.D.R.I.A.N. voice $VERSION"
echo "    Admin UI:   http://$( [ "$LAN" = 1 ] && hostname -I | awk '{print $1}' || echo 127.0.0.1 ):$PORT/"
[ "$LAN" = 1 ] || echo "    From another computer: ssh -L $PORT:127.0.0.1:$PORT <user>@<this-server>, then open http://localhost:$PORT/"
[ "$START" = 1 ] && { echo -n "    "; "$CLI" setup-code 2>/dev/null || true; }
echo "    Then follow the setup wizard. Status: sudo adrian status"
