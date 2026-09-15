#!/usr/bin/env bash
# Writes supplier-keys.yaml for the HA RelayMiner from the operator key in
# ./pocket-home (the pocketd test keyring created by provision-operator.sh).
# The hex never leaves this directory and is never printed. Mode 400, owned by the
# uid the relay-miner image runs as (passed as $1, default 1000) so the read-only
# mount inside the containers works.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
IMG=ghcr.io/pokt-network/pocketd:latest
UID_IN_IMAGE="${1:-1000}"
HEX=$(printf 'y\n' | docker run --rm -i -v "$D/pocket-home:/home" "$IMG" keys export operator --unarmored-hex --unsafe --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n')
if [ "${#HEX}" -ne 64 ]; then echo "could not read the operator key (got ${#HEX} chars)"; exit 1; fi
umask 077
printf 'keys:\n  - "%s"\n' "$HEX" > "$D/supplier-keys.yaml"
unset HEX
sudo chown "$UID_IN_IMAGE":"$UID_IN_IMAGE" "$D/supplier-keys.yaml"
sudo chmod 400 "$D/supplier-keys.yaml"
echo "supplier-keys.yaml written ($(sudo wc -c < "$D/supplier-keys.yaml") bytes), owner uid $UID_IN_IMAGE"
