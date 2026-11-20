#!/usr/bin/env bash
# A.D.R.I.A.N. Discord voice installer (native mode, systemd).
#
#   sudo ./install.sh --bundle adrian-voice-<version>-linux-x64.tar.gz [options]
#
# Options:
#   --yes                 don't ask questions; use the Recommended choices
#   --check               only check this machine and say what to fix; change nothing
#   --mode native         install mode (native is the only one so far)
#   --profile recommended local speech, cloud language model
#   --bundle FILE         app bundle made by packaging/package.sh
#   --port N              admin UI port (default: the one it has, else the first free of 8790-8799)
#   --lan                 let other machines on the network reach the admin UI
#   --no-lan              this machine only again (the default for a new install)
#   --no-start            install but don't start the service
#   --allow-downgrade     install a bundle older than the version already installed
#   --require-checksum    refuse a bundle with no .sha256 next to it (get.sh always has one)
#   --uninstall           remove everything this installer added
#   --keep-data           with --uninstall: keep /etc/adrian and /var/lib/adrian
#
# Downloads are checked against the SHA-256 sums in downloads.sh. Set
# ADRIAN_DOWNLOAD_CACHE=/dir to reuse files already downloaded there.
# Running it again is safe: it keeps the config, keys, port and finished
# downloads, and restarts the service if it was running.
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
RUN_SYSTEMD=/run/systemd/system
MANIFEST=$VAR/install-manifest.json
SERVICE=adrian-voice

ARGS=("$@")
YES=0 CHECK=0 MODE=native PROFILE=recommended BUNDLE="" PORT="" LAN="" START=1 UNINSTALL=0 KEEP_DATA=0 DOWNGRADE=0 REQUIRE_SHA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --check) CHECK=1 ;;
    --mode) MODE="$2"; shift ;;
    --profile) PROFILE="$2"; shift ;;
    --bundle) BUNDLE="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --lan) LAN=1 ;;
    --no-lan) LAN=0 ;;
    --no-start) START=0 ;;
    --allow-downgrade) DOWNGRADE=1 ;;
    --require-checksum) REQUIRE_SHA=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
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

[ "$CHECK" = 1 ] || [ "$(id -u)" = 0 ] || die "run it as root: sudo bash $0 ${ARGS[*]}"

# The lock `adrian update` and `adrian rollback` take: neither may swap the
# release or the service file under this script, nor this script under them.
take_update_lock() {
  [ -d "$OPT" ] && command -v flock >/dev/null || return 0
  exec 9>"$OPT/update.lock"
  flock -n 9 && return 0
  local follow="sudo tail -f $OPT/update.log"
  systemctl is-active --quiet adrian-update.service 2>/dev/null && follow="sudo journalctl -u adrian-update -f"
  die "an update of A.D.R.I.A.N. is running right now. Nothing was changed. Wait for it to finish (follow it: $follow), then run this again."
}

# --- uninstall -------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$MANIFEST" ] || [ -d "$OPT" ] || die "A.D.R.I.A.N. is not installed (no $MANIFEST)"
  what=", its config, keys and data"; [ "$KEEP_DATA" = 1 ] && what=" (keeping config and data)"
  ask "Remove A.D.R.I.A.N.$what?" n || exit 1
  take_update_lock
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
# Everything is checked before anything is created, and every problem is
# listed at once with what to do about it, so one run tells the whole story.
# Every probe here has to survive its tool failing or missing (set -e).
PROBLEMS=() WARNINGS=()
problem() { PROBLEMS+=("$*"); }
warn() { WARNINGS+=("$*"); }
installed() { [ -e "$OPT/current" ]; }

