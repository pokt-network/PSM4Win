# Changelog

One line per user-visible change. Versions are tags `v<version>`; compat strings are `electron-<version>`.

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
