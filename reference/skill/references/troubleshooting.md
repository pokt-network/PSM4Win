# Troubleshooting

A decision tree for the failures a first deployment hits. Each row names the one query or log line that distinguishes the cause. Most "it's broken" reports are timing: a stake goes active only at the next session boundary, and a claim appears only after the session ends.

## Nothing is happening after I staked

| Symptom | Check | Cause and fix |
|---|---|---|
| No relays arriving | `query_state.py --session --app <app> --service <id> --supplier <op>` | If your supplier is NOT IN the session, the stake has not activated yet, or the app's session rolled before activation. Wait one full session and re-check. |
| Supplier not in any session | `query_state.py --supplier <op>` | Stake missing, wrong service_id, or unbonding. Confirm the stake exists and lists the service. |
| Still nothing after two sessions | app stake | The test app must be staked for exactly this service and funded. `query_state.py --balance <app>`. |

## The relay fails

| Symptom | Check | Cause and fix |
|---|---|---|
| pocket-ap: no endpoint / supplier | session query | Your supplier is not in the session (above), or its `rpc_type` does not match the request type. |
| Gateway returns 400 "unconfigured service" or refuses before session lookup | gateway config | The gateway has no `services[]` entry with `rpc_types: ["rest"]` for this service. Add `sage-service.yaml`. |
| RelayMiner logs 404 from backend | `backend_url` | The path join is wrong. `backend_url: http://h:8080/api` + `/v1/x` -> `/api/v1/x`. Mount the API at `/` or fix the prefix. |
| Relayer `/health` not 200, or backend marked unhealthy in logs | `curl :8081/health`, relayer logs | The backend `url` is unreachable from the relayer, or its `health_check.endpoint` does not answer 2xx. On compose, use the service name, not `127.0.0.1`. |
| Every relay rejected: "payload failed to unmarshal as RelayResponse" at the client, "response signer not configured" in the relayer log | relayer log at startup | The relayer has no signing key: the config's `keys` section is missing (it is `keys`, not `signing_keys`) or `supplier-keys.yaml` is unreadable by uid 1000. |
| Backend sees an empty POST body through the relayer but works with curl | backend request headers | Relay bodies arrive with `Transfer-Encoding: chunked` and no `Content-Length`. Decode chunked bodies (design rule 2). |
| Relay returns HTML/plain text and gets retried | `lint_backend.py` | The backend returns a non-JSON body. Wrap it in a JSON object (design rule 1). |
| 5xx passed through, unpaid | backend logs | The backend returns 5xx for a client error. Return 4xx with a JSON body instead (design rule 5). |
| Valid JSON answer retried anyway | first 2 KB of the body | An error-substring (`timeout`, `bad gateway`, ...) sits in the first 2 KB. Rename the field (design rule 6). |
| TLS handshake errors from a gateway | cert | Self-signed or untrusted certificate. Use a publicly trusted cert; some gateways refuse plaintext or raw-IP URLs entirely. |

## The claim does not settle

| Symptom | Check | Cause and fix |
|---|---|---|
| No claim after the session ended | `query_state.py --claims --supplier <op>` | The claim window opens `claim_window_open_offset_blocks` after session end. Wait for it. If still absent, check the miner log for "claims submitted"; if Redis was lost or restarted without persistence, the session trees are gone and those relays are unpaid. |
| Claim fails with "unexpected 'x-cosmos-block-height' header length; got 0" | RelayMiner type | You are running the deprecated single-process `pocketd relayminer` against a public gRPC endpoint that strips that header. Switch to the HA RelayMiner (`templates/ha/`). |
| Claim present, never paid | proof | A proof was required and missing. `query_state.py --proofs --supplier <op>`. A missing required proof forfeits the claim and burns `proof_missing_penalty`. |
| Operator "insufficient funds" in logs | `query_state.py --balance <op>` | The operator cannot pay the claim/proof tx fee. Top it up; claims and proofs are on-chain transactions. |
| Supplier disappeared from sessions | stake amount | Stake fell below `min_stake` (a missing-proof penalty can do this) and the supplier was force-unbonded. Re-stake. |

## Registration problems

| Symptom | Cause and fix |
|---|---|
| `out of gas in location: txSize` | Fixed `--fees` too small for a card-carrying tx. Use `--gas auto --gas-prices 1upokt --gas-adjustment 1.5`. |
| `add-service` rejected, not owner | Only the owner account can update a service. |
| Card validates locally but `validate-card` fails | The bundled schema is older than the installed `pocketd`. Trust `pocketd`; then diff the schemas. |
| `edit-service` did nothing | The card and price already match on-chain byte-for-byte. `encode_card.py diff` confirms. Reformatting counts as a change. |
| Card update seemed to wipe the card | It did not; omitting `--card-file` preserves it. If you published `{}` you erased the content. Re-publish the full card. |

## When to escalate past this skill

- WebSocket, gRPC, or SSE streaming behaving oddly: these are partially in scope; the RelayMiner and gateway handling differ. See the HA RelayMiner docs.
- Anything about the protocol's own behavior (settlement math, tokenomics, session assignment internals) belongs to the `pocket-engineering` skill and the protocol docs, not here.