# The package that brings each command, for the install line.
pkg_for() {
  case "$1:$2" in
    apt:xz) echo xz-utils ;; apt:ss) echo iproute2 ;; apt:useradd) echo passwd ;; apt:runuser) echo util-linux ;;
    apt:sha256sum) echo coreutils ;; apt:systemd-analyze) echo systemd ;;
    dnf:xz) echo xz ;; dnf:ss) echo iproute ;; dnf:useradd) echo shadow-utils ;; dnf:runuser) echo util-linux ;;
    dnf:sha256sum) echo coreutils ;; dnf:systemd-analyze) echo systemd ;;
    *) echo "$2" ;;
  esac
}
pkg_manager() { if command -v apt-get >/dev/null; then echo apt; elif command -v dnf >/dev/null; then echo dnf; fi; }
install_line() { # install_line PKG...: the command that installs them here
  case $(pkg_manager) in
    apt) echo "sudo apt-get install -y $*" ;;
    dnf) echo "sudo dnf install -y $*" ;;
    *) echo "install these with your system's package manager: $*" ;;
  esac
}
# The probes never fail the script: a missing or failing tool is a problem to
# list, not a reason to stop before the list is printed.
free_mb() { df -Pk "$1" 2>/dev/null | awk 'NR==2{print int($4/1024)}' || true; }
mount_of() { df -Pk "$1" 2>/dev/null | awk 'NR==2{print $6}' || true; }
existing() { local d=$1; while [ ! -e "$d" ]; do d=$(dirname "$d"); done; echo "$d"; } # nearest folder that exists
gb() { awk -v m="$1" 'BEGIN{printf "%.1f GB", m/1024}'; }
# Hosts the downloads still needed come from (nothing for files already in place or in the cache).
pending_hosts() {
  local m name url sha kind
  { [ -x "$OPT/node-v$NODE_VERSION/bin/node" ] || [ -f "${ADRIAN_DOWNLOAD_CACHE:-/nonexistent}/$(basename "$NODE_URL")" ] || echo "$NODE_URL"
    for m in "${MODELS[@]}"; do
      IFS='|' read -r name url sha kind _ <<<"$m"
      [ -e "$VAR/models/$name" ] && [ "$(cat "$VAR/models/.$name.sha256" 2>/dev/null)" = "$sha" ] && continue
      [ -f "${ADRIAN_DOWNLOAD_CACHE:-/nonexistent}/$(basename "$url")" ] && continue
      echo "$url"
    done; } | sed -E 's#^https://([^/]+)/.*#\1#' | sort -u
}
reachable() { # any HTTP answer at all counts: this is about the connection, not the page
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 -I "https://$1/" 2>/dev/null) || true
  [ -n "$code" ] && [ "$code" != 000 ]
}

