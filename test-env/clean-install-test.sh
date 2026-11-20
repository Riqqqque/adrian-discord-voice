#!/usr/bin/env bash
# Clean-install test, run inside a throwaway systemd container:
# snapshot → install.sh (Recommended options) → service + API checks
# (invalid Discord token must be rejected) → backup → uninstall → snapshot diff.
#
#   clean-install-test.sh /rel/<bundle>.tar.gz      (download cache mounted at /dl)

set -uo pipefail
# A deliberately invalid, token-shaped value (built here so secret scanners
# don't mistake it for a real token): Discord must reject it.
FAKE_TOKEN="MTAwMDAwMDAwMDAwMDAwMDAw.AAAAAA.$(printf 'invalid%.0s' 1 2 3 4)123"
BUNDLE=$1
PASS=0 FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

snapshot() {
  find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/tmp \
    -o -path /var/log -o -path /var/cache -o -path /var/lib/systemd -o -path /var/lib/apt -o -path /root \) -prune -o -print 2>/dev/null | sort
  getent passwd | cut -d: -f1 | sed 's/^/user:/'
  getent group | cut -d: -f1 | sed 's/^/group:/'
}

echo "== $(. /etc/os-release; echo "$PRETTY_NAME"), $(getconf GNU_LIBC_VERSION), systemd $(systemctl --version | head -1 | awk '{print $2}')"
systemctl is-system-running --wait >/dev/null 2>&1 || true
snapshot >/tmp/before.txt

mkdir -p /tmp/inst && tar -xzf "$BUNDLE" -C /tmp/inst ./packaging
check "install.sh --check: machine ready, nothing changed" bash -c "ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/inst/packaging/install.sh --check | grep -q 'ready for A.D.R.I.A.N.' && [ ! -e /opt/adrian ]"
t0=$(date +%s)
ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/inst/packaging/install.sh --yes --mode native --profile recommended --bundle "$BUNDLE" >/tmp/install.log 2>&1
rc=$?
echo "install exit $rc in $(( $(date +%s) - t0 )) s"; sed 's/^/  | /' /tmp/install.log | grep -v "Setup code" | tail -12
[ $rc = 0 ] && ok "install.sh --yes" || bad "install.sh --yes"

check "service active" systemctl is-active adrian-voice
check "service enabled" systemctl is-enabled adrian-voice
check "runs as adrian" bash -c '[ "$(ps -o user= -p "$(systemctl show -p MainPID --value adrian-voice)")" = adrian ]'
check "secrets.env 0600 adrian" bash -c '[ "$(stat -c "%a %U" /etc/adrian/secrets.env)" = "600 adrian" ]'
check "UI on loopback only" bash -c 'ss -Hltn | grep -q "127.0.0.1:8790 " && ! ss -Hltn | grep -q "0.0.0.0:8790 "'
check "manifest written" test -f /var/lib/adrian/install-manifest.json
check "no download leftovers" bash -c '! ls -d /opt/adrian/.install-* 2>/dev/null | grep -q .'
check "unit verifies" systemd-analyze verify /etc/systemd/system/adrian-voice.service
echo "  security exposure: $(systemd-analyze security adrian-voice 2>/dev/null | tail -1)"

