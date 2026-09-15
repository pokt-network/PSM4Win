#!/usr/bin/env python3
"""Read the on-chain evidence for a supplier, service, session, and claims.

Usage:
  python query_state.py --network beta --service <id>
  python query_state.py --network beta --supplier <operator-addr>
  python query_state.py --network beta --session --app <app-addr> --service <id>
  python query_state.py --network beta --claims --supplier <operator-addr>
  python query_state.py --network beta --proofs --supplier <operator-addr>
  python query_state.py --network beta --balance <addr>

With no specific flag it runs every check it has the addresses for. Answers the
questions a first deployment actually asks: is the service registered, is my
supplier staked and for what, am I in the current session for my app, has a claim
landed, is my operator funded. Standard library only; read-only.
"""
import argparse
import base64
import json

from common import lcd_base, get, upokt_to_pokt, die


def show_service(net, sid):
    d, err = get(f"{lcd_base(net)}/pokt-network/poktroll/service/service/{sid}")
    if err:
        print(f"service {sid}: NOT FOUND ({err})")
        return
    s = d["service"]
    has_card = bool((s.get("metadata") or {}).get("card"))
    print(f"service {sid}: registered, owner {s['owner_address']}, "
          f"cupr {s['compute_units_per_relay']}, card {'present' if has_card else 'MISSING'}")


def show_supplier(net, op):
    d, err = get(f"{lcd_base(net)}/pokt-network/poktroll/supplier/supplier/{op}")
    if err:
        print(f"supplier {op}: NOT FOUND ({err})")
        return
    s = d["supplier"]
    stake = upokt_to_pokt(s["stake"]["amount"])
    print(f"supplier {op}: staked {stake:,.2f} POKT")
    active = {svc["service_id"] for svc in s.get("services", [])}
    for svc in s.get("services", []):
        eps = ", ".join(f"{e['url']} ({e['rpc_type']})" for e in svc.get("endpoints", []))
        print(f"    service {svc['service_id']}: {eps}")
    # A stake-supplier changes the service list only at the next session boundary.
    # Until then `services` is the old active set and the new one is scheduled in
    # service_config_history (deactivation_height 0, activation_height in the future).
    for h in s.get("service_config_history", []):
        svc = h.get("service") or {}
        sid = svc.get("service_id")
        if not sid or str(h.get("deactivation_height", "0")) != "0" or sid in active:
            continue
        print(f"    service {sid}: SCHEDULED, active from height {h.get('activation_height')}")
    unbond = s.get("unstake_session_end_height") or s.get("unbonding_height")
    if unbond and str(unbond) != "0":
        print(f"    UNBONDING (end height {unbond})")


def latest_height(net):
    d, err = get(f"{lcd_base(net)}/cosmos/base/tendermint/v1beta1/blocks/latest")
    if err:
        return None
    return int(d["block"]["header"]["height"])


def get_session(net, app, sid):
    h = latest_height(net)
    if h is None:
        die("could not read latest block height")
    url = (f"{lcd_base(net)}/pokt-network/poktroll/session/get_session"
           f"?application_address={app}&service_id={sid}&block_height={h}")
    d, err = get(url)
    if err:
        die(f"get_session failed: {err}")
    sess = d.get("session", {})
    hdr = sess.get("header", {})
    print(f"session for app {app} / service {sid} at height {h}:")
    print(f"    session id {hdr.get('session_id')}, "
          f"start {hdr.get('session_start_block_height')}, end {hdr.get('session_end_block_height')}")
    sups = sess.get("suppliers", [])
    print(f"    {len(sups)} suppliers this session:")
    for s in sups:
        print(f"      {s.get('operator_address')}")
    return sups


def list_claims(net, op):
    url = f"{lcd_base(net)}/pokt-network/poktroll/proof/claim?supplier_operator_address={op}&pagination.limit=50"
    d, err = get(url)
    if err:
        die(f"list claims failed: {err}")
    claims = d.get("claims", [])
    print(f"claims by {op}: {len(claims)}")
    for c in claims[:20]:
        h = c.get("session_header", {})
        print(f"    service {h.get('service_id')}, session end {h.get('session_end_block_height')}, "
              f"root set: {'yes' if c.get('root') else 'no'}")


def list_proofs(net, op):
    url = f"{lcd_base(net)}/pokt-network/poktroll/proof/proof?supplier_operator_address={op}&pagination.limit=50"
    d, err = get(url)
    if err:
        die(f"list proofs failed: {err}")
    proofs = d.get("proofs", [])
    print(f"proofs by {op}: {len(proofs)}")


def balance(net, addr):
    d, err = get(f"{lcd_base(net)}/cosmos/bank/v1beta1/balances/{addr}")
    if err:
        die(f"balance failed: {err}")
    upokt = 0
    for c in d.get("balances", []):
        if c["denom"] == "upokt":
            upokt = int(c["amount"])
    print(f"balance {addr}: {upokt_to_pokt(upokt):,.6f} POKT ({upokt} upokt)")
    if upokt < 1_000_000:
        print("    WARNING: below 1 POKT; an operator needs a working balance for claim/proof fees")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", choices=["beta", "main"], default="beta")
    ap.add_argument("--service")
    ap.add_argument("--supplier")
    ap.add_argument("--app")
    ap.add_argument("--balance")
    ap.add_argument("--session", action="store_true")
    ap.add_argument("--claims", action="store_true")
    ap.add_argument("--proofs", action="store_true")
    args = ap.parse_args()

    net = args.network
    did = False
    if args.service and not (args.session):
        show_service(net, args.service); did = True
    if args.supplier and not (args.claims or args.proofs):
        show_supplier(net, args.supplier); did = True
    if args.session:
        if not (args.app and args.service):
            die("--session needs --app and --service")
        sups = get_session(net, args.app, args.service)
        if args.supplier:
            inset = any(s.get("operator_address") == args.supplier for s in sups)
            print(f"    your supplier {args.supplier} is {'IN' if inset else 'NOT IN'} this session")
        did = True
    if args.claims and args.supplier:
        list_claims(net, args.supplier); did = True
    if args.proofs and args.supplier:
        list_proofs(net, args.supplier); did = True
    if args.balance:
        balance(net, args.balance); did = True

    if not did:
        die("nothing to do; pass --service, --supplier, --session, --claims, --proofs, or --balance")


if __name__ == "__main__":
    main()
