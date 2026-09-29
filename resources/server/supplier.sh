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
#   supplier.sh deploy <id> <deploy-root> [<health-path>] [<port>]
#                                            build and start a service's backend on the shared network;
#                                            wait for <health-path> on the port this network's relayer calls
#   supplier.sh add-service <id> <backend-url> <health-path>   add to this stack's relayer (or bring an
#                                            existing entry's URL and health path up to date), recreate relayer
#   supplier.sh remove-service <id>          drop from this stack's relayer, recreate relayer; drop the
#                                            service's routes once no other network's stack serves it
#   supplier.sh add-routes <id> <path> <port> [<path> <port> ...]
#                                            route https://<hostname><path>/* to <id>-backend:<port>, prefix stripped
#   supplier.sh remove-routes <id>           drop a service's extra routes
#   supplier.sh status                       one line per fact the app shows
#   supplier.sh operator-adopt keysfile|keyring <path> <operator>
#                                            import: put a supplier's existing operator key, found on
#                                            this server, into this stack instead of creating one
#   supplier.sh operator-import <operator> hex|mnemonic
#                                            import: the same for a key the user pasted into the app,
#                                            read from standard input (never an argument)
#
# The stack's images are pinned in stack.env by the app release that provisioned it
# (STACK_LAYOUT 2 and later); `start` sizes memory from this server and validates both
# configs with the pinned image before anything restarts.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
# Per-stack settings written by the app at provision time (stack.env). The defaults
# match the first layout, one stack per server, so an older directory keeps working.
PROJECT=pocket-supplier; NET=beta; HEALTH_PORT=8081; CADDY_DIR=/opt/pocket/caddy; HOSTNAME_PUBLIC=""
STACK_LAYOUT=1; RELAYMINER_IMAGE=""; REDIS_IMAGE=""; POCKETD_IMAGE=""
if [ -f "$D/stack.env" ]; then . "$D/stack.env"; fi
IMG="${POCKETD_IMAGE:-ghcr.io/pokt-network/pocketd:latest}"
NET_NAME=pocket-supplier
CFG="$D/relayer-config.yaml"
step="${1:-status}"; shift || true

pd() { docker run --rm -v "$D/pocket-home:/home" "$IMG" "$@"; }
# This stack's compose, always with compose.env (pinned images and sized limits).
dc() { (cd "$D" && docker compose -p "$PROJECT" --env-file "$D/compose.env" "$@"); }

# Memory and CPUs for this stack, from the server's own. A quarter of the memory, and
# at least 1 GiB, stays for the system, Caddy and the service backends; the rest is
# split between the two stacks a server can hold (one per network) whether or not the
# other exists yet, so adding the second network never starves the first. Within a
# stack Redis, the miner and the relayer get 40/40/20 of it, upstream's proportions;
# Redis's maxmemory is 80% of its limit and each Go process's GOMEMLIMIT 90% of its.
MEMINFO="${PSM_MEMINFO:-/proc/meminfo}"
STACK_MIN_MB=1024
size_stack() {
  local total cpus reserve per rl rmax ml ll gmp
  total=$(awk '/^MemTotal:/ {print int($2/1024)}' "$MEMINFO")
  cpus="${PSM_NPROC:-$(nproc)}"
  reserve=$(( total / 4 )); [ "$reserve" -lt 1024 ] && reserve=1024
  per=$(( (total - reserve) / 2 ))
  if [ "$per" -lt "$STACK_MIN_MB" ]; then
    echo "error: this server has ${total} MB of memory; each network's supplier stack needs ${STACK_MIN_MB} MB after ${reserve} MB is kept for the system and the service backends, so the server needs at least $(( STACK_MIN_MB * 2 + 1024 )) MB"
    return 1
  fi
  rl=$(( per * 40 / 100 )); rmax=$(( rl * 80 / 100 )); ml=$(( per * 40 / 100 )); ll=$(( per * 20 / 100 ))
  gmp=$(( cpus / 2 )); [ "$gmp" -lt 1 ] && gmp=1
  {
    grep -E '^[A-Z_]+=' "$D/stack.env" 2>/dev/null || true
    printf 'REDIS_MEM_LIMIT=%sm\nREDIS_MAXMEMORY=%smb\n' "$rl" "$rmax"
    printf 'MINER_MEM_LIMIT=%sm\nMINER_GOMEMLIMIT=%sMiB\n' "$ml" $(( ml * 90 / 100 ))
    printf 'RELAYER_MEM_LIMIT=%sm\nRELAYER_GOMEMLIMIT=%sMiB\n' "$ll" $(( ll * 90 / 100 ))
    printf 'GOMAXPROCS=%s\n' "$gmp"
  } > "$D/compose.env"
  echo "resources: ${total} MB and ${cpus} CPUs on this server; this stack gets redis ${rl} MB (maxmemory ${rmax} MB), miner ${ml} MB, relayer ${ll} MB"
}

