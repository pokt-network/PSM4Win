#!/usr/bin/env bash
# Beta TestNet only. Gives the operator account a small working balance from the
# public faucet (claim and proof transactions cost gas) and sends one transaction
# from it so its public key is recorded on chain, which gateways and clients need
# to verify the RelayMiner's signed responses.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
NET=beta
ADDR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json")
pd() { docker run --rm -v "$D/pocket-home:/home" "$IMG" "$@"; }
bal() { pd query bank balances "$ADDR" --network=$NET -o json 2>/dev/null | python3 -c 'import sys,json;b=[x for x in json.load(sys.stdin).get("balances",[]) if x["denom"]=="upokt"];print(b[0]["amount"] if b else 0)'; }
echo "operator: $ADDR"
echo "balance before: $(bal) upokt"
if [ "$(bal)" -lt 1000000 ]; then
  echo "requesting faucet funds"
  pd faucet fund upokt "$ADDR" --network=$NET 2>&1 | tail -3 || true
  for i in $(seq 1 12); do sleep 5; [ "$(bal)" -ge 1000000 ] && break; done
  echo "balance after faucet: $(bal) upokt"
fi
# Is the public key already on chain?
if pd query auth account "$ADDR" --network=$NET -o json 2>/dev/null | grep -q '"key"'; then
  echo "public key already on chain"
else
  echo "sending 1upokt to self to publish the public key"
  pd tx bank send operator "$ADDR" 1upokt --from operator --keyring-backend test --home /home --network=$NET --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json 2>/dev/null | python3 -c 'import sys,json;t=json.load(sys.stdin);print("txhash",t["txhash"],"code",t["code"])'
  for i in $(seq 1 12); do sleep 5; pd query auth account "$ADDR" --network=$NET -o json 2>/dev/null | grep -q '"key"' && { echo "public key now on chain"; break; }; done
fi
echo "balance now: $(bal) upokt"
