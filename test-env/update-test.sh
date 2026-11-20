#!/usr/bin/env bash
# Update/rollback test, run inside a throwaway systemd container.
# Makes two extra bundles from the real one: a healthy 0.1.1-test and a
# broken 0.1.2-bad (its entry point exits at once), then:
#   install <bundle> → update 0.1.1 → update 0.1.2-bad (must roll back to 0.1.1)
#   → rollback (to the bundle's version) → data kept throughout → uninstall.
# Every update here is run by the installed bundle's own `adrian`.
#
#   update-test.sh /rel/<bundle>.tar.gz      (download cache at /dl)

set -uo pipefail
BUNDLE=$1
PASS=0 FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
ver() { adrian version 2>/dev/null; }

systemctl is-system-running --wait >/dev/null 2>&1 || true
mkdir -p /tmp/inst /tmp/b && tar -xzf "$BUNDLE" -C /tmp/inst ./packaging
V0=$(tar -xzOf "$BUNDLE" ./package.json | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -n 1)
# Nothing an update leaves behind once it's over: no note, no temp folders.
clean_after() { [ ! -e /opt/adrian/update-in-progress ] && ! ls -d /opt/adrian/.update-* /opt/adrian/.prep-* /opt/adrian/.install-* 2>/dev/null | grep -q .; }

# Variant bundles (the version lives in package.json).
mk() { # mk <version> <break?>
  rm -rf /tmp/v && mkdir /tmp/v && tar -xzf "$BUNDLE" -C /tmp/v
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$1\"/" /tmp/v/package.json
  [ "$2" = break ] && printf 'process.exit(1);\n' >/tmp/v/dist/app/main.js
  tar -czf "/tmp/b/adrian-voice-$1-linux-x64.tar.gz" -C /tmp/v .
  (cd /tmp/b && sha256sum "adrian-voice-$1-linux-x64.tar.gz" >"adrian-voice-$1-linux-x64.tar.gz.sha256")
}
mk 0.1.1-test keep
mk 0.1.2-bad break

ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/inst/packaging/install.sh --yes --bundle "$BUNDLE" >/tmp/install.log 2>&1 && ok "install $V0" || { bad "install"; tail /tmp/install.log; }
check "version $V0" test "$(adrian version)" = "$V0"
adrian setup-code >/dev/null   # creates state that must survive updates
printf 'kept-value-1234567890' | adrian secret set TEST_KEEP >/dev/null

out=$(adrian update /tmp/b/adrian-voice-0.1.1-test-linux-x64.tar.gz 2>&1); echo "$out" | sed 's/^/  | /'
check "update to 0.1.1-test" bash -c '[ "$(adrian version)" = 0.1.1-test ]'
check "healthy after update" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"0.1.1-test\""'
check "nothing left of the update (note, temp folders)" clean_after
check "update lock in place" test -f /opt/adrian/update.lock

t0=$(date +%s)
out=$(adrian update /tmp/b/adrian-voice-0.1.2-bad-linux-x64.tar.gz 2>&1); rc=$?; echo "$out" | sed 's/^/  | /'
echo "  bad update took $(( $(date +%s) - t0 )) s, exit $rc"
check "bad update reports failure" test $rc -ne 0
check "auto rollback to 0.1.1-test" bash -c '[ "$(adrian version)" = 0.1.1-test ]'
check "healthy after auto rollback" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"0.1.1-test\""'
check "broken release removed" bash -c "! test -e /opt/adrian/releases/0.1.2-bad"
check "nothing left of the failed update either" clean_after

out=$(adrian rollback 2>&1); echo "$out" | sed 's/^/  | /'
check "manual rollback to $V0" test "$(adrian version)" = "$V0"
check "healthy after rollback" bash -c "curl -fsS http://127.0.0.1:8790/api/health | grep -q '\"version\":\"$V0\"'"

check "secret kept across updates" bash -c 'adrian secret list | grep -qx TEST_KEEP'
check "setup code kept across updates" test -f /var/lib/adrian/setup-code
check "bad checksum refused" bash -c 'cp /tmp/b/adrian-voice-0.1.1-test-linux-x64.tar.gz /tmp/x.tar.gz && echo "0000000000000000000000000000000000000000000000000000000000000000  x.tar.gz" > /tmp/x.tar.gz.sha256 && ! adrian update /tmp/x.tar.gz'
check "same version refused" bash -c '! adrian update '"$BUNDLE"

# By hand from a login session that then ends. Where logind has
# KillUserProcesses=yes it stops the session's scope at logout, and everything
# in it dies; that's done by hand here (logind itself is masked in this container).
mk 0.1.3-test keep
systemd-run --scope --unit=inst2-login --quiet bash -c 'ADRIAN_DETACH=1 adrian update /tmp/b/adrian-voice-0.1.3-test-linux-x64.tar.gz >/tmp/byhand.out 2>&1' >/dev/null 2>&1 &
sleep 8
unit=$(systemctl list-units --type=service --plain --no-legend 'adrian-update-by-hand-*' | awk '{print $1}' | head -n 1)
echo "  by-hand update unit: ${unit:-none}, cgroup $(systemctl show -p ControlGroup --value "${unit:-none}" 2>/dev/null)"
check "by-hand update runs as a unit of its own" test -n "$unit"
check "  outside the login session" bash -c "systemctl show -p ControlGroup --value '$unit' | grep -q '^/system.slice/adrian-update-by-hand-'"
systemctl stop inst2-login.scope
for _ in $(seq 1 300); do
  flock -n /opt/adrian/update.lock true && [ -z "$(systemctl list-units --plain --no-legend 'adrian-update-by-hand-*')" ] && break
  sleep 1
done
sed 's/^/  | /' /opt/adrian/update.log | tail -4
check "  it finished after the session was stopped" bash -c '[ "$(adrian version)" = 0.1.3-test ]'
check "  healthy on 0.1.3-test" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"0.1.3-test\""'
check "  its log is its own and says so" bash -c 'head -n 1 /opt/adrian/update.log | grep -q "^== Update started" && grep -q "Updated to 0.1.3-test" /opt/adrian/update.log'
check "  the terminal was told where the log is" grep -q 'sudo tail -f /opt/adrian/update.log' /tmp/byhand.out
check "  update.log is 0600" bash -c '[ "$(stat -c %a /opt/adrian/update.log)" = 600 ]'
# Why a unit of its own: setsid leaves the session's process group, not its scope.
systemd-run --scope --unit=inst2-login2 --quiet bash -c 'setsid sleep 301 </dev/null >/dev/null 2>&1 & sleep 302' >/dev/null 2>&1 &
sleep 2; systemctl stop inst2-login2.scope; sleep 1
check "  (setsid alone would not have survived: stopping the scope kills it)" bash -c '! pgrep -f "[s]leep 301" >/dev/null'
echo "  releases kept: $(ls /opt/adrian/releases | tr '\n' ' ')"

adrian uninstall --yes >/dev/null 2>&1 && ok "uninstall" || bad "uninstall"
check "nothing left" bash -c '! test -e /opt/adrian && ! test -e /etc/adrian && ! test -e /var/lib/adrian && ! id adrian'
echo "== $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
