---
name: pocket-service-builder
description: End-to-end guidance and tooling for building, registering, and deploying any API service on Pocket Network (Shannon), unopinionated about language or purpose. Use for creating or registering a service, writing or encoding a service metadata card, staking a supplier, running a RelayMiner in front of a backend, pricing in compute units, checking the catalog for naming conflicts, testing relays, or configuring a gateway. Triggers include pocket network service, register a service, add-service, service card, pocket-service-card, compute units per relay, CUPR, supplier stake, stake-supplier, relayminer, pocket-relay-miner, backend_url, rpc_type, REST/LLM/MCP/API on pocket, agentic marketplace, pocket-ap, SAGE gateway, sauron, pocketd tx service, pocketd tx supplier, explorer.pocket.network/services, and deploying or serving a non-blockchain service on Pocket.
---

# Pocket Service Builder

Build a service, describe it in a metadata card, register it on-chain, supply it through a RelayMiner, test it, and hand gateway operators what they need. This skill covers HTTP services of any kind: LLM inference, embeddings, data aggregators, renderers, MCP servers, anything that answers an HTTP request. It is not opinionated about what the service does or how it is written.

The canonical human-readable references are the three docs pages. Point the developer at them for concepts; use this skill to do the work they describe.

| Page | URL |
|---|---|
| Services overview | https://docs.pocket.network/services/ |
| Register a Service | https://docs.pocket.network/services/register/ |
| Deploy a Service | https://docs.pocket.network/services/deploy/ |
| Worked LLM example (pnyxai) | https://github.com/pnyxai/pocket-network-supplier-example |

**Verified against** poktroll v0.1.35 / `main` @ `fea9e14`, SAGE @ `703d8d9`, pocket-relay-miner `main`, pocket-ap v0.1.2, on 2026-09-11. The chain moves; when something here disagrees with a newer release, the release wins and this skill needs a diff.

---

## Two rules that override everything

### Rule 1: never state a chain value you did not just fetch
Fees, stake minimums, pricing multipliers, session length, unbonding periods, and every participant count are governance parameters or live state. They change. Fetch them with `scripts/live_params.py` (or the endpoint and field named in `references/live-parameters.md`) at the moment they are needed, and quote the fetched value with the network and date. If no execution tool is available, give the exact query and say the value must be fetched. Never fill in a remembered number.

### Rule 2: every response is a JSON object
Gateways grade response bodies by their first byte. A body that does not start with `{` or `[` is treated as a failed relay and the supplier is penalized for answering correctly. Any HTML, CSV, image, or other non-JSON output travels as a string field inside a JSON object. This is settled; do not design around gateway leniency or suggest formats that happen to pass today. The full rule set is `references/design-rules.md`, and `scripts/lint_backend.py` checks a running backend against it.

---

## Routing: load only what the task needs

| The developer wants to… | Load | Run |
|---|---|---|
| Understand what a service is, how the pieces relate, who does what | `references/concepts.md` | |
| Design the backend's HTTP contract | `references/design-rules.md` | `scripts/lint_backend.py` once it runs |
| Pick a service ID, name, and price | `references/register.md` | `scripts/check_catalog.py`, `scripts/live_params.py --pricing` |
| Write, validate, or encode the metadata card | `references/card-authoring.md` | `scripts/validate_card.py`, `scripts/encode_card.py`, template `templates/card.json` |
| Register or update the service on-chain | `references/register.md` | `scripts/live_params.py --fees` first |
| Stake a supplier, run a RelayMiner, put TLS in front | `references/deploy.md` | `scripts/render_templates.py` |
| Test end to end, read on-chain evidence, diagnose | `references/deploy.md` §Testing, `references/troubleshooting.md` | `scripts/query_state.py` |
| Give gateway operators what they need | `references/deploy.md` §Gateway onboarding | templates `sage-service.yaml`, `pocket-health-checks-entry.yaml` |
| Know when things will happen after staking | `references/concepts.md` §Timing | `scripts/query_state.py --session` |
| Any number that lives on-chain | `references/live-parameters.md` | `scripts/live_params.py` |

---

## The workflow

Run it in this order. Each step names its deliverable. Do not skip the catalog check or the card validation; they are the two steps that prevent irreversible mistakes.

1. **Frame the service.** Name the capability, the request shape, the response shape, whether output is identical across suppliers, and the expected cost of a typical request. One paragraph. This becomes the card's `description`.
2. **Check the catalog.** `python scripts/check_catalog.py <proposed-id> --network beta --name "<name>" --apis <a,b>` against both networks. Resolve collisions and near-collisions before anything else. The ID is permanent.
3. **Fetch live parameters.** `python scripts/live_params.py --network beta --pricing` for the registration fee, supplier and application minimums, and what one compute unit costs today.
4. **Design the backend** against `references/design-rules.md`. If code exists, run `scripts/lint_backend.py` against it. If not, offer a skeleton from `templates/backends/`.
5. **Write the card** from `templates/card.json`, following `references/card-authoring.md`. Validate with `scripts/validate_card.py`; the schema is bundled, so this works without `pocketd`. Encode with `scripts/encode_card.py` only if the developer needs `--card-base64` or wants to compare bytes with what is on-chain.
6. **Register** on Beta with the commands in `references/register.md`. Verify by reading the card back and comparing bytes.
7. **Render the deployment files.** Collect answers (service ID, backend URL, public URL, operator key name, network), then `python scripts/render_templates.py answers.json --out ./deploy` to produce the stake YAMLs, RelayMiner config, compose file, reverse proxy, gateway snippets, and pocket-ap config.
8. **Stake and run.** Supplier stake, RelayMiner, reverse proxy, in that order per `references/deploy.md`. Confirm `rpc_type` on the stake matches the card.
9. **Test.** Stake a test application, wait for the session boundary, relay with `pocket-ap call`, then `scripts/query_state.py --claims` until a claim appears. `pocketd relayminer relay` cannot send REST relays; do not suggest it for REST.
10. **Onboard gateways.** Publish the SAGE block and the health-check entry with the service docs. A gateway that has not been configured refuses REST requests for the service.
11. **MainNet.** Same steps with `--network main` and re-fetched parameters, only after Beta has served real relays.

