#!/usr/bin/env bash
# Ships the Pretty Charts backend to the supplier host and starts it on the supplier
# stack's network. Run from anywhere on the workstation:
#
#   bash services/pretty-charts/deploy/deploy.sh [ssh-host] [remote-root]
#
# Defaults: host "cherry", remote root /opt/pocket/services/pretty-charts.
# Copies backend/ (without node_modules) and deploy/, builds the image on the server,
# starts the container, and checks /healthz from inside the container. It does not
# touch the relayer; run add-to-relayer.sh on the server for that (once the service
# is registered and the supplier is staked for it).
set -euo pipefail
HOST="${1:-cherry}"
ROOT="${2:-/opt/pocket/services/pretty-charts}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "== copying backend/ and deploy/ to $HOST:$ROOT"
ssh "$HOST" "mkdir -p '$ROOT'"
tar -C "$HERE" --exclude=node_modules --exclude=rendered -cf - backend deploy | ssh "$HOST" "tar -C '$ROOT' -xf -"

echo "== building and starting the container"
ssh "$HOST" "cd '$ROOT/deploy' && docker compose -f docker-compose.yaml up -d --build 2>&1 | tail -3"

echo "== waiting for readiness"
for i in $(seq 1 40); do
  if ssh "$HOST" "docker exec pretty-charts-backend wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null" | grep -q '"ok"'; then
    echo "backend ready:"; ssh "$HOST" "docker exec pretty-charts-backend wget -qO- http://127.0.0.1:8080/v1/version"; echo
    exit 0
  fi
  sleep 1
done
echo "backend did not become ready; logs:"; ssh "$HOST" "docker logs --tail 20 pretty-charts-backend"; exit 1
