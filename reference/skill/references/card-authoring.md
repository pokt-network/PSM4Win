# Card authoring

The metadata card is a JSON document stored on-chain with the service. It is the only place a consumer learns how to call the service and a prospective supplier learns what to run. Canonical schema: `assets/service_card.schema.json` (bundled). Prose spec: https://docs.pocket.network/services/register/ and poktroll `docs/pocket_cards.md`. Worked examples: `assets/example-eth-beacon.json` (clean REST, pinned OpenAPI) and `assets/example-text-generation.json` (REST with POST healthchecks).

## Write it

Start from `templates/card.json`. Populate every field the PNF cards populate; the schema only requires `schema`, but a minimal card is a bad card. The field guide is on the Register page. Key points the schema does not tell you:

- **`rpc_types[].type`** is the on-chain enum name, uppercase (`REST`, `JSON_RPC`, `WEBSOCKET`, `GRPC`, `COMET_BFT`). Lowercased, it is the RelayMiner config key. Use `intent`, never `required`; the validator rejects `required`.
- **`apis[]`** are lowercase kebab-case contract names, `<service>-<family>`. `check_catalog.py` warns if a value is already claimed by another card.
- **`specs[]`** carries `api` (which `apis[]` entry it documents), `kind` (`openapi`, `openrpc`, or `docs`), `url`, and optionally `sha256`. Add `sha256` only on a version-addressed URL that will never change in place; its presence tells consumers to reject non-matching content.
- **`results`** is `deterministic` only if any two suppliers return identical bytes for identical input. Timestamps, random IDs, or per-supplier rendering make it `variable`.
- **`serving.sync`** is meaningless without a chain. Omit it.
- **`serving.healthcheck[]`** follows the three-probe pattern: identity, readiness, functional. The identity probe pins the backend to the service. REST probe shape: `{"rpc_type":"REST","request":{"path":"...","method":"GET|POST","body":{...}},"expect":{"json_path":"$.x","matches":"regex"}}`.

## Validate it

```bash
python scripts/validate_card.py ./card.json
```

Works without `pocketd`: it uses the bundled schema (via the `jsonschema` package if present, else a built-in structural check) and adds convention warnings. Fix every error. Then confirm with the authoritative check when `pocketd` is available:

```bash
pocketd tx service validate-card ./card.json
```

## Encode it

The card is stored as raw bytes and returned base64 by the LCD. It is **not gzipped**. You rarely need to encode it yourself, because `--card-file` takes the JSON directly. When you do:

```bash
python scripts/encode_card.py encode ./card.json           # base64 for --card-base64
python scripts/encode_card.py decode --base64 "ewog..."    # decode chain output
pocketd query service show-service <id> -o json | python scripts/encode_card.py decode --stdin-json
python scripts/encode_card.py diff ./card.json --id <id> --network beta   # byte-compare with on-chain
```

The `diff` subcommand matters because `edit-service` compares byte-exactly: reformatting a card counts as a change, and an identical card is skipped. Use it to confirm a publish landed and to decide whether a re-publish is a no-op.

## Rules that cause silent failure

- One UTF-8 JSON object. Target under 4 KiB; hard limit 256 KiB.
- Never inline the full API spec; point at it with `specs[]`.
- Omitting `--card-file` on an update **preserves** the stored card; it does not clear it. There is no clear-to-empty.
- The card describes intent. Nothing enforces it. A supplier serving a subset of what the card says is valid and paid.
