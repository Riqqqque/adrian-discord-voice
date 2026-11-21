#!/usr/bin/env bash
# Install A.D.R.I.A.N. (Discord voice) in one step, on a Linux computer:
#
#   curl -fsSLO https://raw.githubusercontent.com/Riqqqque/adrian-discord-voice/main/packaging/get.sh
#   sudo bash get.sh
#
# It installs the system packages it needs (asking first), finds the newest
# release on GitHub, downloads it with its checksum, checks it, and runs the
# installer inside it. Already installed? Then it updates instead.
#
# Options of its own (anything else goes to the installer, e.g. --lan, --port N):
#   --version X.Y.Z   install that release instead of the newest
#   --yes             don't ask questions (installs missing packages too)
#   --no-packages     never install system packages; only say which are missing
#   --reinstall       run the installer even if A.D.R.I.A.N. is installed (repairs it)
#
# ADRIAN_UPDATE_REPO=owner/name takes releases from another GitHub repository.

set -euo pipefail
umask 022
REPO=${ADRIAN_UPDATE_REPO:-Riqqqque/adrian-discord-voice}
CLI=/usr/local/bin/adrian
OPT=/opt/adrian
WORK=/var/cache/adrian-get
RUN_SYSTEMD=/run/systemd/system

VERSION="" YES=0 PACKAGES=1 REINSTALL=0 PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift ;;
    --yes|-y) YES=1; PASS+=("$1") ;;
    --no-packages) PACKAGES=0 ;;
    --reinstall) REINSTALL=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) PASS+=("$1") ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
ask() { # ask "question" default(y/n)
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || [ -e /dev/tty ] || return 1
  local a; read -r -p "$1 [$( [ "$2" = y ] && echo Y/n || echo y/N )] " a </dev/tty || true
  a=${a:-$2}; [[ $a =~ ^[Yy] ]]
}

[ "$(id -u)" = 0 ] || die "run it as root: sudo bash $0${PASS[*]:+ ${PASS[*]}}"
[ "$(uname -s)" = Linux ] || die "this installs on Linux. On Windows, install the PC app instead (see the README)."
# Before any package or download: the installer would refuse these anyway.
case "$(uname -m)" in
  x86_64) ;;
  *) die "this computer's processor ($(uname -m)) isn't supported: A.D.R.I.A.N. runs only on 64-bit Intel or AMD computers (x86_64) for now. Nothing was changed." ;;
esac
[ -d "$RUN_SYSTEMD" ] ||
  die "systemd isn't running here, and the install needs it (on WSL: add [boot] and systemd=true to /etc/wsl.conf, then wsl --shutdown). In a container, use the Docker install instead. Nothing was changed."

# --- already installed: update instead --------------------------------------
if [ "$REINSTALL" = 0 ] && [ -x "$CLI" ] && [ -e "$OPT/current" ]; then
  say "A.D.R.I.A.N. is already installed (version $(basename "$(readlink -f "$OPT/current")")). Updating it instead."
  say "(To repair the install instead, run: sudo bash $0 --reinstall)"
  if [ -n "$VERSION" ]; then die "to install a particular version over an existing one, download its bundle and run: sudo adrian update FILE"; fi
  exec "$CLI" update
fi

# --- system packages ------------------------------------------------------------
pm=""; command -v apt-get >/dev/null && pm=apt; [ -z "$pm" ] && command -v dnf >/dev/null && pm=dnf
# What the install can't do without, and ffmpeg, which only music needs. They go
# in apart: ffmpeg isn't in every distribution's own sources (RHEL, Rocky and
# Alma have none; Fedora's own is ffmpeg-free, and ffmpeg itself is in RPM
# Fusion), and dnf refuses a whole install over one missing package.
need=() want=()
for c in curl tar gzip sha256sum xz bzip2 ss; do
  command -v "$c" >/dev/null && continue
  case "$pm:$c" in
    apt:xz) need+=(xz-utils) ;; apt:ss) need+=(iproute2) ;; dnf:ss) need+=(iproute) ;;
    *:sha256sum) need+=(coreutils) ;; *) need+=("$c") ;;
  esac
