#!/usr/bin/env bash
# Beta TestNet only. Stakes the throwaway test application (key "test-app" in
# ./app-home) for this service so pocket-ap can send relays to it.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
NET=beta
SERVICE=jinx-service-builder-test
STAKE=${STAKE:-2000000000}   # upokt; the live minimum is 1,000 POKT on Beta
ADDR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/test-app-key.json")
pd() { docker run --rm -v "$D/app-home:/home" -v "$D:/work:ro" "$IMG" "$@"; }
printf 'stake_amount: %supokt\nservice_ids:\n  - %s\n' "$STAKE" "$SERVICE" > "$D/test_app_stake.yaml"
echo "test app: $ADDR"
if pd query application show-application "$ADDR" --network=$NET -o json >/dev/null 2>&1; then
  echo "already staked:"; pd query application show-application "$ADDR" --network=$NET -o json 2>/dev/null | python3 -c 'import sys,json;a=json.load(sys.stdin)["application"];print(" stake",a["stake"]["amount"],"services",[s["service_id"] for s in a["service_configs"]])'
  exit 0
fi
pd tx application stake-application --config /work/test_app_stake.yaml --from test-app --keyring-backend test --home /home --network=$NET --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json 2>/tmp/stake.err | python3 -c 'import sys,json;t=json.load(sys.stdin);print("txhash",t["txhash"],"code",t["code"],t.get("raw_log","")[:200])' || { tail -3 /tmp/stake.err; exit 1; }
for i in $(seq 1 12); do sleep 5; if pd query application show-application "$ADDR" --network=$NET -o json >/dev/null 2>&1; then break; fi; done
pd query application show-application "$ADDR" --network=$NET -o json 2>/dev/null | python3 -c 'import sys,json;a=json.load(sys.stdin)["application"];print("staked:", "stake",a["stake"]["amount"],"services",[s["service_id"] for s in a["service_configs"]])'
