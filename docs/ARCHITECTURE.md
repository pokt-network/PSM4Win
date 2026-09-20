# Architecture: from the HTA to Electron

This document maps every piece of the Windows HTML Application in `reference/hta-app/` onto the Electron app, and fixes the decisions that the rest of the port follows. `SIGNER-CONTRACT.md` and `SCREENS.md` hold the detail; this is the shape.

## 1. What the HTA is, mechanically

| HTA piece | Lines | Role | Electron equivalent |
|---|---|---|---|
| `PocketServiceManager.hta` | 646 | Markup only. Custom chrome plus one hidden panel per screen. | React component tree, `SCREENS.md` section 6 |
| `app.js` | 2,895 | All UI logic, ES5 for the IE11 engine. Reads the chain over HTTPS (`MSXML2.ServerXMLHTTP`), reads and writes files (`Scripting.FileSystemObject`, `ADODB.Stream`), launches the signer (`WScript.Shell`). Never touches the keyring. | `src/renderer` (screens) + `src/core` (protocol logic) + a handful of preload calls for files |
| `app.css` | 291 | Theme. No custom properties, no grid, because of IE11. | `src/renderer/styles/app.css`, converted to custom properties, otherwise the same rules and class names |
| `signer.ps1` | 1,057 | The only code that runs `pocketd` in Docker, opens the keyring, unseals the passphrase, or talks to a server over SSH. Takes a request JSON file, prints a result JSON. | `src/main/signer/` (TypeScript), same operation names, same command shapes |
| `runner.cmd` | 7 | Runs the signer hidden and leaves `.out`, `.err`, `.done` files that `app.js` polls every 300 ms with a 240 s default timeout. | Gone. `ipcMain.handle` awaits a spawned child; progress streams back as events. |
| `winshell.ps1` | ~250 | Win32 surgery: strips the native title bar mshta will not drop, sets the app identity and icon, implements minimise and maximise, stays resident so Windows keeps the icon. | Gone. `new BrowserWindow({ frame: false, icon })`, `-webkit-app-region: drag`, `win.minimize()` / `maximize()` over IPC. |
| `install-shortcut.*` | | Desktop and Start menu shortcuts with the icon. | Gone. The NSIS installer creates them. |
| `server/` | | Templates and `supplier.sh` shipped to a supplier host by Provision. | `resources/server/`, byte-identical, bundled as `extraResources`. |
| `assets/` | | Rubik (three weights), logos, icon. | `resources/` and `src/renderer/assets/`. |

