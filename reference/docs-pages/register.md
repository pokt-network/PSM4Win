---
title: Register a Service
description: Create the on-chain service record, choose its compute-unit price, and publish a metadata card that tells consumers how to call it and suppliers how to serve it.
sidebar:
  order: 2
---

This guide takes you from an idea for a service to a registered service ID with a published metadata card. Budget about an hour, most of it spent writing the card. Registering itself is one transaction.

Registration creates an on-chain record only. Nothing is reachable until at least one supplier stakes on the service and runs a RelayMiner in front of a backend. That is covered in [Deploy a Service](/services/deploy).

:::caution
**The service ID is permanent.** It cannot be renamed or deleted once registered. The name, price, and metadata card can be updated by the owner at any time. Choose the ID carefully.
:::

## Prerequisites

1. **`pocketd` installed.** See [pocketd CLI](/pocketd/). Linux, macOS, or Windows under WSL.
2. **An owner account with funds.** This account pays the registration fee and gas, and it is the only account that will ever be able to update the service. Treat its key accordingly. See [Accounts & Keys](/pocketd/accounts-keys).
3. **A network.** Register on Beta TestNet first. The fee there is a fraction of MainNet's and mistakes are cheap. Chain IDs and endpoints are on the [Networks](/get-started/networks) page; every command below uses `--network=beta`, and you switch to `--network=main` when ready.
4. **A rough API contract.** You do not need running code yet, but you need to know the request and response shapes, because the card describes them.

### Set Up Environment

```bash
export OWNER=<your-owner-key-name>
export NETWORK=beta            # or main
export TX_FLAGS="--from $OWNER --network=$NETWORK --gas auto --gas-prices 1upokt --gas-adjustment 1.5"
```

### Check the Registration Fee

The fee is a governance parameter and changes over time. Query it rather than trusting a number you read somewhere:

```bash
pocketd query service params --network=$NETWORK
```

The `add_service_fee` is charged once, on creation. Updates to an existing service cost gas only. Your owner account must hold more than the fee plus gas.

:::note
As of September 2026 the fee was 1,000 POKT on Beta TestNet and 3,500 POKT on MainNet. Check the live value before every registration.
:::

## Choose the Service ID, Name, and Price

Three values go on-chain with the registration.

