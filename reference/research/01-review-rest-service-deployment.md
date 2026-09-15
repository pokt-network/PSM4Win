# Review: Deploying a REST (non-blockchain) service on Pocket Network Shannon

**Date:** 2026-09-11
**Verified against:** poktroll `main` @ `fea9e14` (2026-09-07); released `pocketd` v0.1.35; MainNet and Beta both report app version 0.1.35. SAGE @ `703d8d9` (2026-09-11; PATH is being deprecated in favor of SAGE, and SAGE is treated as the reference gateway throughout), PATH @ `4606957` for comparison, shannon-sdk @ `b1ba68f`, pocket-relay-miner `main`, pocket-agent-core @ `a3717b4`, pnyxai repos @ HEAD.
**Method:** four research agents (reports in `agent-reports/`), direct source reads of the clones, and live LCD queries against both networks. Every governance number below was queried live on the date above and must be re-queried before use. Reference copies of the load-bearing source files are in `reference/`.

---

## 1. Bottom line

Everything needed to stake, serve, describe, and test a REST service on Shannon exists today, but it is scattered across eight repositories and no single document walks a REST service end to end. The official cheat sheets are JSON-RPC-only, the "relays to your own service" guide is marked WIP, and the only non-blockchain example in poktroll is a one-line `ollama` stanza.

The pieces, and where each one lives:

| Concern | Where it is settled | Status |
|---|---|---|
| Creating the service ID on-chain | poktroll `x/service`, `pocketd tx service add-service` | Stable, documented |
| Service card (metadata) | poktroll `pkg/cards/service_card.schema.json` + `docs/pocket_cards.md`, shipped in v0.1.35 | Stable v1; 5 real cards on beta, 3 on mainnet; 77 PNF cards in `pocket-network-resources` define the conventions |
| Supplier staking | poktroll `x/supplier`, YAML config | Stable; docs have stale limits |
| Serving relays | Two implementations: `pocketd relayminer` (single binary) and `pocket-relay-miner` (HA, Redis) | Both current; HA is what LLM operators run |
| REST semantics through the relayminer | `pkg/relayer/http_request.go` | Path, method, query, headers, body pass through |
| Reaching the service as a client | SAGE gateway (PATH successor, PATH-config compatible), `pocket-ap`, shannon-sdk (Go) | SAGE needs explicit REST config; `pocket-ap call` is the practical test tool |
| Marketplace / discovery | Cards on-chain + pocket-agent-core as consumer | No public "Agentic Marketplace" artifact yet |

Three findings change how a REST service should be **designed**, not just deployed. They are in section 5 and they apply directly to Pocket-Charts.

---

## 2. The end-to-end path a developer follows

This is the sequence the Skill should teach. Section 5 has the response-shape rule that must be settled before step 3: every response is a JSON object, and any HTML or other non-JSON output travels as a string inside it. Commands are Beta; swap `--network=main` and the mainnet endpoints for production.

1. **Install `pocketd`** (Linux/macOS/WSL only):
   ```bash
   curl -sSL https://raw.githubusercontent.com/pokt-network/poktroll/main/tools/scripts/pocketd-install.sh | bash
   ```
   Alternatives: `brew tap pokt-network/poktroll && brew install pocketd`, or `ghcr.io/pokt-network/pocketd:<tag>`.

2. **Create keys and fund them.** One key for the service owner, one for the supplier operator, one for a test application. Beta faucet: `https://faucet.beta.testnet.pokt.network/pokt/` or `pocketd faucet fund upokt <addr> --network=beta`.

3. **Build the service** as a plain HTTP server. Design it against the constraints in section 5.

4. **Write the service card** (`card.json`, schema `pocket-service-card/v1`, start from `reference/cards/template-rest-service.json`) and validate it offline:
   ```bash
   pocketd tx service validate-card ./card.json
   ```

