# Changelog

One line per user-visible change. Versions are tags `v<version>`; compat strings are `electron-<version>`. A release people must install now opens its section with `**Priority update.** <why>`; the app shows it as a priority update (docs/PACKAGING.md).

## Unreleased

- Deploy service: a service deployed without its own compose file now runs with a 512 MB memory limit, so one runaway service can no longer take the memory the supplier's RelayMiner was sized with. A service that needs more says so in its own `deploy/docker-compose.yaml`. The shared Caddy on each server gets a 256 MB limit the next time the server is provisioned.

## 0.1.13

- Supplier servers: the RelayMiner now checks each relay before passing it to your service, instead of passing it first and holding the request and the answer in memory until the check is done. On a small server with several services that holding space could outgrow the memory the relayer is allowed, and a burst of traffic would restart it. Suppliers shows "stack update needed" once more for stacks updated with 0.1.12; Update stack applies it and keeps everything else.

## 0.1.12

**Priority update.** The RelayMiner published its first versioned release, and supplier servers set up by earlier versions of the app can no longer start it: new servers fail at once, and existing ones fail the next time the RelayMiner is downloaded again. Update the app, then press Update stack on each supplier (Suppliers screen).

- Supplier servers run a fixed RelayMiner version (v0.1.0) instead of one that could change underneath the app, with Redis 8.10 set never to throw away relays that have not been claimed yet. The memory each part may use is worked out from the server's own memory, so a server needs at least 3 GB. Before anything restarts, the new version checks both of its configuration files; if either check fails, nothing changes and the app says why.
- Suppliers and Settings mark a server whose supplier stack is older than this version of the app with "stack update needed" and an Update stack button. Updating keeps the operator key, the services and the stake.
- Priority updates: a release marked as a priority shows a banner with an Install now button and opens the update dialog once each time the app starts, until it is installed. This is the first version that can show one, so this release itself arrives as an ordinary update.
- Your server now comes first. Register asks for a provisioned server before a new service goes on chain, with a link to set one up; tick "Someone else will run the supplier" if another operator will supply it. The Dashboard, the welcome message, and Help put setting up the server right after importing the owner wallet.
- Claude is told the same: the app's status tells an assistant to set up the server in the app when none is provisioned, and never to provision a server or stake a supplier on the command line, and the app refuses to register a new service for an assistant until a server exists.
- Provision a supplier no longer has its own network choice. It provisions for the network the app is on, and the stack folder and hostname follow the network switch, so a folder meant for one network can no longer be used for the other.
- Dashboard: the red box listing application stakes below their minimum is gone. It could not be dismissed and repeated the badge in the Margin column; the line under the badge now says what happens and what to do.

## 0.1.11

- Deploy service: a service that keeps separate data for each network can say which port each network's RelayMiner calls, in `deploy/relayer.json`. Deploy connects the RelayMiner for the chosen network to that port and checks the service answers there, so Beta test traffic can never reach the MainNet copy. Services without the file keep using port 8080 on both networks. An extra address from `deploy/routes.json` can never point at one of these ports, since it would bypass the RelayMiner. A server provisioned by an earlier version needs Re-provision under Settings first; Deploy says so.
- Deploy service: deploying again now updates the RelayMiner's entry for the service when its port or its readiness check changed, instead of keeping the old one.

## 0.1.10

- Test service: each probe is also timed against how long gateways wait. An answer that takes more than 10 seconds still passes but shows in yellow, since gateways set to 10 seconds will cut it off; one that takes more than 30 seconds fails, because no gateway waits that long. The time is the supplier's own round trip, not the few seconds the test spends starting up.

## 0.1.9

- Deploy service: a service can ask for extra public addresses on the supplier's hostname in `deploy/routes.json`, for example a path its own copies use to talk to each other. Deploy installs them after connecting the RelayMiner, checks Caddy accepts them before anything changes (a refused route is taken back out, so the hostname keeps serving relays), and lists the web addresses they answer on. Everything else on the hostname still goes to the relayer. A server provisioned by an earlier version needs Re-provision under Settings first; Deploy says so.
- Deploy service: taking a service off a supplier also takes its extra addresses off the server once no network on that server serves it any more. While the other network still does, they stay, since they answer on both.
- Updates: the update notice in the header, the update dialog, and the Updates panel have a "See what changed" link that opens the list of changes for the new version. Releases now carry their notes too, so the dialog shows them.

## 0.1.8

- Test service: choosing a wallet that is not staked for the service now says so in a sentence, instead of showing the node's raw 500 with the request URL and JSON in it. Any error that genuinely is unexpected is trimmed to the status and the message. The badge and the Check again button sit on their own row so nothing runs together.

