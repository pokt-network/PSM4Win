# Changelog

One line per user-visible change. Versions are tags `v<version>`; compat strings are `electron-<version>`.

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
