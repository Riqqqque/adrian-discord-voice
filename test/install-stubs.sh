# Stand-ins for the parts of a real server install.sh talks to (test/install.test.ts).
id() { case "$1" in -u) echo "${UID_IS:-0}" ;; adrian) [ -f users ] ;; *) return 1 ;; esac; }
useradd() { echo "useradd $*" >>calls.log; touch users; }
uname() { if [ "$1" = -m ]; then echo "${ARCH:-x86_64}"; else echo Linux; fi; }
getconf() { echo "glibc ${GLIBC:-2.39}"; }
df() {
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
systemctl() {
  echo "systemctl $*" >>calls.log
  case "$1" in
    is-active) [ -f active ] ;;
    start|restart) touch active; sed -n 's/.*"port": *\([0-9]*\).*/\1/p' etc/config.json | head -1 >serving ;;
    enable) [[ " $* " == *" --now "* ]] && { touch active; [ -f serving ] || sed -n 's/.*"port": *\([0-9]*\).*/\1/p' etc/config.json | head -1 >serving; }; return 0 ;;
    show) echo ;;
  esac
  return 0
}
curl() {
  local a url=
  for a; do case "$a" in http*) url=$a ;; esac; done
  case "$url" in
    */api/health) [ -f active ] && [ "$(cat serving 2>/dev/null)" = "$(sed -E 's#.*:([0-9]+)/api/health#\1#' <<<"$url")" ] ;;
    https://*) local h; h=$(sed -E 's#https://([^/]+)/.*#\1#' <<<"$url"); if grep -qx "$h" offline 2>/dev/null; then printf 000; return 7; fi; printf 200 ;;
    *) return 22 ;;
  esac
}
export -f id useradd uname getconf df ss install chown chmod runuser systemd-analyze journalctl timedatectl hostname sleep systemctl curl