5. **Register the service** (creates or updates; only creation pays `add_service_fee`):
   ```bash
   pocketd tx service add-service <service-id> "<description>" <compute-units-per-relay> \
     --card-file ./card.json --from <owner> --network=beta \
     --gas auto --gas-prices 1upokt --gas-adjustment 1.5
   ```
   Read it back: `pocketd query service card <service-id> --network=beta`.

6. **Stake a supplier** with a YAML declaring the service ID, the public URL of the relayminer, and `rpc_type: REST`:
   ```bash
   pocketd tx supplier stake-supplier --config ./supplier_stake.yaml --from <operator> --network=beta \
     --gas auto --gas-prices 1upokt --gas-adjustment 1.5
   ```
   The operator key must have sent at least one transaction so its public key is on-chain.

7. **Run a relayminer** in front of the service (section 4). TLS terminates at a reverse proxy; the relayminer listens plain HTTP.

8. **Stake a test application** for exactly one service ID (`min_stake` 1,000 POKT on both networks), then wait for the next session boundary.

9. **Send test relays** with `pocket-ap call` (section 7). Optionally run SAGE locally for the gateway path (section 7).

10. **Publish the gateway onboarding material** with the service docs: the SAGE `services:` and `active_health_checks.local[]` snippets from section 5.7, and an entry in the `pocket-health-checks.yaml` format for PATH-era gateways, contributed as a pull request to `pocket-network-resources`. Without this no gateway probes or routes the service correctly.

11. **Monitor** claims and proofs (relayminer metrics on `:9090`, `/ping` on `:8081` for the single binary; `:8081/health` and `:9090`/`:9092` for HA) and keep the operator balance topped up for claim/proof fees.

12. **Repeat on MainNet.** Service creation costs 3,500 POKT there; supplier min stake is 59,500 POKT on both networks.

---

## 3. The service card

### What it is
A JSON document stored verbatim as bytes in `Service.metadata.card` (proto `pocket.shared.Metadata { bytes card = 1; }`). The chain enforces size only (256 KiB hard cap, 4 KiB target). LCD and CLI return it base64-encoded. It is not gzipped. There is no well-known HTTP path; discovery is purely on-chain.

Only `schema` is required. Readers must ignore unknown keys. Nothing in a card is enforced by any layer; every field is an owner assertion. Full schema: `reference/service_card.schema.json`. Prose spec: `reference/poktroll-docs-pocket_cards.md`.

### The schema as practiced: populate every field
The JSON Schema requires only `schema`, but the 77 PNF-owned cards in `pocket-network-resources/service-cards/` populate every top-level field and every `serving` field except `min_ram_gb`, and they add four extension keys the schema does not name: `specs[].api`, `specs[].notes`, `serving.docs`, and `serving.healthcheck[].notes`. Treat that practice as the real schema. The field-by-field usage counts and conventions are in `agent-reports/06-pnf-service-card-conventions.md`, and a full-field REST template is at `reference/cards/template-rest-service.json`.

| Field | What to put there for a REST service |
|---|---|
| `description` | Prose, up to 2048 chars. Say what the service does, the request shape, and that responses are JSON envelopes. |
| `rpc_types[]` | Usually one entry: `{"type": "REST", "intent": "expected", "backend_hint": "...", "notes": "..."}`. Lowercased `type` is the relayminer config key. Use `intent`, never `required` (the schema rejects it). |
| `apis[]` | Lowercase kebab-case contract names, `<service>-<api-family>`. Consumers categorize on these. |
| `specs[]` | The OpenAPI 3.x document. Always set `kind`, `url`, and `api` (naming the `apis[]` entry it documents). Add `sha256` only if the URL is version-addressed and will never change in place. `notes` explains anything odd. |
| `access` | `public` unless the service is gated. |
| `results` | `deterministic` only if every supplier returns identical bytes for identical input. Timestamps, random ids, or rendering differences make it `variable`. This drives retry and cross-check behavior in consumers. |
| `serving.backend` | What a node runner deploys, in one paragraph. |
| `serving.implementations[]` | The reference implementation and minimum version. |
| `serving.docs` | The operator runbook URL. Distinct from top-level `docs`, which is the consumer API documentation. |
| `serving.sync` | Omit. It has no meaning without a chain. |
| `serving.min_disk_gb`, `serving.min_ram_gb` | Set honestly, even if small. |
| `serving.healthcheck[]` | Three probes in the catalog's order: identity, readiness, functional. REST shape: `{"rpc_type": "REST", "request": {"path": "...", "method": "GET|POST", "body": {...}}, "expect": {"json_path": "$.x", "matches": "regex"}, "notes": "..."}`. The identity probe pins the backend to the service name so a wrong backend cannot be staked under the ID. |
| `serving.notes` | Operator guidance: rate limits, sizes, timeouts, and the gateway config the service needs. |
| `docs`, `updated` | Consumer docs URL and the date of the last card revision. |

