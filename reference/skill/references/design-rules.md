# Design rules for a service backend on Pocket

Each rule was verified in gateway, RelayMiner, or client source on 2026-09-11 (SAGE @ `703d8d9`, poktroll `pkg/relayer`, pocket-agent-core). The rules are stated as requirements. `scripts/lint_backend.py` checks a running backend against every rule it can observe.

## 1. Every response is a JSON object

SAGE classifies a body by its first non-whitespace byte (`heuristic/structural.go`). `{` or `[` proceeds to normal grading. Anything else:

| Body | Verdict | Effect on the supplier |
|---|---|---|
| Starts with `<!DOCTYPE` or `<html` | `html_response` | Retried elsewhere, Critical penalty, circuit-broken |
| Starts with any other byte (plain text, CSV, a number, base64) | `plain_text_response` | Retried elsewhere, Major penalty |
| Empty on a 200 | `empty_response` | Retried elsewhere, Critical penalty, circuit-broken |
| Empty on 204, 205, 304 | success | |

After retries are exhausted the last upstream response is delivered, so the client eventually gets the HTML, but every supplier tried was penalized for answering correctly.

**Do:** wrap non-JSON output.
```json
{"content_type": "text/html", "body": "<!DOCTYPE html>..."}
```
The field names are the service's contract, not a network rule. Put short metadata first and the large string last. Plain JSON string escaping is enough; base64 doubles the size for nothing.

**Do not:** rely on XML or SVG passing the classifier. They do today because they start with `<` and are not HTML. That is an accident of the implementation, not a contract.

## 2. All inputs arrive in the request body

What the gateway forwards to the supplier: HTTP method, path, query string (SAGE; PATH dropped it), body. What it does not forward: any client request header. The embedded request carries exactly one header, `Content-Type: application/json`, regardless of what the client sent (`protocol/shannon/relayer.go`, `transport.go`).

**Do:** take every input, including bulk data like CSV, from a JSON body. Use POST for anything with inputs. Treat the query string as unreliable.
**Do not:** read `Accept`, the caller's `Content-Type`, or any custom header.

**The body arrives chunked.** The RelayMiner forwards the body with `Transfer-Encoding: chunked` and no `Content-Length` (verified on Beta, pocketd v0.1.35, against a live supplier). Any framework that decodes chunked bodies (Node `http`, Go `net/http`, Express, Flask, FastAPI, Spring) is fine. A hand-rolled server that reads `Content-Length` bytes sees an empty body on every relay while working perfectly when curled directly; the Python `http.server` template handles this explicitly. Test through the protocol, not only with curl.

## 3. Response headers do not reach the client

The RelayMiner serializes the backend's headers into the relay, but SAGE does not forward them (`domain.Response.Headers` is populated only for gRPC). SAGE sets `Content-Type: application/json` on its reply only when the body starts with `{` or `[`.

**Do:** put anything the client needs to know inside the JSON body.

## 4. No caller authentication; identity encoding only

Relays are paid by the application's stake. Application-side clients strip `Authorization`, `Proxy-Authorization`, `Api-Key`, `X-Api-Key`, and `Cookie`, and force `Accept-Encoding: identity`. Gateways forward no headers at all.

**Do:** if the backend needs a credential to reach something behind it, configure it in the RelayMiner (`headers:` or `authentication:` in `service_config`), never expect it from the caller. Serve uncompressed responses.

## 5. Status codes

| Situation | Return | Gateway verdict | Paid? |
|---|---|---|---|
| Success | 200 + JSON object | success | yes |
| Nothing to return | 204, empty body | success | yes |
| Bad input | 400 or 422 + JSON error object | client's error; delivered, not retried, no penalty | yes |
| Rate limited by you | avoid; 429 is retried with a Minor penalty | | |
| Backend failure | 5xx | retried, Critical penalty, circuit-broken | **no** (RelayMiner `isRewardApplicable` requires status < 500) |

A REST 401 or 403 with a non-JSON body is graded as the supplier's front door refusing, and penalized. Never answer any error with HTML or plain text.

