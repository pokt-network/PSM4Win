// Prompts: the Skill's workflow as entry points a client can offer.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

function user(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "build-service",
    {
      title: "Build and supply a service on Pocket",
      description: "The end-to-end workflow: frame the service, check the catalog, fetch live parameters, design the backend, write and validate the card, register, deploy, stake, test.",
      argsSchema: z.object({
        service_id: z.string().optional().describe("Proposed service ID, if chosen"),
        network: z.string().optional().describe("beta or main; default beta"),
      }),
    },
    async ({ service_id, network }) => {
      const net = network === "main" ? "main" : "beta";
      const id = service_id ? `'${service_id}'` : "the proposed ID";
      return user(`I want to build, register, and supply an HTTP service on Pocket Network (${net === "beta" ? "Beta TestNet first" : "MainNet"}). Walk me through it in this order, using the pocket-service-builder tools and resources, and stop for my input where a decision is mine.

1. Read pocket://skill/SKILL.md for the workflow and the two rules that override everything: never state a chain value you did not just fetch, and every response is a JSON object.
2. Frame the service with me in one paragraph: capability, request shape, response shape, whether output is identical across suppliers, expected cost of a typical request. That paragraph becomes the card's description.
3. Run check_service_id for ${id} on both networks (with the name and apis values). The ID is permanent; resolve every finding before going on.
4. Run live_params for ${net}, with the target price I give you, and tell me the registration fee, the stakes I will need, and the compute_units_per_relay that matches my price, quoting the network and time.
5. Design the backend against pocket://references/design-rules.md. If I have code, tell me what to check; if not, offer one of the skeletons in the Skill's templates.
6. Write the card from pocket://templates/card.json following pocket://references/card-authoring.md, then run validate_card on the exact text until it is clean.
7. For the transactions (register, provision a server, deploy, stake supplier, stake application, test) read pocket://compat/app-versions.json and tell me which buttons in Pocket Service Manager perform each step. Do not give me pocketd commands unless I ask for them.
8. After each transaction, confirm it with service_status, supplier_status, or session_check, and explain the session boundary timing before I wonder why nothing is happening.
9. MainNet only after Beta has served real relays, with parameters re-fetched for main.`);
    },
  );

  server.registerPrompt(
    "write-card",
    {
      title: "Write a service card",
      description: "Author a pocket-service-card/v1 metadata card for a service, validated against the bundled schema and the catalog conventions.",
      argsSchema: z.object({
        service_id: z.string().describe("The service ID the card is for"),
        summary: z.string().optional().describe("One paragraph on what the service does and its request and response shapes"),
      }),
    },
    async ({ service_id, summary }) =>
      user(`Write the metadata card for the Pocket service '${service_id}'.${summary ? ` Here is what it does: ${summary}` : " Ask me what it does, the request and response shapes, and whether output is identical across suppliers before you start."}

Use pocket://templates/card.json as the starting point and follow pocket://references/card-authoring.md exactly. Every response of the service is a JSON object; say so in the description and in rpc_types[].notes. Give it three health probes: an identity probe that pins the backend to this service ID, a readiness probe, and a cheap functional probe with a deterministic expected value. Never put a 'required' key under rpc_types; use 'intent'. Keep the card under 4 KiB by pointing at specs by URL instead of inlining them. When done, run validate_card on the exact JSON text and fix everything it reports, then run check_service_id for '${service_id}' with the card's apis values so we know the ID and contract names are free.`),
  );

  server.registerPrompt(
    "diagnose-relays",
    {
      title: "Diagnose a supplier that is not earning",
      description: "Work through the on-chain evidence for a supplier: stake, activation, session membership, claims, proofs, operator gas, and the gateway grading rules.",
      argsSchema: z.object({
        network: z.string().describe("beta or main"),
        service_id: z.string(),
        operator_address: z.string().optional().describe("The supplier operator address"),
        application_address: z.string().optional().describe("An application staked for the service, used to read the current session"),
      }),
    },
    async ({ network, service_id, operator_address, application_address }) =>
      user(`My supplier for '${service_id}' on ${network} is not serving or not earning. Diagnose it from on-chain evidence before suggesting changes, in this order, and read pocket://references/troubleshooting.md for the known causes.

1. service_status for '${service_id}': registered, card present, and is ${operator_address ? `operator ${operator_address}` : "my operator"} listed among its suppliers with the right endpoint URL and rpc_type?
2. supplier_status${operator_address ? ` for ${operator_address}` : ""}: staked above the live minimum (fetch it with live_params), services active versus scheduled, not unbonding, and operator gas above a working balance.
3. session_check${application_address ? ` with application ${application_address}` : " with an application staked for the service (ask me for one)"}: is the operator in the current session, and how many blocks until the next one? A new stake activates only at a session boundary.
4. claims for the operator: are claims landing after sessions end? If relays are served but no claims appear, the RelayMiner cannot reach the chain to claim; if claims appear but the balance does not grow, look at proofs and the proof settings from live_params.
5. If everything on chain is right, the remaining causes are at the backend: responses that do not start with '{' or '[', gzip encoding, 5xx on bad input, missing Content-Length handling, or GET / not answering 2xx to the RelayMiner's ping. Point me at pocket://references/design-rules.md and the lint_backend script.
Report what you found at each step with the fetched values and the time, then the single most likely cause.`),
  );
}
