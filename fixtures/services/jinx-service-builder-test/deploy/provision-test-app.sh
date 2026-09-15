#!/usr/bin/env bash
# Beta TestNet only. Creates a throwaway APPLICATION key on the server (separate
# keyring dir ./app-home) used to send test relays with pocket-ap. Only the
# address is printed; the backup JSON is mode 600 next to it.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
mkdir -p "$D/app-home"
sudo chown 1025:1025 "$D/app-home"
if [ ! -s "$D/test-app-key.json" ]; then
  umask 077
  docker run --rm -v "$D/app-home:/home" "$IMG" keys add test-app --keyring-backend test --home /home --output json > "$D/test-app-key.json" 2>/dev/null
  chmod 600 "$D/test-app-key.json"
fi
python3 -c 'import json,sys;print("test app address:", json.load(open(sys.argv[1]))["address"])' "$D/test-app-key.json"
