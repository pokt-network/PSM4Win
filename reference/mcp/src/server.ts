// pocket-mcp: a stateless remote MCP server for building and supplying
// services on Pocket Network. Read-only against the public Cosmos LCD; serves
// the Skill's references, templates, and workflow as resources and prompts.
// One Worker, no bindings. Every request builds a fresh server (MCP 2026-07-28).
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { registerParamTools } from "./tools/params";
import { registerCatalogTools } from "./tools/catalog";
import { registerCardTools } from "./tools/card";
import { registerStateTools } from "./tools/state";
import { registerResources, resourceIndex } from "./resources";
import { registerPrompts } from "./prompts";
import { GENERATED_AT } from "./generated/skill";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Pocket Service Builder: tools, references, and prompts for building, registering, and supplying HTTP services on Pocket Network (Shannon).
Two rules override everything. (1) Never state a chain value you did not just fetch: call live_params and quote the value with the network and time. (2) Every service response is a JSON object; HTML or any other output rides inside a string field (pocket://references/design-rules.md).
Start a new service with the build-service prompt, or read pocket://skill/SKILL.md for the routing table. All tools are read-only; nothing here signs or broadcasts. Transactions are performed by the Pocket Service Manager desktop app, and pocket://compat/app-versions.json says what each version of it can do.`;

const TOOL_NAMES = ["live_params", "check_service_id", "catalog_search", "validate_card", "card_diff", "service_status", "supplier_status", "session_check", "claims", "balance"];

function createServer() {
  const server = new McpServer(
    { name: "pocket-service-builder", version: VERSION },
    {
      instructions: INSTRUCTIONS,
      cacheHints: {
        "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
      },
    },
  );
  registerParamTools(server);
  registerCatalogTools(server);
  registerCardTools(server);
  registerStateTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}

const mcp = createMcpHandler(createServer, { route: "/mcp" });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return mcp(request, env, ctx);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: "pocket-service-builder",
        version: VERSION,
        endpoint: `${url.origin}/mcp`,
        transport: "MCP over HTTP, stateless (2026-07-28); also accepts 2025 Streamable HTTP clients",
        auth: "none; every tool is read-only against public chain data",
        tools: TOOL_NAMES,
        prompts: ["build-service", "write-card", "diagnose-relays"],
        resources: resourceIndex(),
        resources_generated_at: GENERATED_AT,
        docs: "https://docs.pocket.network/services/",
        source: "https://github.com/pokt-network/service-builder/tree/main/mcp",
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler;
