# Concepts: what a service is and how the pieces fit

Canonical page: https://docs.pocket.network/services/

## The six pieces

| Piece | On-chain or running | What it is | Who controls it |
|---|---|---|---|
| Service | On-chain | ID, name, `compute_units_per_relay`, owner address, optional metadata card | The owner; sole updater |
| Service backend | Running | The HTTP server that answers requests. Knows nothing about Pocket. | Each supplier |
| RelayMiner | Running | Receives signed relays, forwards plain HTTP to the backend, signs responses, submits claims and proofs | Each supplier |
| Supplier stake | On-chain | "Operator X serves service Y at URL Z with transport T." Requires `min_stake`. | Owner (stake) and operator (services, rev share) |
| Application stake | On-chain | "Account A pays for relays to service Y." Requires `min_stake`; drawn down at settlement. Exactly one service per account, so a consumer of several services holds one application account per service, funded from a main account. Restaking an account for another service re-points it. | The application |
| Gateway | Both | Holds app keys, signs relays, selects suppliers, retries, scores. SAGE is the current implementation; PATH is deprecated. | The gateway operator |

## One relay

```
client → gateway or self-signing app → supplier's RelayMiner → backend
                                         ↑ verifies session and signature,
                                           forwards method/path/query/headers/body,
                                           signs the response, records it for the claim
```

## Sessions, claims, proofs, settlement

- A **session** is `num_blocks_per_session` blocks (fetch it; 20 on both networks as of 2026-09) during which a fixed set of up to `num_suppliers_per_session` suppliers serves a given (application, service) pair.
- Supplier service-config changes, including a new stake, **activate at the next session start**.
- After a session ends there is a **grace period** (`grace_period_end_offset_blocks`) during which late relays still count. A relay whose backend call finishes after that is over-servicing and unpaid.
- The RelayMiner then submits a **claim** in the claim window and, if required, a **proof** in the proof window. Proofs are required when the claim's value exceeds `proof_requirement_threshold`, or randomly with `proof_request_probability`.
- A missing required proof forfeits the claim and burns `proof_missing_penalty` from the stake. A stake that falls below `min_stake` is force-unbonded.
- **Settlement** pays the supplier from the application's stake and pays the service owner a share (`mint_equals_burn_claim_distribution.source_owner` and the source-owner share of `mint_allocation_percentages`, fetch both).

## Timing a first deployment will experience

| Event | When | How to confirm |
|---|---|---|
| Supplier stake tx confirmed | Next block | `query_state.py --supplier` shows the stake |
| Supplier eligible for sessions | Next session start, up to one full session away | `query_state.py --session <app> <service>` lists the operator |
| First relays served | Once an app whose session includes you sends traffic | RelayMiner logs, `served_relays` metric |
| First claim visible | Claim window opens `claim_window_open_offset_blocks` after session end | `query_state.py --claims` |
| First proof, if required | Proof window opens after the claim window closes | `query_state.py --proofs` |
| Settlement and payment | After the proof window closes | Operator and owner balances, explorer |

Block time is not a parameter; measure it (the timestamp difference between the latest block and one a thousand blocks earlier) and multiply by the live `num_blocks_per_session`. Measured on 2026-09-14: Beta about 30 seconds per block and 20 blocks per session, so about 10 minutes; MainNet about a minute per block, about 20 minutes per session. Both have changed before and will again, so quote a measured value with its date, never a remembered one. Tell the developer before they stake so "nothing is happening" is expected.

## Two roles

- **Service owner:** registers the ID, sets the price, publishes the card. Runs nothing. Earns a share of every settlement on the service.
- **Supplier:** stakes on the service, runs a backend and a RelayMiner. Earns the relay price minus the owner share and rev share.

A developer bringing a new service almost always does both. Later suppliers read the card and follow the deploy guide independently.

## Permissionless

No allowlist, no review. Registration costs `add_service_fee` once; supplying costs a stake. Quality is enforced by gateways scoring suppliers on the responses they return and by applications choosing where to send traffic. The design rules exist because gateway scoring assumes JSON RPC-shaped responses, and a service that ignores that assumption gets its suppliers penalized.

## Networks

| | MainNet | Beta TestNet |
|---|---|---|
| `--network` | `main` | `beta` |
| Chain ID | `pocket` | `pocket-lego-testnet` (renamed from `pocket-beta` in v0.1.31) |
| RPC | `https://sauron-rpc.infra.pocket.network` | `https://sauron-rpc.beta.infra.pocket.network` |
| gRPC | `sauron-grpc.infra.pocket.network:443` | `sauron-grpc.beta.infra.pocket.network:443` |
| LCD | `https://sauron-api.infra.pocket.network` | `https://sauron-api.beta.infra.pocket.network` |
| Faucet | MACT only | `https://faucet.beta.pocket.network/` or `pocketd faucet fund upokt <addr> --network=beta` |
| Explorer | https://explorer.pocket.network/services | https://explorer.pocket.network/beta |

`--network=<main|beta>` sets chain ID, node, and gRPC address together on `pocketd`. The RelayMiner's `start` command takes `--chain-id` explicitly.
