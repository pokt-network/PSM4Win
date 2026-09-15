#!/usr/bin/env python3
"""Lint a running service backend against Pocket's gateway design rules.

Usage:
  python lint_backend.py --base-url http://localhost:8080 --card ./card.json
  python lint_backend.py --base-url http://localhost:8080 \
      --probe "POST /v1/chart {\"csv\":\"x,y\\n1,2\",\"type\":\"line\"}" \
      --probe "GET /v1/health"
  python lint_backend.py --base-url http://localhost:8080 --bad "POST /v1/chart notjson"

Sends requests directly to the backend (not through Pocket) and grades each
response the way SAGE would. If --card is given, every serving.healthcheck is
run. Extra probes via --probe. Bad-input probes via --bad expect a 4xx + JSON.

Checks per response:
  - body starts with '{' or '['            (else html_response / plain_text_response: FAIL)
  - not an empty body on a 2xx             (empty_response: FAIL)
  - no Content-Encoding: gzip              (identity only: FAIL)
  - first 2 KB free of error substrings    (Tier-3 retry triggers: FAIL)
  - bad-input probes return 4xx with JSON  (not 5xx, not HTML: FAIL)

Standard library only. Exit 0 if all pass, 1 otherwise.
"""
import argparse
import json
import sys
import urllib.request
import urllib.error

TIER3 = ["timeout", "connection refused", "connection reset", "bad gateway",
         "service unavailable", "gateway timeout", "502 bad gateway",
         "503 service unavailable", "504 gateway timeout"]


def send(base, method, path, body):
    url = base.rstrip("/") + path
    data = body.encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return None, {}, str(e).encode()


def grade(status, headers, body, expect_client_error=False):
    problems = []
    trimmed = body.lstrip()
    if status is None:
        return ["backend unreachable: " + body.decode("utf-8", "replace")]
    if headers.get("Content-Encoding", "").lower() == "gzip":
        problems.append("response is gzip-encoded; serve identity encoding")
    if expect_client_error:
        if not (400 <= status < 500):
            problems.append(f"bad input returned HTTP {status}; expected a 4xx (415/422/400)")
        if trimmed[:1] not in (b"{", b"["):
            problems.append("error body is not JSON; gateways grade a non-JSON error against the supplier")
        return problems
    # success path
    if status >= 500:
        problems.append(f"HTTP {status}: 5xx is never paid and is penalized; use 4xx for client errors")
        return problems
    if 200 <= status < 300 and status not in (204, 205, 304) and len(trimmed) == 0:
        problems.append("empty body on a 2xx: graded empty_response (Critical). Use 204 for no content.")
    if trimmed[:1] not in (b"{", b"[") and status not in (204, 205, 304):
        head = trimmed[:16].decode("utf-8", "replace")
        problems.append(f"body starts with {head!r}, not JSON. Wrap non-JSON output in a JSON object.")
    first2k = body[:2048].lower()
    for pat in TIER3:
        if pat.encode() in first2k:
            problems.append(f"first 2 KB contains {pat!r}; gateways retry and penalize on this substring")
            break
    return problems


def parse_probe(s):
    # "METHOD /path optional-json-body"
    parts = s.split(" ", 2)
    method = parts[0].upper()
    path = parts[1] if len(parts) > 1 else "/"
    body = parts[2] if len(parts) > 2 else None
    return method, path, body


def run(label, base, method, path, body, expect_client_error, results):
    status, headers, resp = send(base, method, path, body)
    problems = grade(status, headers, resp, expect_client_error)
    ok = not problems
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {label}: {method} {path} -> HTTP {status}")
    for p in problems:
        print(f"        {p}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--card", help="run every serving.healthcheck from this card")
    ap.add_argument("--probe", action="append", default=[], help='e.g. "POST /v1/x {...}"')
    ap.add_argument("--bad", action="append", default=[], help="probe that should return a 4xx + JSON")
    args = ap.parse_args()

    results = []

    if args.card:
        card = json.load(open(args.card, encoding="utf-8"))
        for i, hc in enumerate((card.get("serving") or {}).get("healthcheck", [])):
            req = hc.get("request", {})
            method = req.get("method", "GET")
            path = req.get("path") or "/"
            body = json.dumps(req["body"]) if "body" in req else None
            run(f"card healthcheck[{i}]", args.base_url, method, path, body, False, results)

    for pr in args.probe:
        method, path, body = parse_probe(pr)
        run("probe", args.base_url, method, path, body, False, results)

    for pr in args.bad:
        method, path, body = parse_probe(pr)
        run("bad-input", args.base_url, method, path, body, True, results)

    if not results:
        print("nothing to check; pass --card and/or --probe/--bad")
        sys.exit(0)

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
