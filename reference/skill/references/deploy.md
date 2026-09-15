# Deploy a service

Canonical page: https://docs.pocket.network/services/deploy/. Worked LLM example: https://github.com/pnyxai/pocket-network-supplier-example. This reference is the tooling layer.

You are turning a registered service into a supplied one: a backend, a RelayMiner, a stake, a TLS endpoint, and a test. Later suppliers follow the same steps reading the published card.

## 1. Design and lint the backend

Design against `references/design-rules.md` first; the rules change the code, not just the config. Then, against a running backend:

```bash
python scripts/lint_backend.py --base-url http://localhost:8080 --card ./card.json \
  --bad "POST /v1/REPLACE-resource notjson"
```

Every check must pass before you stake. The `templates/backends/{python,node,go}` skeletons already satisfy the rules and implement the three probe endpoints; offer one if there is no backend yet.

## 2. Choose a RelayMiner

Always use the **HA RelayMiner** (`pocket-relay-miner`: Redis + miner + relayer). Templates: `ha/`. It is the production design (replicas, failover, SSE streaming) and it works against the public Sauron endpoints, because it queries the chain through the generated gRPC clients and does not depend on response headers. Use `query_node_grpc_url` as `host:443`, set `chain_id` under `pocket_node`, keep the relayer's key section named `keys`, and give Redis a persistent volume (session trees live there; losing it forfeits unclaimed relays).

Do **not** use the legacy single-process `pocketd relayminer`. It is scheduled for deprecation, and its claim signing goes through the Cosmos SDK account retriever, which requires the `x-cosmos-block-height` gRPC response header that the public Sauron gRPC endpoints strip (Beta and MainNet, verified 2026-09-14): relays are served but every claim fails with "unexpected 'x-cosmos-block-height' header length; got 0" and the session is forfeited. `relayminer_config.yaml` and `docker-compose.single.yaml` remain only as deprecated references.

**One supplier stack per network per server, never one per service.** A supplier is a stake plus one RelayMiner, and one stake covers every service the supplier lists, so the Redis, miner, and relayer live in a stack folder with that stack's operator keyring, and each service is only a backend container started from its own compose file (`templates/backend-compose.yaml`) on the shared `pocket-supplier` network. The stack is per network because its chain ID, node URLs, operator key, and stake are: a server that supplies both Beta and MainNet holds two stack folders (for example `/opt/pocket/supplier-beta/` and `/opt/pocket/supplier-main/`), each with its own compose project name and loopback ports, and two public hostnames, one per network, since a relay carries nothing a proxy could route on. The server, Docker, the backends, and the reverse proxy are network-agnostic: one Caddy per server imports one site file per network and forwards each hostname to that network's relayer by container name, and one backend container serves both relayers. Adding a service to a network on a server means: start its backend there (once), add one `services:` entry to that network's `relayer-config.yaml` pointing at `http://<service-id>-backend:8080`, recreate that relayer, and re-stake that network's supplier with the service in its list.

Streaming responses require HA and non-gateway clients.

## 3. Render the deployment files

```bash
python scripts/render_templates.py --print-answers > answers.json   # edit this
python scripts/render_templates.py answers.json --out ./deploy
```

`answers.json` holds no private keys. Set `BACKEND_URL` to the backend container's name on the supplier network (`http://<service-id>-backend:8080`), not `127.0.0.1`, and `GRPC_URL` as `host:443` with no scheme. The renderer flags any `{{PLACEHOLDER}}` it could not fill. What you deploy: for a server's first service, `deploy/ha/*` plus the reverse proxy config into the server-level supplier folder (`deploy/ha/supplier-keys.yaml` is filled there from the operator keyring and never committed) and `deploy/backend-compose.yaml` into the service's own folder; for every later service on that server, only `backend-compose.yaml` plus the new `services:` entry for the existing relayer config.

## 4. Stake the supplier

Use `deploy/supplier_stake_config.yaml`. Confirm `rpc_type` matches the card. Before staking, send any transaction from the operator account so its public key is on-chain, or gateways reject its signed responses.

