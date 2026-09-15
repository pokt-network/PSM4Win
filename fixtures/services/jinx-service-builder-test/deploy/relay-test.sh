#!/usr/bin/env bash
# Beta TestNet only. Sends real relays to this service through the Pocket
# protocol with pocket-ap, signed by the throwaway test application. The app
# key is read from the test keyring into the environment for the duration of
# this script and never printed.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
NET=beta
SERVICE=jinx-service-builder-test
cat > "$D/pocket-ap.yaml" <<EOF
network: $NET
listeners:
  - addr: 127.0.0.1:8550
    service_id: $SERVICE
    rpc_type: rest
apps: []
EOF
# Export the app key hex (never echoed). pocketd asks "continue? [y/N]" for --unsafe on the test backend too.
KEYHEX=$(printf 'y\n' | docker run --rm -i -v "$D/app-home:/home" "$IMG" keys export test-app --unarmored-hex --unsafe --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n')
if [ "${#KEYHEX}" -ne 64 ]; then echo "could not read the test app key (got ${#KEYHEX} chars)"; exit 1; fi
export POCKET_APP_PRIVATE_KEY="$KEYHEX"
unset KEYHEX
echo "== GET /v1/version"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest -X GET --path /v1/version -v 2>&1 | tail -25
echo
echo "== GET /healthz"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest -X GET --path /healthz 2>&1 | tail -5
echo
echo "== POST /v1/REPLACE-resource (the template's example resource)"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest -X POST --path /v1/REPLACE-resource -d '{"csv":"x,y\n1,2"}' 2>&1 | tail -5
echo
echo "== POST with bad input (expect a JSON 4xx passed through)"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest -X POST --path /v1/REPLACE-resource -d '{"nope":1}' 2>&1 | tail -5
unset POCKET_APP_PRIVATE_KEY
