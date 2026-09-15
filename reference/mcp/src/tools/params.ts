// live_params: port of scripts/live_params.py. Never hardcode any of these.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { NETWORK_ENUM, NETWORKS, params, allServices, upoktToPokt, LIVE_NOTE } from "../lcd";
import { json, fail, READ_ONLY, nowIso } from "./util";

const MAX_CUPR = 1_048_576;

export function registerParamTools(server: McpServer) {
  server.registerTool(
    "live_params",
    {
      title: "Live governance parameters and pricing",
      description:
        "Fetch the governance parameters that every registration, stake, and price depends on, live from the network: registration fee, supplier and application minimum stakes, session length, unbonding periods, the compute-unit price, and proof settings. Optionally convert a target price per relay into compute_units_per_relay and list the services priced nearest to it. Call this instead of stating any chain value from memory.",
      inputSchema: z.object({
        network: z.enum(NETWORK_ENUM).describe("beta (Beta TestNet, chain pocket-lego-testnet) or main (MainNet, chain pocket)"),
        target_upokt: z.number().positive().optional().describe("Desired cost per relay in uPOKT; returns the compute_units_per_relay that resolves to it"),
        target_pokt: z.number().positive().optional().describe("Desired cost per relay in POKT (alternative to target_upokt)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ network, target_upokt, target_pokt }) => {
      try {
        const [svc, shared, sup, app, proof, sess] = await Promise.all(
          ["service", "shared", "supplier", "application", "proof", "session"].map((m) => params(network, m)),
        );
        const mult = Number(shared.compute_units_to_tokens_multiplier);
        const gran = Number(shared.compute_unit_cost_granularity);
        const upoktPerCu = mult / gran;

        const out: Record<string, unknown> = {
          network,
          chain_id: NETWORKS[network].chainId,
          fetched_at: nowIso(),
          registration_fee_pokt: upoktToPokt(svc.add_service_fee?.amount),
          supplier_min_stake_pokt: upoktToPokt(sup.min_stake?.amount),
          supplier_staking_fee_upokt: Number(sup.staking_fee?.amount ?? 0),
          application_min_stake_pokt: upoktToPokt(app.min_stake?.amount),
          application_max_delegated_gateways: Number(app.max_delegated_gateways ?? 0),
          num_blocks_per_session: Number(shared.num_blocks_per_session),
          num_suppliers_per_session: Number(sess.num_suppliers_per_session ?? 0),
          grace_period_end_offset_blocks: Number(shared.grace_period_end_offset_blocks ?? 0),
          claim_window_open_offset_blocks: Number(shared.claim_window_open_offset_blocks ?? 0),
          supplier_unbonding_period_sessions: Number(shared.supplier_unbonding_period_sessions),
          application_unbonding_period_sessions: Number(shared.application_unbonding_period_sessions ?? 0),
          compute_units_to_tokens_multiplier: mult,
          compute_unit_cost_granularity: gran,
          upokt_per_compute_unit: upoktPerCu,
          pricing_formula: "cost per relay (uPOKT) = compute_units_per_relay x compute_units_to_tokens_multiplier / compute_unit_cost_granularity",
          proof: {
            request_probability: Number(proof.proof_request_probability),
            requirement_threshold_pokt: upoktToPokt(proof.proof_requirement_threshold?.amount),
            missing_penalty_pokt: upoktToPokt(proof.proof_missing_penalty?.amount),
          },
        };

        const target = target_upokt ?? (target_pokt !== undefined ? target_pokt * 1_000_000 : undefined);
        if (target !== undefined) {
          const cu = Math.max(1, Math.min(Math.round(target / upoktPerCu), MAX_CUPR));
          const services = await allServices(network);
          const nearest = services
            .map((s) => ({ id: s.id, name: s.name, compute_units_per_relay: Number(s.compute_units_per_relay) }))
            .sort((a, b) => Math.abs(a.compute_units_per_relay - cu) - Math.abs(b.compute_units_per_relay - cu))
            .slice(0, 12)
            .map((r) => ({ ...r, upokt_per_relay: r.compute_units_per_relay * upoktPerCu }));
          out.pricing = {
            target_upokt: target,
            compute_units_per_relay: cu,
            resolves_to_upokt: cu * upoktPerCu,
            resolves_to_pokt: (cu * upoktPerCu) / 1_000_000,
            bounds: `compute_units_per_relay is 1..${MAX_CUPR}; a change takes effect at the next session boundary`,
            nearest_priced_services: nearest,
          };
        }

        out.raw = { service: svc, shared, supplier: sup, application: app, proof, session: sess };
        out.note = LIVE_NOTE;
        return json(out);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