# Both processes' configs, checked by the pinned image itself before anything restarts.
# A relayer with no services yet is not checked: it refuses an empty list by design.
validate_stack() {
  local which out rc=0
  for which in miner relayer; do
    if [ "$which" = relayer ] && ! relayer_has_services; then continue; fi
    if ! out=$(docker run --rm -v "$D/$which-config.yaml:/config/config.yaml:ro" -v "$D/supplier-keys.yaml:/keys/supplier-keys.yaml:ro" "$RELAYMINER_IMAGE" "$which" validate --config /config/config.yaml 2>&1); then
      rc=1
      echo "error: the $which config does not pass the check of RelayMiner ${RELAYMINER_IMAGE##*:}: $(echo "$out" | grep -v 'maxprocs' | tr '\n' ' ' | cut -c1-600)"
    fi
  done
  return "$rc"
}
need_pins() { [ -n "$RELAYMINER_IMAGE" ] && [ -n "$REDIS_IMAGE" ] || { echo "error: this stack predates pinned versions; provision it again from the app"; exit 1; }; }
versions_line() { echo "versions: relayminer ${RELAYMINER_IMAGE##*:}, redis ${REDIS_IMAGE##*:}, pocketd ${IMG##*:}, layout ${STACK_LAYOUT}"; }
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
# /ready answers 503 until the miner has published its service manifest, so ready means
# the whole stack is serving.
wait_health() { for i in $(seq 1 60); do curl -fs "http://127.0.0.1:$HEALTH_PORT/ready" >/dev/null 2>&1 && { echo "relayer: healthy"; return 0; }; sleep 2; done; echo "relayer: not ready after 120 s"; return 1; }

# The shared Caddy: one per server, in CADDY_DIR, importing sites/*.caddy. A stack
# from the first layout carried its own Caddy; its certificates are carried over
# and the old container removed before the shared one takes ports 80 and 443.
caddy_up() {
  mkdir -p "$CADDY_DIR/sites/routes"
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
  if docker exec pocket-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then echo "caddy: serving $(ls "$CADDY_DIR/sites" | grep '\.caddy$' | sed 's/\.caddy$//' | tr '\n' ' ')"; else echo "caddy: started"; fi
}

# Extra routes a service declares in its deploy/routes.json: one file per service in
# sites/routes/, imported inside every stack's site block, so a route answers on each
# network's hostname on this server (one backend serves both networks' relayers).
# A file Caddy refuses is taken back out, and the previous one restored, before
# anything is reloaded, so a bad route never takes a hostname down.
ROUTES_DIR="$CADDY_DIR/sites/routes"
caddy_validate() { docker exec pocket-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1; }
caddy_reload() { docker exec pocket-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; }
caddy_running() { docker ps --format '{{.Names}}' | grep -qx pocket-caddy; }
# Puts back what was there before a change ($1 the route file, $2 its saved copy or "").
routes_restore() { if [ -n "$2" ] && [ -f "$2" ]; then mv -f "$2" "$1"; else rm -f "$1"; fi; }
# The networks whose stacks installed a service's routes: the file's "# networks:" line.
routes_networks() { if [ -f "$1" ]; then sed -n 's/^# networks: //p' "$1" | head -1; fi; }
# Removes a service's route file and reloads Caddy, putting the file back if that fails.
routes_drop() {
  local F="$ROUTES_DIR/$1.route" OLD="$ROUTES_DIR/.$1.route.old"
  if [ ! -f "$F" ]; then echo "routes: $1 has none"; return 0; fi
  mv -f "$F" "$OLD"
  if caddy_running && ! caddy_reload; then
    mv -f "$OLD" "$F"; caddy_reload || true
    echo "error: Caddy did not reload without the routes; they are still in place"; return 1
  fi
  rm -f "$OLD"; echo "routes: removed for $1"
}