### Publishing facts that trip people up
- `add-service` is also the update command. Omitting `--card-file` on an update preserves the stored card. There is no way to clear a card to nil.
- `edit-service --config services.yaml` batches updates and compares cards byte-exactly, so reformatting counts as a change. The batch file embeds `compute_units_per_relay`, so re-read the live value before every publish or the publish silently changes pricing.
- `pocketd query service card <id>` exists on `main` (added after the prose doc was written; the doc still says services lack a decode command). Fallback: `show-service -o json | jq -r .service.metadata.card | base64 -d`.
- The `docs.pocket.network` service-management page still shows the deprecated `--experimental-metadata-*` flags.

### Health checks live in two places
The card's `serving.healthcheck` is the owner's statement. PNF's public gateway at `api.pocket.network` reads its probes from `pocket-network-resources/pocket-health-checks.yaml` instead, in a YAML rule format with `type: rest`, `method`, `path`, `expected_status_code`, `expected_response_contains`, `timeout`, and `reputation_signal`. SAGE reads neither and takes an `active_health_checks.local[].checks` block in its own config with the same keys minus `expected_response_contains`. A REST service should ship all three, kept in sync: the card block, a rule-file entry to contribute upstream, and the SAGE snippet in its docs. Never set `sync_check` or rely on `sync_allowance` for a generic service; the `eth-beacon` entry in the rule file records a 100% false-positive outage from doing so.

### Real REST cards to copy from
- `reference/cards/template-rest-service.json`: full-field template built from the catalog conventions, validated against the schema.
- `reference/cards/pnf-eth-beacon.json`: the cleanest REST card in the catalog (three GET healthchecks, sha256-pinned OpenAPI at a release URL).
- `reference/cards/pnf-tron.json`: a REST HTTP API with POST probes alongside JSON-RPC, and `kind: docs` specs where no OpenAPI exists.
- `reference/cards/onchain-beta-text-generation.json` and `onchain-beta-qwen3-embedding-0-6b.json`: REST with POST healthchecks carrying a body, and a pinned markdown runbook.
- `reference/cards/onchain-beta-pocket-data-mcp.json`: an MCP server described as JSON_RPC on a single path.
- `reference/cards/onchain-mainnet-ai-inference.json`: the pre-schema format. Do not copy it.

---

## 4. RelayMiner: two implementations

| | `pocketd relayminer` (in poktroll) | `pocket-relay-miner` (HA) |
|---|---|---|
| Shape | Single process | Stateless `relayer` + `miner` + Redis |
| Config | `suppliers[]` with `service_config.backend_url` and `rpc_type_service_configs.rest.backend_url` | `services.<id>` with `default_backend: rest` and `backends.rest.url`; backend keys are exact transport names with no fallback |
| SSE streaming | No | Yes, `timeout_profile: streaming` (600 s, no header timeout) |
| Backend health checks | `/ping` checks reachability only | Active per-backend `health_check` block, circuit breaker, multi-URL load balancing |
| Test without staking | No | `docs/simulated-relays.md` (config-pinned rings) |
| Image | `ghcr.io/pokt-network/pocketd` | `ghcr.io/pokt-network/pocket-relay-miner:rc` |
| Who uses it | Cheat sheets, small operators | pnyxai and other LLM operators on mainnet |

