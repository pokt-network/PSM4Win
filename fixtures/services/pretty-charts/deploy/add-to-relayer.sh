#!/usr/bin/env bash
# Run ON the supplier host after the service is registered and the supplier is staked
# for it. Adds the pretty-charts block (relayer-service.yaml) to the HA relayer's
# config under `services:`, restarts the relayer, and waits for its health endpoint.
# Idempotent: a config that already has the block is left alone.
#
#   bash /opt/pocket/services/pretty-charts/deploy/add-to-relayer.sh [supplier-stack-dir]
#
# Default stack dir: /opt/pocket/supplier (project pocket-supplier)
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
STACK="${1:-/opt/pocket/supplier}"
CFG="$STACK/relayer-config.yaml"
PROJECT="${2:-pocket-supplier}"

if grep -qE '^  pretty-charts:' "$CFG"; then
  echo "relayer config already lists pretty-charts; nothing to add"
else
  cp "$CFG" "$CFG.bak-$(date +%Y%m%d%H%M%S)"
  python3 - "$CFG" "$D/relayer-service.yaml" <<'PY'
import sys
cfg, snippet = sys.argv[1], sys.argv[2]
lines = open(cfg).read().split("\n")
block = [l for l in open(snippet).read().split("\n") if not l.startswith("#")]
while block and block[-1] == "": block.pop()
for i, l in enumerate(lines):
    if l.strip() == "services:":
        lines[i+1:i+1] = block
        break
else:
    sys.exit("no 'services:' line in " + cfg)
open(cfg, "w").write("\n".join(lines))
print("inserted pretty-charts block into", cfg)
PY
fi

echo "== restarting the relayer (project $PROJECT)"
docker compose -p "$PROJECT" -f "$STACK/docker-compose.yaml" up -d --force-recreate relayer 2>&1 | tail -2
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:8081/health >/dev/null 2>&1; then echo "relayer healthy"; break; fi
  sleep 1
done
docker logs --tail 15 "$PROJECT-relayer" 2>&1 | grep -iE "pretty-charts|error|backend" || true
