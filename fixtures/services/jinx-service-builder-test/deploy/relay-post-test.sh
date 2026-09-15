#!/usr/bin/env bash
# Beta TestNet only. Tries the POST body flag variants of pocket-ap against the service.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
SERVICE=jinx-service-builder-test
KEYHEX=$(printf 'y\n' | docker run --rm -i -v "$D/app-home:/home" "$IMG" keys export test-app --unarmored-hex --unsafe --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n')
export POCKET_APP_PRIVATE_KEY="$KEYHEX"; unset KEYHEX
BODY='{"csv":"x,y\n1,2"}'
echo "== --data with -X POST"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest -X POST --path /v1/REPLACE-resource --data "$BODY" 2>&1 | tail -3
echo "== --data with --method POST"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest --method POST --path /v1/REPLACE-resource --data "$BODY" 2>&1 | tail -3
echo "== -d, -X POST, explicit Content-Type header"
pocket-ap call --config "$D/pocket-ap.yaml" --service "$SERVICE" --rpc-type rest -X POST --path /v1/REPLACE-resource -H "Content-Type: application/json" -d "$BODY" -v 2>&1 | tail -12
unset POCKET_APP_PRIVATE_KEY