Reference configs: `reference/poktroll-relayminer_config_full_example.yaml` and `reference/ha-relayminer-example-configs.md`.

### What the backend actually receives (both implementations)
Verified in `pkg/relayer/http_request.go`:
- Method verbatim.
- Path is `path.Join(backend_url.Path, request.Path)`. So `backend_url: http://svc:8080/api` plus `/charts` becomes `/api/charts`. Trailing slashes are dropped and `..` is cleaned.
- Query strings merged from the request and the backend URL.
- All request headers copied, then optional `Pocket-*` headers (`forward_pocket_headers: true` adds `Pocket-Supplier`, `Pocket-Service`, `Pocket-Session-Id`, `Pocket-Application`, `Pocket-Session-Start-Height`, `Pocket-Session-End-Height`), then static `headers:` and optional Basic auth from config.
- Body verbatim. Default body cap 20 MB.
- The full backend response, including non-2xx status and all headers, is serialized back and signed.

The relayminer picks its per-transport config from the outer `Rpc-Type` header (integer enum: `4` = REST, `3` = JSON_RPC, `2` = WEBSOCKET, `1` = GRPC, `5` = COMET_BFT), falling back to `service_config`.

---

## 5. Design constraints for a REST service on Pocket

These are the findings that should shape service design. Each was verified in source. The gateway findings are verified against SAGE, the PATH successor; where PATH behaves differently it is noted, and the full comparison is in `agent-reports/05-sage-gateway-rest-handling.md`.

### 5.1 Through the gateway, responses must be JSON with a 2xx status
SAGE grades every REST response body (`heuristic/analyzer.go`, Tier 1 is not conditioned on RPC type). A body that starts with `<!DOCTYPE` or `<html` is `html_response`: retried on another supplier, the answering supplier penalized Critically and circuit-broken. A body that starts with anything other than `{`, `[`, or `<` is `plain_text_response`: retried, Major penalty. An empty body on a 2xx is `empty_response`, Critical. After retries are exhausted SAGE delivers the last upstream response, so the client does eventually get the HTML, but only after every supplier tried has been penalized for answering correctly. PATH behaves the same way but returns a gateway error instead of the last response.

XML and SVG bodies pass SAGE's structural check (they start with `<` but are not HTML). PATH rejects them.

**Pocket-Charts implication:** returning raw HTML will be treated as a failed relay by every SAGE or PATH gateway and will drain the reputation of every supplier serving the service. Return a JSON envelope, for example `{"content_type": "text/html", "body": "<!DOCTYPE html>..."}`, and let the client unwrap it. The field names are the service's contract, not a gateway rule; the gateway only checks that the body starts with `{` or `[`. Put short metadata fields first and the large string last so the first 2 KB stays clear of the substring scan in 5.2. Clients not using a gateway (`pocket-ap`, pocket-agent-core opaque passthrough) do not care, but designing for the strictest consumer costs nothing.

### 5.2 Avoid error-looking words in the first 2 KB of a success body
SAGE's Tier 3 scans the first 2 KB of any body, including a valid JSON REST response, for substrings such as `timeout`, `bad gateway`, `service unavailable`, `gateway timeout`, `connection refused`, and `connection reset` (`heuristic/indicators.go`). A match retries the request and penalizes the supplier. A JSON field literally named `timeout` in an echoed options block would trigger it.

