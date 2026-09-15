#!/usr/bin/env bash
# Pocket Service Manager: the helper the app runs on a supplier host over SSH.
# Lives in a stack directory (one per network, for example /opt/pocket/supplier-main)
# next to that stack's compose file, configs, and stack.env. Every subcommand is
# idempotent and prints plain lines the app reads. Nothing here ever prints a key.
#
#   supplier.sh prepare                      create the directories, network, fix ownership
#   supplier.sh operator                     create the operator key once; print its address
#   supplier.sh keys                         write supplier-keys.yaml from the keyring (mode 400)
#   supplier.sh publish <network>            send 1 uPOKT to self so the public key is on chain
#   supplier.sh start                        start the shared Caddy, then redis and the miner (relayer too once a service exists)
#   supplier.sh deploy <id> <deploy-root>    build and start a service's backend on the shared network
#   supplier.sh add-service <id> <backend-url> <health-path>   add to this stack's relayer, recreate relayer
#   supplier.sh remove-service <id>          drop from this stack's relayer, recreate relayer
#   supplier.sh status                       one line per fact the app shows
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
# Per-stack settings written by the app at provision time (stack.env). The defaults
# match the first layout, one stack per server, so an older directory keeps working.
PROJECT=pocket-supplier; NET=beta; HEALTH_PORT=8081; CADDY_DIR=/opt/pocket/caddy; HOSTNAME_PUBLIC=""
if [ -f "$D/stack.env" ]; then . "$D/stack.env"; fi
NET_NAME=pocket-supplier
CFG="$D/relayer-config.yaml"
step="${1:-status}"; shift || true

pd() { docker run --rm -v "$D/pocket-home:/home" "$IMG" "$@"; }
# Service ids listed under `services:` in the relayer config (the block ends at the next top-level key).
list_services() { python3 - "$CFG" <<'PY'
import sys, re
try: t = open(sys.argv[1]).read()
except Exception: sys.exit()
m = re.search(r'^services:(.*)$', t, re.M)
if not m or '{}' in m.group(1): sys.exit()
rest = t[m.end():]
n = re.search(r'^\S', rest, re.M)
block = rest[:n.start()] if n else rest
print(",".join(re.findall(r'^  ([A-Za-z0-9_-]+):', block, re.M)))
PY
}
relayer_has_services() { [ -n "$(list_services)" ]; }
wait_health() { for i in $(seq 1 45); do curl -fs "http://127.0.0.1:$HEALTH_PORT/health" >/dev/null 2>&1 && { echo "relayer: healthy"; return 0; }; sleep 2; done; echo "relayer: not healthy after 90 s"; return 1; }

