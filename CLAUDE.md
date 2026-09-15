# Pocket Service Manager (Electron)

This repository is the Electron rebuild of the Pocket Service Manager: a desktop app for registering, staking, supplying, deploying, and testing HTTP services on Pocket Network's Shannon protocol (poktroll) without typing `pocketd` commands. It replaces the Windows HTML Application (HTA) that lives, verbatim, in `reference/hta-app/`. The HTA is the behaviour oracle: until every screen has reached parity, the HTA defines what the app does, and the docs under `docs/` are the specification extracted from it.

The app performs every transaction and every signature. It is the only thing in the Pocket Service Builder toolchain that spends or signs. The remote MCP server (`reference/mcp/`) and the Claude Skill (`reference/skill/`) are read-only companions; they tell an assistant what to do, and this app does it.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Platform layer: main-process signer with the HTA's exact operation contract, typed IPC, Docker and SSH drivers, same-PC importer from the HTA, NSIS installer, CI build. Verified with a signer self-test on Beta before any screen exists. | current |
| 2 | Renderer rewrite in React + TypeScript, screen by screen in the order Wallets, Settings, Services, Suppliers, Deploy, Test, Dashboard (which holds Recent activity; there is no separate Activity screen), each checked against the HTA on the same keyring. Then the local MCP action bridge. | next |
| 3 | The encrypted export/import bundle for moving a keyring between machines. The macOS app is not part of this repository: PSM4Win is Pocket Service Manager for Windows, and the Mac build is a separate effort. | later, not started |

Windows only, in every phase of this repository. Do not add macOS conditionals, universal-binary config, or Keychain code paths; the existing `// phase 3` notes mark where a platform split would go and stay as pointers for the separate macOS effort.

## Stack

- Electron (current stable), scaffolded with `electron-vite`. Three processes: `src/main` (Node, privileged), `src/preload` (the only bridge), `src/renderer` (React, sandboxed).
- React with TypeScript in strict mode. Zustand for the global store. Plain CSS carried over from the HTA's `app.css`, converted to CSS custom properties. No CSS-in-JS, no component library: the app already has a complete visual language and it must be kept.
- `electron-builder` producing an NSIS installer and a portable zip. GitHub Actions on `windows-latest` builds both, publishes `SHA256SUMS`, and commits the Scoop manifest. Scoop is the primary distribution channel because its download path carries no Mark-of-the-Web, so unsigned builds run without SmartScreen; the bucket is `bucket/pocket-service-manager.json` in this repo. Signing hook present and disabled until credentials exist (`docs/PACKAGING.md`).
- Vitest for `src/core` and the signer's pure parsing functions. Playwright for Electron is optional later.
- No Python and no PowerShell at runtime. The HTA depended on both; the Electron app must not. The exceptions are the importer's one-time DPAPI unseal (`docs/MIGRATION.md`), which spawns Windows PowerShell once because DPAPI has no Node binding worth adding for a single call, and the updater's hand-off to the user's own Scoop (`scoop update`, which is a PowerShell script) when the app was installed with Scoop.
- `pocketd` still runs inside Docker Desktop (`ghcr.io/pokt-network/pocketd`, pin a tag; the HTA used `:latest`, which is a bug to fix), because `pocketd` has no Windows build. `pocket-ap` runs in Docker for relay tests. `ssh`, `scp`, and `tar` are the Windows 10 built-ins.

## Repository layout