### 5.3 Request headers and the client's Content-Type do not reach the service; the query string does under SAGE only
SAGE forwards the verb, the path, and the query string (`qos/noop/plugin.go` uses `RequestURI()`), but builds the embedded request with exactly one header, `Content-Type: application/json`, and forwards no client headers (`protocol/shannon/relayer.go`). The passthrough plugin never sets a custom content type. PATH additionally drops the query string. Backend response headers are not returned to the client under either gateway; SAGE sets `Content-Type: application/json` on the reply only when the REST body starts with `{` or `[`.

**Implication:** put all inputs, including CSV data, in a POST JSON body. Do not depend on `?param=`, `Accept`, the caller's `Content-Type`, or custom headers. Do not depend on your own response headers reaching the caller.

### 5.4 Do not require caller authentication, and serve identity encoding
Application-side relays (pocket-agent-core, and the same pattern in pocket-ap) strip `Authorization`, `Proxy-Authorization`, `Api-Key`, `X-Api-Key`, and `Cookie`, and force `Accept-Encoding: identity`. Gateways forward no client headers at all. Static auth toward your own backend, if you need it, goes in the relayminer's `headers:` or `authentication:` config, not from the caller.

### 5.5 Return 4xx for client errors, never 5xx for expected failures
The relayminer passes 5xx through but does not count the relay as rewardable (`isRewardApplicable`: status must be below 500). SAGE retries 5xx and 429 immediately with a Critical penalty on 5xx. A REST 4xx with a JSON body is graded as the client's error under SAGE: delivered as is, no retry, no penalty. Bad input should get 400 or 422 with a JSON body.

### 5.6 Respect timing
- SAGE bounds each attempt with the per-service `timeout_config.relay_timeout`, which operators should set explicitly; its server write timeout defaults to 120 s. PATH's default relay timeout is 10 s. Both buffer whole responses; neither streams SSE.
- Sessions are 20 blocks on both networks (roughly 20 min on MainNet, 100 min on Beta). A relay whose backend call finishes after the session plus a 10-block grace period is over-servicing and unpaid.
- Requests that need long processing should use the HA relayminer's `streaming` profile, and clients that are not gateways.

### 5.7 The gateway must be told the service is REST
A service ID whose gateway config does not list `rest` in `rpc_types` has non-JSON-RPC paths classified as JSON-RPC, and a REST request is refused with 400 before any session lookup (SAGE `docs/next-steps.md` records this for `radix`). Gateway operators must add:
```yaml
services:
  - id: <service-id>
    type: passthrough
    rpc_types: ["rest"]
```
Neither SAGE nor PATH reads service cards, so the card cannot do this for them, and SAGE cannot use the card's `serving.healthcheck` either. Put this snippet, plus a matching `active_health_checks.local[].checks` block, in the service's docs so gateway operators can copy both.

### 5.8 Supplier `rpc_type` must match the card
Suppliers publish `endpoints[].rpc_type` on-chain and gateways select endpoints by it; SAGE notes "a REST request still needs a REST-staked supplier to serve it." pnyxai's own mainnet suppliers for `text-generation` stake `JSON_RPC` while the card says `REST`; the third-party supplier stakes `REST`. A REST-only client will skip the JSON_RPC endpoints. Stake the transport the card declares.

---

## 6. Live parameters (queried 2026-09-11; re-query before use)

Endpoints: MainNet LCD `https://sauron-api.infra.pocket.network`, Beta LCD `https://sauron-api.beta.infra.pocket.network`, path `/pokt-network/poktroll/<module>/params`.

| Parameter | MainNet (`pocket`) | Beta (`pocket-lego-testnet`) |
|---|---|---|
| `service.add_service_fee` | 3,500 POKT | 1,000 POKT |
| `supplier.min_stake` | 59,500 POKT | 59,500 POKT |
| `application.min_stake` | 1,000 POKT | 1,000 POKT |
| `application.max_delegated_gateways` | 7 | 7 |
| `shared.num_blocks_per_session` | 20 | 20 |
| `shared.supplier_unbonding_period_sessions` | 1,429 (about 20 days) | 86 (about 6 days) |
| `shared.compute_units_to_tokens_multiplier` | 130,504 | 40,000 |
| `shared.compute_unit_cost_granularity` | 1,000,000 | 1,000,000 |
| `session.num_suppliers_per_session` | 50 | 50 |
| `proof.proof_request_probability` | 0.001 | 0.01 |
| `proof.proof_requirement_threshold` | 10 POKT | 100 upokt |