Runtime dependencies the HTA had and the Electron app drops: Windows PowerShell (all of the signer), Python (card validation via the Skill's `validate_card.py`; the app skipped validation when the script was missing), `mshta`. Dependencies it keeps: Docker Desktop, the `pocketd` and `pocket-ap` images, and the Windows OpenSSH client (`ssh`, `scp`) plus `tar`.

## 2. Process model

```
┌──────────────────────── main (Node, privileged) ─────────────────────────┐
│ state/        app data folder, settings, wallet metadata, history, log     │
│ signer/       port of signer.ps1: one module per area, named operations    │
│   docker.ts   spawn docker; the passphrase-through-environment technique   │
│   ssh.ts      spawn ssh / scp / tar with argument arrays                   │
│   wallet.ts   import, create, recover, list, export, remove, status        │
│   tx.ts       add-service, stake-app, delegate, fund, unstake              │
│   server.ts   ssh-test, supplier-ship, supplier-run, deploy, add/remove    │
│   test.ts     relay-call via pocket-ap, validate-card via core             │
│ ipc/          one ipcMain.handle per operation; zod-validated payloads;    │
│               progress events via webContents.send('psm:progress', ...)    │
│ migration/    importFromHta(): reads %LOCALAPPDATA%\PocketServiceManager   │
│ window.ts     frameless BrowserWindow, icon, min/max/close handlers        │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ contextBridge (preload)
┌───────────────────────────────┴──────────────────────────────────────────┐
│ window.psm: { wallet: {...}, tx: {...}, server: {...}, test: {...},        │
│               files: { readServiceFolders, readText, writeText, pickDir }, │
│               window: { minimize, maximize, close },                       │
│               onProgress(runId, cb) }                                      │
└───────────────────────────────┬──────────────────────────────────────────┘
┌───────────────────────────────┴──── renderer (React, sandboxed) ─────────┐
│ core/ (shared, pure)  lcd client, live params, arithmetic, preflight,      │
│                       card builder + validator, folder discovery           │
│ store/                network, theme, owner wallet, wallets, settings,     │
│                       docker status, live params, block height/time        │
│ screens/  components/  per SCREENS.md                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

Decisions:

- **The renderer reads the chain directly** over `fetch` to the Sauron LCD, exactly as `app.js` did with `lcd(path)`. It is public, read-only data, and keeping it in the renderer keeps the main process small. The CSP `connect-src` lists the two LCD hosts and the explorer. `src/core/lcd.ts` is shared with main so the signer can do its own preflight reads (balance before a spend, service existence) without trusting the renderer.
- **The main process owns every file the app writes.** `settings.json`, `wallet.json`, `wallets.json`, `history.jsonl`, `relay-tests.log`, `app.log`, `runs/`, `work/`. The renderer asks through `window.psm.files` and gets validated objects back, never raw paths to write to. Service folders under `settings.servicesRoot` are the exception where the renderer needs to read and write user files (`service.json`, `card.json`, `deploy/`); expose `readServiceFolders()`, `readServiceFile(id, name)`, `writeServiceFile(id, name, text)` constrained to that root.
- **Long operations narrate.** The HTA narrated multi-step runs (Provision, Deploy, Test, Supply) by appending status lines as each signer call returned. In Electron each operation gets a `runId`; the handler emits `{ runId, step, level, text, sub }` progress events and resolves with the final result. The renderer's narrated-run component subscribes by `runId`. Keep the HTA's step texts; users have seen them.
- **Timeouts and cancellation.** Default 240 s as in the HTA, per-operation overrides where the HTA had them (image pulls, provision, deploy). Cancellation kills the child process tree and marks the run cancelled in the log. The HTA had no cancel; add it, it is cheap in Node.
- **One operation at a time per keyring.** The HTA serialised signer calls implicitly through the UI. Enforce it in main with a mutex around any operation that opens the keyring, so two renderer actions cannot race a `pocketd` sequence number.

## 3. The signer port

`SIGNER-CONTRACT.md` is the specification; these are the porting rules.

- Operation names, request fields, and result fields stay identical. A screen ported later must be able to call the same operation with the same payload as `app.js` did, so that parity checks are mechanical.
- Commands are built as argument arrays. Where `signer.ps1` composed a remote shell line for `ssh` (Provision, Supply on the server), the remote string is still a string, but every interpolated value is validated against a strict pattern first (service IDs, paths, hostnames, key names, amounts), and no user free text ever reaches a remote command line.
- The passphrase never touches a host command line. The HTA passed it into the container through `docker run -e` and had `printf` pipe it to `pocketd`'s prompt inside the container. Keep exactly that: `spawn('docker', ['run', '--rm', '-v', '<volume>:/home/pocket/.pocket', '-e', 'PSM_STDIN', '--entrypoint', 'sh', image, '-c', '<printf "%s" "$PSM_STDIN" | pocketd ...>'])` with `PSM_STDIN` set in the child's environment only, and the inner command unchanged (contract section 2.5 and 4.4). Do not try stdin from Node; the HTA's author found docker's stdin from Windows unreliable, and the port should not re-learn that.
- Secrets entering the signer (a hex key at import, a mnemonic at recovery) go from the renderer to main over IPC once, in memory, and from main into the child's environment. They are never written to `runs/` (the HTA wrote request files to disk and shredded them; the port has no request files). The result of an export is returned once to the renderer and not logged.
- Verification reaches the log. The renderer confirms a transaction by reading the chain, and those reads happen in the renderer, so nothing about them used to reach `app.log`: a verification that failed because the node did not answer left no trace once the screen reloaded. `app:log-verify` is the one channel the renderer may log through (`VerifyReport` in `src/core/contract.ts`, `verifyReportSchema` in `src/main/ipc/schemas.ts`). Its fields are enums, numbers, a transaction hash and service ids that match a pattern, so nothing can carry a chosen string, secret or otherwise, into the file; unknown fields are stripped like every other payload, redaction still applies at the sink, and only a verification that did not confirm is written. It is not a general logging API and must not grow one.
- Transaction results: the signer parses the `-o json` output for `txhash` and `code` (tolerating log noise before the first `{`, and reading the gas estimate from stderr), appends to `history.jsonl`, and returns `{ ok, txhash, code, raw_log, gas, error }`. It does not wait for inclusion; the HTA's `app.js` polled the LCD afterwards and read the object back from the chain to verify. Keep that split: signer returns fast, renderer (or `core`) confirms inclusion. Explorer links are built in the renderer from `core/networks.ts`.
- The self-test mode in the HTA (`selftest` in `app.js`, which drove a scripted run against Beta and wrote `selftest.txt`) becomes `npm run selftest:beta`, a Node script that calls the signer module directly, without the renderer, and prints a table. It is the phase 1 exit criterion.

## 4. Docker and SSH drivers

- Detect Docker Desktop with `docker version --format json`; start it with the path the HTA used (`Docker Desktop.exe` under Program Files) and poll, as the HTA did. Pull images with progress streamed to the run.
- Pin the `pocketd` image tag in `src/core/versions.ts`. The HTA used `ghcr.io/pokt-network/pocketd:latest`, which means a chain upgrade could silently change behaviour between two runs. Show the pinned tag in Settings and offer "Update pocketd image" as an explicit action.
- The keyring volume is `pocket-service-manager-keyring`, mounted at the container's home. Keep the name so the volume is shared with the HTA during the transition.
- SSH uses the server entry from settings (`host`, `port`, `user`, `keyPath`) with `-o BatchMode=yes -o StrictHostKeyChecking=accept-new` as the HTA did. `scp` for single files, `tar | ssh tar` for the backend archive. Operator keys are created and used on the server and never fetched.

## 5. Window and chrome

- `BrowserWindow({ width: 1320, height: 900, minWidth: 1000, minHeight: 700, frame: false, backgroundColor: <theme background>, icon: resources/pocket.ico, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } })`. Centre on first launch; remember bounds in `settings.json` under `window`.
- The title bar is the HTA's own markup with `-webkit-app-region: drag`; buttons and inputs inside it get `no-drag`. Double-click toggles maximise. Resize is native (Electron handles frameless resize borders on Windows).
- `// phase 3`: on macOS this becomes `titleBarStyle: 'hidden'` with `trafficLightPosition` and the custom minimise and close buttons hidden.
- The MainNet banner and coral accent are theme state, not chrome state; they live in the store and apply a class on the root element as `app.js` did with `applyNetworkUi()`.

## 6. Data folder

`app.getPath('userData')` = `%APPDATA%\Pocket Service Manager`.

| File | Shape | Notes |
|---|---|---|
| `settings.json` | `MIGRATION.md` section 2 | Same keys as the HTA plus `window` and `schemaVersion`. |
| `wallet.json` | owner wallet name and address (exact fields in `SIGNER-CONTRACT.md`, owner import) | Owner wallet metadata. Nothing secret. |
| `wallets.json` | a JSON array of `{ name, address, service_id, created_at, source }` | Application wallets. Nothing secret. `source` is `create`, `recover`, or `import`. |
| `history.jsonl` | one JSON object per line: `{ network, op, service_id, txhash, code, extra }` plus the timestamp `Add-History` adds (see contract) | Activity screen. Append-only. |
| `relay-tests.log` | text, one run per block | Test screen's View log. |
| `keyring.pass.enc` | bytes from `safeStorage.encryptString` | The keyring passphrase. Never read outside `signer/docker.ts`. |
| `app.log` | JSON lines, redacted at the sink | New. |
| `runs/`, `work/` | scratch | Cleared on start. |

Read JSON files with a BOM-tolerant parser: the HTA's PowerShell wrote UTF-8 with a byte-order mark, and the importer copies those files as they are.

## 7. Local MCP action bridge

The bridge is the second half of phase 2: the app exposes its own operations to an assistant on the same PC, so that an assistant can drive it instead of narrating buttons. `reference/mcp/src/compat.json` records it under `electron-0.1.0` (`local_mcp_bridge`), and the remote read-only MCP server stays what it was.

**Transport.** MCP over Streamable HTTP, JSON responses only (every tool call resolves to one result; no SSE stream and no session id). The server is `node:http` in the main process (`src/main/bridge/server.ts`), bound to `127.0.0.1` on `settings.bridgePort` (default `BRIDGE_DEFAULT_PORT` in `src/core/versions.ts`), one path `/mcp`, POST only. Requests need `Authorization: Bearer <token>`; a request with an `Origin` header that is not this machine is refused (DNS rebinding). Request timeouts are disabled because a deploy can run for minutes.

**Token.** 32 random bytes as hex, stored in `bridge.token` in the app data folder, created on first start and rotated from Settings. It is compared in constant time. Settings shows it masked. "Add to Claude Code" (`src/main/bridge/claudeConfig.ts`) writes the one entry Claude Code needs, `mcpServers.psm` with the endpoint and the bearer header, into Claude Code's user-level settings file (`~/.claude.json`): the file is read whole, only that key changes, and it is written back atomically; a file that does not parse is never touched. A token rotation or port change refreshes the entry when it is installed. The same entry serves the Claude desktop app's Code tab and a terminal; the chat side's custom connectors need a public https URL and cannot use the bridge.

**Off by default.** `settings.bridgeEnabled` starts false; the Settings "Claude Integration" panel turns it on and off, changes the port, and rotates the token. Status and a per-call activity event reach the renderer over `psm:bridge-status` and `psm:bridge-activity` so the screens refresh after an assistant acts.

**Tools.** The table lives in `src/core/bridge.ts` (pure, unit-tested) as `psm_*` tools, one per named operation plus `psm_status` (network, owner address, Docker, services folder, servers and their stacks). The operations that carry a key or a phrase in either direction are not on the bridge at all: `wallet-import`, `wallet-import-app`, `wallet-create`, `wallet-recover`, `wallet-export`, `wallet-delete` (`BRIDGE_EXCLUDED_OPS`, asserted by a test). Server-scoped tools take `server` (a Settings entry name); main resolves host, port, user, and key path from Settings and defaults the stack directory, deploy root, owner address, and operator address, so no SSH key path or address needs to travel over the bridge. Arguments are validated with the same zod request schemas as IPC before the signer runs.

**Confirmation.** `needsConfirmation(tool, args)` decides: every `tx-*` and `remote-stake-supplier` call unless `dry: true`; `wallet-remove` always; `supplier-run` only for the `publish` step, which signs a self-transfer on the server. The main process builds a plain-language summary and a facts table, sends `psm:bridge-confirm` to the window (restoring and focusing it), and waits up to five minutes for `bridge:confirm-reply` carrying the request nonce; anything else is a decline and nothing is signed. On MainNet, and for the destructive wallet removal, the dialog requires the same typed token as the screen would (service ID, wallet name, server name, `SEND`, `UNSTAKE`). A compromised renderer cannot approve on its own: the gate is main's, keyed by a nonce it generated.

**What an assistant sees.** Results are the signer's result objects, verbatim, as both text and `structuredContent`; a failed operation is a tool result with `isError`, not a protocol error. `initialize` returns instructions that state the rules above, and every tool description says whether it confirms.

## 8. Updater

`src/main/update/index.ts` asks the repository's latest-release endpoint (`RELEASES_API` in `src/core/update.ts`) 20 s after start, every six hours, and when Settings, Start here, "Check for updates" is pressed. The tag is compared with `app.getVersion()` numerically (`compareVersions`); a newer release puts a link in the header, left of the Docker status, and an "Install" button on the Updates panel. "Install" depends on how the copy was installed (`detectInstallKind`): a Scoop copy (`...\scoop\apps\...`) opens a console running `scoop update pocket-service-manager` and quits so the files can be replaced (this is the second and last place the app relies on the user's PowerShell, through Scoop's own shim); an installer copy (an uninstaller beside the executable) downloads `PocketServiceManager-Setup-<version>.exe`, verifies its SHA-256 against the release's `SHA256SUMS`, starts it, and quits; a portable copy downloads the zip to Downloads, verifies it, and shows it; a development build reports only. Downloads are accepted only from `https://github.com/pokt-network/PSM4Win/releases/download/`, and a file whose hash does not match is deleted. The release workflow must therefore keep publishing the installer, the zip, and `SHA256SUMS` under those exact names (docs/PACKAGING.md).

## 9. Versions

Keep in `src/core/versions.ts` and update here in the same commit:

| Item | Value at handoff | Pinned in `src/core/versions.ts` (2026-09-15) |
|---|---|---|
| pocketd image | `ghcr.io/pokt-network/pocketd` (HTA: `:latest`; pin to the tag matching v0.1.35 at first build) | `ghcr.io/pokt-network/pocketd:0.1.35` (the `v`-prefixed tag does not exist on ghcr) |
| pocket-ap | v0.1.2; image `ghcr.io/pokt-network/pocket-ap:latest` pulled by the `pocketap-pull` operation (pin a tag as well) | `ghcr.io/pokt-network/pocket-ap:v0.1.2` |
| poktroll | main @ `fea9e14`, pocketd v0.1.35 |
| Chain IDs | main `pocket`, beta `pocket-lego-testnet` |
| LCD | `https://sauron-api.infra.pocket.network`, `https://sauron-api.beta.infra.pocket.network` |
| Explorer | `https://explorer.pocket.network`, `https://explorer.pocket.network/beta` |
| HTA version string | `hta-2026-09-14` (in `reference/mcp/src/compat.json`) |
| Electron version string | `APP_VERSION_PREFIX` + `package.json` version, so `electron-0.1.2` at this tag. `reference/mcp/src/compat.json` keys an entry by the version that introduced a capability set and points later versions at it with `capabilities_as`, so every released version resolves. |
| Bridge default port | `41777` (`BRIDGE_DEFAULT_PORT`) |
