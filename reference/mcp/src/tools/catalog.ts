// check_service_id and catalog_search: port of scripts/check_catalog.py.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { NETWORK_ENUM, NETWORKS, allServices, decodeCard, type Network, type ChainService } from "../lcd";
import { json, fail, READ_ONLY, nowIso } from "./util";

const ID_RE = /^[A-Za-z0-9_-]{1,42}$/;

function normId(s: string) {
  return s.toLowerCase().replace(/_/g, "-");
}
function tokens(text: string | undefined | null): Set<string> {
  return new Set((text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
function cardOf(s: ChainService): Record<string, any> | null {
  const c = decodeCard(s);
  return c && typeof c === "object" ? (c as Record<string, any>) : null;
}

type Finding = { level: "FATAL" | "WARN" | "INFO"; message: string };

async function check(network: Network, proposed: string, name: string, apis: string[]) {
  const services = await allServices(network);
  const findings: Finding[] = [];
  const pNorm = normId(proposed);
  const pLower = proposed.toLowerCase();

  if (services.some((s) => s.id === proposed)) {
    findings.push({ level: "FATAL", message: `service id '${proposed}' already exists on ${network}. IDs are permanent and cannot be reused. See ${NETWORKS[network].explorer}/services` });
  }
  for (const s of services) {
    if (s.id === proposed) continue;
    if (s.id.toLowerCase() === pLower) findings.push({ level: "WARN", message: `id differs from existing '${s.id}' only by case` });
    else if (normId(s.id) === pNorm) findings.push({ level: "WARN", message: `id differs from existing '${s.id}' only by hyphen/underscore` });
  }
  if (name) {
    for (const s of services) {
      if ((s.name ?? "").trim().toLowerCase() === name.trim().toLowerCase()) findings.push({ level: "WARN", message: `name '${name}' matches existing service '${s.id}'` });
    }
  }
  const want = new Set(apis.map((a) => a.trim().toLowerCase()).filter(Boolean));
  if (want.size) {
    const claimed = new Map<string, string[]>();
    for (const s of services) {
      const card = cardOf(s);
      for (const a of (card?.apis ?? []) as string[]) {
        const k = String(a).toLowerCase();
        claimed.set(k, [...(claimed.get(k) ?? []), s.id]);
      }
    }
    for (const a of [...want].sort()) {
      const by = claimed.get(a);
      if (by) findings.push({ level: "INFO", message: `apis value '${a}' is already used by: ${by.join(", ")}. Reuse it only if you mean the same contract.` });
    }
  }
  const pDesc = tokens(name);
  if (pDesc.size) {
    for (const s of services) {
      const card = cardOf(s);
      const desc = new Set([...tokens(card?.description), ...tokens(s.name)]);
      if (!desc.size || s.id === proposed) continue;
      let overlap = 0;
      for (const t of pDesc) if (desc.has(t)) overlap++;
      if (overlap / Math.max(1, pDesc.size) >= 0.6) {
        findings.push({ level: "INFO", message: `'${s.id}' looks similar to what you described; consider supplying it instead of registering a duplicate` });
      }
    }
  }
  return { network, services_on_chain: services.length, ok: !findings.some((f) => f.level === "FATAL"), findings };
}

function summarize(s: ChainService) {
  const card = cardOf(s);
  const desc: string = card?.description ?? "";
  return {
    id: s.id,
    name: s.name,
    compute_units_per_relay: Number(s.compute_units_per_relay),
    owner_address: s.owner_address,
    has_card: !!s.metadata?.card,
    description: desc.length > 240 ? desc.slice(0, 237) + "..." : desc,
    rpc_types: ((card?.rpc_types ?? []) as any[]).map((r) => r?.type).filter(Boolean),
    apis: card?.apis ?? [],
  };
}

export function registerCatalogTools(server: McpServer) {
  server.registerTool(
    "check_service_id",
    {
      title: "Check a proposed service ID against the catalog",
      description:
        "Before registering: report exact, case-only, and hyphen/underscore-only collisions on the ID (IDs are permanent), name collisions, apis[] values already claimed by other cards, and existing services that look like the one described. Run against both networks before choosing an ID.",
      inputSchema: z.object({
        service_id: z.string().regex(ID_RE, "1-42 chars of A-Z a-z 0-9 - _").describe("The proposed service ID"),
        network: z.enum(["beta", "main", "both"]).default("both"),
        name: z.string().optional().describe("Proposed human-readable name; also used to find near-duplicates"),
        apis: z.array(z.string()).optional().describe("Proposed apis[] values for the card"),
      }),
      annotations: READ_ONLY,
    },
    async ({ service_id, network, name, apis }) => {
      try {
        const nets: Network[] = network === "both" ? ["beta", "main"] : [network];
        const results = await Promise.all(nets.map((n) => check(n, service_id, name ?? "", apis ?? [])));
        return json({ service_id, checked_at: nowIso(), ok: results.every((r) => r.ok), results });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "catalog_search",
    {
      title: "Search the service catalog",
      description:
        "Find services on a network by words in their ID, name, or card description. Use it to see what already exists, what comparable services charge, and whether a capability is already supplied. Returns the best matches with price, owner, transports, and a description excerpt.",
      inputSchema: z.object({
        network: z.enum(NETWORK_ENUM),
        query: z.string().min(1).describe("Words to match, e.g. 'chart csv' or 'llm'"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY,
    },
    async ({ network, query, limit }) => {
      try {
        const services = await allServices(network);
        const q = tokens(query);
        const scored = services
          .map((s) => {
            const card = cardOf(s);
            const hay = new Set([...tokens(s.id), ...tokens(s.name), ...tokens(card?.description)]);
            let score = 0;
            for (const t of q) if (hay.has(t)) score++;
            const qs = query.toLowerCase();
            if (s.id.toLowerCase().includes(qs) || (s.name ?? "").toLowerCase().includes(qs)) score += 2;
            return { s, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
          .slice(0, limit);
        return json({
          network,
          services_on_chain: services.length,
          matches: scored.map((x) => summarize(x.s)),
          explorer: `${NETWORKS[network].explorer}/services`,
          fetched_at: nowIso(),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
