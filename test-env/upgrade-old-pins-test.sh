#!/usr/bin/env bash
# Runs inside a throwaway systemd container: install an older release whose
# speech models came from the 2025 uploads (cached at /dl), then update to this
# one. The models it already has must stay: nothing downloaded, nothing changed.
#   upgrade-old-pins-test.sh /rel/<old bundle>.tar.gz /rel/<new bundle>.tar.gz
set -u
OLD=$1
NEW=$2
PASS=0
FAIL=0
ok() { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
M=/var/lib/adrian/models

systemctl is-system-running --wait >/dev/null 2>&1 || true
mkdir -p /tmp/old && tar -xzf "$OLD" -C /tmp/old ./packaging ./package.json
v_old=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' /tmp/old/package.json | head -1)
ADRIAN_DOWNLOAD_CACHE=/dl bash /tmp/old/packaging/install.sh --yes --bundle "$OLD" >/tmp/install.log 2>&1 && ok "install $v_old (models from the cache)" || { bad "install $v_old"; tail /tmp/install.log; }
for m in sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 kokoro-multi-lang-v1_0; do echo "  $m marker before: $(cat "$M/.$m.sha256")"; done
cat "$M"/.*.sha256 >/tmp/markers.before
stat -c '%n %Y %i' "$M/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx" "$M/kokoro-multi-lang-v1_0/model.onnx" >/tmp/files.before

t0=$(date +%s)
out=$(env -u ADRIAN_DOWNLOAD_CACHE adrian update "$NEW" 2>&1); rc=$?
printf '%s\n' "$out" >/tmp/update.out; sed 's/^/  | /' /tmp/update.out
echo "  update took $(( $(date +%s) - t0 )) s"
v_new=$(tar -xzOf "$NEW" ./package.json | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -1)
[ $rc = 0 ] && ok "update to $v_new" || bad "update to $v_new (exit $rc)"
check "  now on $v_new" bash -c "[ \"\$(adrian version)\" = '$v_new' ]"
check "  no speech model downloaded" bash -c "! grep -qE 'Downloading (sherpa-onnx|kokoro)' /tmp/update.out"
check "  model markers unchanged" bash -c 'cat /var/lib/adrian/models/.*.sha256 | cmp -s - /tmp/markers.before'
check "  model files untouched" bash -c "stat -c '%n %Y %i' $M/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx $M/kokoro-multi-lang-v1_0/model.onnx | cmp -s - /tmp/files.before"
check "  healthy" bash -c 'curl -fsS http://127.0.0.1:8790/api/health | grep -q "\"version\":\"'"$v_new"'\""'

adrian uninstall --yes >/tmp/uninstall.log 2>&1 && ok "adrian uninstall" || { bad "adrian uninstall"; cat /tmp/uninstall.log; }
echo "== $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
