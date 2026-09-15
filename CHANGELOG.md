# Changelog

One line per user-visible change. Versions are tags `v<version>`; compat strings are `electron-<version>`.

## Unreleased (0.1.0)

- Platform layer: main-process signer porting every `signer.ps1` operation, typed IPC with validated payloads, Docker and SSH drivers with timeouts and cancellation, structured redacted log.
- Pinned `pocketd` image `0.1.35` and `pocket-ap` `v0.1.2` (the HTA used `latest`).
- Same-PC importer from the Windows HTML Application: settings, wallet records, activity, relay log, and the keyring passphrase re-sealed with Windows data protection and verified against the keyring.
- Card validation runs in-process; Python is no longer needed.
- `npm run selftest:beta`: the headless phase 1 check against Beta TestNet.
- Renderer: every HTA screen rebuilt in React with the same class names and texts (Dashboard, My services, Create, Register, Stake application with gateway delegation, Supply service list and editor, Deploy, Test, Wallets, Settings with Provision), the frameless chrome, the owner wallet card, the accordion menu, the welcome dialog, and in-app dialogs in place of the HTA's native confirm and alert.
- First-run import from the HTA offered in the window, with the services folder confirmed before it runs.
- Reachability probes and file pickers run in the main process; the renderer's content security policy stays closed.
- NSIS installer, portable zip, `SHA256SUMS`, GitHub Actions build, and the Scoop bucket manifest.