---

## Deliverables the skill produces

| Artifact | Template | Notes |
|---|---|---|
| Metadata card | `templates/card.json` | Full-field, follows the PNF catalog conventions, validates clean |
| OpenAPI skeleton | `templates/openapi.yaml` | Paths match the card's health checks |
| Supplier stake config | `templates/supplier_stake_config.yaml` | `rpc_type` filled from the card |
| Application stake config | `templates/app_stake_config.yaml` | Exactly one service ID |
| HA RelayMiner relayer, miner, keys, compose | `templates/ha/` | Always use this. One stack per server serving every service; Redis-backed; `streaming` profile for long or SSE responses |
| Backend-only compose for one service | `templates/backend-compose.yaml` | Joins the supplier stack's `pocket-supplier` network as `<service-id>-backend` |
| Single-process RelayMiner (DEPRECATED) | `templates/relayminer_config.yaml`, `templates/docker-compose.single.yaml` | Reference only; cannot claim through public gRPC and is scheduled for deprecation |
| Reverse proxy | `templates/Caddyfile`, `templates/nginx.conf` | TLS termination in front of the relayer's `listen_addr` |
| SAGE service entry and health checks | `templates/sage-service.yaml` | `type: passthrough`, `rpc_types: ["rest"]` |
| Public gateway probe entry | `templates/pocket-health-checks-entry.yaml` | For a PR to `pocket-network-resources` |
| pocket-ap client config | `templates/pocket-ap.yaml` | Key from `POCKET_APP_PRIVATE_KEY` |
| `edit-service` batch file | `templates/services.yaml` | Re-read the live price before every publish |
| Backend skeletons | `templates/backends/{node,python,go}` | Three probe endpoints and the JSON envelope, nothing else |

---

## Scripts

All scripts are Python 3 standard library only. Each prints `--help`.

| Script | Purpose |
|---|---|
| `check_catalog.py` | Pull every service on a network and report exact, case-insensitive, and hyphen/underscore collisions on the ID; name collisions; `apis[]` values already claimed by other cards; and near-duplicate services the developer might supply instead |
| `live_params.py` | Fetch service, shared, supplier, application, proof, and session params; with `--pricing`, convert a target price into `compute_units_per_relay` and show comparable services |
| `validate_card.py` | Validate a card against the bundled JSON Schema, check size, flag `required` under `rpc_types`, and warn on convention gaps (missing `specs[].api`, `updated`, identity probe) |
| `encode_card.py` | Base64-encode a card for `--card-base64`, or decode a card from `show-service -o json` output, or diff a local card against the on-chain bytes |
| `lint_backend.py` | Hit a running backend with the card's health checks and a set of probes; fail on non-JSON bodies, empty 200s, gzip, 5xx on bad input, and error-looking substrings in the first 2 KB |
| `query_state.py` | Answer the operational questions: is the supplier staked and active, is it in the current session for an app, have claims and proofs landed, what is the operator balance |
| `render_templates.py` | Fill every template from one answers file |

---

## Scope

- **In:** HTTP request/response services of any kind, on Beta TestNet and MainNet, served by the HA RelayMiner, tested with pocket-ap or a local SAGE.
- **Out:** running a gateway for the public (the skill produces the config and stops), blockchain node operation (covered by the Node Operators docs), Morse-era tooling.
- **Partially in:** WebSocket, gRPC, and streaming SSE services. They work on Pocket but change the relayer profile (`streaming`) and the client story (no SSE through gateways). Say so explicitly rather than pretending the HTTP path applies unchanged.

## Security defaults the skill enforces

- Owner and operator are different accounts. The operator key signs relays and pays claim fees; it never holds the stake.
- Keys live in the `os` or `file` keyring for `pocketd`, in `POCKET_APP_PRIVATE_KEY` for pocket-ap, and in a mounted secrets file for the HA RelayMiner. Never in a config file that is committed, and never in the answers file passed to `render_templates.py`.
- The HA RelayMiner's Redis has a persistent volume with `--appendonly yes`. Session trees live there; losing it forfeits every unclaimed relay.
- The public endpoint is HTTPS with a publicly trusted certificate, terminated by a proxy the supplier controls.
- The gateway admin port and the RelayMiner ping and metrics ports are never exposed publicly.
