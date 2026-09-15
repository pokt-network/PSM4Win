# Pretty Charts

A chart renderer served as a REST service on Pocket Network (Shannon). Send data and a chart description; get back a static SVG (or a complete HTML page) inside a JSON object. Every data mark carries a native `<title>` tooltip, so the output needs no script and no external resource.

The renderer is [Vega-Lite](https://vega.github.io/vega-lite/) 6 on Vega 6, run headless in Node. A request can be a full Vega-Lite spec, which exposes every mark, encoding channel, scale, axis, legend, transform, and composition Vega-Lite supports, or the shorthand form below, which covers the common cases in a few keys. Data is inline only (CSV, TSV, JSON rows); anything with a `url` is refused.

| | |
|---|---|
| Service ID | `pretty-charts` (free on Beta and MainNet as of 2026-09-13) |
| Name | Pretty Charts |
| Transport | REST, `POST /v1/chart` |
| Card | [`card.json`](card.json), validated with the Skill's `validate_card.py` |
| Manifest | [`service.json`](service.json), read and written by the Service Manager app |
| Backend | [`backend/`](backend/), Node 22, ES modules, three runtime dependencies (`vega`, `vega-lite`, `vega-themes`) plus `ajv` for spec validation |
| Deploy bundle | [`deploy/`](deploy/), for the Cherry supplier host |
| API document | [`backend/openapi.json`](backend/openapi.json), also served at `GET /v1/openapi.json` |

## API

Every response is a JSON object, including errors (the Pocket gateway rule). All inputs live in the body; headers never reach the backend.

| Route | Purpose |
|---|---|
| `GET /` and `HEAD /` | RelayMiner reachability ping |
| `GET /healthz` | Readiness; 200 once a render worker is up |
| `GET /v1/version` | Identity probe: `{"service":"pretty-charts","version":...,"engine":{...}}` |
| `GET /v1/capabilities` | Marks, shorthand types, themes, formats, and the active limits |
| `GET /v1/openapi.json` | The OpenAPI 3.1 document |
| `POST /v1/chart` | Render |

### Request

```json
{
  "data":    { "csv": "month,sales\nJan,120\nFeb,98\nMar,143" },
  "chart":   { "type": "bar", "x": "month", "y": "sales", "title": "Sales by month" },
  "options": { "format": "svg", "theme": "dark", "width": 600, "height": 360 }
}
```

- `data` holds exactly one of `csv`, `tsv`, `json` (a JSON array as a string), or `values` (row objects). Numbers and ISO dates in CSV are parsed automatically.
- Exactly one of `chart` (shorthand) or `spec` (a Vega-Lite v6 spec). A spec may carry its own `data.values` instead of the top-level `data`.
- `options`: `format` (`svg` returns the bare `<svg>` element, `html` a complete document), `tooltips` (default true), `width`, `height`, `padding`, `background`, `title`, `theme` (any vega-themes preset), `seed` (for the `sample` transform), `config` (a Vega-Lite config merged over the theme).

### Shorthand

`type` is one of `bar line area point scatter circle square tick rect heatmap arc pie donut boxplot errorbar errorband rule text trail`. Channels (`x y x2 y2 xOffset yOffset theta radius color fill stroke opacity size shape strokeWidth strokeDash angle text detail order row column facet`) take a column name or a Vega-Lite field definition; types are inferred from the data when omitted. Field objects also accept `domain`, `range`, `scheme`, `zero`, `nice`, `reverse` as shortcuts for `scale`. Extra keys: `xRange`, `yRange`, `colors` (color scale range), `colorScheme`, `stack`, `point`, `interpolate`, `innerRadius`, `cornerRadius`, `tooltip` (false, or the columns to show), `title`, `width`, `height`, `mark` (extra mark properties), `transform`. For `pie` and `donut`, `x` becomes the slice and `y` the angle. Categorical `x` and `y` keep the data's order unless the field definition sets `sort`.

### Response

```json
{
  "service": "pretty-charts", "format": "svg", "content_type": "image/svg+xml",
  "width": 650, "height": 398, "rows": 3, "marks": 3, "tooltips": true,
  "render_ms": 48, "warnings": [],
  "html": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...>...</svg>"
}
```

`html` is always the last field. Errors are `{"error":{"code","message","details"}}` with a 4xx status: `invalid_json`, `invalid_request`, `invalid_data`, `invalid_spec` (with the schema errors), `unknown_field` (with the column list), `remote_data_not_allowed`, `body_too_large`, `too_many_rows`, `too_many_marks`, `output_too_large`, `render_failed`, `render_budget_exceeded`.

### Tooltips without script

Vega-Lite writes an accessible description of every data mark, which Vega's SVG renderer emits as an `aria-label`. The backend turns each one into a child `<title>` element, which browsers show as a native hover tooltip. In the shorthand, `tooltip: ["col", ...]` chooses the columns; in a full spec, set `encoding.description` yourself.

### Limits

All caps are environment variables on the container, reported live by `GET /v1/capabilities`.

| Variable | Default | Why |
|---|---|---|
| `PC_MAX_BODY_BYTES` | 1 MiB | Far under every relay hop (RelayMiner 20 MB, application clients 16 MiB) |
| `PC_MAX_ROWS` | 50,000 | Rows drive render cost more than bytes |
| `PC_MAX_MARKS` | 10,000 | Data-mark items in the scenegraph; past it, aggregate or bin |
| `PC_MAX_SVG_BYTES` | 2 MiB | Output safety net |
| `PC_RENDER_BUDGET_MS` | 5,000 | Render is killed and answered with a JSON 422 well inside the gateway's relay budget |
| `PC_WORKERS` | 2 | Render threads |

Renders run in worker threads; an over-budget worker is terminated and replaced, so the probes stay responsive.

## Determinism

Identical input to any supplier on the same version returns identical bytes: Vega's layout is deterministic, random transforms are seeded, and no fonts or images are fetched. The card says `results: deterministic`. Text is measured with Vega's estimator (no canvas), which is stable across machines.

## Development

```bash
cd services/pretty-charts/backend
npm install
npm test          # starts the server with small limits and runs 30 checks
npm start         # listens on :8080
```

`docker build -t pretty-charts-backend .` produces the image (about 280 MB, Alpine). The Skill's `lint_backend.py --base-url http://127.0.0.1:8080 --card ../card.json` grades a running backend the way SAGE would.

## Deployment on Beta

Cherry runs one supplier stack (redis, miner, relayer, Caddy at `https://services.agentdata.network`) in `/opt/pocket/supplier`, described in [`servers/cherry/`](../../servers/cherry/). A supplier serves every service it is staked for through the same relayer, so Pretty Charts is only a backend container on that stack's `pocket-supplier` network plus one entry in the relayer config.

1. **Ship and start the backend** from the workstation: `bash services/pretty-charts/deploy/deploy.sh`. Copies `backend/` and `deploy/` to `/opt/pocket/services/pretty-charts`, builds the image, starts `pretty-charts-backend` on the supplier network, and waits for `/healthz`. Done 2026-09-13.
2. **Register the service** on Beta with the Service Manager (Services, Register). Done 2026-09-13 at 10,000 CU per relay.
3. **Re-stake the supplier for both services** with Supply service (server `cherry`), using [`deploy/supplier_stake_config.yaml`](deploy/supplier_stake_config.yaml) as the reference: the service list is replaced on every stake, so both ids are listed with the same endpoint.
4. **Relayer entry**: already present in [`servers/cherry/relayer-config.yaml`](../../servers/cherry/relayer-config.yaml) since the supplier migration on 2026-09-14. For another server, `bash deploy/add-to-relayer.sh` inserts [`deploy/relayer-service.yaml`](deploy/relayer-service.yaml) into that server's relayer config and recreates the relayer.
5. **Stake an application wallet for it.** An account can be staked as an application for exactly one service, so on the Wallets tab create `app-pretty-charts`, fund it from the owner wallet, and stake it on the Stake tab (that wallet is preselected under "Stake as"). Registration recorded on 2026-09-13 at 10,000 CU per relay; the manifest carries the transaction hash.
6. **Relay through the protocol** from Cherry: export the app wallet's key (Wallets tab, Export key) into `POCKET_APP_PRIVATE_KEY` on the server, or put it in `deploy/app-key.hex` (mode 600, never committed), then after one session `bash deploy/relay-test.sh` sends GET and POST relays with pocket-ap. Without an exported key the script falls back to the throwaway `test-app` from the first service once `bash deploy/stake-test-app.sh` has re-pointed it at pretty-charts. Watch claims with the Skill's `query_state.py --claims`.

`deploy/rendered/` holds the Skill's rendered templates for reference (SAGE service block, public health-check entry, pocket-ap config, application stake config).

## Before MainNet

- Publish the OpenAPI document and the operator docs at the URLs the card names under `agentdata.network`, then add the `sha256` to `specs[0]`. Both URLs are placeholders today.
- Re-fetch the live price multiplier and decide the MainNet `compute_units_per_relay`.
- Gateway onboarding: hand operators [`deploy/rendered/sage-service.yaml`](deploy/rendered/sage-service.yaml) and open the `pocket-health-checks.yaml` PR with [`deploy/rendered/pocket-health-checks-entry.yaml`](deploy/rendered/pocket-health-checks-entry.yaml).
