#!/usr/bin/env bash
# One-time migration on Cherry: moves the supplier stack out of the first service's
# folder into /opt/pocket/supplier, keeping the operator keyring, the Redis session
# trees, and the Let's Encrypt certificate. Run ON the server after the new files
# have been copied to /opt/pocket/supplier (deploy from the workstation does that):
#
#   bash /opt/pocket/supplier/migrate-from-service-folder.sh
#
# Downtime: the few minutes between stopping the old stack and the new one passing
# its health check. The old volumes and the old ha/ folder are kept (renamed) for
# rollback; delete them once the new stack has claimed a session.
set -euo pipefail
OLD=/opt/pocket/services/jinx-service-builder-test
NEW=/opt/pocket/supplier
OLDPROJ=jinx-service-builder-test
NEWPROJ=pocket-supplier
STAMP=$(date +%Y%m%d%H%M%S)

if [ ! -d "$OLD/ha" ] || [ ! -d "$OLD/pocket-home" ]; then echo "nothing to migrate: $OLD/ha or pocket-home missing"; exit 0; fi
for f in docker-compose.yaml relayer-config.yaml miner-config.yaml Caddyfile; do [ -s "$NEW/$f" ] || { echo "missing $NEW/$f; deploy the supplier files first"; exit 1; }; done

echo "== stopping the old stack and the backends (volumes are kept)"
docker compose -p "$OLDPROJ" -f "$OLD/ha/docker-compose.yaml" down --remove-orphans
docker compose -p deploy -f /opt/pocket/services/pretty-charts/deploy/docker-compose.yaml down 2>/dev/null || true

echo "== moving the operator keyring and keys"
# pocket-home belongs to the pocketd image's user (uid 1025), so the move needs sudo.
sudo mv "$OLD/pocket-home" "$NEW/pocket-home"
[ -f "$OLD/operator-key.json" ] && mv "$OLD/operator-key.json" "$NEW/operator-key.json"
sudo mv "$OLD/ha/supplier-keys.yaml" "$NEW/supplier-keys.yaml"
ls -la "$NEW/supplier-keys.yaml" "$NEW/pocket-home" | head -3

echo "== copying volumes to the new project name"
V=$(docker compose version --short 2>/dev/null || echo 2)
for v in redis-data caddy_data caddy_config; do
  if docker volume inspect "${NEWPROJ}_$v" >/dev/null 2>&1; then echo "  ${NEWPROJ}_$v exists, left alone"; continue; fi
  docker volume create --label "com.docker.compose.project=$NEWPROJ" --label "com.docker.compose.volume=$v" --label "com.docker.compose.version=$V" "${NEWPROJ}_$v" >/dev/null
  docker run --rm -v "${OLDPROJ}_$v:/from:ro" -v "${NEWPROJ}_$v:/to" alpine:3 sh -c 'cp -a /from/. /to/'
  echo "  copied ${OLDPROJ}_$v -> ${NEWPROJ}_$v ($(docker run --rm -v "${NEWPROJ}_$v:/v:ro" alpine:3 sh -c 'du -sh /v | cut -f1'))"
done

echo "== starting the supplier stack"
cd "$NEW" && docker compose -p "$NEWPROJ" up -d
for i in $(seq 1 60); do curl -fs http://127.0.0.1:8081/health >/dev/null 2>&1 && { echo "relayer healthy"; break; }; sleep 2; done

echo "== starting the backends on the supplier network"
cd "$OLD/deploy" && docker compose -p jinx-service-builder-test-backend up -d --build 2>&1 | tail -2
cd /opt/pocket/services/pretty-charts/deploy && docker compose -p pretty-charts up -d 2>&1 | tail -2

echo "== archiving the old layout (kept for rollback)"
mv "$OLD/ha" "$OLD/ha.migrated-$STAMP"
for f in relayminer_config.yaml relayminer_config.yaml.bak-grpc Caddyfile; do [ -f "$OLD/$f" ] && mv "$OLD/$f" "$OLD/ha.migrated-$STAMP/"; done
[ -d "$OLD/smt" ] && mv "$OLD/smt" "$OLD/ha.migrated-$STAMP/smt"

echo "== state"
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Networks}}'
echo "public endpoint: HTTP $(curl -sk -o /dev/null -w '%{http_code}' https://services.agentdata.network/)"
sleep 20
docker logs --tail 40 pocket-supplier-relayer 2>&1 | grep -iE 'backend|health|error|service' | tail -8 | cut -c1-220
echo "old volumes ${OLDPROJ}_* and $OLD/ha.migrated-$STAMP are kept; remove them once a claim has landed from the new stack."
