#!/usr/bin/env python3
"""Encode, decode, or diff a service metadata card.

The card is stored on-chain as raw bytes and returned base64-encoded by the LCD
and by `pocketd ... -o json`. It is NOT gzipped. Base64 is only the transport
encoding of the proto bytes field.

Usage:
  # Encode a local card for --card-base64 (single line, no wrapping):
  python encode_card.py encode ./card.json

  # Decode the base64 the chain returns (paste it, or pipe show-service output):
  python encode_card.py decode --base64 "ewog..."
  pocketd query service show-service <id> -o json | python encode_card.py decode --stdin-json

  # Diff a local card against what is on-chain (byte-exact; reformatting counts):
  python encode_card.py diff ./card.json --id <service-id> --network beta

Standard library only.
"""
import argparse
import base64
import json
import sys

from common import lcd_base, get, die


def onchain_card_bytes(network, service_id):
    url = f"{lcd_base(network)}/pokt-network/poktroll/service/service/{service_id}"
    data, err = get(url)
    if err:
        die(f"could not read service '{service_id}' on {network}: {err}")
    md = (data.get("service") or {}).get("metadata") or {}
    b64 = md.get("card")
    if not b64:
        die(f"service '{service_id}' has no card on-chain")
    return base64.b64decode(b64)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("encode", help="base64-encode a local card")
    e.add_argument("card")

    d = sub.add_parser("decode", help="decode base64 to pretty JSON")
    g = d.add_mutually_exclusive_group(required=True)
    g.add_argument("--base64", help="the base64 string")
    g.add_argument("--stdin-json", action="store_true", help="read show-service -o json from stdin")

    f = sub.add_parser("diff", help="diff a local card against on-chain bytes")
    f.add_argument("card")
    f.add_argument("--id", required=True)
    f.add_argument("--network", choices=["beta", "main"], default="beta")

    args = ap.parse_args()

    if args.cmd == "encode":
        raw = open(args.card, "rb").read()
        sys.stdout.write(base64.b64encode(raw).decode("ascii"))
        sys.stdout.write("\n")

    elif args.cmd == "decode":
        if args.stdin_json:
            data = json.load(sys.stdin)
            b64 = (data.get("service") or {}).get("metadata", {}).get("card")
            if not b64:
                die("no service.metadata.card in the piped JSON")
        else:
            b64 = args.base64
        raw = base64.b64decode(b64)
        try:
            print(json.dumps(json.loads(raw), indent=2))
        except json.JSONDecodeError:
            sys.stdout.buffer.write(raw)

    elif args.cmd == "diff":
        local = open(args.card, "rb").read()
        remote = onchain_card_bytes(args.network, args.id)
        if local == remote:
            print(f"identical: local card matches '{args.id}' on {args.network} byte-for-byte")
            print("edit-service would skip this service (no change).")
            sys.exit(0)
        print(f"DIFFERENT: local card and on-chain '{args.id}' differ.")
        print(f"  local:    {len(local)} bytes")
        print(f"  on-chain: {len(remote)} bytes")
        print("edit-service compares byte-exactly, so reformatting alone counts as a change.")
        try:
            import difflib
            a = json.dumps(json.loads(remote), indent=2, sort_keys=True).splitlines()
            b = json.dumps(json.loads(local), indent=2, sort_keys=True).splitlines()
            print("\nsemantic diff (on-chain -> local, keys sorted):")
            for line in difflib.unified_diff(a, b, "on-chain", "local", lineterm=""):
                print("  " + line)
        except json.JSONDecodeError:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
