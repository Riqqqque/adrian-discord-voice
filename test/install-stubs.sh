# Stand-ins for the parts of a real server install.sh talks to (test/install.test.ts).
id() { case "$1" in -u) echo "${UID_IS:-0}" ;; adrian) [ -f users ] ;; *) return 1 ;; esac; }
useradd() { echo "useradd $*" >>calls.log; touch users; }
uname() { if [ "$1" = -m ]; then echo "${ARCH:-x86_64}"; else echo Linux; fi; }
# GETCONF=fail: musl's getconf (it has no GNU_LIBC_VERSION); GETCONF=missing: no getconf at all.
# LDD: the first line ldd --version prints (none set: no ldd either).
getconf() { case "${GETCONF:-}" in fail) return 1 ;; missing) return 127 ;; esac; echo "glibc ${GLIBC:-2.39}"; }
ldd() { [ -n "${LDD:-}" ] || return 127; echo "$LDD" >&2; return 1; }
df() {
  [ -z "${DF_FAILS:-}" ] || return 1
  local d; for d; do :; done
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
  case "$d" in */var*) echo "fs 1 1 $(( ${VAR_MB:-50000} * 1024 )) 1% ${VAR_MOUNT:-/}" ;; *) echo "fs 1 1 $(( ${OPT_MB:-50000} * 1024 )) 1% /" ;; esac
}
ss() { local p=${2##*:}; if grep -qx "$p" listening 2>/dev/null; then echo "LISTEN 0 0 127.0.0.1:$p"; fi; return 0; }
install() {
  if [ "$1" = -d ]; then shift; while [[ $1 == -* ]]; do shift 2; done; mkdir -p "$@"; return; fi
  cp "$3" "$4"
}
chown() { :; }
chmod() { :; }
runuser() { :; }
systemd-analyze() { :; }
journalctl() { cat journal 2>/dev/null || true; }
timedatectl() { echo UTC; }
hostname() { echo 192.0.2.10; }
sleep() { :; }
# Where she answers once started, as her config says: "PROTO HOST PORT".
serve() {
  local port host proto=http
  port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' etc/config.json | head -1)
  host=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' etc/config.json | head -1)
  if grep -q '"tls"' etc/config.json; then proto=https; fi
  echo "$proto ${host:-127.0.0.1} $port" >serving
}
systemctl() {
  echo "systemctl $*" >>calls.log
  case "$1" in
    is-active) [ -f active ] && [ "${*: -1}" = adrian-voice ] ;;
    start|restart) touch active; serve ;;
    enable) [[ " $* " == *" --now "* ]] && { touch active; [ -f serving ] || serve; }; return 0 ;;
    show) echo ;;
  esac
}
# She answers only where she listens: her scheme, her address (listening on all
# of them takes loopback too) and her port; over TLS, only to a client that
# accepts a certificate of her own making (curl -k).
answers() {
  local url=$1 insecure=$2 proto host port
  read -r proto host port <serving 2>/dev/null || return 1
  [[ $url =~ ^(https?)://(\[[^]]*\]|[^:/]+):([0-9]+)/ ]] || return 1
  [ "${BASH_REMATCH[1]}" = "$proto" ] && [ "${BASH_REMATCH[3]}" = "$port" ] || return 1
  [ "${BASH_REMATCH[2]}" = "$host" ] || { [ "$host" = 0.0.0.0 ] && [ "${BASH_REMATCH[2]}" = 127.0.0.1 ]; } || return 1
  [ "$proto" = http ] || [ "$insecure" = 1 ]
}
curl() {
  local a url= insecure=0
  for a; do
    case "$a" in http*) url=$a ;; -k|--insecure) insecure=1 ;; --*) ;; -*k*) insecure=1 ;; esac
  done
  case "$url" in
    */api/health) if [ -n "${FOREIGN_ANSWER:-}" ]; then printf '<html>some other program</html>'; elif [ -f active ] && answers "$url" "$insecure"; then printf '{"ok":true,"state":"%s"}' "$(cat health-state 2>/dev/null || echo setup)"; else return 7; fi ;;
    https://*) local h; h=$(sed -E 's#https://([^/]+)/.*#\1#' <<<"$url"); if grep -qx "$h" offline 2>/dev/null; then printf 000; return 7; fi; printf 200 ;;
    *) return 22 ;;
  esac
}
export -f id useradd uname getconf ldd df ss install chown chmod runuser systemd-analyze journalctl timedatectl hostname sleep serve systemctl answers curl