# The shared Caddy: one per server, in CADDY_DIR, importing sites/*.caddy. A stack
# from the first layout carried its own Caddy; its certificates are carried over
# and the old container removed before the shared one takes ports 80 and 443.
caddy_up() {
  mkdir -p "$CADDY_DIR/sites"
  [ -f "$CADDY_DIR/docker-compose.yaml" ] || { echo "error: $CADDY_DIR/docker-compose.yaml missing; provision again"; return 1; }
  if docker ps -a --format '{{.Names}}' | grep -qx "$PROJECT-caddy"; then
    if docker volume inspect "${PROJECT}_caddy_data" >/dev/null 2>&1 && ! docker volume inspect pocket-caddy_data >/dev/null 2>&1; then
      docker volume create pocket-caddy_data >/dev/null
      docker run --rm -v "${PROJECT}_caddy_data:/from:ro" -v pocket-caddy_data:/to alpine:3 sh -c 'cp -a /from/. /to/'
      echo "caddy: certificates carried over from $PROJECT-caddy"
    fi
    docker rm -f "$PROJECT-caddy" >/dev/null 2>&1 || true
    echo "caddy: removed $PROJECT-caddy; Caddy is now shared by every stack on this server"
  fi
  # This stack owns its hostname. A site file left by another stack or by hand that
  # claims the same hostname (for example an alias kept while a stake moved to a new
  # hostname) would make Caddy refuse the config, so retire it.
  if [ -n "$HOSTNAME_PUBLIC" ]; then
    for f in "$CADDY_DIR"/sites/*.caddy; do
      [ -f "$f" ] || continue; [ "$(basename "$f")" = "$NET.caddy" ] && continue
      if grep -q "^$HOSTNAME_PUBLIC {" "$f"; then rm -f "$f"; echo "caddy: retired $(basename "$f"), which also claimed $HOSTNAME_PUBLIC"; fi
    done
  fi
  docker volume create pocket-caddy_data >/dev/null; docker volume create pocket-caddy_config >/dev/null
  (cd "$CADDY_DIR" && docker compose -p pocket-caddy up -d 2>&1 | tail -2)
  if docker exec pocket-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then echo "caddy: serving $(ls "$CADDY_DIR/sites" | sed 's/\.caddy$//' | tr '\n' ' ')"; else echo "caddy: started"; fi
}

case "$step" in
  prepare)
    mkdir -p "$D/pocket-home" "$CADDY_DIR/sites"
    sudo chown 1025:1025 "$D/pocket-home"
    chmod +x "$D/supplier.sh"
    docker network inspect "$NET_NAME" >/dev/null 2>&1 || docker network create "$NET_NAME" >/dev/null
    # Configs from the first layout named Redis by its service alias; each stack now has
    # its own Redis on a private network, addressed by container name.
    for f in "$D/relayer-config.yaml" "$D/miner-config.yaml"; do
      if [ -f "$f" ]; then sed -i "s#redis://redis:6379#redis://$PROJECT-redis:6379#" "$f"; fi
    done
    echo "prepared: $D (stack $PROJECT for $NET)"
    ;;
  operator)
    mkdir -p "$D/pocket-home"; sudo chown 1025:1025 "$D/pocket-home"
    if [ ! -s "$D/operator-key.json" ]; then
      umask 077
      pd keys add operator --keyring-backend test --home /home --output json > "$D/operator-key.json" 2>/dev/null
      chmod 600 "$D/operator-key.json"
      echo "created: new operator key"
    else
      echo "created: existing operator key kept"
    fi
    echo "operator: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json")"
    ;;
  keys)
    UID_IN_IMAGE="${1:-1000}"
    HEX=$(printf 'y\n' | docker run --rm -i -v "$D/pocket-home:/home" "$IMG" keys export operator --unarmored-hex --unsafe --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n')
    if [ "${#HEX}" -ne 64 ]; then echo "error: could not read the operator key from the keyring"; exit 1; fi
    umask 077
    # The existing file is read-only and owned by the container user, so write a
    # fresh one and move it into place with sudo.
    printf 'keys:\n  - "%s"\n' "$HEX" > "$D/.supplier-keys.tmp"
    unset HEX
    sudo mv -f "$D/.supplier-keys.tmp" "$D/supplier-keys.yaml"
    sudo chown "$UID_IN_IMAGE":"$UID_IN_IMAGE" "$D/supplier-keys.yaml"; sudo chmod 400 "$D/supplier-keys.yaml"
    echo "keys: supplier-keys.yaml written"
    ;;
  publish)
    NETARG="${1:-$NET}"
    ADDR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json")
    if pd query auth account "$ADDR" --network="$NETARG" -o json 2>/dev/null | grep -q '"key"'; then echo "published: already on chain"; exit 0; fi
    OUT=$(pd tx bank send operator "$ADDR" 1upokt --from operator --keyring-backend test --home /home --network="$NETARG" --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json 2>&1 || true)
    TX=$(echo "$OUT" | python3 -c 'import sys,json
t=sys.stdin.read(); i=t.find("{")
try:
    j=json.loads(t[i:]); print(j.get("txhash",""), j.get("code",""))
except Exception: print("", "parse")' 2>/dev/null)
    echo "txhash: $TX"
    CODE="${TX##* }"
    if [ -z "${TX%% *}" ] || [ "$CODE" != "0" ]; then echo "error: the self-transfer was not accepted; is the operator funded? ($(echo "$OUT" | tail -c 300 | tr '\n' ' '))"; exit 1; fi
    # Inclusion takes a block or two; MainNet blocks are about a minute apart.
    for i in $(seq 1 60); do sleep 5; if pd query auth account "$ADDR" --network="$NETARG" -o json 2>/dev/null | grep -q '"key"'; then echo "published: public key now on chain"; exit 0; fi; done
    echo "error: the self-transfer ${TX%% *} was accepted but its inclusion was not seen within 5 minutes; run provisioning again, it resumes here"; exit 1
    ;;
  start)
    caddy_up
    cd "$D"
    if relayer_has_services; then docker compose -p "$PROJECT" up -d --remove-orphans 2>&1 | tail -4; wait_health || true
    else docker compose -p "$PROJECT" up -d --remove-orphans redis miner 2>&1 | tail -3; echo "relayer: waiting for the first service"; fi
    ;;
  deploy)
    ID="${1:?service id}"; ROOT="${2:-/opt/pocket/services}"
    SVC="$ROOT/$ID"
    [ -f "$SVC/deploy/docker-compose.yaml" ] || { echo "error: $SVC/deploy/docker-compose.yaml missing"; exit 1; }
    docker network inspect "$NET_NAME" >/dev/null 2>&1 || docker network create "$NET_NAME" >/dev/null
    cd "$SVC/deploy" && docker compose -p "$ID" up -d --build 2>&1 | tail -3
    HP="${3:-/healthz}"
    for i in $(seq 1 60); do
      if docker run --rm --network "$NET_NAME" alpine:3 wget -qO- "http://$ID-backend:8080$HP" 2>/dev/null | grep -q '"'; then echo "backend: healthy at http://$ID-backend:8080$HP"; exit 0; fi
      sleep 2
    done
    echo "error: backend did not answer $HP within 120 s"; docker logs --tail 20 "$ID-backend" 2>&1 | tail -20; exit 1
    ;;
  add-service)
    ID="${1:?service id}"; URL="${2:?backend url}"; HP="${3:-/healthz}"
    python3 - "$CFG" "$ID" "$URL" "$HP" <<'PY'
import sys, re
cfg, sid, url, hp = sys.argv[1:5]
t = open(cfg).read()
block = f"  {sid}:\n    timeout_profile: fast\n    max_body_size_bytes: 20971520\n    default_backend: rest\n    backends:\n      rest:\n        url: \"{url}\"\n        health_check:\n          endpoint: \"{hp}\"\n          interval_seconds: 10\n          timeout_seconds: 5\n"
if re.search(rf'^  {re.escape(sid)}:', t, re.M):
    print("relayer: already lists", sid); sys.exit(0)
t = re.sub(r'^services:\s*\{\}\s*$', 'services:', t, count=1, flags=re.M)
m = re.search(r'^services:\s*$', t, re.M)
if not m: sys.exit("error: no services: line in " + cfg)
i = m.end() + 1
t = t[:i] + block + t[i:]
open(cfg, "w").write(t)
print("relayer: added", sid)
PY
    cd "$D" && docker compose -p "$PROJECT" up -d --force-recreate relayer 2>&1 | tail -2
    wait_health
    ;;
  remove-service)
    ID="${1:?service id}"
    python3 - "$CFG" "$ID" <<'PY'
import sys, re
cfg, sid = sys.argv[1:3]
t = open(cfg).read()
t2 = re.sub(rf'^  {re.escape(sid)}:\n(?:    .*\n|\n)*', '', t, count=1, flags=re.M)
open(cfg, "w").write(t2)
print("relayer: removed" if t2 != t else "relayer: did not list", sid)
PY
    cd "$D"
    if relayer_has_services; then docker compose -p "$PROJECT" up -d --force-recreate relayer 2>&1 | tail -2; wait_health || true
    else docker compose -p "$PROJECT" stop relayer >/dev/null 2>&1 || true; echo "relayer: stopped (no services left)"; fi
    ;;
  status)
    echo "dir: $D"
    echo "stack: $PROJECT ($NET)"
    [ -s "$D/operator-key.json" ] && echo "operator: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json")" || echo "operator: none"
    [ -s "$D/supplier-keys.yaml" ] && echo "keys: present" || echo "keys: missing"
    S=$(list_services); echo "services: ${S:-none}"
    docker ps --filter "name=$PROJECT-" --format 'container: {{.Names}} {{.Status}}'
    docker ps --filter "name=pocket-caddy" --format 'container: {{.Names}} {{.Status}}'
    curl -fs "http://127.0.0.1:$HEALTH_PORT/health" >/dev/null 2>&1 && echo "relayer: healthy" || echo "relayer: not answering"
    ;;
  *)
    echo "error: unknown step $step"; exit 2
    ;;
esac