| Path | What it is |
|---|---|
| `src/main/` | Privileged code. `signer/` is the port of `signer.ps1` and the only module that runs `docker`, opens the keyring, unseals the passphrase, or talks to a server. `ipc/` registers one handler per signer operation. `migration/` is the importer. `docker/` and `ssh/` are thin process drivers. `state/` owns the app's data folder. |
| `src/preload/` | `contextBridge` exposing a typed `window.psm` API: one function per operation plus a progress event subscription. Nothing else. No `require`, no generic invoke. |
| `src/renderer/` | React. `screens/` one folder per screen from `docs/SCREENS.md`; `components/` the three shared patterns (form with preflight, live table with row actions, narrated run) plus chrome; `store/`; `styles/` with the migrated `app.css`. |
| `src/core/` | Pure TypeScript with no Electron and no DOM: the LCD client, live parameters, fee and stake arithmetic, preflight rules, the card builder and validator, service-folder discovery, and the ports of the MCP tools. Used by main, renderer, and later the action bridge. Start from `reference/mcp/src/tools/` and `reference/mcp/src/lcd.ts`. |
| `resources/` | Rubik fonts, the Pocket logos and icon, and `server/` (the templates and `supplier.sh` that Provision ships to a supplier host; copied from `reference/hta-app/server/` and kept byte-identical until Provision is re-verified). |
| `docs/` | The specification. `ARCHITECTURE.md` (HTA to Electron mapping, process model, IPC design), `SIGNER-CONTRACT.md` (every operation, its fields, its command, its side effects), `SCREENS.md` (every screen, input, button, table, LCD path), `MIGRATION.md` (the importer), `PACKAGING.md` (installer, portable zip, CI, Scoop bucket, signing). |
| `bucket/` | The Scoop bucket: `pocket-service-manager.json`, rewritten by the release workflow. Users add this repo as a bucket. |
| `reference/` | Read-only material from the service-builder repository: `hta-app/` (the HTA, complete), `skill/` (the Claude Skill: card schema, templates, references, scripts), `mcp/` (the Cloudflare Worker with JavaScript ports of the Skill scripts and `compat.json`), `docs-pages/` (the three docs.pocket.network pages), `research/` (the deployment review whose section 5 lists every design constraint), `servers/example-host/` (the reference copy of a provisioned supplier host). Never edit these here; they are snapshots. |
| `fixtures/services/` | Two example service folders (`example-charts`, a charts service that was verified on Beta and MainNet; `example-builder-test`, the Beta test service) without `node_modules`. Their service IDs, hostnames, addresses, and transaction hashes are placeholders; the live values stay in the ignored handoff package. Use them as test data for folder discovery, card validation, and Deploy. They contain no keys. |
| `.claude/hooks/tx_guard.py` | PreToolUse hook: blocks Claude sessions from exporting keys, reading the sealed passphrase, touching the keyring volume, or moving funds. Keep it installed. It is a policy boundary, not a cryptographic one. |

## Rules that override everything

1. **Live-data discipline.** Fees, stake minimums, the compute-unit price multiplier, session length, unbonding periods, the gateway list, chain IDs: all governance parameters or live state, all fetched from the LCD at the moment of use. Nothing in this codebase hardcodes a chain value. The only constants are the LCD hostnames and explorer URL formats per network (`src/core/networks.ts`), and even those are settings-overridable. If you find yourself typing a number that came from the chain, stop and fetch it.
2. **The JSON envelope rule.** Every response a Pocket service returns is a JSON object. HTML or any other output rides inside a string field. Gateways (SAGE) grade a relay by its first byte, and a body that does not start with `{` or `[` is a failed relay that penalises the supplier. The Test screen grades against this rule and the Create screen's card builder assumes it. Do not soften it. Full rules: `reference/skill/references/design-rules.md`.
3. **Always the HA RelayMiner, one stack per network per server.** Suppliers run `pocket-relay-miner` (Redis + miner + relayer). A server is network-agnostic and holds one stack per network, each with its own operator key, directory, compose project, and public hostname, plus one shared Caddy. Service backends are single containers on the shared `pocket-supplier` Docker network and serve both networks' relayers. Never one stack per service, never the legacy single-process `pocketd relayminer` (deprecated; cannot claim through the public gRPC endpoints). The relayer refuses an empty service list, so it starts with the first deployed service. Backends must answer `GET /` and `HEAD /` with 2xx and must accept chunked request bodies.
4. **SAGE is the reference gateway.** PATH is deprecated. Guidance and gateway config target SAGE.
5. **The signer contract is fixed.** Named operations only, the same list as `signer.ps1` (`docs/SIGNER-CONTRACT.md`). There is no generic "run this command" channel, not in IPC, not in the signer, not in the action bridge. Secrets cross the boundary only through the named operations that exist for them (owner key at import and revoke; application wallet key at import, recovery, and typed-confirmation export; recovery phrase once at creation). The only transfers are fund-operator and fund-wallet. Passphrase and keys never appear on a command line, in a log, in a request file, in the activity list, or in a renderer devtools console.