```bash
pocketd tx supplier stake-supplier --config ./deploy/supplier_stake_config.yaml \
  --from <operator> --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5
python scripts/query_state.py --network beta --supplier <operator-addr>
```

The service config activates at the next session boundary; read the live session length and block time rather than assuming a duration. Tell the developer so the wait is expected. Until that boundary the supplier record's `services` still shows the old list and the new one sits in `service_config_history` with `deactivation_height: 0` and a future `activation_height`; `query_state.py --supplier` prints those entries as SCHEDULED. A verification that reads only `services` right after inclusion reports a false failure.

**Stake above the minimum, not at it.** The stake is the amount the protocol can slash. A missed required proof deducts `proof_missing_penalty` from it, and a supplier whose stake falls below `min_stake` is auto-unstaked; a stake that equals the minimum has no room at all, and the minimum itself is a governance parameter that can rise. Fetch both values with `live_params.py` and keep a margin above the minimum (a few hundred POKT is plenty at today's penalty; re-check the penalty rather than assuming it).

**One relay stack serves many services, but it needs at least one.** The HA relayer refuses to start with an empty `services:` map ("at least one service must be configured"). When a server is provisioned before its first service, start Redis, the miner, and the reverse proxy, and start the relayer when the first service's entry is added.

**Unstaking.** `pocketd tx supplier unstake-supplier <operator-address> --from <owner-or-operator>` begins unbonding; the chain accepts either the owner or the operator as signer, and the stake always returns to the owner. The supplier keeps serving until the current session ends, then the stake is locked for `supplier_unbonding_period_sessions` sessions (fetch it; it differs between networks, hours on Beta and weeks on MainNet as of 2026-09) and returns to the owner wallet at `unstake_session_end_height + supplier_unbonding_period_sessions × num_blocks_per_session`. While unbonding, the supplier record carries `unstake_session_end_height`; `query_state.py --supplier` and the MCP `supplier_status` tool report it. To serve again afterwards, stake anew with the same operator; the RelayMiner and its key need no change.

## 5. Run the RelayMiner and TLS

The supplier stack (redis + miner + relayer) from the server-level folder, then the service's backend on its network:

```bash
cd /opt/pocket/supplier && docker compose -p pocket-supplier up -d
cd /opt/pocket/services/<service-id>/deploy && docker compose -p <service-id> up -d --build
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/health   # 200 = relayer ready
docker logs <relayer-container> 2>&1 | grep "signing keys loaded"        # the operator key was read
docker logs <miner-container>   2>&1 | grep "HA Miner started"
```

If the relayer logs "no key providers configured", the `keys` section is missing from its config or `supplier-keys.yaml` is unreadable by the container's user (uid 1000 in the image); every relay is rejected as unsigned until fixed.

Put `deploy/Caddyfile` or `deploy/nginx.conf` in front for TLS, pointed at the relayer's `listen_addr`; stake the proxy's public `https://` URL. The relayer speaks plain HTTP and must not be exposed directly. Never expose the health (`:8081`) or metrics (`:9090`, `:9092`) ports publicly.

## 6. Test end to end

Stake a small test application (`deploy/app_stake_config.yaml`), wait for the next session, then relay with pocket-ap (no gateway needed). An account can be staked as an application for exactly one service, so a developer with several services needs one application account per service, each funded from the owner account and staked for its own service; restaking an account for a different service re-points it and drops the old one.

pocket-ap runs anywhere Docker runs, which is the easiest route on Windows; the key is passed through the container's environment, never on the command line:

```bash
docker run --rm -e POCKET_APP_PRIVATE_KEY -v "$PWD/deploy:/work:ro" ghcr.io/pokt-network/pocket-ap:latest \
  call --config /work/pocket-ap.yaml --service <id> --rpc-type rest \
  -X POST --path /v1/REPLACE-resource --data @/work/body.json -v
```

Or with a local install (`go install github.com/pokt-network/pocket-ap/cmd/pocket-ap@latest`, or brew):

```bash
POCKET_APP_PRIVATE_KEY=<app-key-hex> pocket-ap call --config ./deploy/pocket-ap.yaml \
  --service <id> --rpc-type rest -X POST --path /v1/REPLACE-resource -d '{"...":"..."}' -v
```

How to read its output: the response body goes to stdout verbatim; `-v` diagnostics go to stderr, including the session id, the supplier that answered and its latency, and, for a 4xx or 5xx from the backend, a line `upstream returned HTTP <code>` (the exit code is still 0 and the body is still printed, so a JSON 4xx for bad input is a pass). A non-zero exit means the relay itself failed: no supplier in session, a signature problem, or the endpoint unreachable. `--compare http://localhost:8080` diffs the relayed answer against a direct backend call. `pocketd relayminer relay` is JSON-RPC only and cannot exercise a REST service.

Confirm the relay was accounted for:

```bash
python scripts/query_state.py --network beta --session --app <app-addr> --service <id> --supplier <operator-addr>
python scripts/query_state.py --network beta --claims --supplier <operator-addr>
```

To exercise the path most users take, run SAGE locally with the `sage-service.yaml` block.

**Stake the application above the minimum, never at it.** Settlement pays suppliers from the application's stake, and an application whose stake drops below `min_stake` (application params; fetch it) is unstaked by the protocol at the end of the session, with the reason recorded as below-minimum-stake and an `unstake_session_end_height` on its record. A stake of exactly the minimum therefore unbonds after the first settled relay. Stake the minimum plus a margin (the app defaults to 10%). Staking again while unbonding cancels the unbonding and keeps the delegations (poktroll `msg_server_stake_application.go`).

**Delegate the application to a gateway.** A self-signing client such as pocket-ap signs its own relays, but reaching the service through a gateway (SAGE, including the one behind the agentic portal) requires the application to delegate to that gateway: `pocketd tx application delegate-to-gateway <gateway-address> --from <app-key> --network=<beta|main>`. The gateway may then sign relays on the application's behalf; the application's stake still pays for them, and the transaction costs gas only. List the registered gateways with `GET /pokt-network/poktroll/gateway/gateway` (response key `gateways`) rather than remembering an address; an application may delegate to at most `max_delegated_gateways` (application params; fetch it), and the record's `delegatee_gateway_addresses` shows the current set. `undelegate-from-gateway` removes one and takes effect when the current session ends (`pending_undelegations`).

## 7. Onboard gateways

Gateways do not read the card. Publish `deploy/sage-service.yaml` with the service docs, and open a PR adding `deploy/pocket-health-checks-entry.yaml` to `pocket-network-resources` for the public gateway. A gateway that has not been configured refuses the service's REST requests with a 400.

## 8. Server specs

| Component | Minimum | Comfortable |
|---|---|---|
| Backend | what your service needs; size for concurrent bursts, not average | |
| RelayMiner | 1 vCPU, 1 GB RAM, 5 GB SSD | 4 vCPU, 16 GB RAM |
| Full node (optional) | 4 vCPU, 16 GB, 200 GB SSD | 6 vCPU, 32 GB, 420 GB |

Linux on x86_64 or ARM64. Redis on a persistent volume with append-only persistence (session trees live there). Operator balance kept above a few POKT for claim/proof fees. Metrics scraped from `:9090` (relayer) and `:9092` (miner). The HA RelayMiner works against the public Sauron RPC/gRPC endpoints (verified on Beta with a settled claim); a production RelayMiner may still prefer a node it controls for latency and independence.

## 9. MainNet

Re-fetch `min_stake`, `add_service_fee`, and pricing with `--network main`; repoint `pocket_node` URLs and `--chain-id pocket`; everything else is unchanged. Stake, wait a session, relay, watch for the first claim, then publish the gateway config and tell operators the service exists. A supplier no gateway routes to earns nothing.
