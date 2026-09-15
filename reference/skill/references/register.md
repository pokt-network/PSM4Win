# Register a service

Canonical page: https://docs.pocket.network/services/register/. This reference is the tooling layer: how to do each step with the skill's scripts and templates. Registration creates an on-chain record only; nothing is reachable until a supplier deploys it (see `deploy.md`).

The service ID is **permanent**. Run the catalog check before anything else.

## 1. Check the catalog

```bash
python scripts/check_catalog.py <proposed-id> --both --name "<name>" --apis "<a,b>"
```

Exit code 2 means a fatal conflict (ID already exists). Resolve every FATAL and consider every WARN and INFO. INFO "looks similar to an existing service" is a prompt to ask whether the developer should supply that service instead of registering a duplicate; the network prefers more suppliers on one service over many near-identical services.

## 2. Fetch the fee and pricing inputs

```bash
python scripts/live_params.py --network beta --pricing --target-upokt <n>
```

Read `add_service_fee` and confirm the owner account can cover it plus gas. Use the printed `compute_units_per_relay` suggestion and the comparable-services list to set the price. Do not hardcode any of these numbers; see `live-parameters.md`.

## 3. Choose ID, name, price

- ID: 1-42 chars, `A-Z a-z 0-9 - _`, immutable. Lowercase kebab-case named for the capability.
- Name: up to 169 chars, letters/digits/`- _`/space. Updatable.
- `compute_units_per_relay`: 1..1,048,576, updatable, effective at the next session.

## 4. Write and validate the card

Follow `card-authoring.md`. Draft from `templates/card.json`, then:

```bash
python scripts/validate_card.py ./card.json
```

## 5. Register

```bash
export TX="--from <owner> --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5"
pocketd tx service add-service <id> "<name>" <cupr> --card-file ./card.json $TX
```

Use `--gas auto` (not a fixed `--fees`); a multi-KB card enlarges the tx and a fixed fee causes `out of gas in location: txSize`. `--card-base64 "$(python scripts/encode_card.py encode ./card.json)"` is the inline alternative, mutually exclusive with `--card-file`.

## 6. Verify

```bash
pocketd query service show-service <id> --network=beta
python scripts/query_state.py --network beta --service <id>
python scripts/encode_card.py diff ./card.json --id <id> --network beta   # expect "identical"
```

The service appears at the explorer within a few blocks.

## Updating

`add-service` re-run from the owner updates the service; only the fields you pass change, and omitting `--card-file` leaves the card intact. For version-controlled cards or multi-service updates, use `templates/services.yaml` with `edit-service`:

```bash
pocketd tx service edit-service --config ./services.yaml $TX
```

Re-read the live price before every `edit-service`; the batch file carries `compute_units_per_relay` and a stale value silently reprices the service.

## Transfer ownership

```bash
pocketd tx service transfer-service <id> <new-owner> $TX
```

## MainNet

Repeat with `--network=main` after the service has been supplied and tested on Beta (`deploy.md`). The fee is higher; the card is unchanged.