| Field | Rules | Guidance |
|---|---|---|
| **Service ID** | 1 to 42 characters, `a-z A-Z 0-9 - _`. Immutable. | Lowercase kebab-case, named for the capability rather than your product: `text-generation`, `qwen3-embedding-0-6b`, `pocket-charts`. Check [explorer.pocket.network/services](https://explorer.pocket.network/services) for collisions first. |
| **Name** | Up to 169 characters, `a-z A-Z 0-9 - _` and spaces. No other punctuation. Updatable. | A one-line human description. Longer prose belongs in the card. |
| **Compute units per relay** | Integer from 1 to 1,048,576. Updatable; a change takes effect at the next session boundary. | See below. |

### Setting the price

`compute_units_per_relay` is the price of one request to your service, expressed in compute units. The network converts compute units to POKT with two shared parameters:

```
cost per relay in uPOKT = compute_units_per_relay × compute_units_to_tokens_multiplier ÷ compute_unit_cost_granularity
```

Query the two parameters to see what one compute unit is worth today:

```bash
pocketd query shared params --network=$NETWORK
```

Price is charged **per relay, not per byte or per second**. A request that carries a hundred inputs costs the same as one that carries one. Set the price for the expected cost of a typical request, and say in the card what a typical request looks like. For reference, blockchain RPC services on MainNet are priced in the low thousands of compute units, embeddings at 10,000, and LLM text generation at 300,000.

Applications pay this price from their stake, and suppliers earn it. A price too high attracts no applications; a price too low attracts no suppliers. You can adjust it later, but every change reprices the service for everyone at once.

## Write the Metadata Card

The card is a JSON document stored on-chain with the service. It is the only place a consumer can learn what your service does and the only place a prospective supplier can learn what to run. The chain enforces its size and nothing else, so the card is entirely your assertion, and it is worth getting right.

The schema is `pocket-service-card/v1`. Only the `schema` field is required, and readers ignore fields they do not know. The canonical schema is `pkg/cards/service_card.schema.json` in the [poktroll repository](https://github.com/pokt-network/poktroll), with a prose specification in `docs/pocket_cards.md`. The cards for every foundation-owned service are in [pocket-network-resources/service-cards](https://github.com/pokt-network/pocket-network-resources/tree/main/service-cards) and are the best examples of the conventions in practice.

### What a complete card contains

| Field | What to put there |
|---|---|
| `schema` | `"pocket-service-card/v1"`. Required. |
| `description` | Prose, up to 2,048 characters. What the service does, the request shape, the response shape, and whether every supplier returns the same output for the same input. |
| `rpc_types[]` | The transports you expect suppliers to serve. For an HTTP API this is one entry: `{"type": "REST", "intent": "expected", "backend_hint": "...", "notes": "..."}`. The `type` value is the on-chain enum name (`REST`, `JSON_RPC`, `WEBSOCKET`, `GRPC`, `COMET_BFT`); lowercased, it is also the key suppliers use in their RelayMiner config. Use `intent`, never `required`. Nothing enforces intent; it tells suppliers what serving the service well looks like. |
| `apis[]` | Short contract names in lowercase kebab-case, `<service>-<api-family>`. Consumers categorize services by these. |
| `specs[]` | Where the full API specification lives. For a REST service, an OpenAPI 3.x document: `{"kind": "openapi", "api": "<one of your apis[]>", "url": "...", "sha256": "..."}`. Put `sha256` only on a URL that is version-addressed and will never be overwritten in place; its presence tells consumers to reject any content that does not match. Use `"kind": "docs"` if you only have human-readable documentation. |
| `access` | `"public"`, or `"gated"` if suppliers need credentials to run the backend. |
| `results` | `"deterministic"` if any two suppliers return identical bytes for identical input. `"variable"` if they legitimately differ, for example because each supplier runs its own model, or because output contains timestamps. Consumers use this to decide whether they can retry across suppliers and cross-check answers. |
| `serving.backend` | What a supplier deploys, in one paragraph. |
| `serving.implementations[]` | The reference implementation and minimum version. |
| `serving.docs` | The operator runbook URL. |
| `serving.min_disk_gb`, `serving.min_ram_gb` | Honest minimums, even if small. |
| `serving.healthcheck[]` | Requests a supplier can run against their backend before staking, with the answer to expect. See below. |
| `serving.notes` | Anything a supplier would otherwise learn the hard way: rate limits to disable for the RelayMiner, request sizes, timeouts, the gateway configuration the service needs. |
| `docs` | Consumer-facing API documentation URL. |
| `updated` | The date of this card revision, `YYYY-MM-DD`. |

### Health checks

`serving.healthcheck` is the most useful field in the card. A supplier runs these probes against their own backend before staking and finds out immediately whether it is set up correctly, instead of discovering it from failed relays. Gateway operators transcribe the same probes into their own health-check configuration.

Follow the pattern every foundation card uses, three probes in this order:

1. **Identity.** A request whose answer pins the backend to this service, so a supplier cannot stake the wrong backend under your ID. For a REST service, a version or info endpoint that returns the service name.
2. **Readiness.** A health endpoint that returns a fixed value when the backend is ready to serve.
3. **A real request.** A small functional call with a deterministic answer. Keep it cheap; gateways run it against every supplier on a schedule.

The REST probe shape:

```json
{
  "rpc_type": "REST",
  "request": { "path": "/v1/version", "method": "GET" },
  "expect": { "json_path": "$.service", "matches": "^my-service$" },
  "notes": "Identity probe."
}
```

A `POST` probe adds a `body` object to `request`. `matches` is a regular expression applied to the value at `json_path`.

### A complete REST card

```json
{
  "schema": "pocket-service-card/v1",
  "description": "Renders a chart from CSV data. POST /v1/chart with {\"csv\": \"...\", \"type\": \"bar|line|pie\", \"title\": \"...\"} returns {\"content_type\": \"text/html\", \"body\": \"<html>...\"}. Output is deterministic for identical input.",
  "rpc_types": [
    {
      "type": "REST",
      "intent": "expected",
      "backend_hint": "pocket-charts HTTP server on :8080; mount at /",
      "notes": "Only POST /v1/chart, GET /v1/health and GET /v1/version are expected. Every response is a JSON object; the HTML chart is carried in the body field."
    }
  ],
  "apis": ["pocket-charts-api"],
  "specs": [
    {
      "kind": "openapi",
      "api": "pocket-charts-api",
      "url": "https://example.org/pocket-charts/openapi/v1/openapi.json",
      "notes": "Version-addressed; add sha256 once the URL is frozen."
    }
  ],
  "access": "public",
  "results": "deterministic",
  "serving": {
    "backend": "The pocket-charts container behind a RelayMiner with the rest backend pointed at it. No authentication toward the backend; callers cannot send headers.",
    "implementations": ["pocket-charts >= 1.0"],
    "docs": "https://example.org/pocket-charts/operators",
    "min_disk_gb": 1,
    "min_ram_gb": 1,
    "healthcheck": [
      {
        "rpc_type": "REST",
        "request": { "path": "/v1/version", "method": "GET" },
        "expect": { "json_path": "$.service", "matches": "^pocket-charts$" },
        "notes": "Identity probe."
      },
      {
        "rpc_type": "REST",
        "request": { "path": "/v1/health", "method": "GET" },
        "expect": { "json_path": "$.status", "matches": "^ok$" }
      },
      {
        "rpc_type": "REST",
        "request": {
          "path": "/v1/chart",
          "method": "POST",
          "body": { "csv": "x,y\n1,2\n2,4", "type": "line", "title": "probe" }
        },
        "expect": { "json_path": "$.content_type", "matches": "^text/html$" }
      }
    ],
    "notes": "Requests up to 1 MB of CSV. Typical render under 500 ms. Gateway operators: configure as type passthrough with rpc_types [\"rest\"]; see the operator docs for the health-check rules."
  },
  "docs": "https://example.org/pocket-charts/docs",
  "updated": "2026-09-11"
}
```

### Card rules

- One UTF-8 JSON object. Target under 4 KiB; the hard limit is 256 KiB.
- Never inline the full API specification. Point at it with `specs[]`.
- Prefer immutable, version-addressed URLs for specs and docs so a pinned hash never goes stale.
- The card is stored byte for byte. Reformatting it counts as a change when you publish.

## Validate the Card

The chain does not check the card's contents, so this is the only place a malformed card is caught before it costs gas:

```bash
pocketd tx service validate-card ./card.json
```

Fix every reported violation. The command runs automatically inside `add-service`, but running it on its own is faster while you iterate.

## Register the Service

```bash
pocketd tx service add-service \
  <service-id> "<service name>" <compute-units-per-relay> \
  --card-file ./card.json \
  $TX_FLAGS
```

:::note
Use `--gas auto` as shown. A card of a few kilobytes makes the transaction larger than a fixed `--fees` value covers, and the transaction fails with `out of gas in location: txSize`.
:::

If you prefer to pass the card inline, `--card-base64 "$(base64 -w0 ./card.json)"` replaces `--card-file`. The two flags are mutually exclusive.

## Verify

Read the record back and decode the card:

```bash
pocketd query service show-service <service-id> --network=$NETWORK
pocketd query service card <service-id> --network=$NETWORK
```

The service also appears at [explorer.pocket.network/services](https://explorer.pocket.network/services) within a few blocks. Confirm the ID, the owner address, the compute units, and that the decoded card is byte-identical to your file.

## Update a Service

`add-service` is also the update command. Run it again with the same service ID from the owner account to change the name, the price, or the card. Only the fields you pass change:

- Omitting `--card-file` leaves the stored card untouched. There is no way to clear a card back to empty; publishing a minimal `{"schema": "pocket-service-card/v1"}` is the closest.
- A price change is pinned to the session boundary. Sessions in flight keep the old price.

To update several services in one transaction, or to keep cards in version control and publish from there, use `edit-service` with a YAML batch file:

```yaml
# services.yaml
services:
  - service_id: pocket-charts
    compute_units_per_relay: 5000
    card_file: ./cards/pocket-charts.json
```

```bash
pocketd tx service edit-service --config ./services.yaml $TX_FLAGS
```

A service is skipped when both its price and its card already match what is on-chain, so this is safe to run repeatedly.

:::caution
**The batch file carries the price.** Re-read the live `compute_units_per_relay` before every publish. A stale value in the file silently reprices the service.
:::

## Transfer Ownership

```bash
pocketd tx service transfer-service <service-id> <new-owner-address> $TX_FLAGS
```

The new owner gains the sole right to update the service and receives the owner's share of settlements from that point.

## Going to MainNet

Repeat the registration with `--network=main`. The fee is higher, the same card works unchanged, and you should register only after the service has been supplied and tested end to end on Beta as described in [Deploy a Service](/services/deploy).

## Related Pages

- [Deploy a Service](/services/deploy)
- [Service Management](/node-operators/service-management) for the full `pocketd tx service` and `pocketd query service` reference
- [Networks](/get-started/networks)
- [Governance Parameters](/governance/parameters)
