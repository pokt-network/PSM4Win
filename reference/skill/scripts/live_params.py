#!/usr/bin/env python3
"""Fetch live governance parameters and, optionally, help price a service.

Usage:
  python live_params.py [--network beta|main]
  python live_params.py --network main --pricing --target-upokt 400
  python live_params.py --network main --pricing --target-pokt 0.0004

Never hardcode these values; they are governance-set and change. This script is
the source of truth at the moment it runs.

--pricing converts a target price-per-relay into compute_units_per_relay using the
live multiplier and granularity, and lists comparable services for a sanity check.
Standard library only.
"""
import argparse
import base64
import json

from common import params, get_all_services, upokt_to_pokt, note_live_values, die


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", choices=["beta", "main"], default="beta")
    ap.add_argument("--pricing", action="store_true")
    ap.add_argument("--target-upokt", type=float, help="desired cost per relay in uPOKT")
    ap.add_argument("--target-pokt", type=float, help="desired cost per relay in POKT")
    args = ap.parse_args()

    svc = params(args.network, "service")
    shared = params(args.network, "shared")
    supplier = params(args.network, "supplier")
    app = params(args.network, "application")
    proof = params(args.network, "proof")
    session = params(args.network, "session")

    fee = svc.get("add_service_fee", {})
    mult = int(shared["compute_units_to_tokens_multiplier"])
    gran = int(shared["compute_unit_cost_granularity"])

    print(f"=== live parameters on {args.network} ===")
    print(f"service.add_service_fee            {upokt_to_pokt(fee.get('amount', 0)):>14,.2f} POKT")
    print(f"supplier.min_stake                 {upokt_to_pokt(supplier['min_stake']['amount']):>14,.2f} POKT")
    print(f"supplier.staking_fee               {supplier.get('staking_fee', {}).get('amount', '?'):>14} upokt")
    print(f"application.min_stake              {upokt_to_pokt(app['min_stake']['amount']):>14,.2f} POKT")
    print(f"application.max_delegated_gateways {app.get('max_delegated_gateways', '?'):>14}")
    print(f"shared.num_blocks_per_session      {shared['num_blocks_per_session']:>14}")
    print(f"session.num_suppliers_per_session  {session.get('num_suppliers_per_session', '?'):>14}")
    print(f"shared.supplier_unbonding_sessions {shared['supplier_unbonding_period_sessions']:>14}")
    print(f"shared.compute_units_to_tokens_mult{mult:>14,}")
    print(f"shared.compute_unit_cost_granularity{gran:>13,}")
    print(f"proof.proof_request_probability    {proof['proof_request_probability']:>14}")
    print(f"proof.proof_requirement_threshold  {upokt_to_pokt(proof['proof_requirement_threshold']['amount']):>14,.2f} POKT")

    upokt_per_cu = mult / gran
    print(f"\none compute unit costs {upokt_per_cu:.6f} uPOKT ({upokt_per_cu/1e6:.12f} POKT) on {args.network}")

    if args.pricing:
        target = None
        if args.target_upokt is not None:
            target = args.target_upokt
        elif args.target_pokt is not None:
            target = args.target_pokt * 1_000_000
        if target is not None:
            cu = round(target / upokt_per_cu)
            cu = max(1, min(cu, 1_048_576))
            print(f"\nto charge ~{target:.4f} uPOKT per relay, set compute_units_per_relay = {cu}")
            print(f"  (that resolves to {cu * upokt_per_cu:.4f} uPOKT = {cu * upokt_per_cu / 1e6:.10f} POKT per relay)")
        else:
            print("\npass --target-upokt or --target-pokt to compute compute_units_per_relay")

        print("\ncomparable services on this network (id: compute_units_per_relay):")
        rows = []
        for s in get_all_services(args.network):
            rows.append((int(s["compute_units_per_relay"]), s["id"]))
        for cu, sid in sorted(rows)[:40]:
            print(f"  {cu:>10}  {sid}")

    print("\n" + note_live_values())


if __name__ == "__main__":
    main()