preflight() {
  [ "$MODE" = native ] || problem "Only --mode native is supported so far. For Docker, use packaging/docker instead of this script."
  [ "$PROFILE" = recommended ] || problem "Only --profile recommended is supported so far."
  local arch; arch=$(uname -m 2>/dev/null) || arch=unknown
  case "$arch" in
    x86_64) ;;
    aarch64|arm64|armv7l|armv6l) problem "This computer has an ARM processor ($arch), like a Raspberry Pi. A.D.R.I.A.N. runs only on 64-bit Intel or AMD computers (x86_64) for now." ;;
    *) problem "This computer's processor ($arch) isn't supported. A.D.R.I.A.N. needs a 64-bit Intel or AMD computer (x86_64)." ;;
  esac
  if [ ! -d "$RUN_SYSTEMD" ]; then
    if grep -qi microsoft /proc/version 2>/dev/null; then
      problem "This is WSL without systemd. Turn it on: add the two lines \"[boot]\" and \"systemd=true\" to /etc/wsl.conf, run \"wsl --shutdown\" in Windows, open WSL again, then run this again."
    elif [ -f /.dockerenv ] || [ -n "${container:-}" ]; then
      problem "This looks like a container, which has no systemd. Use the Docker install (packaging/docker) instead, or run this on the host."
    else
      problem "systemd isn't running on this computer, and the native install needs it. Use a systemd distribution (Ubuntu 24.04 or Debian 12 are tested), or the Docker install (packaging/docker)."
    fi
  fi
  local c missing=() pm; pm=$(pkg_manager)
  for c in tar gzip xz bzip2 sha256sum curl ss useradd runuser systemd-analyze; do
    command -v "$c" >/dev/null || missing+=("$(pkg_for "$pm" "$c")")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    problem "Some tools this installer needs are missing. Install them with: $(install_line "$(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ' | sed 's/ $//')")"
  fi
  # musl's getconf doesn't know GNU_LIBC_VERSION, and some systems have no getconf.
  local glibc libc
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}') || glibc=""
  if [ -z "$glibc" ]; then
    libc=$(ldd --version 2>&1 | head -n 1) || true
    if [[ $libc =~ (GLIBC|GNU\ libc).*[[:space:]]([0-9]+\.[0-9]+)$ ]]; then glibc=${BASH_REMATCH[2]}; fi
  fi
  if [ -z "$glibc" ] && [[ ${libc:-} == *musl* ]]; then
    problem "This system has no glibc (Alpine and other musl systems aren't supported). Use Ubuntu, Debian or Fedora, or the Docker install."
  elif [ -z "$glibc" ]; then
    warn "couldn't tell which C library this system has (no getconf); Node.js 22 needs glibc 2.28 or newer, which Ubuntu 20.04, Debian 10, Fedora and later have"
  elif ! awk -v v="$glibc" 'BEGIN{split(v,a,".");exit !(a[1]>2||(a[1]==2&&a[2]>=28))}'; then
    problem "This system is too old: glibc $glibc, and Node.js 22 needs 2.28 or newer (Ubuntu 20.04, Debian 10 or later)."
  fi
  # Disk: the app and Node under /opt, the speech models under /var/lib. Counted
  # per disk, so two folders on one disk add up.
  local need_opt=1024 need_var=2048 o v stage models
  installed && need_var=512 # the models are there already
  # What the downloads still to do take, from their pinned sizes: the biggest
  # archive staged under /opt, and the models they unpack to.
  read -r stage models <<<"$(disk_needed "$OPT" "$VAR/models" 2>/dev/null || echo "0 0")"
  [[ ${stage:-} =~ ^[0-9]+$ && ${models:-} =~ ^[0-9]+$ ]] || { stage=0 models=0; }
  [ $((stage + 400)) -le "$need_opt" ] || need_opt=$((stage + 400)) # plus the app and Node
  [ $((models + 100)) -le "$need_var" ] || need_var=$((models + 100))
  o=$(existing "$OPT") v=$(existing "$VAR")
  if [ "$(mount_of "$o")" = "$(mount_of "$v")" ]; then
    local have; have=$(free_mb "$o")
    ! [[ $have =~ ^[0-9]+$ ]] || [ "$have" -ge $((need_opt + need_var)) ] ||
      problem "Not enough free disk: $(gb "$have") free on the disk that holds /opt and /var/lib, and A.D.R.I.A.N. needs about $(gb $((need_opt + need_var))). Free some space (for example: sudo apt-get clean) and run this again."
  else
    local ho hv; ho=$(free_mb "$o") hv=$(free_mb "$v")
    ! [[ $ho =~ ^[0-9]+$ ]] || [ "$ho" -ge "$need_opt" ] || problem "Not enough free disk under /opt: $(gb "$ho") free, and the app needs about $(gb $need_opt). Free some space and run this again."
    ! [[ $hv =~ ^[0-9]+$ ]] || [ "$hv" -ge "$need_var" ] || problem "Not enough free disk under /var/lib: $(gb "$hv") free, and the speech models need about $(gb $need_var). Free some space and run this again."
  fi
  local mem_kb; mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null) || mem_kb=0
  [[ $mem_kb =~ ^[0-9]+$ ]] || mem_kb=0
  [ "$mem_kb" -gt $((4 * 1024 * 1024)) ] || warn "less than 4 GB of memory; she needs about 3.5 GB with the language voices on (the default), about 1.5 GB with them off (sudo adrian config languages false)"
  command -v ffmpeg >/dev/null || warn "ffmpeg not found; music stays off until it is installed ($(install_line ffmpeg))"
  if [ -n "$PORT" ] && ! [[ $PORT =~ ^[0-9]+$ && $PORT -ge 1 && $PORT -le 65535 ]]; then problem "--port $PORT isn't a port number (1-65535)."; fi
  if [ -n "$BUNDLE" ] && [ ! -f "$BUNDLE" ]; then problem "The bundle file isn't there: $BUNDLE"; fi
  [ -n "$BUNDLE" ] || [ "$CHECK" = 1 ] || problem "--bundle FILE is required (the adrian-voice-<version>-linux-x64.tar.gz from the Releases page)."
  # Last, and only if the rest is fine: a test of the line costs time.
  if [ ${#PROBLEMS[@]} -eq 0 ] && command -v curl >/dev/null; then
    local h
    for h in $(pending_hosts); do
      reachable "$h" || problem "Can't reach $h, where some of the downloads come from. Check that this computer is online and can look up names (try: curl -I https://$h). Behind a proxy? Run it as: sudo https_proxy=http://PROXY:PORT bash $0 ..."
    done
  fi
}

preflight
for w in "${WARNINGS[@]}"; do say "warning: $w"; done
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  printf '\nThis computer is not ready for A.D.R.I.A.N. yet. Nothing was changed. Fix:\n' >&2
  for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "$p" >&2; done
  printf 'Then run the same command again.\n' >&2
  exit 1
fi
if [ "$CHECK" = 1 ]; then say "This computer is ready for A.D.R.I.A.N."; exit 0; fi
CPUS=$(nproc 2>/dev/null || echo 1)
# Held until this script ends: the hourly update can't start under it.
take_update_lock

# The listen address: what an earlier install chose stays, unless asked otherwise.
OLD_HOST="" OLD_PORT=""
if [ -f "$ETC/config.json" ] && [ -x "$OPT/node/bin/node" ]; then
  read -r OLD_HOST OLD_PORT < <("$OPT/node/bin/node" -e '
    try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server||{};console.log(String(s.host||"-")+" "+String(s.port||"-"))}catch{console.log("- -")}' "$ETC/config.json") || true
  [ "$OLD_HOST" = - ] && OLD_HOST=""; [ "$OLD_PORT" = - ] && OLD_PORT=""
elif [ -f "$ETC/config.json" ]; then
  # Kept data without Node (after --uninstall --keep-data): the installer wrote
  # "server" first, so its first host and port are hers.
  OLD_HOST=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' "$ETC/config.json" | head -n 1)
  OLD_PORT=$(sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$ETC/config.json" | head -n 1)
fi
if [ -z "$PORT" ] && [[ $OLD_PORT =~ ^[0-9]+$ ]]; then PORT=$OLD_PORT; fi
# A port asked for that isn't hers already must be free.
if [ -n "$PORT" ] && [ "$PORT" != "$OLD_PORT" ] && ss -Hltn "sport = :$PORT" | grep -q .; then
  die "port $PORT is already used by another program. Nothing was changed. Pick a free one with --port N, or leave --port out to get the first free one from 8790."
fi
if [ -z "$PORT" ]; then
  for p in $(seq 8790 8799); do
    if ! ss -Hltn "sport = :$p" | grep -q .; then PORT=$p; break; fi
  done
  [ -n "$PORT" ] || die "ports 8790-8799 are all taken by other programs; run this again with --port N (a free port number)"
fi
if [ "$LAN" = 1 ]; then HOST=0.0.0.0
elif [ "$LAN" = 0 ]; then HOST=127.0.0.1
else HOST=${OLD_HOST:-127.0.0.1}; fi
if [ "$HOST" = 0.0.0.0 ]; then LAN=1; fi
[ "$LAN" = 1 ] && say "warning: --lan serves the admin login over plain HTTP on your network. Add a TLS cert/key under \"server.tls\" in $ETC/config.json, or use an SSH tunnel instead."
WAS_ACTIVE=0
systemctl is-active --quiet "$SERVICE" 2>/dev/null && WAS_ACTIVE=1

# --- the bundle: checked before anything is changed ---------------------------
if [ -f "$BUNDLE.sha256" ]; then
  (cd "$(dirname "$BUNDLE")" && sha256sum -c --status "$(basename "$BUNDLE").sha256") || die "the bundle doesn't match its checksum file, so it's damaged or not the real one. Nothing was changed. Download it again."
elif [ "$REQUIRE_SHA" = 1 ]; then
  die "there's no $(basename "$BUNDLE").sha256 next to the bundle, so it can't be checked (--require-checksum). Nothing was changed. Download the .sha256 from the same Releases page and put it next to the bundle."
else
  printf '[1mwarning:[0m %s
' "NOT CHECKED: there's no $(basename "$BUNDLE").sha256 next to the bundle, so a damaged or changed download would go unnoticed. Download the .sha256 from the same Releases page and put it next to the bundle (--require-checksum refuses to go on without one; get.sh always checks)." >&2
fi
VERSION=$(tar -xzOf - ./package.json <"$BUNDLE" 2>/dev/null | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -1) || true
[[ $VERSION =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ && $VERSION != *..* ]] || die "can't read the version from $BUNDLE; is the download complete? Nothing was changed."
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; } # newer A B: A is above B
if installed; then
  OLD_VERSION=$(basename "$(readlink -f "$OPT/current")")
  if [ "$DOWNGRADE" = 0 ] && newer "$OLD_VERSION" "$VERSION"; then
    die "this bundle is version $VERSION, older than the $OLD_VERSION already installed. Nothing was changed. To get the newest: sudo adrian update. To go back one version: sudo adrian rollback. To install this one anyway, add --allow-downgrade."
  fi
fi

say "Installing A.D.R.I.A.N. voice $VERSION (native, $CPUS CPU threads) with admin UI on $HOST:$PORT"

# --- manifest bookkeeping ---------------------------------------------------
CREATED_USER=false
if [ -f "$MANIFEST" ] && grep -q '"createdUser": true' "$MANIFEST"; then CREATED_USER=true; fi

# --- user and directories ----------------------------------------------------
if ! id adrian >/dev/null 2>&1; then
  say "Creating system user adrian"
  useradd --system --user-group --home-dir "$VAR" --no-create-home --shell /usr/sbin/nologin adrian
  CREATED_USER=true
fi
install -d -m 0755 "$OPT" "$OPT/releases"
rm -rf "$OPT"/.install-* # left by an install that was cut off
refuse_symlinks "$ETC" "$VAR" "$VAR/models"
install -d -m 0750 -o adrian -g adrian "$ETC" "$VAR"
# Root's from the start, so the service account never gets to plant links in it.
install -d -m 0750 -o root -g adrian "$VAR/models"

# --- downloads (verified) ---------------------------------------------------
# On the same disk as the app, which the preflight measured: /tmp is often a
# small RAM disk, too small for the speech model archives.
TMP=$(mktemp -d "$OPT/.install-XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# --- Node.js runtime -----------------------------------------------------------
install_node "$OPT" "$TMP"

# --- app release ---------------------------------------------------------------
say "Unpacking the app"
mkdir -p "$TMP/app"
tar -xzf - -C "$TMP/app" --no-same-owner <"$BUNDLE" || die "can't unpack $BUNDLE; is the download complete?"
rm -rf "$OPT/releases/$VERSION.new"
mv "$TMP/app" "$OPT/releases/$VERSION.new"
chown -R root:root "$OPT/releases/$VERSION.new"
chmod -R go-w "$OPT/releases/$VERSION.new"
chmod 0755 "$OPT/releases/$VERSION.new"
rm -rf "$OPT/releases/$VERSION"
mv -T "$OPT/releases/$VERSION.new" "$OPT/releases/$VERSION"
ln -sfn "releases/$VERSION" "$OPT/current"

# --- speech models ---------------------------------------------------------------
install_models "$VAR/models" "$TMP"
chown -R root:adrian "$VAR/models"
chmod -R u=rwX,g=rX,o= "$VAR/models"

# --- config ------------------------------------------------------------------------
TZ_NAME=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
[ -n "$TZ_NAME" ] || TZ_NAME=UTC
# Before anything is written: a dangling link would be followed and created as root.
refuse_symlinks "$ETC/config.json" "$ETC/secrets.env"
if [ ! -f "$ETC/config.json" ]; then
  cat >"$ETC/config.json" <<EOF
{
  "server": { "host": "$HOST", "port": $PORT },
  "timezone": "$TZ_NAME",
  "secretsFile": "$ETC/secrets.env"
}
EOF
elif [ "$HOST:$PORT" != "$OLD_HOST:$OLD_PORT" ]; then
  # Keep everything else; the listen address changes only when asked on the command line.
  "$OPT/node/bin/node" -e '
    const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));
    c.server={...(c.server||{}),host:process.argv[2],port:Number(process.argv[3])};
    fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$ETC/config.json" "$HOST" "$PORT" ||
    die "$ETC/config.json can't be read (is it valid JSON?). Fix or remove it, then run this again."
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
# An update that was cut off (power cut, killed) left a note for the next
# `adrian update` to judge. This install has taken its place: judged later, it
# would roll this release back for that update's sake, or undo what this put in.
MARK=$OPT/update-in-progress
if [ -f "$MARK" ]; then
  refuse_symlinks "$MARK"
  read -r m_old m_new _ <"$MARK" || true
  say "An update (${m_old:-?} -> ${m_new:-?}) had been cut off; this install takes its place."
  if [[ ${m_new:-} =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ && $m_new != *..* && $m_new != "$VERSION" ]] &&
    [ "$(basename "$(readlink -f "$OPT/previous" 2>/dev/null)")" != "$m_new" ]; then
    rm -rf "${OPT:?}/releases/$m_new"
  fi
  rm -f "$MARK" "$MARK.unit"
