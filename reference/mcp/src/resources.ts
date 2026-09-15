// Static resources: the Skill's references and templates, the docs pages, the
// card schema, and the app compatibility table. Regenerated from the repo by
// scripts/sync-skill.mjs on every deploy.
import type { McpServer } from "@modelcontextprotocol/server";
import { FILES, GENERATED_AT } from "./generated/skill";
import compat from "./compat.json";

const HOUR = 3_600_000;

export function registerResources(server: McpServer) {
  for (const f of FILES) {
    server.registerResource(
      f.name,
      f.uri,
      { title: f.title, description: f.description, mimeType: f.mime, cacheHint: { ttlMs: HOUR, cacheScope: "public" } },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: f.mime, text: f.text }] }),
    );
  }
  server.registerResource(
    "app-compatibility",
    "pocket://compat/app-versions.json",
    {
      title: "Pocket Service Manager compatibility",
      description: "What each version of the desktop app can do and whether it has a local MCP bridge. Read it before telling a user which steps the app performs.",
      mimeType: "application/json",
      cacheHint: { ttlMs: HOUR, cacheScope: "public" },
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...compat, resources_generated_at: GENERATED_AT }, null, 2) }] }),
  );
}

export function resourceIndex() {
  return [...FILES.map((f) => ({ uri: f.uri, title: f.title })), { uri: "pocket://compat/app-versions.json", title: "Pocket Service Manager compatibility" }];
}
