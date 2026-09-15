# Live parameters: what to fetch and from where

Never state any of these from memory. Fetch with `scripts/live_params.py --network <beta|main>`, or hit the LCD directly. LCD base URLs are in `concepts.md`; the path is `/pokt-network/poktroll/<module>/params`.

| Value | Module | Field | Used when |
|---|---|---|---|
| Registration fee | `service` | `add_service_fee.amount` (upokt) | Before registering; owner must hold more than this |
| Relay-mining target | `service` | `target_num_relays` | Informational |
| Supplier minimum stake | `supplier` | `min_stake.amount` | Before staking a supplier |
| Supplier staking fee | `supplier` | `staking_fee.amount` | Before staking |
| Application minimum stake | `application` | `min_stake.amount` | Before staking a test app |
| Max delegated gateways | `application` | `max_delegated_gateways` | If delegating |
| Session length | `shared` | `num_blocks_per_session` | To predict when a stake goes active |
| Suppliers per session | `session` | `num_suppliers_per_session` | To reason about selection odds |
| Supplier unbonding | `shared` | `supplier_unbonding_period_sessions` | Before unstaking |
| Compute-unit price | `shared` | `compute_units_to_tokens_multiplier`, `compute_unit_cost_granularity` | To price the service |
| Proof probability | `proof` | `proof_request_probability` | To understand when proofs are required |
| Proof threshold | `proof` | `proof_requirement_threshold.amount` | Same |
| Proof missing penalty | `proof` | `proof_missing_penalty.amount` | To size slashing risk |

## Pricing formula

```
cost per relay (uPOKT) = compute_units_per_relay × compute_units_to_tokens_multiplier ÷ compute_unit_cost_granularity
```

`scripts/live_params.py --pricing --target-upokt <n>` (or `--target-pokt`) inverts this to a `compute_units_per_relay` and prints comparable services. `compute_units_per_relay` is bounded to 1..1,048,576 on-chain and a change takes effect at the next session boundary.

## Snapshot for orientation only (do not quote to a user)

As of 2026-09-11 the fee was 1,000 POKT (beta) / 3,500 POKT (main); supplier min stake 59,500 POKT on both; application min stake 1,000 POKT; session 20 blocks; suppliers per session 50; one compute unit ≈ 0.04 uPOKT (beta) / 0.130504 uPOKT (main). These are here so a wildly wrong fetch is recognizable, not to be repeated as current.