Derived: cost per relay in uPOKT = `compute_units_per_relay × multiplier ÷ granularity`, so one compute unit is 0.130504 uPOKT on MainNet. A `cupr` change takes effect at the next session boundary. The code-level `cupr` maximum is 2,097,152 (`2 << 20`); the comment and docs say 1,048,576.

Beta's chain ID was renamed from `pocket-beta` to `pocket-lego-testnet` in v0.1.31. `--network=beta` sets chain ID, node, and gRPC address together.

Service ID: up to 42 chars, `^[a-zA-Z0-9_-]+$`, immutable. Name: up to 169 chars, `^[a-zA-Z0-9-_ ]+$`. The supplier config doc's "8 characters" is stale.

---

## 7. Testing a REST service

| Tool | REST support | Needs | Notes |
|---|---|---|---|
| `pocket-ap call` (pokt-network/pocket-ap v0.1.2) | Yes, verified on beta | A staked app key only; no gateway or delegation | `POCKET_APP_PRIVATE_KEY=<hex> pocket-ap call --config config.yaml --rpc-type rest -X POST --path /charts -d '{...}' -v`. `--compare <url>` diffs against a direct backend call. This is the recommended test tool. |
| `pocketd relayminer relay` | No | App key in keyring, supplier in session | JSON-RPC only: POSTs to the endpoint root and JSON-parses the body. Source carries a TODO for REST. `--supplier-public-endpoint-override` lets you hit a local relayminer. |
| SAGE (local) | Yes, with the section 5.7 config | Staked gateway (1 POKT on beta), an app staked for the service; SAGE signs with its configured app keys and ignores delegation headers | `make sage_build && ./bin/sagegw -config config.yaml`, then `curl localhost:3069/v1/<path> -H "Target-Service-Id: <id>" -H "RPC-Type: rest"`. Tests the strict-consumer path. PATH works the same way but is being deprecated. |
| HA relayminer simulated relays | Yes | Nothing on-chain | `docs/simulated-relays.md`; validates the backend and signing loop before staking. |
| Hosted public gateways | No | | `{service}.api.pocket.network` serves only the curated mainnet registry. Nothing public serves a new beta service. |

SDKs: Go `shannon-sdk` only. There is no JS/TS Shannon SDK; `pocket-js` is Morse-era. `pocket-relay-miner/examples/relay-signing/` has Node, Python, and Rust signing examples.

---

## 8. Documentation gaps to fill on docs.pocket.network

1. An end-to-end "stake and serve a REST service" guide. Nothing today covers a non-blockchain service; the closest is the WIP `relays_to_your_own_service` sketch, which is JSON-RPC and has stale stake numbers.
2. The service design constraints in section 5. None of them are documented anywhere; each was found in SAGE, PATH, relayminer, or pocket-agent-core source.
3. Which relayminer to run and when. The two implementations have different config shapes and only the HA one streams.
4. `pocket-ap call` as the REST test path, with the note that `pocketd relayminer relay` cannot send REST.
5. The SAGE `services:` and `active_health_checks.local[]` snippets gateway operators need, and the fact that neither SAGE nor PATH reads cards.
6. Card authoring for REST: healthcheck shape, `results`, `specs[]` pinning rules, the `intent` vs `required` rule, and the PNF `api` key convention.
7. Corrections: service ID limit is 42 chars not 8; rev share is integers not floats; `--experimental-metadata-*` is deprecated in favor of `--card-file`; beta chain ID is `pocket-lego-testnet`; `cupr` max is 2,097,152 in code.
8. Key management guidance. The pnyxai example commits a hex private key in `supplier-keys.yaml`.
9. TLS and ingress. Every example stakes `https://…:443` but shows a plain-HTTP relayminer and no proxy.
10. How a non-PNF service gets probed by the public gateway. `pocket-health-checks.yaml` has no contribution process, and the card's `serving.healthcheck` is not read by any gateway.