## 0.1.7

- Test service: a relay that never completes is sent once more instead of failing the probe. The first relay into a session that has only just started can come back truncated while the supplier's relayer catches up, which read as a broken service; the log says when it happens.
- Register, Stake application and the supplier editor fold the preflight checklist and plan into a green "Preflight passed" line once the action runs, so the run itself is what you see. Click it to read them again.

## 0.1.6

- Funding a wallet and returning POKT to the owner now show what is happening. Confirming used to close the dialog they were reporting into, so the app looked idle for the minute the transaction took; both now narrate into a modal that stays until you close it and ends with the block the transfer landed in.

## 0.1.5

- Wallets: "Return to owner" on an application wallet sends its POKT back to the owner wallet. Until now funds only went the other way, so a wallet whose service was finished, or whose stake had come back after unbonding, was a dead end. The owner address is resolved inside the app and is the only place the transfer can go.

## 0.1.4

- Stake application: an "Unstake this application" panel. The application wallet signs for itself and pays the gas, the dialog states the live unbonding period and what comes back, and staking again before the stake returns cancels it. It is in the app window only and not offered to an assistant over the bridge.
- A way back. Opening a screen from a row, or from a line that sends you somewhere to fix something, now shows "Back to ..." above it, naming the screen you came from. Choosing a screen from the menu clears it.

## 0.1.3

- A stake whose verification does not confirm is now written to the app log, so the reason survives the screen being closed. The renderer can log that one fixed report and nothing else.
- Stake supplier and Stake application: after the transaction, the app no longer calls a stake wrong when it cannot read the record back. It drops its cached copy, reads again if the node does not answer, and says which of the three things went wrong instead of one message that blamed the service list for all of them. A service scheduled for the next session boundary is reported as scheduled with its block, not as missing.

## 0.1.2

- Test service: the bad-input probe sends malformed JSON instead of an empty object. An empty object is a legal request to a service whose fields are all optional, so the probe was failing services that answered it correctly.
- Test service: before a test runs, the screen asks the network whether a supplier is serving the service in the session running now. A service staked minutes ago is not, so instead of four failed probes and a node error it says so, names the block the wait ends at, and turns the button on by itself when it does.

## 0.1.1

- Create and Register: a folder picker replaces the service folder dropdown, so a folder made outside the app is selectable at once instead of after a restart.
- The buttons beside a file or folder box match the height of the box again.

## 0.1.0

- Platform layer: main-process signer porting every `signer.ps1` operation, typed IPC with validated payloads, Docker and SSH drivers with timeouts and cancellation, structured redacted log.
- Pinned `pocketd` image `0.1.35` and `pocket-ap` `v0.1.2`.
- Same-PC importer from the internal prototype this app replaces: settings, wallet records, activity, relay log, and the keyring passphrase re-sealed with Windows data protection and verified against the keyring.
- Card validation runs in-process; Python is no longer needed.
- `npm run selftest:beta`: the headless phase 1 check against Beta TestNet.
- Renderer: every screen of the internal prototype rebuilt in React with the same class names and texts (Dashboard, My services, Create, Register, Stake application with gateway delegation, Supply service list and editor, Deploy, Test, Wallets, Settings with Provision), the frameless chrome, the owner wallet card, the accordion menu, the welcome dialog, and in-app dialogs in place of the HTA's native confirm and alert.
- First-run import from the prototype offered in the window, with the services folder confirmed before it runs.
- Reachability probes and file pickers run in the main process; the renderer's content security policy stays closed.
- NSIS installer, portable zip, `SHA256SUMS`, GitHub Actions build, and the Scoop bucket manifest.
- Screen-by-screen parity pass against the prototype on the same keyring: about fifty deviations fixed; the deliberate differences are listed in `docs/SCREENS.md`.
- Local MCP action bridge: the app exposes its own operations to Claude Code on this PC over a loopback endpoint with a per-install token; every spend or signature is confirmed in the app window, and no key or phrase is ever available to it.
- One-click "Add to Claude Code" for both the read-only Pocket tools and the bridge; Settings shows no JSON and no commands by default.
- Help screen under Settings: a five-chapter guide for a first-time service owner.
- Settings split into Start here, Servers, Suppliers, and Claude Integration tabs.
- In-app updater: checks the latest GitHub release on start and every six hours, shows a header link and a Start here panel, and installs the way the copy was installed (Scoop, installer with checksum verification, or a verified portable download).
- Fixtures and reference material carry example values only; no live service, host, or wallet detail is in the repository.