## Security model (Electron specifics)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity` on, a strict CSP, `will-navigate` and `setWindowOpenHandler` blocked. The renderer cannot reach Node.
- Every IPC channel is `ipcMain.handle` with a validated payload (use `zod` schemas generated from the contract interfaces). Unknown channels do not exist. Handlers never take a command string or an argument array from the renderer; they build commands from typed fields.
- Child processes are spawned with argument arrays, never a shell string. Secrets go to a child only through its environment, and the child is `docker` or `ssh`, never a shell. The HTA's technique of passing the passphrase through the container environment and piping it to `pocketd`'s prompt with `printf` inside the container stays, because feeding docker's stdin from the host proved unreliable on Windows.
- The keyring passphrase is sealed with Electron `safeStorage` (DPAPI under the hood on Windows) and stored in the app's data folder. It is unsealed into memory for one operation and dropped. The keyring itself stays in the Docker volume `pocket-service-manager-keyring`, encrypted by `pocketd` with that passphrase, shared with the HTA during the transition.
- Spends and signatures are confirmed in the renderer before the call and, for MainNet, by typing the service ID or wallet name. The main process enforces the same rule independently: a spend handler requires a `confirmation` field whose value it can check (for example the exact amount and destination the renderer displayed), so a compromised renderer cannot skip the dialog.
- Logging: a structured log in the data folder with a redaction filter applied at the sink. Any string that matches a hex key, a `pokt1` secret export, or a mnemonic word count is replaced before write. Test the filter.
- The local MCP action bridge (phase 2, after parity): a loopback HTTP server with a per-install token, exposing the same named operations, and every spend or signature still confirms in the app window. It is described in `reference/mcp/src/compat.json` under `planned.electron` and must be kept consistent with it.

## UI rules (from the product owner)

- Every step is a button in the app. Never instruct the user to run a CLI command; if something cannot be done in the app yet, say that and offer the nearest in-app path.
- Lean UI: show only data relevant to creating, registering, supplying, deploying, and testing a service. No decorative metrics.
- The wallet that owns services is the "owner wallet", everywhere. Application wallets are "application wallets" or "app wallets". Operators are "operator" keys. Do not invent other names.
- List, then edit. Screens that manage a collection show the list first and open an editor from a row.
- When unsure about a product decision, ask; do not guess and build.
- Keep the look: Rubik, the Pocket palette (blue, mint, gold, coral, lavender), light and dark themes, the MainNet coral accent and banner, the custom frameless chrome. Reuse the class names from `app.css` so the screens can be compared side by side with the HTA. The palette values and their proposed custom-property names are in `docs/SCREENS.md`.
- The window draws its own chrome: no native title bar on Windows (`frame: false`), drag region on the title bar, minimise, maximise, close, and resize handled by the window itself. Double-click the bar to maximise. The Pocket icon is the window and taskbar icon.
- The Settings section of the menu also holds a "Help" screen (new; the HTA does not have it): a five-chapter guide for a first-time service owner written in a teacher's voice, with no commands and no typed-in chain values (docs/SCREENS.md 3.14). Keep it in step with the screens when they change.
- Settings gets a "Claude Integration" section (new; the HTA does not have it). It covers both clients: Claude Code in a terminal (`claude mcp add --transport http pocket https://mcp.pocketmcp.network/mcp`, or a project `.mcp.json`) and the Claude desktop app, which connects through Connectors, Add custom connector, paste the URL, no OAuth. Both instruction sets end with a check that tool permissions are set to "Always allow", because the desktop connector groups the read-only tools and its default differs. The endpoint lives in one constant in `src/core/versions.ts`. When the local action bridge ships, this section also shows the bridge's status and token rotation.

## Data and state

