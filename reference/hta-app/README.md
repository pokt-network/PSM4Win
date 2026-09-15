# Pocket Service Manager

A small Windows desktop app for registering services and staking applications on Pocket Network (Shannon) without typing `pocketd` commands by hand. Double-click `PocketServiceManager.hta` to open it. There is no server, no install, and nothing to keep running: the app is an HTML Application that Windows runs directly, and it drives `pocketd` inside Docker Desktop because `pocketd` has no Windows build.

Phase 1 (this version) covers the wallet, service registration, and application staking. Phase 2 adds the RelayMiner connection and deployment to the production server.

## What it does

- **Layout**: the left side holds the owner wallet card (address, balance, and the three live fees) and an accordion menu: Dashboard, Services (My services, Create, Register, Stake application), Suppliers (Supply service), Wallets, Settings. The app opens on the Dashboard.
- **Dashboard**: services owned, suppliers staked and their POKT, app wallets and their stakes, owner balance; block height, measured block time, session length and the next session boundary (when new suppliers and stakes take effect); the services directory in use (or a pointer to Settings when none is set); a Services card that shows, per owned service, who supplies it and the application stake's margin above the live minimum as POKT and as an estimated number of relays, with a red alert when an application is unbonding, at the minimum, or nearly there; the health of every supplier on a configured server (staked or not, services served, operator gas, whether the public URL answers); and recent activity with transaction links.
- **My services**: every service the owner wallet owns on the selected network, merged with the service folders on this machine, with Update, Stake, Register, Supply, and Edit card actions per row. With nothing yet, it offers Create service.
- **Beta TestNet or MainNet** with one toggle. MainNet turns the accents coral and asks you to type the service ID before anything is broadcast. A light/dark toggle sits next to it; both follow the Pocket brand (Rubik, blue, mint, gold, coral, lavender), with the fonts and logo bundled under `assets/`.
- **Owner wallet** imported once from its hex private key, stored encrypted, never shown again unless you revoke it. It owns the services and funds everything else. Balance is read live.
- **Wallets**: on Pocket an account can be staked as an application for exactly one service, so each service you want to call gets its own application wallet. The Wallets tab creates one (a new key in the same encrypted keyring; its 24-word recovery phrase is shown once, at creation, and stored nowhere), recovers one from a phrase, imports one from a hex key, funds it from the owner wallet, shows its private key on typed confirmation (for a relay client such as pocket-ap), and removes it. Balances and application stakes are read live per wallet.
- **Create service**: a form for the service ID, name, price, description, protocol, API contract names, spec and docs URLs, what a supplier runs, and the three health probes. It creates `services/<id>/` with a `card.json` built the way the Skill's card template and `card-authoring.md` prescribe, plus a `service.json`, validates the card with the Skill's `validate_card.py`, and hands the folder to the Register tab. Loading an existing folder fills the form from its card so you can edit and re-create it.
- **Register service**: fill in the ID, name, compute units per relay, and card file, or pick a folder under `services/` and let its `service.json` fill the form. Preflight checks the catalog for conflicts, validates the card, reads the live fee, checks the balance, and shows the exact command before you confirm. After the transaction lands it reads the service back from the chain to verify.
- **Stake application**: pick a service and the wallet to stake as (the app wallet made for that service is preselected; the owner wallet is allowed but can hold only one stake), fund the wallet from the parent if needed, and stake it with the live minimum and its current stake taken into account. Relays settle against the stake and the protocol unstakes an application that falls below the minimum, so the amount defaults to the minimum plus a margin and preflight refuses a stake with no margin; an unbonding application is flagged on this screen, in My services, and in Wallets, and staking it again cancels the unbonding while keeping its delegations. Below it, **Gateway delegation** lets a staked application delegate to any gateway registered on the network (the list is read live; nothing is preselected), shows its current delegations against the live maximum, and undelegates, which takes effect when the session ends. Both are signed by the application's own wallet and cost gas only.
- **Provision** (Settings, per server and network): creates one network's supplier stack on a server. A server is network-agnostic (an SSH connection and a deploy root); each network it supplies gets its own stack in its own directory (`/opt/pocket/supplier-<network>` by default) with its own RelayMiner, operator key, and public hostname, and the server runs one shared Caddy (`/opt/pocket/caddy`) that imports one site file per network. Over SSH, Provision copies the stack (`server/` templates rendered for the network, hostname, compose project, and loopback ports), creates that stack's operator key on the server (kept if it exists; it never leaves), writes the RelayMiner's key file, tops the operator up from the owner wallet if it holds less than 5 POKT, publishes its public key with a self-transfer signed on the server, starts the shared Caddy with the network's hostname, then Redis and the miner. The relayer starts with the first deployed service, since it refuses an empty service list. Every step is narrated and safe to repeat. A stack from the first layout (one per server, Caddy inside it) is migrated in place on re-provision: its compose project name is kept so containers and volumes are reused, and Caddy's certificates are carried over to the shared Caddy.
- **Deploy service** (Services): ships a service folder's `backend/` (without `node_modules`) and its deploy compose file (the folder's own, or the standard backend-only one) to `<deploy root>/<service id>/` on a server provisioned for the current network as one archive, builds and starts the backend on the shared `pocket-supplier` network, waits for its readiness probe, and adds it to the current network's relayer config with a relayer restart. One backend container serves every network's stack on that server; deploying for a second network adds it to that network's relayer. Then offers the supplier stake and the test.
- **Test service**: sends the service's own card probes (identity, readiness, functional, plus a bad-input request against the functional path) through the protocol, signed by an application wallet staked for the service, and grades each answer against the card's expectations and the JSON-object rule. Relays go through pocket-ap in a container (downloaded once from the Test screen); the signer reads the wallet key from the keyring for the call and never displays it. Each run is narrated step by step and appended to `relay-tests.log` in the state folder; View log lists previous runs, Clear log deletes them.
- **Suppliers**: one supplier per configured server per network, listed for the current network with its live status, stake, services, operator gas, and whether its URL answers; a server with no stack for this network shows a Provision button. Manage opens that supplier: the services it serves are a table of tick boxes (your own services by default; "Show all services" opens the whole catalog), each with its protocol and endpoint URL, plus the stake amount and the operator's balance with a fund box. The owner wallet receives the revenue and the returned stake; the operator is a separate key on the server. Because only the operator may set the service list, and the signer pays the stake, the stake config is copied to the server over SSH and signed there with the operator key. The list on chain is replaced on every stake, so unticking a staked service drops it. The editor also unstakes the supplier (signed by the owner wallet, after a confirmation that states the live unbonding period as sessions and time and the block the stake returns at); an unbonding supplier shows as "unstaking" with its return block everywhere until the record clears and the POKT is back in the owner wallet. Preflight checks the operator's account, key, and balance, merges the supplier's existing services so restaking never drops one, confirms the URL answers, and shows the activation session and the unbonding period as time. Running the RelayMiner itself is still done on the server by hand (see `services/<id>/deploy/`); the Deploy function is phase 2.
- **Activity**: every transaction this machine broadcast, with links to the transaction on the network.
- **Settings**: the services folder (set once; defaults to the repository's `services/`), the server list, and the welcome message. A server entry is an explicit SSH connection (host, port, user, key file on this PC) and a deploy root; its Beta TestNet and MainNet columns show whether a stack is provisioned for each network and its operator, hostname, and directory. Below the list, the Provision panel picks a server and a network and creates or refreshes that stack. Test connection checks SSH, Docker Compose, and the current network's keyring directory. MainNet is signalled by the banner and the network toggle only; buttons keep the same colours on both networks. Supply service picks a server from this list, remembers the choice, and links here when the list is empty.
- **Revoke**: shows the owner private key one final time so you can store it elsewhere, then deletes the keyring, the Docker volume, and the sealed passphrase. It refuses while application wallets are still in the keyring; export or remove those first.

Live values (fees, minimum stakes, price per compute unit, chain ID) are fetched from the network each time; none are hardcoded.

## Window and launcher

The app draws its own window: no native Windows title bar. Drag the title bar to move it, double-click it or use the middle button to maximise and restore, drag the bottom-right corner to resize, and use the buttons at the top right to minimise or close. The Pocket icon is the window and taskbar icon.

Run `install-shortcut.cmd` once to get a "Pocket Service Manager" shortcut with that icon on the Desktop and in the Start menu, which you can pin to the taskbar. Double-clicking the `.hta` still works; it just shows the generic HTA file icon in Explorer.

## First run

The first launch opens a welcome message: what the app does, what to have ready (Docker Desktop, a funded owner wallet, a server reachable over SSH, a backend with a Dockerfile), and the steps in order. It is shown once and can be reopened from Settings with **Show Welcome Message**.

1. Start Docker Desktop. The app can start it for you and waits for it.
2. Open `PocketServiceManager.hta`. If the `pocketd` image is not on this machine yet, press **Download pocketd** (about 100 MB, once).
3. Press **Import private key** and paste the 64-character hex key of the wallet that will own your services. The app reports the resulting `pokt1...` address; check it matches what you expect.
4. Pick the network, create a folder for your service under `services/`, press **Rescan**, choose it, fill in the form, and press **Run preflight**.

## How the key is protected

| Piece | Where | Protection |
|---|---|---|
| Private key | `pocketd` file keyring inside the Docker volume `pocket-service-manager-keyring` | Encrypted by `pocketd` with a passphrase |
| Keyring passphrase | `%LOCALAPPDATA%\PocketServiceManager\keyring.pass.dpapi` | 32 random bytes, generated by the app, sealed with Windows DPAPI to your Windows login. Decryptable only by your user on this PC. |
| Wallet metadata | `%LOCALAPPDATA%\PocketServiceManager\wallet.json` | Address and key name only. Nothing secret. |

Every signing operation goes through `signer.ps1`, which unseals the passphrase in memory and passes it into the `pocketd` container through the container's environment, where `printf` pipes it to `pocketd`'s prompt (feeding docker's own standard input from PowerShell proved unreliable). The passphrase and the keys never appear on a command line, in a request file, in a log, or in the `Activity` list. Secrets cross the boundary only through named operations: the owner key enters at import and leaves at revoke; an application wallet's key enters at import or recovery (hex key or phrase, through the process environment) and leaves only through an "Export key" you confirm by typing; a new wallet's recovery phrase is returned once at creation and stored nowhere. `signer.ps1` has no generic "run this command" path. Its only transfers are "fund operator" (to a supplier operator address you name) and "fund wallet" (to an application wallet it manages), both confirmed in the app before they run.

Application wallets are listed in `%LOCALAPPDATA%\PocketServiceManager\wallets.json` (name, address, service, nothing secret). The signer only signs with the parent or a wallet on that list, and refuses to import a key whose address is already in the keyring.

For Claude Code sessions in this repository, `.claude/hooks/tx_guard.py` blocks shell commands that would export the key, read the sealed passphrase, touch the keyring volume, or move funds. This is a policy boundary, not a cryptographic one: anything running as your Windows user could in principle unseal the passphrase. If you want a boundary a compromised session could not cross, move the key to the RelayMiner host in phase 2 and sign there.

Losing `keyring.pass.dpapi` (a Windows reinstall, a different user account) makes the keyring unreadable. That is not a loss of funds: import the private key again. Keep the key in your password manager.

## Files

| File | Role |
|---|---|
| `PocketServiceManager.hta` | The window. Markup only. |
| `app.js` | UI logic. ES5, because the HTA engine is Internet Explorer 11. Reads the network over HTTPS from the Sauron LCD and drives the form. Never touches the keyring. |
| `app.css` | Styling. No CSS variables or grid (IE11). |
| `signer.ps1` | The only code that runs `pocketd`, opens the keyring, or unseals the passphrase. Takes a request JSON file, prints a result JSON. |
| `server/` | What Provision ships to a supplier host: `supplier.sh` (the helper the app runs in a stack directory: prepare, operator, keys, publish, start, deploy, add-service, remove-service, status), the stack's compose, config, site, and `stack.env` templates rendered per network, hostname, project, and ports, and `caddy/` (the server's shared Caddy: a compose file and a Caddyfile that imports `sites/*.caddy`). |
| `runner.cmd` | Runs `signer.ps1` hidden in the background and leaves `.out`/`.err`/`.done` files the app polls, so the window never freezes. |
| `winshell.ps1` | Window chrome. mshta ignores the frameless attributes in IE11 document mode, so this strips the native title bar with Win32 right after launch, gives the window its app identity and the Pocket icon, and handles minimise and maximise (an HTA cannot do either itself). One hidden instance stays alive while the app runs, because Windows drops a window icon the moment the process that loaded it exits. |
| `install-shortcut.cmd` | Creates Desktop and Start menu shortcuts with the Pocket icon. |

Per-service files live in `services/<name>/`:

- `service.json` remembers the form values and, after each success, the transaction hash per network under `networks.beta` / `networks.main`.
- `card.json` is the service card the Skill produces.

## Troubleshooting

- **"Docker Desktop is not running"**: press the button in the top bar, or start it yourself. The app polls until it is up.
- **Preflight says the ID is taken**: IDs are permanent and global. Pick another, or if the existing one is yours, the same action becomes an update.
- **Card rejected**: the Skill's `validate_card.py` output is shown in the preflight list, and `pocketd` runs its own schema check before broadcasting. Fix the card and run preflight again.
- **Transaction accepted but "not seen in a block"**: the Activity tab keeps the hash. Check it on the network; block inclusion can lag under load.
- **"Leftover wallet files were found"**: an earlier import was interrupted. Importing again replaces them.

## Testing without real funds

Import a throwaway key on Beta TestNet, fund it from the faucet, and run the same flows. The app behaves identically on both networks apart from the confirmations.
