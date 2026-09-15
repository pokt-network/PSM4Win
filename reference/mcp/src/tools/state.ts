// service_status, supplier_status, session_check, claims, balance:
// port of scripts/query_state.py. Read-only.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  NETWORK_ENUM, NETWORKS, service, decodeCard, cardBytes, supplier, suppliersForService, latestHeight, session,
  claims, proofs, balanceUpokt, application, upoktToPokt, LIVE_NOTE, type ChainSupplier,
} from "../lcd";
import { json, fail, READ_ONLY, nowIso } from "./util";

const ADDR = z.string().regex(/^pokt1[0-9a-z]{38}$/, "a pokt1... bech32 address");

function supplierView(s: ChainSupplier) {
  const active = new Set(s.services.map((x) => x.service_id));
  const scheduled = (s.service_config_history ?? [])
    .filter((h) => h.service?.service_id && String(h.deactivation_height ?? "0") === "0" && !active.has(h.service.service_id))
    .map((h) => ({ service_id: h.service!.service_id, activation_height: Number(h.activation_height) }));
  const unbond = s.unstake_session_end_height;
  return {
    operator_address: s.operator_address,
    owner_address: s.owner_address,
    stake_pokt: upoktToPokt(s.stake?.amount),
    services: s.services.map((x) => ({
      service_id: x.service_id,
      endpoints: x.endpoints.map((e) => ({ url: e.url, rpc_type: e.rpc_type })),
      rev_share: x.rev_share ?? [],
    })),
    scheduled_services: scheduled,
    scheduled_note: scheduled.length ? "A stake changes the service list only at the next session boundary; until then the new services are scheduled." : undefined,
    unbonding_end_height: unbond && unbond !== "0" ? Number(unbond) : null,
  };
}

