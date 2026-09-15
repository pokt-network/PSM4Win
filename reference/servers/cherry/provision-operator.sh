#!/usr/bin/env bash
# Creates the supplier operator key for this server, in a pocketd "test" keyring
# under ./pocket-home (owned by the pocketd image's user, uid 1025). One operator
# per server; it signs relays and claims for every service the supplier serves.
# The key never leaves the server. Its backup JSON (including the seed) is written
# next to it with mode 600; only the address is printed.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
mkdir -p "$D/pocket-home"
sudo chown 1025:1025 "$D/pocket-home"
if [ ! -s "$D/operator-key.json" ]; then
  umask 077
  docker run --rm -v "$D/pocket-home:/home" "$IMG" keys add operator --keyring-backend test --home /home --output json > "$D/operator-key.json" 2>/dev/null
  chmod 600 "$D/operator-key.json"
fi
ADDR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["address"])' "$D/operator-key.json")
echo "operator address: $ADDR"
echo "keys in keyring: $(docker run --rm -v "$D/pocket-home:/home" "$IMG" keys list --keyring-backend test --home /home --output json 2>/dev/null | python3 -c 'import sys,json;print(",".join(k["name"] for k in json.load(sys.stdin)))')"
