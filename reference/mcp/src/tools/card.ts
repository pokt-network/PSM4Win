// validate_card and card_diff: ports of scripts/validate_card.py and encode_card.py diff.
import { z } from "zod";
import { Validator } from "@cfworker/json-schema";
import type { McpServer } from "@modelcontextprotocol/server";
import { NETWORK_ENUM, service, cardBytes } from "../lcd";
import { FILES } from "../generated/skill";
import { json, fail, READ_ONLY } from "./util";

const RPC_ENUM = new Set(["GRPC", "WEBSOCKET", "JSON_RPC", "REST", "COMET_BFT"]);
const MAX_HARD = 256 * 1024;
const MAX_TARGET = 4 * 1024;

const SCHEMA = JSON.parse(FILES.find((f) => f.uri === "pocket://schema/service-card-v1.json")!.text);
let validator: Validator | null = null;
function schemaErrors(card: unknown): string[] {
  validator ??= new Validator(SCHEMA, "2020-12", false);
  const r = validator.validate(card);
  if (r.valid) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of r.errors) {
    const line = `${e.instanceLocation || "#"}: ${e.error}`;
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  return out.slice(0, 60);
}

function structural(card: any): string[] {
  const errs: string[] = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) return ["card must be a JSON object"];
  if (card.schema !== "pocket-service-card/v1") errs.push('schema must be exactly "pocket-service-card/v1"');
  (card.rpc_types ?? []).forEach((r: any, i: number) => {
    if (!r || typeof r !== "object") { errs.push(`rpc_types[${i}] must be an object`); return; }
    if ("required" in r) errs.push(`rpc_types[${i}] has a 'required' key: forbidden by the schema. Use 'intent'.`);
    if (!RPC_ENUM.has(r.type)) errs.push(`rpc_types[${i}].type must be one of ${[...RPC_ENUM].sort().join(", ")}`);
  });
  (card.specs ?? []).forEach((s: any, i: number) => {
    if (s && typeof s === "object" && !("url" in s)) errs.push(`specs[${i}] requires a url`);
  });
  ((card.serving ?? {}).healthcheck ?? []).forEach((h: any, i: number) => {
    if (!h || typeof h !== "object") { errs.push(`serving.healthcheck[${i}] must be an object`); return; }
    if (!RPC_ENUM.has(h.rpc_type)) errs.push(`serving.healthcheck[${i}].rpc_type must be one of ${[...RPC_ENUM].sort().join(", ")}`);
    if (!("request" in h)) errs.push(`serving.healthcheck[${i}] requires a request`);
  });
  if (typeof card.description === "string" && card.description.length > 2048) errs.push("description exceeds 2048 chars");
  return errs;
}

function conventions(card: any): string[] {
  const warns: string[] = [];
  const serving = card.serving ?? {};
  if (!("results" in card)) warns.push("no 'results' field; set 'deterministic' or 'variable' so consumers know if suppliers are interchangeable");
  if (!("updated" in card)) warns.push("no 'updated' date; every PNF card carries one (YYYY-MM-DD)");
  if ("sync" in serving) warns.push("serving.sync is set; it means nothing for a non-blockchain service and should be omitted");
  (card.specs ?? []).forEach((s: any, i: number) => {
    if (s && typeof s === "object" && !("api" in s)) warns.push(`specs[${i}] has no 'api' key; PNF convention names the apis[] entry each spec documents`);
  });
  if (!(serving.healthcheck ?? []).length) warns.push("no serving.healthcheck; suppliers cannot self-test before staking and gateways have nothing to probe");
  if (!(card.rpc_types ?? []).length) warns.push("no rpc_types; consumers and node runners both read this, and gateways will not route without it");
  const desc = String(card.description ?? "");
  if (!/json/i.test(desc)) warns.push("description does not mention that every response is a JSON object; consumers and gateway operators rely on that statement");
  return warns;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function deepDiff(a: unknown, b: unknown, path: string, out: { path: string; on_chain: unknown; local: unknown }[]) {
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) deepDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) deepDiff(a[i], b[i], `${path}[${i}]`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: path || "(root)", on_chain: a, local: b });
  }
}

export function registerCardTools(server: McpServer) {
  server.registerTool(
    "validate_card",
    {
      title: "Validate a service card",
      description:
        "Validate a pocket-service-card/v1 metadata card without pocketd: size against the chain limit and the 4 KiB target, the JSON Schema bundled from poktroll, the forbidden 'required' key under rpc_types, and the catalog's convention warnings. Pass the exact JSON text so the size is the size the chain will see. pocketd tx service validate-card remains the authoritative check.",
      inputSchema: z.object({
        card: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The card as JSON text (preferred) or as an object"),
      }),
      annotations: READ_ONLY,
    },
    async ({ card }) => {
      try {
        const text = typeof card === "string" ? card : JSON.stringify(card, null, 2);
        const size = new TextEncoder().encode(text).length;
        const out: Record<string, unknown> = {
          size_bytes: size,
          size_note: typeof card === "string" ? "size of the text as given" : "size of a pretty-printed serialization; pass the exact text for the real size",
        };
        if (size > MAX_HARD) return json({ ...out, ok: false, fatal: "over the 256 KiB chain limit; the chain will reject this" });
        if (size > MAX_TARGET) out.size_warning = "over the 4 KiB target; move large content (specs) out of the card";
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          return json({ ...out, ok: false, fatal: `not a single JSON object: ${(e as Error).message}` });
        }
        const errs = [...schemaErrors(parsed), ...structural(parsed).filter((e) => e.includes("'required' key") || e.includes("must be a JSON object"))];
        const uniq = [...new Set(errs)];
        return json({
          ...out,
          ok: uniq.length === 0,
          schema_errors: uniq,
          warnings: isObj(parsed) ? conventions(parsed) : [],
          authoritative_check: "pocketd tx service validate-card <card.json>",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "card_diff",
    {
      title: "Compare a card with what is on chain",
      description:
        "Byte-exact comparison of a local card against the card stored for a registered service, with a field-level diff when they differ. edit-service compares bytes, so reformatting alone counts as a change; identical bytes mean an update would be a no-op.",
      inputSchema: z.object({
        network: z.enum(NETWORK_ENUM),
        service_id: z.string(),
        card: z.string().describe("The local card as exact JSON text"),
      }),
      annotations: READ_ONLY,
    },
    async ({ network, service_id, card }) => {
      try {
        const svc = await service(network, service_id);
        if (!svc) return json({ ok: false, error: `service '${service_id}' is not registered on ${network}` });
        const remote = cardBytes(svc);
        if (!remote) return json({ ok: false, error: `service '${service_id}' has no card on chain` });
        const local = new TextEncoder().encode(card);
        const identical = local.length === remote.length && local.every((b, i) => b === remote[i]);
        if (identical) return json({ identical: true, bytes: local.length, note: "edit-service would skip this service (no change)" });
        const out: Record<string, unknown> = { identical: false, local_bytes: local.length, on_chain_bytes: remote.length };
        try {
          const a = JSON.parse(new TextDecoder().decode(remote));
          const b = JSON.parse(card);
          const changes: { path: string; on_chain: unknown; local: unknown }[] = [];
          deepDiff(a, b, "", changes);
          out.field_changes = changes;
          if (!changes.length) out.note = "Same content, different bytes (formatting or key order). The chain would still record an update.";
        } catch (e) {
          out.note = `could not parse one side as JSON: ${(e as Error).message}`;
        }
        return json(out);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