- App data folder: Electron `app.getPath('userData')`, which is `%APPDATA%\Pocket Service Manager` by default. Files: `settings.json`, `wallet.json`, `wallets.json`, `history.jsonl`, `relay-tests.log`, `keyring.pass.enc`, `runs/`, `work/`, `app.log`. Same names and shapes as the HTA where one exists (`docs/MIGRATION.md` has the shapes) so the two apps stay comparable.
- The HTA's folder is `%LOCALAPPDATA%\PocketServiceManager`. The importer reads it once. The Electron app never writes there.
- `services/<id>/` folders live wherever the user's Settings point (`settings.servicesRoot`). The HTA defaulted to the service-builder repository's `services/` folder; the importer records that absolute path so existing folders keep working. `service.json` and `card.json` shapes are defined by the HTA's Create screen and `reference/skill/references/card-authoring.md`. The Skill's `validate_card.py` and its JavaScript port in `reference/mcp/src/tools/card.ts` are the validators; use the port.
- Never read `keyring.pass.dpapi` or the Docker volume from a Claude session. The hook blocks it. The importer is the one sanctioned reader, and it runs inside the app, not in a session.

## Working on this repo

- **Parity before polish.** A screen is done when its checklist in `docs/SCREENS.md` passes against the HTA on the same keyring and network. Keep the HTA runnable during phase 2. Do not press Revoke in either app during the transition: it deletes the shared keyring volume for both.
- **Verify the signer on Beta first.** Phase 1 ends with a self-test that runs every read-only and wallet operation against Beta TestNet with a throwaway application wallet and confirms the addresses, balances, and history match the HTA's. No MainNet activity until phase 2 parity.
- **Pin versions.** The `pocketd` image tag, the `pocket-ap` image tag, Electron, and the protocol versions this app was verified against go in `src/core/versions.ts` and in `docs/ARCHITECTURE.md`. Update both together.
- **Update the compat file.** When the app gains or loses a capability, update `reference/mcp/src/compat.json` here and open a change in the service-builder repository's `mcp/src/compat.json` so assistants know what the installed version can do. App version strings are `electron-<semver>`.
- **Commit messages** describe the screen or operation touched, as in the HTA's history ("Service Manager: gateway delegation, application-stake margin"). Never commit anything from the app data folder, a `.pfx`, or a signing secret.
- **Do not widen scope by analogy.** WebSocket, gRPC, and streaming services change the RelayMiner choice and the client story; they are out of scope until verified against fresh protocol sources. Same for gateway operation: the app produces gateway config and never runs a gateway.

## Protocol references (versions this app's behaviour was verified against)

- `pokt-network/poktroll` main @ `fea9e14`, `pocketd` v0.1.35. Chain IDs: MainNet `pocket`, Beta TestNet `pocket-lego-testnet`. LCD: `https://sauron-api.infra.pocket.network` and `https://sauron-api.beta.infra.pocket.network`. Explorer: `https://explorer.pocket.network` and `/beta`.
- `pokt-network/sage` @ `703d8d9` (response grading, hence the JSON envelope rule).
- `pokt-network/pocket-relay-miner` main (the HA RelayMiner the Provision templates run).
- `pokt-network/pocket-ap` v0.1.2 (relay client for the Test screen; the built-in `pocketd relayminer relay` is JSON-RPC only).
- `pokt-network/pocket-network-resources` @ `a6f0408` (the PNF service cards that set the card conventions).
- Live verification history: the whole lifecycle (register, stake, provision, deploy, supply, test, unstake, delegate) was run end to end on Beta on 2026-09-14, and the charts service behind the `example-charts` fixture was registered and supplied on MainNet the same day. Chain values quoted in the reference docs are from that date and must be re-fetched, never reused.

Before trusting a structural claim against a newer poktroll tag, diff the `x/service` module, the card schema (`reference/skill/assets/service_card.schema.json` is a snapshot), and the proto package. Flag names and command shapes have changed between releases before.

## Public-copy note

The pristine handoff package lives in `pocket-service-manager-electron/`, which is gitignored and never published. The copies in this root are the same files with every live detail removed: the self-test server override in `reference/hta-app/app.js`, the server-entry paragraph in `reference/servers/example-host/README.md`, and the owner, operator, and application addresses in `fixtures/` hold documentation placeholders (`203.0.113.10`, `REPLACE-user`, `id_supplier`, and `pokt1q...` addresses that belong to nobody); the service IDs (`example-charts`, `example-builder-test`), the supplier hostnames (`services.example.org`, `services-beta.example.org`), the server name (`example-host`), and the transaction hashes (`0000...01` and up) are placeholders too. The live service IDs, hostnames, hashes, and server name must not appear in this tree. Real values are in the ignored package on the product owner's PC only. Never copy them into this tree.