done
command -v ffmpeg >/dev/null || want+=(ffmpeg)
missing=(${need[@]+"${need[@]}"} ${want[@]+"${want[@]}"})
pkgs() { # pkgs PKG...: install them with this system's package manager
  if [ "$pm" = apt ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; else dnf install -y -q "$@"; fi
}
if [ ${#missing[@]} -gt 0 ]; then
  if [ "$PACKAGES" = 1 ] && [ -n "$pm" ] && ask "Install the system packages A.D.R.I.A.N. needs (${missing[*]})?" y; then
    if [ "$pm" = apt ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq || die "apt-get update failed: is this computer online? Then run the same command again."
    fi
    if [ ${#need[@]} -gt 0 ]; then
      say "Installing ${need[*]}"
      pkgs "${need[@]}" || die "installing ${need[*]} failed; the lines above say why. Fix that and run the same command again."
    fi
    if [ ${#want[@]} -gt 0 ]; then
      say "Installing ffmpeg (for music)"
      if ! pkgs ffmpeg && ! { [ "$pm" = dnf ] && pkgs ffmpeg-free; }; then
        if [ "$pm" = dnf ]; then
          say "warning: ffmpeg isn't in this system's package sources (on Fedora, RHEL, Rocky or Alma it comes with RPM Fusion: https://rpmfusion.org). Everything else goes ahead; music stays off until ffmpeg is installed."
        else
          say "warning: ffmpeg couldn't be installed. Everything else goes ahead; music stays off until it is: sudo apt-get install ffmpeg"
        fi
      fi
    fi
  else
    say "warning: missing system packages: ${missing[*]}. The installer will say which ones it can't do without."
  fi
fi
for c in curl tar gzip sha256sum; do
  command -v "$c" >/dev/null || die "$c is needed to download and check the release. Install it and run the same command again."
done

# --- which release ------------------------------------------------------------
# The API answers 60 times an hour per address; the web page's redirect has no
# such limit, so it's the way round a "rate limited" answer.
latest() {
  local json tag url
  if json=$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null); then
    tag=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' <<<"$json" | head -n 1)
  fi
  if [ -z "${tag:-}" ]; then
    url=$(curl -fsSL --max-time 20 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null) || return 1
    tag=${url##*/tag/}
    [ "$tag" != "$url" ] || return 1
  fi
  echo "${tag#v}"
}
if [ -z "$VERSION" ]; then
  VERSION=$(latest) || die "can't reach GitHub to find the newest release. Check that this computer is online (try: curl -I https://github.com), then run the same command again."
fi
[[ $VERSION =~ ^[0-9][0-9A-Za-z.+-]*$ && $VERSION != *..* ]] || die "\"$VERSION\" isn't a release version (like 1.2.3)"

# --- download and check -----------------------------------------------------------
# Root's own folder on disk (not /tmp, often a small RAM disk). Kept until the
# install succeeds, so running it again after a fix doesn't download it again.
[ ! -L "$WORK" ] || die "$WORK is a symbolic link; refusing to continue"
install -d -m 0700 "$WORK"
name="adrian-voice-$VERSION-linux-x64.tar.gz"
base="https://github.com/$REPO/releases/download/v$VERSION"
cd "$WORK"
rm -f "$name.sha256"
curl -fsSL --max-time 60 -o "$name.sha256" "$base/$name.sha256" ||
  die "can't download the checksum for version $VERSION. Is that a published release, and is this computer online? Then run the same command again."
if ! { [ -f "$name" ] && sha256sum -c --status "$name.sha256" 2>/dev/null; }; then
  say "Downloading A.D.R.I.A.N. $VERSION"
  rm -f "$name"
  curl -fL --retry 3 --connect-timeout 30 --speed-time 60 --speed-limit 1024 -o "$name" "$base/$name" ||
    die "the download of $name stopped. Check the internet connection and run the same command again."
  sha256sum -c --status "$name.sha256" ||
    { rm -f "$name"; die "the download doesn't match its published checksum, so it's damaged or was changed on the way. Nothing was installed. Run the same command again."; }
fi
say "Checked $name against its published checksum"
rm -rf inst && mkdir inst
tar -xzf "$name" -C inst ./packaging || die "can't unpack $name; run the same command again"

# --- install ------------------------------------------------------------------
rc=0
bash inst/packaging/install.sh --bundle "$WORK/$name" ${PASS[@]+"${PASS[@]}"} || rc=$?
if [ "$rc" = 0 ]; then
  cd / && rm -rf "$WORK"
else
  echo "The download is kept in $WORK, so running the same command again starts from there." >&2
fi
exit "$rc"
