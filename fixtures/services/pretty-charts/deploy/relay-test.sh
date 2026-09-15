#!/usr/bin/env bash
# Beta TestNet only. Run ON the supplier host. Sends relays for pretty-charts through
# the protocol with pocket-ap, signed by an application staked for pretty-charts.
#
# Key source, in order:
#   1. POCKET_APP_PRIVATE_KEY already in the environment (64 hex chars), e.g. the
#      app wallet exported from the Service Manager's Wallets tab;
#   2. $D/app-key.hex (mode 600, never committed) holding that hex;
#   3. the throwaway "test-app" key from the first service's keyring, after
#      stake-test-app.sh re-pointed it at pretty-charts.
# The application must be staked for pretty-charts and the supplier must be in its
# current session, so wait one session after staking.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="${APP_HOME:-/opt/pocket/services/jinx-service-builder-test/app-home}"
IMG=ghcr.io/pokt-network/pocketd:latest
SERVICE=pretty-charts
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ] && [ -s "$D/app-key.hex" ]; then
  POCKET_APP_PRIVATE_KEY=$(tr -d '[:space:]' < "$D/app-key.hex")
fi
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ]; then
  POCKET_APP_PRIVATE_KEY=$(printf 'y\n' | docker run --rm -i -v "$APP_HOME:/home" "$IMG" keys export test-app --unarmored-hex --unsafe --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n')
fi
export POCKET_APP_PRIVATE_KEY
AP="pocket-ap call --config $D/rendered/pocket-ap.yaml --service $SERVICE --rpc-type rest"

echo "== GET /v1/version"
$AP -X GET --path /v1/version 2>&1 | tail -2
echo "== GET /v1/capabilities"
$AP -X GET --path /v1/capabilities 2>&1 | tail -1 | cut -c1-300
echo "== POST /v1/chart (shorthand bar, CSV)"
BODY='{"data":{"csv":"month,sales\nJan,120\nFeb,98\nMar,143"},"chart":{"type":"bar","x":"month","y":"sales","title":"Sales"}}'
OUT=$($AP -X POST --path /v1/chart --data "$BODY" 2>&1 | tail -1)
echo "$OUT" | python3 -c 'import sys,json
t=sys.stdin.read()
try:
    j=json.loads(t); h=j.pop("html",""); print(json.dumps(j)); print("html bytes", len(h), "first 60:", h[:60])
except Exception as e:
    print("not JSON:", t[:300])'
echo "== POST /v1/chart (bad input must be a 4xx JSON error)"
$AP -X POST --path /v1/chart --data '{"data":{"csv":"a\n1"},"chart":{"type":"nope"}}' 2>&1 | tail -1 | cut -c1-300
unset POCKET_APP_PRIVATE_KEY
