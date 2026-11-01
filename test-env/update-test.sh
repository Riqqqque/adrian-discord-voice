#!/usr/bin/env bash
# Update/rollback test, run inside a throwaway systemd container.
# Makes two extra bundles from the real one: a healthy 0.1.1-test and a
# broken 0.1.2-bad (its entry point exits at once), then:
#   install 0.1.0 → update 0.1.1 → update 0.1.2-bad (must roll back to 0.1.1)
#   → rollback (to 0.1.0) → data kept throughout → uninstall.
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

ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/inst/packaging/install.sh --yes --bundle "$BUNDLE" >/tmp/install.log 2>&1 && ok "install 0.1.0" || { bad "install"; tail /tmp/install.log; }
check "version 0.1.0" bash -c '[ "$(adrian version)" = 0.1.0 ]'
adrian setup-code >/dev/null   # creates state that must survive updates
printf 'kept-value-1234567890' | adrian secret set TEST_KEEP >/dev/null

out=$(adrian update /tmp/b/adrian-voice-0.1.1-test-linux-x64.tar.gz 2>&1); echo "$out" | sed 's/^/  | /'
check "update to 0.1.1-test" bash -c '[ "$(adrian version)" = 0.1.1-test ]'
check "healthy after update" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"0.1.1-test\""'

t0=$(date +%s)
out=$(adrian update /tmp/b/adrian-voice-0.1.2-bad-linux-x64.tar.gz 2>&1); rc=$?; echo "$out" | sed 's/^/  | /'
echo "  bad update took $(( $(date +%s) - t0 )) s, exit $rc"
check "bad update reports failure" test $rc -ne 0
check "auto rollback to 0.1.1-test" bash -c '[ "$(adrian version)" = 0.1.1-test ]'
check "healthy after auto rollback" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"0.1.1-test\""'
check "broken release removed" bash -c "! test -e /opt/adrian/releases/0.1.2-bad"

out=$(adrian rollback 2>&1); echo "$out" | sed 's/^/  | /'
check "manual rollback to 0.1.0" bash -c '[ "$(adrian version)" = 0.1.0 ]'
check "healthy after rollback" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"0.1.0\""'

check "secret kept across updates" bash -c 'adrian secret list | grep -qx TEST_KEEP'
check "setup code kept across updates" test -f /var/lib/adrian/setup-code
check "bad checksum refused" bash -c 'cp /tmp/b/adrian-voice-0.1.1-test-linux-x64.tar.gz /tmp/x.tar.gz && echo "0000000000000000000000000000000000000000000000000000000000000000  x.tar.gz" > /tmp/x.tar.gz.sha256 && ! adrian update /tmp/x.tar.gz'
check "same version refused" bash -c '! adrian update '"$BUNDLE"
echo "  releases kept: $(ls /opt/adrian/releases | tr '\n' ' ')"

adrian uninstall --yes >/dev/null 2>&1 && ok "uninstall" || bad "uninstall"
check "nothing left" bash -c '! test -e /opt/adrian && ! test -e /etc/adrian && ! test -e /var/lib/adrian && ! id adrian'
echo "== $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
