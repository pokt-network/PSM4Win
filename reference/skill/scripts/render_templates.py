#!/usr/bin/env python3
"""Fill every deployment template from one answers file.

Usage:
  python render_templates.py answers.json --out ./deploy
  python render_templates.py --print-answers      # write a starter answers.json to stdout

Templates use {{PLACEHOLDER}} tokens. This substitutes them and copies the result
into --out, preserving the templates/ layout. It never asks for or stores private
keys: keys are referenced by keyring name or by env var in the rendered files.

Standard library only.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(__file__)
TPL = os.path.abspath(os.path.join(HERE, "..", "templates"))

STARTER = {
    "SERVICE_ID": "my-service",
    "SERVICE_NAME": "My Service",
    "COMPUTE_UNITS_PER_RELAY": "5000",
    "NETWORK": "beta",
    "CHAIN_ID": "pocket-lego-testnet",
    "RPC_URL": "https://sauron-rpc.beta.infra.pocket.network",
    "GRPC_URL": "sauron-grpc.beta.infra.pocket.network:443",
    "OWNER_ADDRESS": "pokt1owner...",
    "OPERATOR_ADDRESS": "pokt1operator...",
    "OPERATOR_KEY_NAME": "operator",
    "OWNER_KEY_NAME": "owner",
    "APP_KEY_NAME": "test-app",
    "STAKE_AMOUNT_UPOKT": "59500000000",
    "APP_STAKE_AMOUNT_UPOKT": "1000000000",
    "RPC_TYPE": "REST",
    "RPC_TYPE_LOWER": "rest",
    "PUBLIC_URL": "https://relay.example.org",
    "BACKEND_URL": "http://my-service-backend:8080",
    "LISTEN_PORT": "8545",
    "SMT_STORE_PATH": "/var/lib/pocket/smt",
    "HEALTH_PATH": "/v1/health",
    "VERSION_PATH": "/v1/version",
    "RELAY_TIMEOUT": "30s",
    "TIMEOUT_PROFILE": "fast",
    "DOMAIN": "relay.example.org",
}

DERIVED = {
    "beta": {"CHAIN_ID": "pocket-lego-testnet",
             "RPC_URL": "https://sauron-rpc.beta.infra.pocket.network",
             "GRPC_URL": "sauron-grpc.beta.infra.pocket.network:443"},
    "main": {"CHAIN_ID": "pocket",
             "RPC_URL": "https://sauron-rpc.infra.pocket.network",
             "GRPC_URL": "sauron-grpc.infra.pocket.network:443"},
}


def render_tree(src, dst, answers):
    for root, _, files in os.walk(src):
        rel = os.path.relpath(root, src)
        outdir = os.path.join(dst, rel) if rel != "." else dst
        for name in files:
            sp = os.path.join(root, name)
            with open(sp, encoding="utf-8") as f:
                text = f.read()
            for k, v in answers.items():
                text = text.replace("{{" + k + "}}", str(v))
            os.makedirs(outdir, exist_ok=True)
            op = os.path.join(outdir, name)
            with open(op, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            leftover = [tok for tok in _unfilled(text)]
            flag = f"   (unfilled: {', '.join(sorted(set(leftover)))})" if leftover else ""
            print(f"  wrote {os.path.relpath(op, dst)}{flag}")


def _unfilled(text):
    import re
    return re.findall(r"\{\{([A-Z_]+)\}\}", text)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("answers", nargs="?")
    ap.add_argument("--out", default="./deploy")
    ap.add_argument("--print-answers", action="store_true")
    args = ap.parse_args()

    if args.print_answers:
        print(json.dumps(STARTER, indent=2))
        return
    if not args.answers:
        ap.error("provide answers.json, or --print-answers for a starter")

    answers = dict(STARTER)
    answers.update(json.load(open(args.answers, encoding="utf-8")))
    # Derive network-specific endpoints unless explicitly overridden in the answers file.
    given = json.load(open(args.answers, encoding="utf-8"))
    for k, v in DERIVED.get(answers.get("NETWORK", "beta"), {}).items():
        if k not in given:
            answers[k] = v
    if "RPC_TYPE_LOWER" not in given:
        answers["RPC_TYPE_LOWER"] = answers["RPC_TYPE"].lower()

    os.makedirs(args.out, exist_ok=True)
    print(f"rendering templates into {args.out} for service '{answers['SERVICE_ID']}' on {answers['NETWORK']}:")
    render_tree(TPL, args.out, answers)
    print("\nreview every file, especially addresses and URLs, before using them.")
    print("keys are referenced by keyring name / env var; no private key is written here.")


if __name__ == "__main__":
    main()