BASE=http://127.0.0.1:8790
J=/tmp/jar
check "health ok (setup)" bash -c "curl -fsS $BASE/api/health | grep -q '\"state\":\"setup\"'"
code=$(adrian setup-code | sed -n 's/^Setup code: \([A-Z0-9-]*\).*/\1/p')
[ -n "$code" ] && ok "adrian setup-code" || bad "adrian setup-code"
claim=$(curl -sS -c $J -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$code\",\"username\":\"admin\",\"password\":\"container-test-pass-1\"}" $BASE/api/setup/claim)
csrf=$(sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' <<<"$claim")
[ -n "$csrf" ] && ok "admin claimed with setup code" || bad "admin claim: $claim"
check "setup code single use" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: $BASE' -H 'Content-Type: application/json' -d '{\"code\":\"$code\",\"username\":\"x\",\"password\":\"container-test-pass-2\"}' $BASE/api/setup/claim)\" = 404 ]"
# Deliberately invalid, token-shaped value: Discord must reject it and it must not be stored.
r=$(curl -sS -b $J -H "Origin: $BASE" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$FAKE_TOKEN\"}" $BASE/api/check/discord)
echo "  discord check: $r"
grep -q '"ok":false' <<<"$r" && grep -q 'rejected' <<<"$r" && ok "invalid Discord token rejected" || bad "invalid Discord token rejected"
check "invalid token not saved" bash -c "! grep -q DISCORD_TOKEN /etc/adrian/secrets.env"
t1=$(date +%s%N)
check "voice preview under service hardening (Kokoro)" bash -c "curl -fsS -b $J -o /tmp/p.wav '$BASE/api/voice-preview?voice=am_michael&speed=1' && [ \$(stat -c %s /tmp/p.wav) -gt 50000 ]"
echo "  preview took $(( ($(date +%s%N) - t1) / 1000000 )) ms, service memory $(systemctl show -p MemoryCurrent --value adrian-voice | awk '{ if ($1 ~ /^[0-9]+$/) printf "%d MiB", $1/1048576; else print "unknown" }')"
check "settings save" bash -c "curl -fsS -b $J -X PUT -H 'Origin: $BASE' -H 'X-CSRF-Token: $csrf' -H 'Content-Type: application/json' -d '{\"voice\":{\"voice\":\"am_michael\",\"speed\":1},\"limits\":{\"perUserPerHour\":30,\"dailyUsd\":1,\"monthlyUsd\":10,\"maxRequestChars\":600}}' $BASE/api/settings"
echo "  doctor:"; adrian doctor 2>&1 | sed 's/^/  | /'
check "no seccomp/permission errors in journal" bash -c "! journalctl -u adrian-voice --no-pager | grep -qiE 'SIGSYS|seccomp|EPERM|Operation not permitted|EACCES'"
# Full stack with fake credentials: speech models must load under the unit's
# hardening; Discord login must then fail cleanly (state "failed", health 503).
printf '%s' "$FAKE_TOKEN" | adrian secret set DISCORD_TOKEN >/dev/null
printf 'gsk_fakefakefakefakefakefake0000' | adrian secret set GROQ_API_KEY >/dev/null
curl -fsS -b $J -X PUT -H "Origin: $BASE" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' \
  -d '{"guildId":"100000000000000000","channelId":"100000000000000001","llm":{"preset":"groq"},"fallback":{"preset":"none"},"search":false}' $BASE/api/settings >/dev/null
check "config complete" adrian check
r=$(curl -sS -b $J -X POST -H "Origin: $BASE" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' -d '{}' $BASE/api/restart)
echo "  full start: $r"
check "ASR loaded under hardening" bash -c "journalctl -u adrian-voice --no-pager -o cat | grep -q '\"msg\":\"asr loaded\"'"
check "TTS loaded under hardening" bash -c "journalctl -u adrian-voice --no-pager -o cat | grep -q '\"msg\":\"tts loaded and calibrated\"'"
check "fake token fails cleanly" bash -c "grep -q '\"state\":\"failed\"' <<<'$r' && [ \"\$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/health)\" = 503 ]"
echo "  service memory with models: $(systemctl show -p MemoryCurrent --value adrian-voice | awk '{ if ($1 ~ /^[0-9]+$/) printf "%d MiB", $1/1048576; else print "unknown" }')"
journalctl -u adrian-voice --no-pager -o cat | grep -E '"(asr loaded|tts loaded and calibrated|opus|voice stack failed to start)"' | cut -c1-160 | sed 's/^/  | /'
systemctl restart adrian-voice; sleep 30
check "restart with bad token: process stays up (no crash loop)" bash -c "systemctl is-active adrian-voice && [ \"\$(systemctl show -p NRestarts --value adrian-voice)\" = 0 ] && curl -s $BASE/api/health | grep -q '\"state\":\"failed\"'"
echo "  doctor on a failed start:"; adrian doctor >/tmp/doctor.txt 2>&1; sed 's/^/  | /' /tmp/doctor.txt | grep -E 'FAIL|what to do|belong' | cut -c1-200
check "doctor explains the failed start" bash -c "grep -q 'what to do: Discord rejected the bot token' /tmp/doctor.txt"
check "doctor: her files belong to her" grep -q 'ok    her files belong to her' /tmp/doctor.txt
# Running the installer again over a live install: same port, same address, the
# service restarted on the new files, the admin account kept.
ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/inst/packaging/install.sh --yes --bundle "$BUNDLE" >/tmp/reinstall.log 2>&1
rc=$?
sed 's/^/  | /' /tmp/reinstall.log | tail -4
check "install.sh again over a live install" [ $rc = 0 ]
check "  keeps port 8790 on loopback" bash -c "grep -q '\"port\": 8790' /etc/adrian/config.json && ss -Hltn | grep -q '127.0.0.1:8790 '"
check "  keeps the admin account" bash -c "adrian setup-code 2>&1 | grep -q 'already exists'"
check "  keeps the keys" bash -c "adrian secret list | grep -q DISCORD_TOKEN"
# Again, with the admin page on this machine's own address only and over TLS
# (a certificate of its own making): the installer has to find her there.
IP=$(hostname -I | awk '{print $1}')
setjson() { /opt/adrian/node/bin/node -e 'const fs=require("fs"),f="/etc/adrian/config.json",c=JSON.parse(fs.readFileSync(f,"utf8"));c.server=JSON.parse(process.argv[1]);fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$1"; }
if command -v openssl >/dev/null && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP" -addext "basicConstraints=critical,CA:FALSE" \
  -keyout /etc/adrian/tls.key -out /etc/adrian/tls.crt >/dev/null 2>&1; then
  chown adrian:adrian /etc/adrian/tls.key /etc/adrian/tls.crt; chmod 0600 /etc/adrian/tls.key
  setjson "{\"host\":\"$IP\",\"port\":8790,\"tls\":{\"cert\":\"/etc/adrian/tls.crt\",\"key\":\"/etc/adrian/tls.key\"}}"
  systemctl restart adrian-voice
  ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/inst/packaging/install.sh --yes --bundle "$BUNDLE" >/tmp/reinstall-tls.log 2>&1
  rc=$?
  sed 's/^/  | /' /tmp/reinstall-tls.log | tail -3
  check "install.sh again, admin page on $IP over TLS" [ $rc = 0 ]
  check "  she answers there over https" bash -c "curl -sk https://$IP:8790/api/health | grep -q '\"state\":'"
  check "  and says that address" grep -q "Admin UI:   https://$IP:8790/" /tmp/reinstall-tls.log
  check "  adrian url says so too" bash -c "[ \"\$(adrian url)\" = https://$IP:8790/ ]"
  # Back to plain loopback for the rest.
  setjson '{"host":"127.0.0.1","port":8790}'
  rm -f /etc/adrian/tls.key /etc/adrian/tls.crt
  systemctl restart adrian-voice
else
  bad "openssl can't make a test certificate here"
fi
check "backup" adrian backup /tmp/b.tar.gz
check "backup has no models" bash -c "! tar -tzf /tmp/b.tar.gz | grep -q models/"
check "backup is 0600" bash -c '[ "$(stat -c %a /tmp/b.tar.gz)" = 600 ]'
echo "  log leak check:"
journalctl -u adrian-voice --no-pager -o cat > /tmp/journal.txt
check "journal has no setup code or token" bash -c "! grep -qE '${code:-NO-CODE-SEEN}|invalidinvalid|argon2id' /tmp/journal.txt"

adrian uninstall --yes >/tmp/uninstall.log 2>&1 && ok "adrian uninstall" || { bad "adrian uninstall"; cat /tmp/uninstall.log; }
snapshot >/tmp/after.txt
d=$(diff /tmp/before.txt /tmp/after.txt)
if [ -z "$d" ]; then ok "uninstall leaves no trace (files, users, groups)"; else bad "leftovers after uninstall:"; echo "$d" | head -20; fi
check "unit gone" bash -c "! systemctl cat adrian-voice"
echo "== $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