# ---- import: an existing operator key instead of a new one ----
# The operator this stack already has, from operator-key.json, or nothing.
stack_operator() {
  [ -s "$D/operator-key.json" ] && python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json" 2>/dev/null || true
}
# Before an import: a stack that already has this operator is done; one with another
# operator is refused; otherwise the keyring is made ready and emptied of a leftover
# "operator" from an earlier attempt that did not finish.
import_prepare() {
  local cur; cur=$(stack_operator)
  if [ -n "$cur" ] && [ "$cur" != "$1" ]; then echo "error: this stack already has the operator $cur"; exit 1; fi
  if [ -n "$cur" ]; then echo "created: the operator is already in this stack"; echo "operator: $cur"; exit 0; fi
  mkdir -p "$D/pocket-home"; sudo chown 1025:1025 "$D/pocket-home"
  pd keys delete operator -y --keyring-backend test --home /home >/dev/null 2>&1 || true
}
# Imports the hex key in PSM_IMPORT_KEY as "operator". The key reaches the container through
# its environment (docker -e with the name only), not the command line.
import_hex_env() {
  docker run --rm -e PSM_IMPORT_KEY -v "$D/pocket-home:/home" --entrypoint sh "$IMG" \
    -c 'pocketd keys import-hex operator "$PSM_IMPORT_KEY" --keyring-backend test --home /home' >/dev/null 2>&1 || true
}
# After an import: the keyring must hold exactly the operator, or nothing is kept.
import_record() {
  local want="$1" how="$2" got
  got=$(pd keys show operator -a --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n' || true)
  if [ "$got" != "$want" ]; then
    pd keys delete operator -y --keyring-backend test --home /home >/dev/null 2>&1 || true
    echo "error: the key imported is ${got:-no key}, not the operator $want; nothing was kept"
    exit 1
  fi
  umask 077
  printf '{"address": "%s", "imported": "%s"}\n' "$want" "$how" > "$D/operator-key.json"
  chmod 600 "$D/operator-key.json"
  echo "created: operator key imported ($how)"
  echo "operator: $want"
}

case "$step" in
  prepare)
    mkdir -p "$D/pocket-home" "$CADDY_DIR/sites/routes"
    sudo chown 1025:1025 "$D/pocket-home"
    chmod +x "$D/supplier.sh"
    docker network inspect "$NET_NAME" >/dev/null 2>&1 || docker network create "$NET_NAME" >/dev/null
    # Configs from the first layout named Redis by its service alias; each stack now has
    # its own Redis on a private network, addressed by container name.
    for f in "$D/relayer-config.yaml" "$D/miner-config.yaml"; do
      if [ -f "$f" ]; then sed -i "s#redis://redis:6379#redis://$PROJECT-redis:6379#" "$f"; fi
    done
    # The relayer config is kept across provisioning because it holds the service list;
    # RelayMiner v0.1.0 no longer reads pocket_node.chain_id in it (only the miner does).
    if [ -f "$D/relayer-config.yaml" ]; then sed -i '/^pocket_node:/,/^[^ ]/{/^  chain_id:/d}' "$D/relayer-config.yaml"; fi
    # Relays are validated before they reach the backend (layout 3): the optimistic default
    # queues bodies per service and outgrows a small server's relayer. A mode already set
    # in the kept config, by hand or by an earlier run, is left as it is.
    if [ -f "$D/relayer-config.yaml" ] && ! grep -q '^default_validation_mode:' "$D/relayer-config.yaml"; then
      printf '\n# Validate each relay before it reaches the backend (Pocket Service Manager, stack layout 3).\ndefault_validation_mode: eager\n' >> "$D/relayer-config.yaml"
    fi
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
  operator-adopt)
    # The key is already on this server (the survey found it). It moves from there into this
    # stack's keyring and never leaves the machine or appears on a command line.
    KIND="${1:?keysfile or keyring}"; SRC="${2:?where the key is}"; WANT="${3:?operator address}"
    import_prepare "$WANT"
    case "$KIND" in
      keysfile)
        # keyaddr.py picks the key whose address is the operator's; the file reaches it
        # through a pipe (with sudo when only root may read it).
        PSM_IMPORT_KEY=$( { cat -- "$SRC" 2>/dev/null || sudo -n cat -- "$SRC"; } | python3 "$D/keyaddr.py" pick "$WANT" 2>/dev/null || true)
        if [ -z "$PSM_IMPORT_KEY" ]; then echo "error: $SRC holds no key for $WANT"; exit 1; fi
        export PSM_IMPORT_KEY
        import_hex_env
        unset PSM_IMPORT_KEY
        ;;
      keyring)
        # A keyring without a passphrase (the test backend). The key goes from that keyring
        # to this one inside a single container, run as root to read a keyring owned by
        # root, which then hands this stack's keyring back to the image's user.
        H="$SRC"
        if ! { [ -d "$H/keyring-test" ] || sudo -n test -d "$H/keyring-test"; }; then
          echo "error: $H has no keyring without a passphrase; paste the operator key into the app instead"; exit 1
        fi
        rc=0
        docker run --rm --user 0 -e WANT="$WANT" -v "$H:/src:ro" -v "$D/pocket-home:/home" --entrypoint sh "$IMG" -c '
          cp -a /src /tmp/src
          N=$(pocketd keys show "$WANT" --keyring-backend test --home /tmp/src --output json 2>/dev/null | sed -n "s/.*\"name\":\"\([^\"]*\)\".*/\1/p")
          [ -n "$N" ] || exit 3
          K=$(printf "y\n" | pocketd keys export "$N" --unarmored-hex --unsafe --keyring-backend test --home /tmp/src 2>/dev/null)
          pocketd keys import-hex operator "$K" --keyring-backend test --home /home >/dev/null 2>&1
          chown -R 1025:1025 /home' || rc=$?
        if [ "$rc" = 3 ]; then echo "error: the keyring in $H has no key for $WANT"; exit 1; fi
        ;;
      *) echo "error: unknown key source $KIND"; exit 2 ;;
    esac
    import_record "$WANT" "$KIND"
    ;;
  operator-import)
    # A key the user pasted into the app, on standard input. A hex key goes to the container
    # through its environment; a recovery phrase through the container's standard input.
    WANT="${1:?operator address}"; KIND="${2:?hex or mnemonic}"
    SECRET=""; IFS= read -r SECRET || true
    import_prepare "$WANT"
    case "$KIND" in
      hex)
        PSM_IMPORT_KEY="$SECRET"; SECRET=""
        export PSM_IMPORT_KEY
        import_hex_env
        unset PSM_IMPORT_KEY
        ;;
      mnemonic)
        printf '%s\n' "$SECRET" | docker run --rm -i -v "$D/pocket-home:/home" "$IMG" \
          keys add operator --recover --keyring-backend test --home /home >/dev/null 2>&1 || true
        SECRET=""
        ;;
      *) echo "error: unknown key kind $KIND"; exit 2 ;;
    esac
    import_record "$WANT" pasted
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
    if pd query auth account "$ADDR" --network="$NETARG" -o json 2>/dev/null | grep -qE '"(public_)?key"'; then echo "published: already on chain"; exit 0; fi
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
    for i in $(seq 1 60); do sleep 5; if pd query auth account "$ADDR" --network="$NETARG" -o json 2>/dev/null | grep -qE '"(public_)?key"'; then echo "published: public key now on chain"; exit 0; fi; done
    echo "error: the self-transfer ${TX%% *} was accepted but its inclusion was not seen within 5 minutes; run provisioning again, it resumes here"; exit 1
    ;;
  start)
    need_pins
    size_stack
    # Download first, while anything already running keeps serving; then check both
    # configs with the new image. Nothing is restarted unless both pass.
    dc pull --quiet >/dev/null 2>&1 || { echo "error: could not download the stack's images: $(dc pull 2>&1 | tail -2 | tr '\n' ' ')"; exit 1; }
    validate_stack
    caddy_up
    if relayer_has_services; then dc up -d --remove-orphans 2>&1 | tail -4; wait_health || true
    else dc up -d --remove-orphans redis miner 2>&1 | tail -3; echo "relayer: waiting for the first service"; fi
    versions_line
    ;;
  deploy)
    ID="${1:?service id}"; ROOT="${2:-/opt/pocket/services}"
    SVC="$ROOT/$ID"
    [ -f "$SVC/deploy/docker-compose.yaml" ] || { echo "error: $SVC/deploy/docker-compose.yaml missing"; exit 1; }
    docker network inspect "$NET_NAME" >/dev/null 2>&1 || docker network create "$NET_NAME" >/dev/null
    cd "$SVC/deploy" && docker compose -p "$ID" up -d --build 2>&1 | tail -3
    HP="${3:-/healthz}"
    # The port this network's relayer calls (the service's deploy/relayer.json; 8080 by default).
    PORT="${4:-8080}"
    [[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || { echo "error: bad backend port $PORT"; exit 2; }
    for i in $(seq 1 60); do
      if docker run --rm --network "$NET_NAME" alpine:3 wget -qO- "http://$ID-backend:$PORT$HP" 2>/dev/null | grep -q '"'; then echo "backend: healthy at http://$ID-backend:$PORT$HP"; exit 0; fi
      sleep 2
    done
    echo "error: backend did not answer $HP on port $PORT within 120 s"; docker logs --tail 20 "$ID-backend" 2>&1 | tail -20; exit 1
    ;;
  add-service)
    ID="${1:?service id}"; URL="${2:?backend url}"; HP="${3:-/healthz}"
    need_pins
    [ -f "$D/compose.env" ] || size_stack >/dev/null
    cp -f "$CFG" "$CFG.before"
    python3 - "$CFG" "$ID" "$URL" "$HP" <<'PY'
import sys, re
cfg, sid, url, hp = sys.argv[1:5]
t = open(cfg).read()
block = f"  {sid}:\n    timeout_profile: fast\n    max_body_size_bytes: 20971520\n    default_backend: rest\n    backends:\n      rest:\n        url: \"{url}\"\n        health_check:\n          endpoint: \"{hp}\"\n          interval_seconds: 10\n          timeout_seconds: 5\n"
# An existing entry keeps its place and its other settings. When its URL or health path
# differs (a redeploy that changed this network's relay port or the readiness path), only
# those two lines are rewritten. An entry missing either line is replaced whole.
old = re.search(rf'^  {re.escape(sid)}:\n(?:    .*\n|\n)*', t, re.M)
if old:
    body = old.group(0)
    U = r'^([ \t]+url:[ \t]*)"?([^"\n]*)"?[ \t]*$'
    E = r'^([ \t]+endpoint:[ \t]*)"?([^"\n]*)"?[ \t]*$'
    u, e = re.search(U, body, re.M), re.search(E, body, re.M)
    was = (u.group(2) if u else "?") + " " + (e.group(2) if e else "?")
    if was == url + " " + hp:
        print("relayer: already lists", sid, "at", url); sys.exit(0)
    if u and e:
        body = re.sub(U, lambda m: m.group(1) + '"' + url + '"', body, count=1, flags=re.M)
        body = re.sub(E, lambda m: m.group(1) + '"' + hp + '"', body, count=1, flags=re.M)
        how = "updated"
    else:
        body, how = block, "replaced"
    open(cfg, "w").write(t[:old.start()] + body + t[old.end():])
    print("relayer:", how, sid, "to", url, hp, "(was " + was + ")"); sys.exit(0)
t = re.sub(r'^services:\s*\{\}\s*$', 'services:', t, count=1, flags=re.M)
m = re.search(r'^services:\s*$', t, re.M)
if not m: sys.exit("error: no services: line in " + cfg)
i = m.end() + 1
t = t[:i] + block + t[i:]
open(cfg, "w").write(t)
print("relayer: added", sid)
PY
    # A config the RelayMiner rejects would stop the relayer for every service; keep the
    # one that worked instead.
    if ! validate_stack; then mv -f "$CFG.before" "$CFG"; echo "error: the relayer config was put back as it was"; exit 1; fi
    rm -f "$CFG.before"
    dc up -d --force-recreate relayer 2>&1 | tail -2
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
    need_pins
    [ -f "$D/compose.env" ] || size_stack >/dev/null
    if relayer_has_services; then dc up -d --force-recreate relayer 2>&1 | tail -2; wait_health || true
    else dc stop relayer >/dev/null 2>&1 || true; echo "relayer: stopped (no services left)"; fi
    # Routes answer on every network's hostname here, so they go only when the last
    # network whose stack installed them stops serving the service.
    RF="$ROUTES_DIR/$ID.route"
    if [ -f "$RF" ]; then
      LEFT=""; for n in $(routes_networks "$RF"); do [ "$n" = "$NET" ] || LEFT="${LEFT:+$LEFT }$n"; done
      if [ -n "$LEFT" ]; then
        sed -i "s/^# networks: .*/# networks: $LEFT/" "$RF"
        echo "routes: $ID keeps its extra routes while $LEFT still serves it"
      else
        routes_drop "$ID" || exit 1
      fi
    fi
    ;;
  add-routes)
    ID="${1:?service id}"; shift
    [[ "$ID" =~ ^[A-Za-z0-9_-]{1,42}$ ]] || { echo "error: bad service id"; exit 2; }
    if [ $# -eq 0 ] || [ $(($# % 2)) -ne 0 ]; then echo "error: add-routes takes <path> <port> pairs"; exit 2; fi
    caddy_running || { echo "error: the shared Caddy is not running; provision this stack again"; exit 1; }
    SITE="$CADDY_DIR/sites/$NET.caddy"
    grep -q 'sites/routes/' "$SITE" 2>/dev/null || { echo "error: $NET.caddy predates service routes; provision this stack again, then deploy again"; exit 1; }
    mkdir -p "$ROUTES_DIR"
    F="$ROUTES_DIR/$ID.route"
    # Which stacks installed these routes, so remove-service knows when the last one goes.
    NETS=$(routes_networks "$F"); case " $NETS " in *" $NET "*) ;; *) NETS="${NETS:+$NETS }$NET" ;; esac
    BODY="# $ID: routes from the service's deploy/routes.json, written by the Pocket Service Manager."$'\n'"# networks: $NETS"$'\n'
    SEEN=" "; PAIRS=()
    # Ports a relayer calls this backend on, from this stack's relayer config and its sibling
    # stacks' (one directory per network, side by side); 8080 is refused below regardless.
    RELAY_PORTS=" $(cat "$CFG" "$(dirname "$D")"/*/relayer-config.yaml 2>/dev/null | grep -o "http://$ID-backend:[0-9]*" | sed 's/.*://' | sort -u | tr '\n' ' ' || true)"
    while [ $# -gt 0 ]; do
      P="$1"; PORT="$2"; shift 2
      [[ "$P" =~ ^/[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "error: bad route path $P"; exit 2; }
      [[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] && [ "$PORT" -ne 8080 ] || { echo "error: bad route port $PORT"; exit 2; }
      case "$RELAY_PORTS" in *" $PORT "*) echo "error: port $PORT is where a relayer on this server calls $ID-backend; a public route to it would serve relays without the relayer"; exit 1 ;; esac
      case "$SEEN" in *" $P "*) echo "error: $P is listed twice"; exit 2 ;; esac
      SEEN="$SEEN$P "
      # Paths are single segments, so two services collide only on the same path.
      for o in "$ROUTES_DIR"/*.route; do
        [ -f "$o" ] && [ "$o" != "$F" ] || continue
        if grep -qxF "handle_path $P/* {" "$o"; then echo "error: $P is already routed to $(basename "$o" .route) on this server"; exit 1; fi
      done
      BODY="${BODY}handle_path $P/* {"$'\n\t'"reverse_proxy $ID-backend:$PORT"$'\n'"}"$'\n'
      PAIRS+=("$P $PORT")
    done
    OLD=""; if [ -f "$F" ]; then OLD="$ROUTES_DIR/.$ID.route.old"; cp -f "$F" "$OLD"; fi
    printf '%s' "$BODY" > "$ROUTES_DIR/.$ID.route.new" && mv -f "$ROUTES_DIR/.$ID.route.new" "$F"
    if ! V=$(caddy_validate); then
      routes_restore "$F" "$OLD"
      echo "error: Caddy refused the routes, nothing changed: $(echo "$V" | grep -v '^{' | tail -1)"; exit 1
    fi
    if ! caddy_reload; then
      routes_restore "$F" "$OLD"; caddy_reload || true
      echo "error: Caddy did not reload with the routes; the previous routes are back"; exit 1
    fi
    rm -f "$OLD"
    for f in "$CADDY_DIR"/sites/*.caddy; do
      [ -f "$f" ] && ! grep -q 'sites/routes/' "$f" || continue
      echo "warning: $(basename "$f") predates service routes, so they do not answer on its hostname until that stack is provisioned again"
    done
    for pp in "${PAIRS[@]}"; do
      P="${pp% *}"; PORT="${pp#* }"
      echo "route: $P/ -> $ID-backend:$PORT"
      # From Caddy's side of the network: any HTTP answer, even a 404, means the port is up.
      W=$(docker exec pocket-caddy wget -S -O /dev/null -T 5 "http://$ID-backend:$PORT/" 2>&1 || true)
      if echo "$W" | grep -q 'HTTP/'; then echo "route: $ID-backend:$PORT answers"
      else echo "warning: nothing answers on $ID-backend:$PORT yet"; fi
    done
    ;;
  remove-routes)
    ID="${1:?service id}"
    [[ "$ID" =~ ^[A-Za-z0-9_-]{1,42}$ ]] || { echo "error: bad service id"; exit 2; }
    routes_drop "$ID" || exit 1
    ;;
  status)
    echo "dir: $D"
    echo "stack: $PROJECT ($NET)"
    [ -s "$D/operator-key.json" ] && echo "operator: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json")" || echo "operator: none"
    [ -s "$D/supplier-keys.yaml" ] && echo "keys: present" || echo "keys: missing"
    S=$(list_services); echo "services: ${S:-none}"
    docker ps --filter "name=$PROJECT-" --format 'container: {{.Names}} {{.Status}}'
    docker ps --filter "name=pocket-caddy" --format 'container: {{.Names}} {{.Status}}'
    if [ -n "$RELAYMINER_IMAGE" ]; then versions_line; else echo "versions: layout 1 (unpinned images); provision again to update"; fi
    if [ -f "$D/compose.env" ]; then echo "limits: $(grep -E '^(REDIS_MEM_LIMIT|MINER_MEM_LIMIT|RELAYER_MEM_LIMIT)=' "$D/compose.env" | tr '\n' ' ')"; fi
    curl -fs "http://127.0.0.1:$HEALTH_PORT/ready" >/dev/null 2>&1 && echo "relayer: healthy" || echo "relayer: not answering"
    ;;
  *)
    echo "error: unknown step $step"; exit 2
    ;;
esac
