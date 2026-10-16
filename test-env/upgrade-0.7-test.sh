#!/usr/bin/env bash
# The real upgrade path: a 0.6.x install (whose `adrian` can't install models)
# goes to 0.7.x with the one-time prep step, then a later update through the
# new `adrian` installs models by itself.
#   upgrade-0.7-test.sh /rel/<0.6.2 bundle> /rel/<0.7.x bundle>   (download cache at /dl)
set -uo pipefail
OLD=$1 NEW=$2
PASS=0 FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local n=$1; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
systemctl is-system-running --wait >/dev/null 2>&1 || true

mkdir -p /tmp/old /tmp/new && tar -xzf "$OLD" -C /tmp/old ./packaging && tar -xzf "$NEW" -C /tmp/new ./packaging
ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/old/packaging/install.sh --yes --bundle "$OLD" >/tmp/i.log 2>&1 && ok "install 0.6.2" || { bad "install"; tail /tmp/i.log; }
check "0.6.2 healthy" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q 0.6.2'

# The one-time step from the new bundle, then the old `adrian update`.
t0=$(date +%s)
ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/new/packaging/upgrade-prep.sh 2>&1 | sed 's/^/  | /'
echo "  prep took $(( $(date +%s) - t0 )) s"
check "multilingual models installed" bash -c 'test -f /var/lib/adrian/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tokens.txt && test -f /var/lib/adrian/models/sherpa-onnx-whisper-small/small-encoder.int8.onnx && test -f /var/lib/adrian/models/vits-piper-vi_VN-vais1000-medium/vi_VN-vais1000-medium.onnx'
check "unused whisper files dropped" bash -c '! test -e /var/lib/adrian/models/sherpa-onnx-whisper-small/small-encoder.onnx'
check "service file updated (MemoryMax 5G)" grep -q MemoryMax=5G /etc/systemd/system/adrian-voice.service
adrian update "$NEW" 2>&1 | sed 's/^/  | /'
V=$(tar -xzOf "$NEW" ./package.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
check "on $V and healthy" bash -c "curl -fsS http://127.0.0.1:8790/api/health | grep -q '\"version\":\"$V\"'"
check "config mature always" adrian config mature always
check "config reasoning medium" adrian config brain.extraBody.reasoning_effort medium
check "restart after config" adrian restart
check "mature setting saved" bash -c 'adrian config mature | grep -q always'

# A later update through the NEW adrian must run the prep by itself.
rm -rf /tmp/v && mkdir /tmp/v && tar -xzf "$NEW" -C /tmp/v
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$V-next\"/" /tmp/v/package.json
tar -czf /tmp/next.tar.gz -C /tmp/v .
rm -rf /var/lib/adrian/models/vits-piper-vi_VN-vais1000-medium   # pretend a model is missing
adrian update /tmp/next.tar.gz 2>&1 | sed 's/^/  | /'
check "new adrian re-installs a missing model" test -f /var/lib/adrian/models/vits-piper-vi_VN-vais1000-medium/vi_VN-vais1000-medium.onnx
check "on $V-next and healthy" bash -c "curl -fsS http://127.0.0.1:8790/api/health | grep -q '\"version\":\"$V-next\"'"
echo "  memory: $(systemctl show -p MemoryCurrent --value adrian-voice | awk '{printf "%d MiB", $1/1048576}')"
adrian uninstall --yes >/dev/null 2>&1 && ok uninstall || bad uninstall
echo "== $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
