#!/usr/bin/env python3
"""Validate a service metadata card without needing pocketd.

Usage:
  python validate_card.py ./card.json

Checks, in order:
  1. Single UTF-8 JSON object.
  2. Size: hard limit 256 KiB (chain-enforced), target <= 4 KiB (warning).
  3. Schema: validated against the bundled pocket-service-card/v1 JSON Schema if
     the 'jsonschema' package is available; otherwise a built-in structural check
     covering the load-bearing constraints.
  4. The 'required' key inside rpc_types[] (schema-forbidden; use 'intent').
  5. Convention warnings: missing specs[].api, missing updated, no identity probe,
     results not set, serving.sync present (meaningless for a non-chain service).

pocketd tx service validate-card is the authoritative check; this mirrors it so a
card can be checked on a machine without pocketd (e.g. Windows). Exit 0 clean,
1 on schema/structural error, leaves warnings non-fatal.
"""
import argparse
import json
import os
import sys

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "service_card.schema.json")
RPC_ENUM = {"GRPC", "WEBSOCKET", "JSON_RPC", "REST", "COMET_BFT"}
MAX_HARD = 256 * 1024
MAX_TARGET = 4 * 1024


def structural_check(card):
    """Built-in check for when jsonschema is not installed. Returns list of errors."""
    errs = []
    if not isinstance(card, dict):
        return ["card must be a JSON object"]
    if card.get("schema") != "pocket-service-card/v1":
        errs.append('schema must be exactly "pocket-service-card/v1"')
    for i, r in enumerate(card.get("rpc_types", []) or []):
        if not isinstance(r, dict):
            errs.append(f"rpc_types[{i}] must be an object")
            continue
        if "required" in r:
            errs.append(f"rpc_types[{i}] has a 'required' key: forbidden by the schema. Use 'intent'.")
        if r.get("type") not in RPC_ENUM:
            errs.append(f"rpc_types[{i}].type must be one of {sorted(RPC_ENUM)}")
    for i, s in enumerate(card.get("specs", []) or []):
        if isinstance(s, dict) and "url" not in s:
            errs.append(f"specs[{i}] requires a url")
    for i, h in enumerate((card.get("serving") or {}).get("healthcheck", []) or []):
        if not isinstance(h, dict):
            errs.append(f"serving.healthcheck[{i}] must be an object")
            continue
        if h.get("rpc_type") not in RPC_ENUM:
            errs.append(f"serving.healthcheck[{i}].rpc_type must be one of {sorted(RPC_ENUM)}")
        if "request" not in h:
            errs.append(f"serving.healthcheck[{i}] requires a request")
    for field in ("description",):
        v = card.get(field)
        if v is not None and len(v) > 2048:
            errs.append(f"{field} exceeds 2048 chars")
    return errs


def schema_check(card):
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return None  # signal fallback
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema = json.load(f)
    v = jsonschema.Draft202012Validator(schema)
    return [f"{list(e.path)}: {e.message}" for e in sorted(v.iter_errors(card), key=lambda e: list(e.path))]


def conventions(card):
    warns = []
    serving = card.get("serving") or {}
    if "results" not in card:
        warns.append("no 'results' field; set 'deterministic' or 'variable' so consumers know if suppliers are interchangeable")
    if "updated" not in card:
        warns.append("no 'updated' date; every PNF card carries one (YYYY-MM-DD)")
    if "sync" in serving:
        warns.append("serving.sync is set; it means nothing for a non-blockchain service and should be omitted")
    for i, s in enumerate(card.get("specs", []) or []):
        if isinstance(s, dict) and "api" not in s:
            warns.append(f"specs[{i}] has no 'api' key; PNF convention names the apis[] entry each spec documents")
    hcs = serving.get("healthcheck") or []
    if not hcs:
        warns.append("no serving.healthcheck; suppliers cannot self-test before staking and gateways have nothing to probe")
    if not card.get("rpc_types"):
        warns.append("no rpc_types; consumers and node runners both read this, and gateways will not route without it")
    return warns


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("card")
    args = ap.parse_args()

    raw = open(args.card, "rb").read()
    size = len(raw)
    print(f"size: {size} bytes ({size/1024:.1f} KiB)")
    if size > MAX_HARD:
        print(f"  FATAL: over the 256 KiB chain limit; the chain will reject this")
        sys.exit(1)
    if size > MAX_TARGET:
        print(f"  warning: over the 4 KiB target; move large content (specs) out of the card")

    try:
        card = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"FATAL: not a single UTF-8 JSON object: {e}")
        sys.exit(1)

    errs = schema_check(card)
    if errs is None:
        print("(jsonschema not installed; using built-in structural check. "
              "pip install jsonschema for full validation, or run `pocketd tx service validate-card`.)")
        errs = structural_check(card)
    else:
        # Belt and braces: also run the forbidden-key check, which is a custom message on-chain.
        errs += [e for e in structural_check(card) if "'required' key" in e]

    if errs:
        print("\nSCHEMA ERRORS:")
        for e in errs:
            print(f"  - {e}")
    else:
        print("\nschema: OK")

    warns = conventions(card)
    if warns:
        print("\nconvention warnings (non-fatal):")
        for w in warns:
            print(f"  - {w}")

    print("\nAuthoritative check: pocketd tx service validate-card " + args.card)
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