## 6. Keep error-looking words out of the first 2 KB of a success body

SAGE's Tier 3 scans the first 2 KB of every body, including valid JSON, for substrings (`heuristic/indicators.go`). Supplier-attributed patterns that cause retry and penalty include:

`timeout`, `connection refused`, `connection reset`, `bad gateway`, `service unavailable`, `gateway timeout`, `502 bad gateway`, `503 service unavailable`, `504 gateway timeout`

Case-insensitive. A JSON field named `timeout` in an echoed options block triggers it.

**Do:** name such fields `deadline_ms` or `max_wait`, and keep status prose free of those phrases.

## 7. Respond within the relay timeout and the session

- SAGE bounds each attempt by the per-service `timeout_config.relay_timeout`; operators typically set 10 to 30 s. PATH's default was 10 s.
- A relay that finishes after the session plus grace period is unpaid.
- Gateways buffer whole responses. There is no SSE or chunked streaming through a gateway. Streaming works only through the HA RelayMiner to non-gateway clients.

**Do:** return quickly. For long work, return a handle and let the client poll, or target streaming clients deliberately.

## 8. Body size

RelayMiner default `max_body_size` is 20 MB for request and response. SAGE refuses request bodies over 75 MiB. Application-side clients cap requests at 16 MiB. Design for requests and responses well under 16 MiB.

## 9. Path handling

The RelayMiner builds the backend URL as `path.Join(backend_url.Path, request.Path)`. With `backend_url: http://svc:8080/api`, a request to `/v1/chart` reaches `/api/v1/chart`. Trailing slashes are dropped and `..` is cleaned. SAGE forwards `/v1/<rest>` after stripping its own `/v1` mount.

**Do:** mount the API at `/` on the backend and use `backend_url` without a path unless you intend a prefix. Do not depend on trailing slashes.

## 10. Provide the three probe endpoints

The card's `serving.healthcheck` names them; suppliers and gateways run them.

```
GET  /v1/version   → {"service": "<service-id>", "version": "1.2.0"}
GET  /v1/health    → {"status": "ok"}
POST /v1/<resource> with a minimal body → a deterministic answer
```

The identity probe pins the backend to the service so a wrong backend cannot be staked under the ID.

**Also answer the RelayMiner's own reachability checks.** The HA relayer probes the `health_check.endpoint` you configure for the backend (use the readiness probe path); the legacy single-process RelayMiner requests the backend URL's root (`GET /`) and treats anything but a 2xx as "backend unreachable", refusing to start on a 404 or a 501 for `HEAD`. Return a small JSON object for `GET /` (and accept `HEAD`) as well as the probe paths, exactly as the templates do; it costs nothing and keeps the backend usable behind either.

## 11. Determinism

Decide whether two suppliers return identical bytes for identical input, and say so in the card's `results`. Timestamps, random IDs, and floating-point rendering differences make it `variable`. Consumers use this to decide whether they can retry across suppliers and cross-check answers.

## 12. Per-request identity, if you want it

With `forward_pocket_headers: true` in the RelayMiner config, the backend receives `Pocket-Supplier`, `Pocket-Service`, `Pocket-Session-Id`, `Pocket-Application`, `Pocket-Session-Start-Height`, `Pocket-Session-End-Height`. They are the only per-request identity available and are useful for logging and per-application limits. Never require them.

## Checklist

- [ ] Every response body starts with `{` or `[`, including errors
- [ ] No empty 200s; 204 for no content
- [ ] All inputs from a JSON body; no dependence on headers or query string
- [ ] No auth expected from the caller
- [ ] No gzip
- [ ] 4xx with JSON for bad input; 5xx only for real failures
- [ ] No `timeout` / `bad gateway` / `service unavailable` / `connection *` substrings in the first 2 KB of success bodies
- [ ] Typical response well under 10 s; sizes well under 16 MiB
- [ ] `/v1/version`, `/v1/health`, and one cheap functional probe implemented exactly as the card says
- [ ] `results` in the card matches reality
