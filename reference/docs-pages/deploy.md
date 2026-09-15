---
title: Deploy a Service
description: Build a backend that works well behind a RelayMiner, stake a supplier, run the RelayMiner, test end to end, and hand gateway operators what they need to route to you.
sidebar:
  order: 3
---

This guide takes you from a registered service ID to a supplier serving real relays. Budget a day: a few hours to build and test the backend against the rules below, an hour for staking and the RelayMiner, and a session or two of waiting for the network to pick your supplier up.

It assumes the service is already registered. If it is not, start with [Register a Service](/services/register). It also assumes you are the first supplier. A later supplier follows the same steps from [Stake a Supplier](#stake-a-supplier) onward, reading the service's metadata card instead of writing it.

:::danger
**Every relay a supplier serves is signed with the operator key.** A lost operator key cannot be replaced on an existing supplier stake; the operator address is immutable. Back it up before staking and never run two RelayMiners with the same key against the same service unless you intend them as replicas.
:::

## Prerequisites

1. **A registered service ID** with a metadata card. See [Register a Service](/services/register).
2. **`pocketd` installed** and two funded accounts: an **owner** that holds the stake and an **operator** that signs relays. Non-custodial staking, where these are different accounts, is recommended for production. See [Supplier Staking](/node-operators/supplier-staking) for the owner-operator model and [Accounts & Keys](/pocketd/accounts-keys).
3. **Enough POKT to stake.** The supplier minimum is a governance parameter; query it:
   ```bash
   pocketd query supplier params --network=beta
   ```
   As of September 2026 it was 59,500 POKT on both Beta TestNet and MainNet. On Beta, request funds from the faucet listed on the [Networks](/get-started/networks) page. The operator account also needs a small working balance for claim and proof transaction fees.
4. **A public HTTPS endpoint.** Suppliers publish a URL that gateways connect to. It must be reachable from the internet, on `https://` with a publicly trusted certificate, and terminated by a reverse proxy you control, because the RelayMiner itself speaks plain HTTP.
5. **Access to a Pocket full node**, either your own or a public RPC and gRPC endpoint from the [Networks](/get-started/networks) page. A RelayMiner needs both.

### Set Up Environment

```bash
export SERVICE_ID=<your-service-id>
export OWNER=<owner-key-name>
export OPERATOR=<operator-key-name>
export NETWORK=beta            # or main
export TX_FLAGS="--network=$NETWORK --gas auto --gas-prices 1upokt --gas-adjustment 1.5"
```

## Build the Backend

The backend is an ordinary HTTP server. It does not talk to the chain, verify signatures, or know what a session is; the RelayMiner does all of that. What the backend receives is a plain HTTP request with the method, path, query string, headers, and body the client sent, and what it returns is passed back to the client.

There is one catch. Most clients reach your service through a gateway, and gateways grade every response to decide which suppliers to trust. A backend that ignores the rules below will work perfectly when you test it directly and will get its suppliers penalized in production. Design to these rules from the first line of code.

### Every response is a JSON object

Gateways classify a response body by its first byte. A body that starts with `{` or `[` is graded as a normal response. A body that starts with `<html` or `<!DOCTYPE` is treated as a proxy error page: the request is retried on another supplier and the supplier that answered is penalized and circuit-broken. Plain text, an empty body on a 200, or CSV get the same treatment.

So any output that is not itself JSON travels as a string inside a JSON object. The field names are your contract, not a network rule; what matters is that the body starts with `{`.

```json
{
  "content_type": "text/html",
  "body": "<!DOCTYPE html><html>...</html>"
}
```

Plain JSON string escaping is sufficient. Base64 is not needed and doubles the size. Put short metadata fields first and the large string last.

### All inputs arrive in the body

Gateways forward the HTTP method, the path, and the query string, but they do not forward the caller's request headers and they always set `Content-Type: application/json` on the request your backend sees. Some clients drop the query string as well. Design every endpoint to take its inputs from a JSON request body, including bulk data such as CSV, and use `POST` for anything with inputs.

### No caller authentication

Relays are paid for by the application's stake, not by a credential. Gateways and application-side relay clients strip `Authorization`, `Api-Key`, `X-Api-Key`, and `Cookie` headers before forwarding. If your backend needs a credential to reach something behind it, the RelayMiner can inject static headers or HTTP basic auth toward the backend; the caller never supplies one.

### Status codes

| Situation | Return | Why |
|---|---|---|
| Success | `200` with a JSON object | Graded as success. |
| Nothing to return | `204` with no body | The only status where an empty body is graded as correct. |
| Bad input | `400` or `422` with a JSON error object | Gateways treat a 4xx with a JSON body as the client's mistake: delivered as is, not retried, no penalty. |
| Backend failure | `5xx` | Retried elsewhere, the supplier is penalized, and the relay is not paid. Reserve for real failures. |

Never answer an expected condition with a 5xx, and never answer any error with HTML or plain text.

### Avoid error-looking words early in a success body

Gateways also scan the first 2 KB of a body for substrings that indicate an upstream failure, among them `timeout`, `bad gateway`, `service unavailable`, `gateway timeout`, `connection refused`, and `connection reset`, and they retry on a match even inside a valid JSON object. Do not name fields `timeout` and do not echo those phrases in status messages.

### Respond within the session

Gateways bound each relay attempt, typically to between 10 and 30 seconds. A relay whose backend call finishes after the session and its grace period ends is not paid. Long-running work should return quickly with a handle rather than blocking, unless you deliberately target streaming-capable clients through the HA RelayMiner.

### Serve identity encoding

Application-side relay clients force `Accept-Encoding: identity`. Do not gzip responses.

### Provide the three probe endpoints

Your metadata card's `serving.healthcheck` names an identity endpoint, a readiness endpoint, and a cheap functional request. Implement them exactly as the card describes; suppliers and gateways will run them.

```
GET  /v1/version   → {"service": "<service-id>", "version": "1.2.0"}
GET  /v1/health    → {"status": "ok"}
POST /v1/<resource> with a minimal body → a deterministic answer
```

### Test the backend directly

Before involving the network, run the card's health checks against the backend with `curl`, and confirm that every response, including error responses, starts with `{`.

Two things `curl` will not show you, because they only happen behind a RelayMiner:

- **Relay bodies arrive chunked.** The RelayMiner forwards the request body with `Transfer-Encoding: chunked` and no `Content-Length`. Frameworks decode this for you; a hand-written server that reads `Content-Length` bytes sees an empty body on every relay while working perfectly under `curl`.
- **The RelayMiner pings your root.** Its backend health check requests `GET /` on the backend URL and treats anything but a 2xx as "backend down". Answer `GET /` (and `HEAD`) with a small JSON object.

## The RelayMiner

Run the **HA RelayMiner** (`pocket-relay-miner`): stateless relayers that answer relays plus a miner that builds session trees and submits claims and proofs, coordinated through Redis. It is the production design (multiple replicas, failover, streaming responses, active per-backend health checks), and it is also the right choice for a first deployment, because it works against the public Sauron endpoints. Documentation: [HA RelayMiner](/node-operators/ha-relayminer).

The legacy single-process `pocketd relayminer` is scheduled for deprecation. Do not start a new deployment on it: its claim signing requires a gRPC response header that the public gRPC endpoints do not return, so it serves relays but never gets paid for them.

### Configuration

Three files. The miner:

```yaml
# miner-config.yaml
redis:
  url: redis://redis:6379
pocket_node:
  chain_id: pocket-lego-testnet                          # pocket on MainNet
  query_node_rpc_url: https://sauron-rpc.beta.infra.pocket.network
  query_node_grpc_url: sauron-grpc.beta.infra.pocket.network:443   # host:port, no scheme
  grpc_insecure: false
keys:
  keys_file: /keys/supplier-keys.yaml
block_time_seconds: 30                                   # 60 on MainNet
transaction:
  gas_limit: 0                                           # auto-estimate
  gas_price: 0.000001upokt
  gas_adjustment: 1.7
```

The relayer:

```yaml
# relayer-config.yaml
listen_addr: 0.0.0.0:8080                                # the reverse proxy forwards here
redis:
  url: redis://redis:6379
pocket_node:
  chain_id: pocket-lego-testnet
  query_node_rpc_url: https://sauron-rpc.beta.infra.pocket.network
  query_node_grpc_url: sauron-grpc.beta.infra.pocket.network:443
  grpc_insecure: false
keys:
  keys_file: /keys/supplier-keys.yaml
services:
  <your-service-id>:
    timeout_profile: fast                                # streaming, for long or SSE responses
    max_body_size_bytes: 20971520
    default_backend: rest                                # the card's rpc_types[].type, lowercased
    backends:
      rest:
        url: http://backend:8080                         # your backend, by container name
        health_check:
          endpoint: /v1/health
health_check:
  enabled: true
  addr: 0.0.0.0:8081
```

And the operator key, which both processes read:

```yaml
# supplier-keys.yaml   (mode 400, owned by the uid the image runs as; never commit it)
keys:
  - "<64-hex operator private key>"
```

Points that matter for a REST backend:

- The backend key under `backends` is the card's `rpc_types[].type`, lowercased. `REST` in the card becomes `rest` here, and `default_backend` names it.
- The path the client requested is appended to the backend `url`. With `url: http://backend:8080/api`, a request for `/v1/chart` reaches the backend at `/api/v1/chart`.
- Each backend request carries `Pocket-Supplier`, `Pocket-Service`, `Pocket-Session-Id`, `Pocket-Application`, `Pocket-Session-Start-Height`, and `Pocket-Session-End-Height` headers. They are the only per-request identity your backend will ever see, and they are useful for logging and per-application rate limiting.
- Redis holds the relays you have served but not yet claimed. Give it a persistent volume and `--appendonly yes`; if it is lost, those relays are unpaid.

### Start it

Run one supplier stack per server with Docker Compose: `redis`, `miner` (`pocket-relay-miner miner --config /config/config.yaml`), and `relayer` (`pocket-relay-miner relayer --config /config/config.yaml`) from `ghcr.io/pokt-network/pocket-relay-miner:rc`, on a named network that each service's backend container joins from its own compose file. One stake and one RelayMiner serve every service the supplier lists; a new service on the same server is a backend container plus one `services:` entry in the relayer config. Confirm it is up:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/health   # 200 when the relayer is ready
docker logs <relayer> | grep "signing keys loaded"                      # the operator key was read
```

If the relayer logs "no key providers configured", the `keys` section is missing or the key file is unreadable by the container's user; every relay will be rejected as unsigned until that is fixed.

### Put a reverse proxy in front

The relayer listens on plain HTTP. Terminate TLS on a reverse proxy such as Caddy, nginx, or your cloud load balancer, and forward to `listen_addr`. The proxy's public `https://` address is what you will stake as the supplier's endpoint. Do not add authentication at the proxy; every request is already signed.

## Stake a Supplier

The stake declares which service you serve and where. The full field reference and the owner-operator model are in [Supplier Staking](/node-operators/supplier-staking).

```yaml
# supplier_stake_config.yaml
owner_address: <owner pokt1... address>
operator_address: <operator pokt1... address>
stake_amount: 59500000000upokt               # at least the live min_stake
default_rev_share_percent:
  <owner pokt1... address>: 100
services:
  - service_id: <your-service-id>
    endpoints:
      - publicly_exposed_url: https://relay.example.org
        rpc_type: REST
```

:::caution
**`rpc_type` must match the card.** Gateways select supplier endpoints by transport. A card that declares `REST` and a stake that declares `JSON_RPC` means REST clients never see your endpoint. Use exactly the type the card's `rpc_types` lists.
:::

Before staking, send any transaction from the operator account, for example a tiny self-transfer, so its public key is recorded on-chain. Gateways reject responses from an operator whose key they cannot look up.

```bash
pocketd tx supplier stake-supplier \
  --config ./supplier_stake_config.yaml \
  --from $OPERATOR \
  $TX_FLAGS
```

Verify:

```bash
pocketd query supplier show-supplier <operator address> --network=$NETWORK
```

The service configuration becomes active at the start of the next session. Sessions are 20 blocks, so on Beta this is up to about 100 minutes and on MainNet up to about 20 minutes.

### Unstaking

To stop supplying, unstake the supplier:

```bash
pocketd tx supplier unstake-supplier <operator-address> --from <owner-or-operator> --network=<beta|main>
```

Either the owner or the operator may sign; the stake always returns to the owner. The supplier keeps serving until the current session ends. The stake is then locked for the supplier unbonding period, a governance parameter measured in sessions that differs between networks (query `shared` params for `supplier_unbonding_period_sessions`), and is returned to the owner at the end of it. While unbonding, the supplier record shows `unstake_session_end_height`. To serve again later, stake anew with the same operator.

## Test End to End

Testing needs an application, because relays are paid for by an application stake. Stake a small one for your own service on Beta. See [Application Staking](/developers/application-staking) for the details; the short form is:

```yaml
# app_stake_config.yaml
stake_amount: 1000000000upokt      # the live application min_stake
service_ids:
  - <your-service-id>              # exactly one
```

```bash
pocketd tx application stake-application --config ./app_stake_config.yaml --from <app-key> $TX_FLAGS
```

Wait for the next session, then send relays with `pocket-ap`, a command-line relay client from the [pocket-ap repository](https://github.com/pokt-network/pocket-ap). It signs with the application key directly; no gateway and no delegation are needed, because an application is always a member of its own signing ring.

```bash
go install github.com/pokt-network/pocket-ap/cmd/pocket-ap@latest   # or: brew install pokt-network/tap/pocket-ap
```

```yaml
# pocket-ap.yaml
network: beta
listeners:
  - addr: 127.0.0.1:8550
    service_id: <your-service-id>
    rpc_type: rest
apps: []                        # key comes from the environment
```

```bash
POCKET_APP_PRIVATE_KEY=<app key hex> pocket-ap call \
  --config ./pocket-ap.yaml \
  --service <your-service-id> --rpc-type rest \
  -X POST --path /v1/<resource> \
  -d '{"...": "..."}' -v
```

Its `--compare <url>` flag sends the same request straight to your backend and diffs the two answers, which is the fastest way to catch a path-prefix or content-type mistake.

:::note
`pocketd relayminer relay` sends JSON-RPC relays only. It posts to the endpoint root with no path, so it cannot exercise a REST service. Use `pocket-ap` or a gateway.
:::

Then confirm the relay was accounted for. Within a session or two of serving relays you should see a claim from your operator:

```bash
pocketd query proof list-claims --supplier-operator-address <operator address> --network=$NETWORK
```

To test the path most users will take, run a gateway locally. [SAGE](https://github.com/pokt-network/sage) is the current gateway implementation; the configuration it needs for your service is in the next section.

### Stake above the minimum

Every settled relay is paid from the application's stake, and the protocol unstakes an application whose stake falls below the minimum (`min_stake` in the `application` params). A stake of exactly the minimum therefore begins unbonding after the first settled relay. Stake the minimum plus a margin, and top it up as it is drawn down. Staking again while unbonding cancels the unbonding and keeps any gateway delegations.

### Delegate to a gateway

`pocket-ap` signs its own relays. To reach the service through a gateway instead, the application delegates to it:

```bash
pocketd tx application delegate-to-gateway <gateway-address> --from <app-key> --network=<beta|main>
```

The gateway can then sign relays on the application's behalf; the application's stake still pays for them, and the transaction itself costs gas only. Registered gateways are listed at `/pokt-network/poktroll/gateway/gateway` on the LCD. An application may delegate to at most `max_delegated_gateways` (query the `application` params). `undelegate-from-gateway` removes a delegation and takes effect when the current session ends.

## Give Gateway Operators What They Need

Gateways do not read the metadata card. Each one has to be configured for your service by hand, and if it is not, a REST request to it is refused before a session is even looked up. Publish the following in your service documentation so an operator can copy it.

The SAGE service entry:

```yaml
gateway_config:
  services:
    - id: <your-service-id>
      type: passthrough
      rpc_types: ["rest"]
      timeout_config:
        relay_timeout: 30s
  active_health_checks:
    local:
      - service_id: <your-service-id>
        enabled: true
        checks:
          - name: version
            type: rest
            method: GET
            path: /v1/version
            expected_status_code: 200
            reputation_signal: critical_error
            timeout: 5s
          - name: health
            type: rest
            method: GET
            path: /v1/health
            expected_status_code: 200
            reputation_signal: major_error
            timeout: 5s
```

The health checks mirror your card's `serving.healthcheck`. Keep the two in sync. Do not add `sync_check` or `sync_allowance` to a non-blockchain service; those assume a block height and will mark every healthy supplier as failing.

## Minimal Server Specifications

Three components run on the supplier side. They can share one machine at first.

| Component | Minimum | Comfortable | Notes |
|---|---|---|---|
| **Service backend** | Whatever your service needs | | Size it for concurrent requests, not average load. Gateways hedge and retry, so bursts are normal. |
| **RelayMiner** | 1 vCPU, 1 GB RAM, 5 GB SSD | 4 vCPU, 16 GB RAM, 5 GB SSD | Scales linearly with relay volume and with the number of services one RelayMiner fronts. Redis must have a persistent volume; the session trees for unclaimed relays live there. |
| **Full node** | 4 vCPU, 16 GB RAM, 200 GB SSD | 6 vCPU, 32 GB RAM, 420 GB SSD | Optional. A public RPC and gRPC endpoint from the [Networks](/get-started/networks) page works for a first deployment, but a production RelayMiner should not depend on infrastructure it does not control. |

The full tables are on [Hardware & Infrastructure Requirements](/node-operators/hardware-requirements). Linux on x86_64 or ARM64 is the supported environment for the RelayMiner and full node.

Beyond hardware:

- **Persistent disk** for the RelayMiner's SMT store and for the keyring.
- **A public HTTPS endpoint** with a publicly trusted certificate. Gateways verify TLS and can be configured to refuse plain-HTTP or raw-IP supplier URLs outright.
- **Operator balance** kept above a few POKT at all times. Claims and proofs are transactions; an operator that cannot pay the fee forfeits the session's earnings.
- **Metrics scraped.** The RelayMiner exposes Prometheus metrics on `:9090`. See [Monitoring](/node-operators/monitoring).

## Going to MainNet

1. Register the service on MainNet if you have not yet. See [Register a Service](/services/register).
2. Re-query `min_stake`, `add_service_fee`, and the shared pricing parameters with `--network=main`.
3. Repoint `pocket_node` URLs and `--chain-id pocket`. Every other config line is unchanged.
4. Stake, wait a session, run the card's health checks through `pocket-ap`, and watch for the first claim.
5. Publish the gateway configuration and the card's `docs` URL, then tell gateway operators the service exists. A supplier no gateway routes to earns nothing.

## Related Pages

- [Register a Service](/services/register)
- [Supplier Staking](/node-operators/supplier-staking)
- [RelayMiner Setup](/node-operators/relayminer-setup)
- [HA RelayMiner](/node-operators/ha-relayminer)
- [Application Staking](/developers/application-staking)
- [Hardware & Infrastructure Requirements](/node-operators/hardware-requirements)
- [Monitoring](/node-operators/monitoring)
- [Supplier Rewards & Economics](/node-operators/rewards-economics)