export function registerStateTools(server: McpServer) {
  server.registerTool(
    "service_status",
    {
      title: "Service status on chain",
      description:
        "Is a service registered, who owns it, what does it charge, is its card present (decoded here), and which suppliers are staked for it with their endpoints. The first question after registering, and the way to read a competitor's card.",
      inputSchema: z.object({ network: z.enum(NETWORK_ENUM), service_id: z.string() }),
      annotations: READ_ONLY,
    },
    async ({ network, service_id }) => {
      try {
        const svc = await service(network, service_id);
        if (!svc) return json({ network, service_id, registered: false, explorer: `${NETWORKS[network].explorer}/services`, fetched_at: nowIso() });
        const sups = await suppliersForService(network, service_id);
        return json({
          network,
          registered: true,
          id: svc.id,
          name: svc.name,
          owner_address: svc.owner_address,
          compute_units_per_relay: Number(svc.compute_units_per_relay),
          card_bytes: cardBytes(svc)?.length ?? 0,
          card: decodeCard(svc),
          suppliers: sups.map((s) => ({
            operator_address: s.operator_address,
            stake_pokt: upoktToPokt(s.stake?.amount),
            endpoints: s.services.find((x) => x.service_id === service_id)?.endpoints.map((e) => ({ url: e.url, rpc_type: e.rpc_type })) ?? [],
          })),
          explorer: `${NETWORKS[network].explorer}/services`,
          fetched_at: nowIso(),
          note: LIVE_NOTE,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "supplier_status",
    {
      title: "Supplier status on chain",
      description:
        "For a supplier operator address: stake, the services it is staked for with endpoints and revenue share, services scheduled to activate at the next session, unbonding state, and the operator's gas balance. Use it after stake-supplier to confirm the stake and again after the session boundary to confirm activation.",
      inputSchema: z.object({ network: z.enum(NETWORK_ENUM), operator_address: ADDR }),
      annotations: READ_ONLY,
    },
    async ({ network, operator_address }) => {
      try {
        const [s, bal, height] = await Promise.all([supplier(network, operator_address), balanceUpokt(network, operator_address), latestHeight(network)]);
        if (!s) return json({ network, operator_address, staked: false, operator_balance_pokt: upoktToPokt(bal), fetched_at: nowIso() });
        return json({ network, staked: true, ...supplierView(s), operator_balance_pokt: upoktToPokt(bal), current_height: height, fetched_at: nowIso(), note: LIVE_NOTE });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "session_check",
    {
      title: "Current session for an application and service",
      description:
        "Which suppliers serve a given application for a service right now, the session's start and end heights, and whether a particular operator is among them. Answers 'why is my supplier getting no relays' and 'when does the next session start'.",
      inputSchema: z.object({
        network: z.enum(NETWORK_ENUM),
        application_address: ADDR,
        service_id: z.string(),
        operator_address: ADDR.optional().describe("If given, reports whether this supplier is in the session"),
      }),
      annotations: READ_ONLY,
    },
    async ({ network, application_address, service_id, operator_address }) => {
      try {
        const height = await latestHeight(network);
        const sess = await session(network, application_address, service_id, height);
        const hdr = sess.header ?? {};
        const sups: string[] = (sess.suppliers ?? []).map((s: any) => s.operator_address);
        const app = await application(network, application_address);
        return json({
          network,
          current_height: height,
          session_id: hdr.session_id,
          session_start_height: Number(hdr.session_start_block_height),
          session_end_height: Number(hdr.session_end_block_height),
          blocks_until_next_session: Number(hdr.session_end_block_height) - height + 1,
          suppliers_in_session: sups,
          operator_in_session: operator_address ? sups.includes(operator_address) : undefined,
          application: app
            ? { staked: true, stake_pokt: upoktToPokt(app.stake?.amount), services: (app.service_configs ?? []).map((c: any) => c.service_id) }
            : { staked: false, note: "this address is not staked as an application; get_session may still answer for an unstaked address but relays will be rejected" },
          fetched_at: nowIso(),
          note: LIVE_NOTE,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "claims",
    {
      title: "Claims and proofs by a supplier",
      description:
        "List recent claims or proofs submitted by a supplier operator. A claim appearing after a session's claim window opens is the first on-chain evidence that relays were served and mined; a proof appears only when one is required.",
      inputSchema: z.object({
        network: z.enum(NETWORK_ENUM),
        operator_address: ADDR,
        kind: z.enum(["claims", "proofs"]).default("claims"),
      }),
      annotations: READ_ONLY,
    },
    async ({ network, operator_address, kind }) => {
      try {
        if (kind === "proofs") {
          const list = await proofs(network, operator_address);
          return json({ network, operator_address, proofs: list.length, recent: list.slice(0, 20).map((p: any) => ({ service_id: p.session_header?.service_id, session_end_height: Number(p.session_header?.session_end_block_height) })), fetched_at: nowIso() });
        }
        const list = await claims(network, operator_address);
        return json({
          network,
          operator_address,
          claims: list.length,
          recent: list.slice(0, 20).map((c: any) => ({
            service_id: c.session_header?.service_id,
            application_address: c.session_header?.application_address,
            session_end_height: Number(c.session_header?.session_end_block_height),
            root_set: !!c.root_hash || !!c.root,
            proof_status: c.proof_validation_status,
          })),
          fetched_at: nowIso(),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "balance",
    {
      title: "Account balance",
      description: "The liquid POKT balance of any account. Owners need more than the registration fee plus stakes; operators need a working gas balance for claims and proofs.",
      inputSchema: z.object({ network: z.enum(NETWORK_ENUM), address: ADDR }),
      annotations: READ_ONLY,
    },
    async ({ network, address }) => {
      try {
        const upokt = await balanceUpokt(network, address);
        return json({
          network,
          address,
          upokt,
          pokt: upoktToPokt(upokt),
          warning: upokt < 1_000_000 ? "below 1 POKT; an operator needs a working balance for claim and proof fees" : undefined,
          faucet: network === "beta" ? NETWORKS.beta.faucet : undefined,
          fetched_at: nowIso(),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
