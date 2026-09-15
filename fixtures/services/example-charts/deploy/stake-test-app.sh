#!/usr/bin/env bash
# Beta TestNet only. Run ON the supplier host. Re-points the throwaway test
# application (key "test-app", created for the first service) at example-charts so
# pocket-ap can relay to it. An application stakes for EXACTLY ONE service, so this
# replaces its previous service; the stake may not go down (STAKE defaults to the
# 2,000 POKT already staked).
#
# The production model is one application wallet per service, created and funded
# in the Service Manager (Wallets tab), whose exported key drives relay-test.sh.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
FIRST="${FIRST:-/opt/pocket/services/example-builder-test}"
IMG=ghcr.io/pokt-network/pocketd:latest
NET=beta
SERVICE=example-charts
STAKE=${STAKE:-2000000000}
ADDR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$FIRST/test-app-key.json")
pd() { docker run --rm -v "$FIRST/app-home:/home" -v "$D:/work:ro" "$IMG" "$@"; }
current() { pd query application show-application "$ADDR" --network=$NET -o json 2>/dev/null | python3 -c 'import sys,json;a=json.load(sys.stdin)["application"];print(",".join(s["service_id"] for s in a["service_configs"]))' || true; }
printf 'stake_amount: %supokt\nservice_ids:\n  - %s\n' "$STAKE" "$SERVICE" > "$D/test_app_stake.yaml"
echo "test app: $ADDR"
CUR=$(current)
echo "currently staked for: ${CUR:-nothing}"
if [ "$CUR" = "$SERVICE" ]; then echo "already staked for $SERVICE"; exit 0; fi
pd tx application stake-application --config /work/test_app_stake.yaml --from test-app --keyring-backend test --home /home --network=$NET --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json 2>/tmp/stake.err | python3 -c 'import sys,json;t=json.load(sys.stdin);print("txhash",t["txhash"],"code",t["code"],t.get("raw_log","")[:200])' || { tail -3 /tmp/stake.err; exit 1; }
for i in $(seq 1 12); do
  sleep 5
  if [ "$(current)" = "$SERVICE" ]; then echo "staked for $SERVICE"; exit 0; fi
done
echo "stake not visible yet; check again in a minute"
