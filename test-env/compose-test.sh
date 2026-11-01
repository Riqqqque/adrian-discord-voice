#!/usr/bin/env bash
# Docker Compose mode test on the host's Docker. Isolated project name and
# port (8795) so it can't touch anything else; everything it creates
# (containers, volumes, images) is removed at the end.
#
#   compose-test.sh BUNDLE.tar.gz DOWNLOAD_CACHE_DIR

set -uo pipefail
# A deliberately invalid, token-shaped value (built here so secret scanners
# don't mistake it for a real token): Discord must reject it.
FAKE_TOKEN="MTAwMDAwMDAwMDAwMDAwMDAw.AAAAAA.$(printf 'invalid%.0s' 1 2 3 4)123"
BUNDLE=$(readlink -f "$1") CACHE=$(readlink -f "$2")
P=adrian-cit PORT=8795 BASE=http://127.0.0.1:8795
PASS=0 FAIL=0
ok() { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

W=$(mktemp -d)
tar -xzf "$BUNDLE" -C "$W" ./packaging
D=$W/packaging/docker
cat >"$D/compose.test.yaml" <<EOF
services:
  models:
    volumes:
      - $CACHE:/dl:ro
EOF
export ADRIAN_PORT=$PORT ADRIAN_DOWNLOAD_CACHE=/dl TZ=America/Denver
VERSION=$(tar -xzOf "$BUNDLE" ./package.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
export ADRIAN_VERSION=$VERSION
dc() { docker compose -p $P -f "$D/compose.yaml" -f "$D/compose.test.yaml" "$@"; }

t0=$(date +%s)
bash "$D/build.sh" "$BUNDLE" >/tmp/$P-build.log 2>&1 && ok "images build" || { bad "images build"; tail -20 /tmp/$P-build.log; }
echo "  build took $(( $(date +%s) - t0 )) s; image size $(docker image inspect -f '{{.Size}}' adrian-voice:$VERSION | awk '{printf "%d MB", $1/1e6}')"
t0=$(date +%s)
dc up -d >/tmp/$P-up.log 2>&1 && ok "compose up" || { bad "compose up"; tail -20 /tmp/$P-up.log; }
for _ in $(seq 1 90); do curl -fsS $BASE/api/health >/dev/null 2>&1 && break; sleep 1; done
echo "  up to healthy: $(( $(date +%s) - t0 )) s"
check "models job finished ok" bash -c "[ \"\$(docker inspect -f '{{.State.ExitCode}}' \$(docker compose -p $P -f $D/compose.yaml ps -aq models))\" = 0 ]"
check "health on loopback port" bash -c "curl -fsS $BASE/api/health | grep -q '\"state\":\"setup\"'"
check "published on 127.0.0.1 only" bash -c "docker port ${P}-adrian-1 8790 | grep -qx '127.0.0.1:$PORT'"
C=${P}-adrian-1
check "runs as uid 10001" bash -c "[ \"\$(docker exec $C id -u)\" = 10001 ]"
check "read-only root fs" bash -c "! docker exec $C touch /opt/adrian/x"
check "no capabilities" bash -c "docker exec $C grep -q '^CapEff:\s*0000000000000000' /proc/1/status"
check "models volume read-only" bash -c "! docker exec $C touch /var/lib/adrian/models/x"
check "secrets.env 0600" bash -c "[ \"\$(docker exec $C stat -c %a /etc/adrian/secrets.env)\" = 600 ]"
code=$(dc exec -T adrian node dist/cli/tool.js setup-code | sed -n 's/^Setup code: \([A-Z0-9-]*\).*/\1/p')
[ -n "$code" ] && ok "setup code via exec" || bad "setup code via exec"
J=$(mktemp)
claim=$(curl -sS -c $J -H "Origin: $BASE" -H 'Content-Type: application/json' -d "{\"code\":\"$code\",\"username\":\"admin\",\"password\":\"compose-test-pass-1\"}" $BASE/api/setup/claim)
csrf=$(sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p' <<<"$claim")
[ -n "$csrf" ] && ok "admin claimed" || bad "admin claimed: $claim"
r=$(curl -sS -b $J -H "Origin: $BASE" -H "X-CSRF-Token: $csrf" -H 'Content-Type: application/json' -d "{\"token\":\"$FAKE_TOKEN\"}" $BASE/api/check/discord)
grep -q 'rejected' <<<"$r" && ok "invalid Discord token rejected" || bad "invalid token: $r"
check "voice preview (Kokoro in container)" bash -c "curl -fsS -b $J -o /dev/null '$BASE/api/voice-preview?voice=am_michael&speed=1'"
echo "  memory: $(docker stats --no-stream --format '{{.MemUsage}}' $C)"
check "time zone passed through" bash -c "docker exec $C grep -q America/Denver /etc/adrian/config.json"
dc restart adrian >/dev/null 2>&1
for _ in $(seq 1 60); do curl -fsS $BASE/api/health >/dev/null 2>&1 && break; sleep 1; done
check "admin account survives restart" bash -c "curl -fsS $BASE/api/session | grep -q '\"setupNeeded\":false'"
check "no secret or code in logs" bash -c "! docker logs $C 2>&1 | grep -qE '${code:-NO-CODE}|invalidinvalid|argon2id'"

dc down -v --remove-orphans >/dev/null 2>&1 && ok "compose down -v" || bad "compose down -v"
docker rmi "adrian-voice:$VERSION" "adrian-voice-fetch:$VERSION" >/dev/null 2>&1 && ok "images removed" || bad "images removed"
check "no containers left" bash -c "[ -z \"\$(docker ps -aq --filter name=$P-)\" ]"
check "no volumes left" bash -c "[ -z \"\$(docker volume ls -q --filter name=${P}_)\" ]"
rm -rf "$W" "$J" /tmp/$P-*.log
echo "== $PASS passed, $FAIL failed"
[ $FAIL = 0 ]