---

## 9. Recommended shape of the Skill

- **Unopinionated core:** the eleven steps in section 2, parameterized by service ID, cupr, backend URL, and network. Every number fetched live from the LCD, never hardcoded (the `pocket-engineering` skill's rule 1 applies).
- **Design checklist** from section 5, presented before any code is written.
- **Card generator:** produce `card.json` from a short questionnaire (description, apis, OpenAPI URL, healthcheck path and expected field), then run `validate-card`.
- **Two relayminer templates:** single-binary YAML and HA compose plus configs, adapted from `reference/`.
- **Test recipe:** `pocket-ap call` first, then optional local SAGE.
- **Pointer to the docs.pocket.network page** once it is published, with the same content as sections 2 and 5.
- **What the Skill should not do:** hardcode fees, stakes, or chain IDs; assume JSON-RPC; assume a specific backend language or framework.

---

## 10. Source index

| Repo | Load-bearing files |
|---|---|
| `pokt-network/poktroll` | `pkg/cards/service_card.schema.json`, `docs/pocket_cards.md`, `x/service/module/{tx_add_service,tx_edit_service,tx_validate_card,query}.go`, `x/shared/types/service.go`, `proto/pocket/shared/service.proto`, `pkg/relayer/http_request.go`, `pkg/relayer/proxy/sync.go`, `pkg/relayer/config/types.go`, `pkg/relayer/cmd/cmd_relay.go`, `localnet/pocketd/config/*_example.yaml`, `docusaurus/docs/1_operate/**` |
| `pokt-network/pocket-relay-miner` | `config.relayer.example.yaml`, `config.miner.example.yaml`, `config.relayer.schema.yaml`, `docs/simulated-relays.md`, `examples/relay-signing/` |
| `pokt-network/sage` | `qos/noop/plugin.go`, `heuristic/{analyzer,structural,indicators}.go`, `relay/middleware/{heuristic,parse}.go`, `protocol/shannon/{transport,relayer}.go`, `router/router.go`, `docs/{configuration,path-compat,next-steps}.md`, `ARCHITECTURE.md` |
| `pokt-network/path` (deprecated, for comparison) | `request/parser.go`, `qos/noop/`, `qos/heuristic/{analyzer,structural}.go`, `gateway/http_request_context_handle_request.go`, `gateway/rpc_type_detector.go`, `protocol/shannon/context.go`, `config/config.schema.yaml` |
| `pokt-network/shannon-sdk` | `types/request.go`, `relay.go`, `proto/types/http.proto` |
| `pokt-network/pocket-ap` | README (`call` command) |
| `pokt-network/pocket-agent-core` | `services/card.go`, `services/spec.go`, `front/front.go`, `CLAUDE.md` |
| `pokt-network/pocket-network-resources` | `service-cards/README.md` (conventions), `service-cards/cards/*.json` (77 cards; `eth-beacon.json`, `tron.json` are the REST references), `pocket-health-checks.yaml` (public gateway probe rules), `README.md` (Sauron endpoints) |
| `pnyxai/pocket-network-services` | `mainnet/card_*.json`, `mainnet/docs_*.md`, `mainnet/service_*.yaml`, `card-spec-sha.sh` |
| `pnyxai/pocket-network-supplier-example` | `relay-and-miner/docker-compose.yaml`, `relay-and-miner/config/*.yaml`, `stake/*.yaml`, `backend/README.md` |
| `pnyxai/pokt-ml-sidecar` | Poncho reverse proxy; vLLM-specific, not needed for a generic REST service |
