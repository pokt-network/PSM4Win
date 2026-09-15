#!/usr/bin/env python3
"""Check a proposed service against the live catalog for conflicts.

Usage:
  python check_catalog.py <proposed-id> [--network beta|main] [--name "..."] [--apis a,b,c]
  python check_catalog.py <proposed-id> --both            # check beta and main

Reports, on each network:
  - exact ID collision (fatal: the ID is permanent and cannot be reused)
  - case-insensitive ID collision, and hyphen/underscore-insensitive collision
  - name collision (case-insensitive)
  - apis[] values already claimed by another service's card
  - near-duplicate services by description similarity (consider supplying instead)

Standard library only. Reads the Cosmos LCD; nothing is written on-chain.
"""
import argparse
import base64
import json
import re
import sys

from common import get_all_services, EXPLORER, die


def norm_id(s):
    return s.lower().replace("_", "-")


def decode_card(svc):
    md = svc.get("metadata") or {}
    raw = md.get("card")
    if not raw:
        return None
    try:
        return json.loads(base64.b64decode(raw))
    except Exception:
        return None


def tokens(text):
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def check(network, proposed, name, apis):
    services = get_all_services(network)
    findings = []  # (level, message); level in {FATAL, WARN, INFO}
    p_norm = norm_id(proposed)
    p_lower = proposed.lower()

    ids = {s["id"] for s in services}
    if proposed in ids:
        findings.append(("FATAL", f"service id '{proposed}' already exists on {network}. "
                                  f"IDs are permanent and cannot be reused. See {EXPLORER[network]}/services"))
    for s in services:
        sid = s["id"]
        if sid == proposed:
            continue
        if sid.lower() == p_lower:
            findings.append(("WARN", f"id differs from existing '{sid}' only by case"))
        elif norm_id(sid) == p_norm:
            findings.append(("WARN", f"id differs from existing '{sid}' only by hyphen/underscore"))

    if name:
        for s in services:
            if (s.get("name") or "").strip().lower() == name.strip().lower():
                findings.append(("WARN", f"name '{name}' matches existing service '{s['id']}'"))

    want_apis = {a.strip().lower() for a in apis if a.strip()} if apis else set()
    if want_apis:
        claimed = {}
        for s in services:
            card = decode_card(s)
            if not card:
                continue
            for a in card.get("apis", []):
                claimed.setdefault(a.lower(), []).append(s["id"])
        for a in sorted(want_apis):
            if a in claimed:
                findings.append(("INFO", f"apis value '{a}' is already used by: {', '.join(claimed[a])}. "
                                         f"Reuse it only if you mean the same contract."))

    # Near-duplicate by description token overlap.
    p_desc = tokens(name)
    if p_desc:
        for s in services:
            card = decode_card(s)
            desc = tokens((card or {}).get("description", "")) | tokens(s.get("name"))
            if not desc:
                continue
            overlap = len(p_desc & desc) / max(1, len(p_desc))
            if overlap >= 0.6 and s["id"] != proposed:
                findings.append(("INFO", f"'{s['id']}' looks similar to what you described; "
                                         f"consider supplying it instead of registering a duplicate"))

    return services, findings


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("service_id")
    ap.add_argument("--network", choices=["beta", "main"], default="beta")
    ap.add_argument("--both", action="store_true", help="check both networks")
    ap.add_argument("--name", default="")
    ap.add_argument("--apis", default="", help="comma-separated apis[] values")
    args = ap.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,42}", args.service_id):
        die("service id must be 1-42 chars of A-Z a-z 0-9 - _")

    apis = args.apis.split(",") if args.apis else []
    networks = ["beta", "main"] if args.both else [args.network]

    any_fatal = False
    for net in networks:
        services, findings = check(net, args.service_id, args.name, apis)
        print(f"\n=== {net}: {len(services)} services on-chain ===")
        if not findings:
            print(f"  OK: '{args.service_id}' is free of conflicts on {net}.")
        for level, msg in findings:
            print(f"  [{level}] {msg}")
            if level == "FATAL":
                any_fatal = True

    print()
    sys.exit(2 if any_fatal else 0)


if __name__ == "__main__":
    main()