fi
rm -rf "$OPT"/.update-* "$OPT"/.prep-* # an update's leftovers; none runs while this holds the lock

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

# Why the service didn't answer, in words, after its log.
explain_down() {
  local log; log=$(journalctl -u "$SERVICE" -n 200 --no-pager -o cat 2>/dev/null || true)
  if grep -q 'EADDRINUSE' <<<"$log"; then
    echo "Port $PORT is taken by another program. Run this again with --port N (for example --port $((PORT + 1)))."
  elif [ "$(systemctl show -p Result --value "$SERVICE" 2>/dev/null)" = oom-kill ] || grep -qi 'out of memory' <<<"$log"; then
    echo "It ran out of memory. Close other programs, or turn the language voices off: sudo adrian config languages false"
  else
    echo "The service did not come up; the log above says why. sudo adrian doctor checks the usual causes."
  fi
}

# Where she answers, as the config says: http or https (server.tls), and the
# address she listens on (one that means "all of them" is reached on loopback).
read -r PROTO REACH < <("$OPT/node/bin/node" -e '
  let s={};try{s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).server||{}}catch{}
  let h=String(s.host||"127.0.0.1");if(h==="0.0.0.0")h="127.0.0.1";else if(h==="::")h="::1";
  console.log((s.tls?"https":"http")+" "+(h.includes(":")?"["+h+"]":h))' "$ETC/config.json" 2>/dev/null) || true
[ -n "${PROTO:-}" ] || PROTO=http
[ -n "${REACH:-}" ] || REACH=127.0.0.1

if [ "$START" = 1 ]; then
  say "Starting the service"
  systemctl enable --quiet "$SERVICE"
  # Running from before: it has to restart to run what was just installed.
  if [ "$WAS_ACTIVE" = 1 ]; then systemctl restart "$SERVICE"; else systemctl start "$SERVICE"; fi
  # Her health answer, whatever its status: a 503 is a bot that failed to start
  # (a bad token, say), which the admin page and the doctor explain. Only her
  # own answer counts, not another program's on that port. -k: a TLS admin page
  # usually has a certificate of its own making, and this asks only for her state.
  body=""
  for _ in $(seq 1 60); do
    body=$(curl -s -k --max-time 3 "$PROTO://$REACH:$PORT/api/health" 2>/dev/null) || true
    if grep -q '"state":' <<<"$body"; then break; fi
    body=""
    sleep 1
  done
  if [ -z "$body" ]; then journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true; die "$(explain_down)"; fi
  grep -q '"state":"failed"' <<<"$body" && say "warning: the admin page is up, but the bot itself didn't start. Open the admin page, or run: sudo adrian doctor"
fi

echo
say "Installed A.D.R.I.A.N. voice $VERSION"
if [ "$LAN" = 1 ]; then SHOWN=$(hostname -I 2>/dev/null | awk '{print $1}') || true; else SHOWN=$REACH; fi
echo "    Admin UI:   $PROTO://${SHOWN:-$REACH}:$PORT/"
# Only for an admin page on this machine alone: one on a chosen address is reached there.
if [ "$LAN" != 1 ] && { [ "$REACH" = 127.0.0.1 ] || [ "$REACH" = "[::1]" ] || [ "$REACH" = localhost ]; }; then
  echo "    From another computer: ssh -L $PORT:$REACH:$PORT ${SUDO_USER:-<user>}@<this-server>, then open $PROTO://localhost:$PORT/"
fi
[ "$START" = 1 ] && { echo -n "    "; "$CLI" setup-code 2>/dev/null || true; }
echo "    Then follow the setup wizard. Status: sudo adrian status"
