# Pocket Service Manager: signer contract

Specification of the `signer.ps1` operation surface as it exists in the Windows HTML Application, written so the Electron port (React + TypeScript renderer, TypeScript main process) can reproduce it operation for operation. Everything below was read from the source; nothing was executed.

Sources (all under `tools/service-manager/` in the `service-builder` repository):

| File | Lines | Role |
|---|---|---|
| `signer.ps1` | 1,057 | The only code that runs `pocketd` in Docker, opens the keyring, unseals the DPAPI passphrase, and talks to servers over `ssh`/`scp`. Takes a request JSON file, prints one result JSON object. Dispatches on `$req.op`. |
| `app.js` | 2,895 (ES5) | The UI. Calls the signer only through `run(op, payload, cb, opts)`. There is no synchronous variant; every call site is listed in this document. |
| `runner.cmd` | 7 | Launches the signer hidden in the background and leaves `.out` / `.err` / `.done` files the UI polls. |
| `server/supplier.sh` | 194 | The helper the signer runs on a supplier host over SSH. Read so the `supplier-run` steps could be described accurately. |
| `README.md` | sections "How the key is protected" and "Files" | The security model as documented. |

Conventions in this document: request fields are quoted exactly as `signer.ps1` reads them (`$req.<field>`) and as `app.js` sends them; a mismatch between the two is called out where it exists. Command shapes show secrets as `<placeholders>`; no real key, passphrase, or address from a private file appears here.

---

## 1. Preamble

### 1.1 The signer's role

`signer.ps1` is the single trust boundary of the application. The UI never touches `pocketd`, the keyring, the sealed passphrase, or a server. It writes a request file naming an operation and reads back one JSON object. Every key lives in one `pocketd` **file** keyring on a Docker named volume: the owner wallet (key name `service-manager`, imported once; it owns services and funds everything else) plus any number of application wallets created or imported here (one per service, because an account stakes as an application for exactly one service).

### 1.2 Security rules the port must preserve

These are stated in the header comment of `signer.ps1` and in `README.md`; each is enforced in code as noted.

1. **Named operations only.** The main `switch ($op)` lists every operation; the `default` branch returns `Unknown operation '<op>'.` There is no generic "run this pocketd command" path, and the port must not add one.
2. **The passphrase and keys never appear on a command line, in a request file, in a log, or in a result** (except the two explicit export paths). Secrets enter and leave only through:
   - `wallet-import` and `wallet-import-app`: the hex private key arrives in the environment variable `PSM_IMPORT_KEY` (never in the request JSON).
   - `wallet-recover`: the recovery phrase arrives in `PSM_IMPORT_MNEMONIC`.
   - `wallet-create`: returns the new wallet's recovery phrase once in the result (`mnemonic`) and stores it nowhere.
   - `wallet-export`: returns a hex private key (`hex`) on explicit request; the UI requires a typed confirmation first (`EXPORT` for an application wallet, `REVOKE` for the owner wallet in the revoke flow).
   - `relay-call`: exports an application wallet's key in memory and hands it to the `pocket-ap` container only through its environment (`POCKET_APP_PRIVATE_KEY`); it is never written or returned.
3. **The only transfers of funds are `tx-fund-operator`** (owner wallet to a supplier operator address the user names; refuses the owner's own address) **and `tx-fund-wallet`** (owner wallet to an application wallet that is listed in `wallets.json`). No other operation calls `tx bank send`.
4. **A key whose address is already in the keyring is refused on import.** `wallet-import-app` derives the address in a throwaway keyring first (`Probe-HexAddress`) and checks it against `wallet.json` and `wallets.json` (`Wallet-Holding`) before touching the real keyring, because `pocketd` accepts such a duplicate and the two names then share one address file, which breaks removal.
5. **Only the owner wallet or a wallet in `wallets.json` ever signs.** `Resolve-Signer` maps `from` to `service-manager` when empty or equal to the owner's name (and requires `wallet.json` to exist), otherwise requires `Find-Wallet` to succeed. Arbitrary key names are rejected with `'<name>' is not a wallet this app manages.`
6. **The signer only signs with the local keyring for application-side and owner-side transactions.** The supplier stake (`remote-stake-supplier`) is signed on the server by the operator key, which never leaves the server; the local keyring is not touched in that operation.

### 1.3 Transport as it exists today (to be replaced by IPC + `child_process`)

`app.js` `run(op, payload, cb, opts)` (lines 111 to 144):

1. Sets `payload.op = op` and generates an id: `Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)`.
2. Writes `<stateDir>\runs\<id>.req.json` (UTF-8 without BOM) containing the JSON payload.
3. If `opts.env` is given (only `PSM_IMPORT_KEY` and `PSM_IMPORT_MNEMONIC` are ever passed), sets those variables on the HTA's own process environment (`WScript.Shell.Environment("PROCESS")`), launches the runner, then removes them.
4. Launches, hidden and non-blocking (`sh.Run(cmdline, 0, false)`):
   `"<appDir>\runner.cmd" "<stateDir>\runs" <id> "<appDir>\signer.ps1"`
5. `runner.cmd` executes
   `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<signer.ps1>" -Request "<runsDir>\<id>.req.json" > "<runsDir>\<id>.out" 2> "<runsDir>\<id>.err"`
   and then `echo %ERRORLEVEL%> "<runsDir>\<id>.done"`.
6. `app.js` polls for the `.done` file every 300 ms with a self-rescheduling `setTimeout` (never `setInterval`, because the IE engine mishandles `clearInterval` from inside the callback). Default timeout `opts.timeoutMs || 240000`; on timeout the callback gets `{ ok: false, error: "Timed out waiting for the signer (<N>s)." }` and the run files are left behind (a late result is orphaned, never delivered).
7. When `.done` exists it reads `.out` and `.err`, parses `.out` as JSON, and on parse failure substitutes `{ ok: false, error: "The signer did not return a result.", detail: trim(err || out).substring(0, 3000) }`. It then deletes `.req.json`, `.out`, `.err`, `.done`; with `opts.shred` it first overwrites each file with spaces of the same length (used for every operation that carried or returned a secret: `wallet-import`, `wallet-import-app`, `wallet-recover`, `wallet-create`, `wallet-export`).
8. The `.done` exit code is never read by `app.js`. `signer.ps1` always exits 0 (`Emit` calls `exit 0` after writing the JSON), so the only way `.out` is not a JSON object is a PowerShell startup failure or an unhandled error outside the outer `try` (the `try` wraps the whole switch and turns any exception into `{ ok: false, error: "The signer hit an unexpected error.", detail: <exception message> }`).

The signer writes its result with `[Console]::Out.Write(($obj | ConvertTo-Json -Depth 10 -Compress))` and sets `[Console]::OutputEncoding` to UTF-8 without BOM.

In the port this becomes: renderer `ipcRenderer.invoke('signer:<op>', request)` -> main-process handler that runs the same docker/ssh/scp commands with `child_process.spawn` (argument arrays, no shell), secrets passed via the child's `env` only, and returns the same result object. See section 5.

---

## 2. Common request fields, constants, and the result envelope

### 2.1 What every request carries

Only one field is universal: `op` (string). There is no shared "context" block; the signer derives everything else from constants or from operation-specific fields. The fields that recur:

| Field | Type | Read by | Meaning |
|---|---|---|---|
| `op` | string | main switch | Operation name. |
| `network` | `"beta"` or `"main"` | every `tx-*`, `relay-call`, `remote-stake-supplier`, `supplier-ship`, `supplier-run` step `publish` | Validated by `Require-Network` against `$Networks = @('beta', 'main')`; any other value fails with `Unknown network '<n>'. Use beta or main.` Passed to `pocketd` as `--network <net>` (pocketd's built-in network presets supply chain id and node URLs; the signer never sends chain ids, RPC, LCD, or gRPC URLs to `pocketd`). |
| `dry` | boolean (truthy) | every `tx-*` and `remote-stake-supplier` | When truthy, the operation returns the command it would run without signing or broadcasting. `app.js` sends `dry: true` from every preflight and omits it when executing. |
| `host`, `port`, `user`, `key_path` | string, int, string, string | every SSH operation via `Resolve-Ssh` | An explicit server connection. `port` defaults to 22 when empty; `key_path` may start with `~` (expanded to `%USERPROFILE%`). Validation: `host` `^[A-Za-z0-9.-]+$`, `user` `^[A-Za-z0-9._-]+$`, port 1 to 65535, key file must exist. |
| `path` | string | SSH operations that act in a stack directory | Absolute Linux path, `^/[A-Za-z0-9._/-]+$`. |
| `service_id` | string | many | Validated by `Validate-ServiceId`: `^[A-Za-z0-9_-]{1,42}$`. |
| `name` | string | wallet operations | Application wallet name, `Validate-WalletName`: `^[a-z0-9][a-z0-9_-]{0,39}$` and not equal to `service-manager`. (In `tx-add-service`, `name` is instead the service display name, `^[A-Za-z0-9 _-]{1,169}$`.) |
| `from` | string | `tx-stake-app`, `tx-delegate-gateway`, `tx-undelegate-gateway` | Signing key name, resolved by `Resolve-Signer` (see rule 5). |

Things the code reads from the environment rather than the request: `PSM_IMPORT_KEY` (`wallet-import`, `wallet-import-app`), `PSM_IMPORT_MNEMONIC` (`wallet-recover`), `LOCALAPPDATA` (state directory), `USERPROFILE` (for `~` in key paths), `SystemRoot` (to find `System32\tar.exe`).

### 2.2 Constants in `signer.ps1`

| Name | Value | Use |
|---|---|---|
| `$Image` | `ghcr.io/pokt-network/pocketd:latest` | The pocketd image, local and (hardcoded again in `supplier.sh` as `IMG`) remote. |
| `$ApImage` | `ghcr.io/pokt-network/pocket-ap:latest` | Relay client for `relay-call`. |
| `$Volume` | `pocket-service-manager-keyring` | Docker named volume that holds the keyring. |
| `$KeyName` | `service-manager` | The owner wallet's key name. `app.js` mirrors it as `PARENT`. |
| `$HomeInBox` | `/home/pocket/.pocket` | Where the volume is mounted inside the container (pocketd's home). |
| `$StateDir` | `%LOCALAPPDATA%\PocketServiceManager` | Every state file lives here. |
| `$PassFile` | `<StateDir>\keyring.pass.dpapi` | Sealed keyring passphrase. |
| `$WalletFile` | `<StateDir>\wallet.json` | Owner wallet metadata. |
| `$WalletsFile` | `<StateDir>\wallets.json` | Application wallet list. |
| `$WorkRoot` | `<StateDir>\work` | Per-call scratch directories (12-hex-char names), mounted read-only into containers. |
| `$HistoryFile` | `<StateDir>\history.jsonl` | One JSON object per line. |
| `$GasArgs` | `--gas auto --gas-prices 1upokt --gas-adjustment 1.5` | Appended to every local transaction; the same three flags are written literally into the remote stake command and into `supplier.sh publish`. |
| `$Networks` | `beta`, `main` | Allowed `network` values. |
| `$DockerDesktop` | `C:\Program Files\Docker\Docker\Docker Desktop.exe` | Used by `docker-start`. |

`app.js` constants the port also needs: `NET.beta.lcd = https://sauron-api.beta.infra.pocket.network`, `NET.main.lcd = https://sauron-api.infra.pocket.network`, explorers `https://explorer.pocket.network/beta` and `https://explorer.pocket.network`, `CADDY_DIR = /opt/pocket/caddy`, `POKT = 1000000` (upokt per POKT).

### 2.3 Result envelope

Every result is one JSON object. `ok` is always present.

| Field | Type | When |
|---|---|---|
| `ok` | boolean | Always. |
| `error` | string | Present when `ok` is false (from `Fail`), and on transaction results where the node rejected the tx (`code != 0`), and in one `wallet-status` variant that is otherwise `ok: true`. |
| `detail` | string | Longer explanation next to `error`; `Fail` sets it to `''` when there is none. |
| `txhash`, `code`, `raw_log`, `gas` | string, int, string, string | Every transaction result that reached the node (see `Emit-Tx`, section 3.3). |
| `dry`, `command` | boolean, string | Dry-run results; `command` is the display form of the pocketd or ssh command line. |

`Fail(msg, detail)` emits `{ ok: false, error: msg, detail: detail }` and exits. Because `Emit` exits the process, code after an `Emit` never runs; several branches rely on this (for example `wallet-status` emits from inside `if` blocks).

### 2.4 Files under the state directory

| File or directory | Written by | Format |
|---|---|---|
| `keyring.pass.dpapi` | signer (`Seal-Passphrase`) | One line of hex (DPAPI blob), ASCII, trailing newline. See section 4. |
| `wallet.json` | signer (`wallet-import`) | `{ "name": "service-manager", "address": "<pokt1...>", "imported_at": "<ISO 8601 UTC>", "volume": "pocket-service-manager-keyring" }`. Written with `Set-Content -Encoding utf8` (Windows PowerShell 5.1 emits a UTF-8 BOM). |
| `wallets.json` | signer (`Save-Wallets`) | `{ "wallets": [ { "name", "address", "service_id", "created_at", "source" } ] }`, `source` is `create`, `recover`, or `import`. UTF-8 with BOM (same reason). |
| `history.jsonl` | signer (`Add-History`) | One compact JSON object per line, appended with `Add-Content -Encoding utf8` (BOM at file start). Fields vary: `time` (always, `(Get-Date).ToUniversalTime().ToString('o')`), `op`, `network`, `service_id`, `txhash`, `code`, `extra`, `address`. |
| `work/<12 hex>/` | signer (`New-WorkDir`) | Scratch for card copies, stake YAML, pocket-ap config, deploy staging; removed after use on the success paths. |
| `runs/` | `app.js` | The request/result files of the transport (section 1.3). |
| `settings.json` | `app.js` only | UI settings: `network`, `theme`, `servicesRoot`, `lastService`, `welcomeSeen`, `supplierServer`, `servers[]` (each `{ name, host, port, user, keyPath, deployRoot, suppliers: { beta?: {...}, main?: {...} } }` with each stack `{ dir, project, url, operator, provisioned_at }`). The signer never reads it. |
| `relay-tests.log` | `app.js` only | JSON lines: `{ time, network, service, wallet, passed, total, ms, steps: [{ label, ok, ms, http, note }] }`. The signer never reads it. |
| `selftest.txt`, `selftest.flag`, `selftest-services/` | `app.js` only | Self-test mode (section 6.13). |

The port must strip a leading BOM (`\uFEFF`) before `JSON.parse` on `wallet.json`, `wallets.json`, and the first line of `history.jsonl`, and should keep writing them in a form the HTA can still read if both apps coexist (the HTA's `Get-Content | ConvertFrom-Json` tolerates a missing BOM, so writing without a BOM is safe).

### 2.5 The Docker invocation

`Invoke-InBox($shcmd, $stdinText, $mounts, $envExtra, -Root)` builds:

```
docker run --rm -v pocket-service-manager-keyring:/home/pocket/.pocket [--user root] [-v <mount>]... [-e <NAME>]... --entrypoint sh ghcr.io/pokt-network/pocketd:latest -c '<shcmd>'
```

- Environment values are **never on the command line**: each `-e NAME` has no `=value`, so the docker CLI copies the value from its own process environment, which `Invoke-Native` sets through `ProcessStartInfo.EnvironmentVariables` for that one child.
- When `$stdinText` is given it is placed in `PSM_STDIN` and the shell command becomes `printf "%s" "$PSM_STDIN" | <shcmd>`, so the container pipes the passphrase (and any prefix lines) into `pocketd`'s prompts itself. This exists because feeding docker's own stdin from PowerShell delivered mangled lines.
- No `--network`, no `--workdir`, no `-i`/`-t` flags. The default bridge network is used; the container needs outbound HTTPS/gRPC to reach the public Sauron endpoints that pocketd's `--network` presets point at.
- `-Root` (`--user root`) is used only by `Ensure-Volume` to `chown pocket:pocket /home/pocket/.pocket` on a freshly created volume.

`Pocketd($argv, $pass, $mounts, $envExtra, -Root, $prefixLines)` wraps that: `shcmd = 'pocketd ' + args each single-quoted for POSIX sh (Sh-Quote: `'` -> `'\''`)`; stdin is `"$prefixLines$pass`n$pass`n"` when a passphrase is given (fed twice: a fresh keyring asks for the passphrase and a confirmation, an existing one reads only the first line), or just `$prefixLines` otherwise.

`Invoke-Native($exe, $argv, $stdin, $envExtra)`: `ProcessStartInfo` with all three streams redirected, `CreateNoWindow`, arguments joined with `Quote-Arg` (Windows quoting: values that are empty or contain whitespace or `"` are wrapped in quotes with `(\\*)"` -> `$1$1\"`), stdout/stderr read with `ReadToEndAsync` (avoids the deadlock of reading them sequentially), stdin written if given then closed, `WaitForExit` with **no timeout**. Returns `@{ code; out; err }`. In Node, `spawn(exe, argvArray)` performs the Windows quoting itself; `Quote-Arg` is only needed to render the dry-run `command` string for display.

---

## 3. Operations

Ordering follows the request: docker, wallet, transactions, servers, testing, history, then everything else found. For each: purpose, request fields, result fields, the command shape, which key signs, side effects on disk, and the UI confirmation.

Shared helpers referenced below:

- `Require-Docker`: runs `Docker-Check`; fails with its `error`/`detail` when Docker is not usable, and with `The pocketd image is not downloaded yet. Use "Download pocketd" first.` when the image is missing.
- `Require-Passphrase`: `Unseal-Passphrase`, failing with `No sealed passphrase exists on this machine, so the keyring cannot be opened. Import the owner wallet first.`
- `Keyring-Address(name, pass)`: `pocketd keys show <name> -a --keyring-backend file` (with passphrase); returns the address when it matches `^pokt1[0-9a-z]{38}$`, else `$null`.
- `Keyring-List(pass)`: `pocketd keys list --keyring-backend file --output json`; returns an array, `@()` for empty/`null` output, or `$null` on failure.
- `Clean-Err` / `Summarize-Err`: see section 6.5.

### 3.1 Docker

#### `docker-check`

Purpose: report whether Docker is reachable, whether the two images are present, and the pocketd version. Also used internally by `Require-Docker`, `wallet-status`, `wallet-list`, and `wallet-delete`.

Request: no fields besides `op`.

Commands, in order:

1. `docker version --format {{.Server.Version}}`; if the `docker` executable cannot be started: `{ ok: false, running: false, error: "The docker command was not found. Install Docker Desktop.", detail: <exception> }`; if exit code is not 0: `{ ok: false, running: false, error: "Docker Desktop is not running.", detail: <first line of stderr> }`.
2. `docker image inspect ghcr.io/pokt-network/pocketd:latest --format {{.Id}}`
3. `docker image inspect ghcr.io/pokt-network/pocket-ap:latest --format {{.Id}}`
4. If the pocketd image is present: `docker run --rm ghcr.io/pokt-network/pocketd:latest version` (default entrypoint, no volume).

Result:

| Field | Type | Meaning |
|---|---|---|
| `ok` | bool | Docker reachable. |
| `running` | bool | Same as `ok` in practice. |
| `docker` | string | Server version. |
| `image` | bool | pocketd image present. |
| `pocketap` | bool | pocket-ap image present. |
| `pocketd` | string | Output of `pocketd version`, `''` if the image is absent or the call failed. |
| `error`, `detail` | string | On failure. |

Side effects: none. UI: `dockerCycle()` on startup; while Docker is down it re-runs `docker-check` every 10 s in the background (`dockerRetry`); after `docker-start` it re-checks every 5 s up to 24 times. `preflightRegister`/`preflightStake` re-run it when the cached state says not ready. `app.js` treats "ready" as `r.ok && r.image` (`dockerReady()`).

#### `docker-start`

Purpose: launch Docker Desktop.

Request: none. Command: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`. Fails with `Docker Desktop is not installed at the expected location.` (detail: the path) when the file is missing. Result `{ ok: true }`. No side effects. UI: the "Start Docker Desktop" button in the top bar; no confirmation.

#### `image-pull`

Purpose: download the pocketd image.

Request: none. Commands: `docker pull ghcr.io/pokt-network/pocketd:latest` (fail: `Could not download the pocketd image.`, detail first stderr line), then `docker run --rm ghcr.io/pokt-network/pocketd:latest version`. Result `{ ok: true, pocketd: <version output> }`. UI: "Download pocketd" button, `timeoutMs: 900000`.

#### `pocketap-pull`

Purpose: download the pocket-ap image for the in-app relay test.

Request: none. Commands: `docker pull ghcr.io/pokt-network/pocket-ap:latest` (fail: `Could not download the pocket-ap image.`), then `docker run --rm ghcr.io/pokt-network/pocket-ap:latest version`. Result `{ ok: true, version: <first line> }`. UI: "Download pocket-ap" on the Test screen, `timeoutMs: 900000`; on success it sets `state.docker.pocketap = true` locally.

### 3.2 Wallet

#### `wallet-status`

Purpose: whether the owner wallet is imported, verified against the keyring when Docker is up.

Request: none.

Logic (each `Emit` ends the operation):

1. Read `wallet.json` (`$w`), `Test-Path` of the pass file (`$hasPass`), `Docker-Check` (`$dc`), volume existence when Docker is ok, and the application wallet count (`$apps.Count`).
2. Docker down: if `$w` and `$hasPass` -> `{ ok: true, imported: true, verified: false, address: <wallet.json address>, name: "service-manager", imported_at, app_wallets }`; else `{ ok: true, imported: false, verified: false, app_wallets }`.
3. Not all three of wallet.json, pass file, volume present -> `{ ok: true, imported: false, verified: true, partial: <any one of them present>, app_wallets }`. The UI shows the "Leftover wallet files were found" box when `partial` is true.
4. Otherwise unseal, `Keyring-Address service-manager`; if it fails -> `{ ok: true, imported: false, verified: true, partial: true, app_wallets, error: "The parent key could not be read from the keyring." }`; else `{ ok: true, imported: true, verified: true, address: <from keyring>, name, imported_at, app_wallets }`.

Command (verified path): `pocketd keys show service-manager -a --keyring-backend file` with the passphrase piped. Side effects: none. UI: `walletStatus()` after every Docker check and after import/revoke; it then reads the balance from the LCD and re-renders.

#### `wallet-import`

Purpose: import the owner wallet's hex private key; creates the sealed passphrase, the volume, and the keyring on first use.

Request: no JSON fields. The key is read from `$env:PSM_IMPORT_KEY` (trimmed, optional `0x` stripped, must match `^[0-9a-fA-F]{64}$`).

Steps:

1. `Require-Docker`.
2. Fail `No private key was provided.` / `The private key must be 64 hexadecimal characters (32 bytes), optionally prefixed with 0x.` / `A wallet is already imported. Revoke it before importing another.` (when `wallet.json` exists).
3. `Unseal-Passphrase`; if there is no usable passphrase, **start clean**: `docker volume rm -f pocket-service-manager-keyring` if the volume exists, delete `wallets.json`, generate a new passphrase and seal it (section 4).
4. `Ensure-Volume`: `docker volume inspect <vol>` else `docker volume create <vol>`; then `docker run --rm --user root -v <vol>:/home/pocket/.pocket --entrypoint sh <image> -c "chown pocket:pocket /home/pocket/.pocket"`.
5. If a key named `service-manager` already exists: `pocketd keys delete service-manager -y --keyring-backend file` (passphrase piped).
6. Import: `docker run ... -e PSM_STDIN -e PSM_IMPORT_KEY --entrypoint sh <image> -c 'printf "%s" "$PSM_STDIN" | pocketd keys import-hex '\''service-manager'\'' "$PSM_IMPORT_KEY" --keyring-backend file'` with `PSM_STDIN = "<pass>\n<pass>\n"`. Fail `pocketd could not import the key.` (detail `Clean-Err`).
7. Read back the address with `Keyring-Address`; fail `The key was imported but cannot be read back.`
8. Write `wallet.json` `{ name, address, imported_at, volume }`; `Add-History { op: "wallet-import", address }`.

Result: `{ ok: true, address, name: "service-manager" }`.

Key: none signs; the imported key is stored. Disk: `keyring.pass.dpapi` (possibly new), `wallet.json`, `history.jsonl`, the Docker volume (possibly recreated), `wallets.json` (deleted when starting clean). UI: modal with a password field; regex check client-side; passes `opts.env = { PSM_IMPORT_KEY: hex }` and `shred: true`; clears the input afterwards; no typed confirmation.

#### `wallet-import-app`

Purpose: add an application wallet from a hex private key.

Request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Wallet name (`Validate-WalletName`). |
| `service_id` | string | no | Service the wallet is for; validated when non-empty; stored in `wallets.json`. |
| env `PSM_IMPORT_KEY` | string | yes | Hex key, `0x` optional. |

Steps: `Require-Docker`; validate name and service id; require `wallet.json` (`Import the owner wallet first; it creates the keyring the application wallets live in.`); refuse an existing `wallets.json` name (`A wallet named '<name>' already exists.`); validate the hex; `Require-Passphrase`; refuse a keyring key with that name the app does not track (`The keyring already holds a key named '<name>' that this app does not track. Choose another name.`); `Probe-HexAddress` (see below; fail `pocketd could not derive an address from that key.`); `Wallet-Holding` (fail `That key is already in the keyring as '<holder>' (<address>).`); import with the same `import-hex` shape as `wallet-import` but with `<name>`; read back; compare to the probe (`The imported key does not match the address derived beforehand.`); `Register-Wallet name address service_id 'import'`.

`Probe-HexAddress` command (no volume needed, but `Invoke-InBox` still mounts it):
`sh -c 'pocketd keys import-hex probe "$PSM_IMPORT_KEY" --keyring-backend test --home /tmp/psm-probe >/dev/null 2>&1 && pocketd keys show probe -a --keyring-backend test --home /tmp/psm-probe'` with `PSM_IMPORT_KEY` in the environment. The throwaway keyring lives in the container's `/tmp` and vanishes with it.

`Register-Wallet` replaces any entry with the same name, appends `{ name, address, service_id, created_at, source }`, saves `wallets.json`, and appends history `{ op: "wallet-<source>", address, service_id, extra: "name=<name>" }` (so the history op is `wallet-import`, the same string as the owner import; the `extra` field distinguishes them).

Result: `{ ok: true, name, address, service_id }`. Disk: `wallets.json`, `history.jsonl`, keyring. UI: modal with service select, name, password field; `opts.env = { PSM_IMPORT_KEY }`, `shred: true`; no typed confirmation.

#### `wallet-create`

Purpose: create a new application wallet key; return its recovery phrase once.

Request: `name` (required), `service_id` (optional).

Steps: `Require-Docker`; validations as above; `Require-Passphrase`; refuse an untracked keyring key with that name; `pocketd keys add <name> --keyring-backend file --output json` with the passphrase piped; `Parse-FirstJson` (first `{` in stdout, then stderr); fail `pocketd could not create the key.` if exit code non-zero or no `address`; address must match `^pokt1[0-9a-z]{38}$`; the mnemonic must have at least 12 words (else `pocketd did not return a recovery phrase; the key was created but cannot be backed up. Remove it and try again.`); `Register-Wallet ... 'create'`.

Result: `{ ok: true, name, address, service_id, mnemonic }`. The signer nulls its copies of the JSON after extracting them. Disk: keyring, `wallets.json`, `history.jsonl` (`op: "wallet-create"`). UI: modal (service select fills the name as `app-<service>`); `shred: true`; the phrase is shown once in a table with a "Copy phrase" button and a checkbox the user must tick before "Done".

#### `wallet-recover`

Purpose: add an application wallet from a BIP-39 phrase.

Request: `name` (required), `service_id` (optional), env `PSM_IMPORT_MNEMONIC`.

Phrase normalisation: collapse whitespace to single spaces, trim, lowercase. Word count must be one of 12, 15, 18, 21, 24 (the error text says "12 or 24"); must match `^[a-z ]+$`.

Command: `pocketd keys add <name> --recover --keyring-backend file --output json` with stdin `"<phrase>\n<pass>\n<pass>\n"` (pocketd reads the phrase first, then the keyring passphrase). Fail `pocketd could not recover the key.` with `Summarize-Err` (which maps `invalid mnemonic` to a friendly message). Then `Register-Wallet ... 'recover'`.

Result: `{ ok: true, name, address, service_id }`. Disk: keyring, `wallets.json`, `history.jsonl` (`op: "wallet-recover"`). UI: modal with a textarea; client-side word count check; `opts.env = { PSM_IMPORT_MNEMONIC: phrase }`, `shred: true`; clears the textarea.

#### `wallet-list`

Purpose: every wallet the app manages, checked against the keyring when possible.

Request: none.

Logic: read `wallet.json` and `wallets.json`; `Docker-Check`; when Docker is ok, the image is present, the volume exists, and the pass file exists: unseal and `Keyring-List`; if that returns non-null, `verified = true` and a name-to-address map of the keyring is built.

Result:

| Field | Type | Meaning |
|---|---|---|
| `ok` | true | Always. |
| `verified` | bool | The keyring was listed. |
| `parent` | object or null | `{ name: "service-manager", address, present: bool|null }` from `wallet.json`. |
| `wallets` | array | Each `{ name, address, service_id, created_at, source, present }`; `present` is `null` when not verified. |

Command: `pocketd keys list --keyring-backend file --output json`. Side effects: none. UI: `loadWallets()` after every wallet status and wallet change; drives the "Stake as" select and the Wallets table ("missing from keyring" badge when `present === false`).

#### `wallet-export`

Purpose: show a private key on explicit request.

Request: `name` (optional; empty means the owner wallet). A non-owner name must be in `wallets.json`.

Command: `pocketd keys export <name> --unarmored-hex --unsafe --keyring-backend file` with stdin `"y\n<pass>\n<pass>\n"` (pocketd asks `continue? [y/N]` for `--unsafe`, then the keyring passphrase). Output must match `^[0-9a-fA-F]{64}$` (fail `pocketd returned something that is not a 64-character hex key.`).

Result: `{ ok: true, hex, name }`. Disk: `history.jsonl` `{ op: "wallet-export", extra: "name=<name>" }` (never the key). UI: for an application wallet, the user types `EXPORT`; for the owner wallet this is the first half of Revoke and the user types `REVOKE`. Both use `shred: true`; the key is displayed in a box with a copy button.

#### `wallet-remove`

Purpose: delete an application wallet's key from the keyring and its record.

Request: `name` (required), `confirm` (must equal `name`; else `The wallet name was not confirmed.`).

Refusals: the owner name (`The owner wallet is removed with Revoke, not here.`); a name not in `wallets.json`; another record sharing the same address (`'<other>' holds the same key; removing one would break the other. Remove that record first.`).

Command: if `Keyring-Address <name>` succeeds, `pocketd keys delete <name> -y --keyring-backend file` (passphrase piped); a non-zero exit is tolerated when the key is gone afterwards. Then `Save-Wallets` without that name; history `{ op: "wallet-remove", address, extra: "name=<name>" }`.

Result: `{ ok: true }`. UI: before calling, `app.js` reads the wallet's balance and application record from the LCD and warns about funds and stakes; the user types the wallet name.

#### `wallet-delete`

Purpose: Revoke. Removes the whole keyring volume and the local state files.

Request: `force` (boolean, optional). If application wallets exist and `force` is falsy: `The keyring still holds <n> application wallet(s). Export or remove them first, or confirm that they may be deleted with it.` `app.js` never sends `force`; its dialog tells the user to export or remove them first.

Commands: `Docker-Check`; if Docker is ok and the volume exists, `docker volume rm -f pocket-service-manager-keyring` (fail `Could not delete the keyring volume.`); if Docker is not ok, fail `Docker Desktop must be running to delete the keyring volume.` (if Docker is ok but the volume is already gone, it proceeds). Then delete `keyring.pass.dpapi`, `wallet.json`, `wallets.json`; history `{ op: "wallet-delete", address: <old address> }`.

Result: `{ ok: true }`. UI: Revoke dialog: type `REVOKE`, the owner key is exported and shown (`wallet-export`), then "I saved it. Delete from this machine" triggers `wallet-delete`.

#### `wallet-set-service`

Purpose: change the `service_id` recorded for an application wallet.

Request: `name` (must be in `wallets.json`), `service_id` (validated when non-empty; may be empty to unassign). Rewrites `wallets.json`. Result `{ ok: true }`. No Docker, no keyring.

**Not called by `app.js`** (the UI updates the recorded service only as a side effect of `tx-stake-app`). Keep it in the port for completeness.

### 3.3 Transactions

Shared behaviour for the local transactions (`tx-*`):

- All go through `Require-Docker`, `Require-Network`, validation, then (unless `dry`) `Require-Passphrase` and `Pocketd $argv $pass [$mounts]`.
- Every argv ends with `--keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json`.
- `Emit-Tx($r, $net, $op, $serviceId, $extra)`:
  - `Parse-TxOutput`: parse stdout as JSON, or from the first `{`; extract `gas` from stderr with `gas estimate:\s*(\d+)`.
  - If no JSON or no `txhash`: `Fail (Summarize-Err stderr) (Clean-Err stderr + "\n" + stdout)`. Nothing is written to history in that case.
  - Otherwise `code = [int] json.code`, append history `{ network, op, service_id, txhash, code, extra, time }` (**even when `code != 0`**), and emit `{ ok: code == 0, txhash, code, raw_log, gas, error: code != 0 ? "The node rejected the transaction (code <code>)." : "", detail: code != 0 ? raw_log : "" }`.
- The signer returns as soon as the node accepts the tx into the mempool. **Waiting for inclusion is done by the UI** (`pollTx`, section 6.8).
- Dry runs return `{ ok: true, dry: true, command: "pocketd <args quoted with Quote-Arg>" }` plus operation-specific extras, and never unseal the passphrase.

#### `tx-add-service`

Purpose: register or update a service (`MsgAddService`), signed by the owner wallet.

Request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `network` | string | yes | `beta` or `main`. |
| `service_id` | string | yes | `Validate-ServiceId`. |
| `name` | string | yes | Display name, `^[A-Za-z0-9 _-]{1,169}$`. |
| `compute_units_per_relay` | int64 | yes | 1 to 1,048,576. |
| `card_path` | string | no | Local path to `card.json`; must exist and be at most 262,144 bytes. `app.js` sends `""` when there is no card. |
| `dry` | bool | no | Plan only. |

Also requires `wallet.json` (`No wallet is imported.`).

Command: the card, when given, is copied to `work/<id>/card.json` and mounted `<work>:/work:ro`:

```
pocketd tx service add-service <id> <name> <cupr> [--card-file /work/card.json] --from service-manager --keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
```

Signs: owner wallet (`service-manager`). Result: `Emit-Tx` with history `op: "add-service"`, `service_id`, `extra: "cupr=<n>"`. Dry: `{ ok, dry, command }`. Disk: `work/` (removed), `history.jsonl`.

UI (`preflightRegister`, `executeRegister`): preflight checks Docker, wallet, field regexes, reads the live `add_service_fee` and balance, looks the id up in the catalog (`/pokt-network/poktroll/service/service/<id>`: 200 and same owner = update, 200 other owner = fail, 404 = free), warns on near-duplicate ids and duplicate names, runs `cardChecks` and `validate-card`, then a `dry: true` call whose `command` is shown as the plan. Execute re-compares the form to the preflight snapshot, then on MainNet requires the service id to be typed in a modal, on Beta a `confirm()`. After broadcast: `pollTx`, read the service back and verify the owner, write `register_tx` or `last_update_tx` into the service folder's `service.json` under `networks.<net>`.

#### `tx-stake-app`

Purpose: stake a wallet as an application for one service (`MsgStakeApplication`).

Request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `network` | string | yes | |
| `service_id` | string | yes | |
| `stake_upokt` | int64 | yes | Positive. |
| `from` | string | no | Signing wallet via `Resolve-Signer` (empty or `service-manager` = owner; otherwise a `wallets.json` name). |
| `dry` | bool | no | |

Config written to `work/<id>/app_stake.yaml` (mounted `/work:ro`):

```
stake_amount: <stake>upokt
service_ids:
  - <service_id>
```

Command:

```
pocketd tx application stake-application --config /work/app_stake.yaml --from <from> --keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
```

Signs: `<from>`. Side effect before `Emit-Tx`: when `from` is an application wallet and `service_id` is set, `wallets.json` gets that wallet's `service_id` updated **regardless of whether the transaction succeeded** (the update runs before the result is parsed). History `op: "stake-application"`, `extra: "stake_upokt=<n> from=<from>"`. Dry: `{ ok, dry, command, config: <yaml>, from }`.

UI (`preflightStake`, `executeStake`): reads live `min_stake`, refuses a stake below the minimum or with less than 1% margin, checks the service exists, reads the wallet's application record (warns on re-pointing, refuses lowering the stake, notes unbonding), checks the staking wallet's balance (offering `tx-fund-wallet`), shows the plan with the YAML. MainNet: type the service id; Beta: `confirm()`. After `pollTx`, verifies the application record and writes `app_stake_tx`, `app_wallet`, `app_address` to `service.json`.

#### `tx-delegate-gateway` and `tx-undelegate-gateway`

Purpose: delegate an application to a gateway, or remove the delegation (takes effect at session end). Gas only; no funds move.

Request: `network`, `from` (via `Resolve-Signer`), `gateway_address` (`^pokt1[0-9a-z]{38}$`), `dry`.

Commands:

```
pocketd tx application delegate-to-gateway <gateway> --from <from> --keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
pocketd tx application undelegate-from-gateway <gateway> --from <from> ... (same tail)
```

Signs: `<from>`. History ops `delegate-to-gateway` / `undelegate-from-gateway`, `service_id: ""`, `extra: "gateway=<gw> from=<from>"`. Dry: `{ ok, dry, command, from }`.

UI (`delegationTx`): the gateway list is read live (`/pokt-network/poktroll/gateway/gateway?pagination.limit=1000`); refuses a duplicate delegation or one beyond `max_delegated_gateways`. MainNet: a modal confirm (no typed word); Beta: `confirm()`. `pollTx` afterwards.

#### `tx-fund-wallet`

Purpose: send POKT from the owner wallet to one of the application wallets it manages.

Request: `network`, `name` (must be in `wallets.json`; its recorded address is the recipient), `amount_upokt` (positive int64), `dry`. Requires `wallet.json`.

Command:

```
pocketd tx bank send service-manager <recipient> <amount>upokt --keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
```

Signs: owner wallet. History `op: "fund-wallet"`, `service_id: <wallet's service_id>`, `extra: "to=<addr> name=<name> amount_upokt=<n>"`. UI (`fundWallet`): checks the owner balance covers amount + 1 POKT; MainNet: type `SEND`; Beta: `confirm()`; `pollTx`.

#### `tx-fund-operator`

Purpose: send POKT from the owner wallet to a supplier operator address the user names.

Request: `network`, `to` (`^pokt1[0-9a-z]{38}$`, must differ from the owner address: `The recipient is this wallet itself.`), `amount_upokt` (positive), `dry`. Requires `wallet.json`.

Command: same `tx bank send service-manager <to> <amount>upokt ...` shape. History `op: "fund-operator"`, `service_id: ""`, `extra: "to=<to> amount_upokt=<n>"`. UI: from the supplier editor (`fundOperator`) and from Provision when the operator holds under 5 POKT (`runProvision`); MainNet: type `SEND`; Beta: `confirm()`; `pollTx`.

#### `tx-unstake-supplier`

Purpose: begin unbonding a supplier, signed by the owner wallet (the chain accepts owner or operator; the stake returns to the owner).

Request: `network`, `operator_address` (`^pokt1[0-9a-z]{38}$`), `dry`. Requires `wallet.json`.

Command:

```
pocketd tx supplier unstake-supplier <operator> --from service-manager --keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
```

History `op: "unstake-supplier"`, `extra: "operator=<op> owner=<owner address>"`. UI (`unstakeSupplierDialog`): refuses when already unbonding or when the on-chain owner is not this wallet; the dialog states the live unbonding period in sessions and time and the return block; MainNet: type `UNSTAKE`; Beta: a modal button. `pollTx`, then re-reads the supplier record.

#### `tx-unstake-app`

**New in the Electron app (product owner, 2026-09-20); the HTA has no equivalent.** Purpose: begin unbonding an application, signed by the application wallet itself.

Request: `network`, `from` (a wallet name, resolved through `resolveSigner`), `dry`. Refuses the owner wallet, which is not an application.

Command:

```
pocketd tx application unstake-application --from <app key> --keyring-backend file --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
```

Note the shape: the message carries no address and the node reads it from the signer, so unlike `tx-unstake-supplier` there is no positional argument and the owner wallet cannot sign on the application's behalf. Verified against `pocketd` 0.1.35 help.

History `op: "unstake-application"`, `service_id: ""`, `extra: "from=<key>"`. UI (Stake application, "Unstake this application"): shown only when the chosen wallet is staked, and replaced by a notice when it is already unbonding; the dialog states the live application unbonding period in sessions and time; MainNet: type `UNSTAKE`; Beta: a modal button. `pollTx`, then re-reads the application record through `readAfterTx`. Not on the MCP bridge: see `BRIDGE_APP_ONLY_OPS`.

#### `remote-stake-supplier`

Purpose: stake (or restake) a supplier, signed on the server by the operator key over SSH. The YAML lists every service the supplier serves because `stake-supplier` replaces the whole list; the UI merges the existing on-chain list before calling.

Request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `network` | string | yes | |
| `host`, `port`, `user`, `key_path` | | yes | `Resolve-Ssh`. |
| `path` | string | yes | The network's stack directory on the server (holds `pocket-home/`). |
| `operator_key_name` | string | no | Defaults to `operator`; `^[A-Za-z0-9._-]+$`. `app.js` never sends it. |
| `owner_address` | string | yes | `pokt1...`; the UI sends the owner wallet's address. |
| `operator_address` | string | yes | `pokt1...`. |
| `stake_upokt` | int64 | yes | Positive. |
| `services` | array | yes, non-empty | Each `{ service_id, url, rpc_type }`; `url` must match `^https://[^\s]+$`; `rpc_type` in `REST`, `JSON_RPC`, `WEBSOCKET`, `GRPC`, `COMET_BFT`. |
| `dry` | bool | no | |

YAML built locally (`work/<id>/supplier_stake.yaml`) and copied to `<path>/supplier_stake.yaml` with `scp`:

```
owner_address: <owner>
operator_address: <operator>
stake_amount: <stake>upokt
default_rev_share_percent:
  <owner>: 100
services:
  - service_id: <id>
    endpoints:
      - publicly_exposed_url: <url>
        rpc_type: <RPC_TYPE>
  ...
```

Remote command (one ssh invocation, argument as a single string):

```
cd <path> && docker run --rm -v <path>/pocket-home:/home -v <path>:/work:ro ghcr.io/pokt-network/pocketd:latest tx supplier stake-supplier --config /work/supplier_stake.yaml --from <operator_key_name> --keyring-backend test --home /home --network <net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json
```

Note the server-side keyring is the unencrypted `test` backend under `<path>/pocket-home`.

Failure rule: if ssh exits non-zero **and** stdout does not contain `"txhash"`, fail with `Summarize-Err`; otherwise hand `$r` to `Emit-Tx` (history `op: "stake-supplier"`, `service_id: "<id1>,<id2>,..."`, `extra: "operator=<op> via <user@host>"`). Dry: `{ ok, dry, command: "ssh <ssh args> <target> '<remote>'", config: <yaml> }`.

Signs: the operator key on the server; the local keyring is not opened. Disk: `work/` (removed), `history.jsonl`; on the server, `<path>/supplier_stake.yaml` is left in place.

UI (`preflightSupply`, `executeSupply`): checks the operator account exists with a published public key (`/cosmos/auth/v1beta1/accounts/<op>`), the operator's balance covers stake delta + gas (suggesting a `tx-fund-operator` amount), the existing supplier record's owner, that every ticked service is in the catalog, that each endpoint URL answers from this PC, reports the next session boundary and the unbonding period; dry run shows the ssh command and the YAML. MainNet: type the server name; Beta: `confirm()`. After `pollTx`, verifies the supplier record (`services` active now, `service_config_history` entries with `deactivation_height == 0` scheduled) and writes `supplier_stake_tx`, `supplier_operator`, `supplier_url`, `deploy_host`, `deploy_path` into each local service folder's `service.json`.

### 3.4 Servers (SSH)

All SSH operations use `Resolve-Ssh`, which yields:

- ssh args: `-i <key_path> -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new -p <port>`
- scp args: the same with `-P <port>`, plus `-q`
- target: `<user>@<host>`

Executed with `Invoke-Native 'ssh' (...)` and `Invoke-Native 'scp' (...)`; the OpenSSH client on the PC's `PATH` is used. Nothing depends on `~/.ssh/config`.

`app.js` maps its settings fields to request fields: `keyPath` -> `key_path`, `deployRoot` -> `deploy_root`, `suppliers[net].dir` -> `path` (`connOf(s, net)`).

#### `ssh-test`

Purpose: check a server entry: the connection works, Docker Compose is there, and (if a stack directory is given) the operator keyring exists.

Request: `host`, `port`, `user`, `key_path`, `path` (optional; when given must be an absolute Linux path).

Remote command: `hostname; docker compose version 2>/dev/null | head -1[; test -d '<path>/pocket-home' && echo PSM_KEYRING_OK]; true` (the probe always exits 0; ssh itself exits 255 when it cannot connect or authenticate -> `Could not connect over SSH.`).

Result: `{ ok: true, hostname: <first non-empty line>, docker: <the line containing "Docker Compose", or ""> , keyring: <bool> }`. No disk side effects. UI: Settings "Test connection" (`timeoutMs: 60000`), the first step of Provision (without `path`), and the first step of Deploy (with `path`; `keyring` must be true).

#### `supplier-ship`

Purpose: render one network's supplier stack from `tools/service-manager/server/` and copy it to the stack directory, plus the server's shared Caddy files, then run `supplier.sh prepare`. No keys involved.

Request:

| Field | Type | Required | Default / validation |
|---|---|---|---|
| `host`, `port`, `user`, `key_path` | | yes | |
| `path` | string | yes | Stack directory, absolute Linux path. |
| `network` | string | yes | |
| `hostname` | string | yes | `^[A-Za-z0-9.-]+$`; the public DNS name. |
| `project` | string | no | Compose project; default `pocket-supplier-<net>`; `^[a-z0-9][a-z0-9-]{0,40}$`. `app.js` sends the existing stack's project or `stackProjectDefault(net)`. |
| `caddy_dir` | string | no | Default `/opt/pocket/caddy`; must differ from `path`. `app.js` sends `CADDY_DIR`. |
| `health_port` | int | no | Default 8081. `app.js`: beta 8081, main 8082. |
| `relayer_metrics_port` | int | no | Default 9090. `app.js`: beta 9090, main 9091. |
| `miner_metrics_port` | int | no | Default 9092. `app.js`: beta 9092, main 9093. |
| `block_time` | int | no | Seconds. `app.js` sends `Math.round(state.params.blockTime || 0)` (measured over the last 1,000 blocks). `signer.ps1` fell back to 60 for main and 30 for beta when 0 or missing; the Electron signer measures it from the LCD over the last 1,000 blocks instead and fails the step when the network cannot be read (no chain value is typed in, CLAUDE.md rule 1). |

Network-specific values hardcoded in the signer:

| Token | beta | main |
|---|---|---|
| `{{CHAIN_ID}}` | `pocket-lego-testnet` | `pocket` |
| `{{RPC_URL}}` | `https://sauron-rpc.beta.infra.pocket.network` | `https://sauron-rpc.infra.pocket.network` |
| `{{GRPC_URL}}` | `sauron-grpc.beta.infra.pocket.network:443` | `sauron-grpc.infra.pocket.network:443` |

Other tokens: `{{NETWORK}}`, `{{BLOCK_TIME}}`, `{{HOSTNAME}}`, `{{PROJECT}}`, `{{HEALTH_PORT}}`, `{{RELAYER_METRICS_PORT}}`, `{{MINER_METRICS_PORT}}`, `{{CADDY_DIR}}`. Templates are found at `$PSScriptRoot\server\` (fail `The server templates are missing next to signer.ps1.` when `supplier.sh` is absent).

Rendering into `work/<id>/`: `miner-config.yaml.tmpl` -> `miner-config.yaml`, `relayer-config.yaml.tmpl` -> `relayer-config.yaml`, `docker-compose.yaml.tmpl` -> `docker-compose.yaml`, `stack.env.tmpl` -> `stack.env`, `site.caddy.tmpl` -> `caddy\sites\<net>.caddy`; plus `supplier.sh`, `caddy\docker-compose.yaml`, `caddy\Caddyfile` copied verbatim. Every file is written UTF-8 without BOM with CRLF converted to LF.

Remote steps:

1. `ssh <target> "mkdir -p '<path>' '<caddy_dir>/sites' && test -f '<path>/relayer-config.yaml' && echo PSM_HAVE_RELAYER || true"`; if stdout contains `PSM_HAVE_RELAYER` the existing relayer config (with its services) is kept and not shipped.
2. `scp -q <work>\docker-compose.yaml <work>\miner-config.yaml <work>\stack.env <work>\supplier.sh [<work>\relayer-config.yaml] <target>:<path>/`
3. `scp -q <work>\caddy\docker-compose.yaml <work>\caddy\Caddyfile <target>:<caddy_dir>/`
4. `scp -q <work>\caddy\sites\<net>.caddy <target>:<caddy_dir>/sites/`
5. `ssh <target> "bash '<path>/supplier.sh' prepare"` (creates `pocket-home`, chowns it 1025:1025, creates the `pocket-supplier` Docker network, rewrites `redis://redis:6379` to `redis://<project>-redis:6379` in older configs).

Result: `{ ok: true, files: [<stack files shipped>, "<caddy_dir>/docker-compose.yaml", "<caddy_dir>/Caddyfile", "<caddy_dir>/sites/<net>.caddy"], relayer_kept: <bool>, out: <first line of prepare output> }`. History `{ op: "supplier-ship", network, extra: "host=<target> path=<path> project=<p> hostname=<h> caddy=<dir>" }`. Disk: `work/` (removed on success and on scp failure, **not** when the initial ssh `mkdir` fails). UI: second step of `runProvision` (`timeoutMs: 180000`); after success it records `{ dir, project, url: "https://<hostname>" }` for the stack in `settings.json`.

#### `supplier-run`

Purpose: run one allow-listed step of `supplier.sh` in a stack directory. Steps that touch the operator key do so only on the server; only the address comes back.

Request: `host`, `port`, `user`, `key_path`, `path`, `step`, plus per step:

| `step` | Extra request fields | Arguments appended | What `supplier.sh` does |
|---|---|---|---|
| `operator` | none | none | Creates `pocket-home/` and, if `operator-key.json` is absent, `pocketd keys add operator --keyring-backend test --home /home --output json > operator-key.json` (mode 600). Prints `created: ...` and `operator: <pokt1...>`. |
| `keys` | none | none | Exports the operator key inside the container (`keys export operator --unarmored-hex --unsafe --keyring-backend test --home /home`) and writes `supplier-keys.yaml` (`keys:\n  - "<hex>"`, owner uid 1000 by default, mode 400). Prints `keys: supplier-keys.yaml written`. |
| `publish` | `network` (required, `Require-Network`) | `<net>` | If `pocketd query auth account <addr> --network=<net> -o json` already shows a `"key"`, prints `published: already on chain`; else sends `tx bank send operator <addr> 1upokt --from operator --keyring-backend test --home /home --network=<net> --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json`, prints `txhash: <hash> <code>`, then polls the account every 5 s for up to 5 minutes. |
| `start` | none | none | `caddy_up` (shared Caddy under `<caddy_dir>` with compose project `pocket-caddy`, migrating certificates from a first-layout `<project>-caddy`, retiring other site files that claim this hostname), then `docker compose -p <project> up -d --remove-orphans` (all services when the relayer config lists services, else only `redis miner` and `relayer: waiting for the first service`). Waits up to 90 s for `http://127.0.0.1:<health_port>/health`. |
| `status` | none | none | Prints `dir:`, `stack:`, `operator:`, `keys:`, `services:`, `container: ...` lines, and `relayer: healthy` / `relayer: not answering`. |
| `deploy` | `service_id`, `deploy_root` (absolute Linux path), `health_path` (default `/healthz`, `^/[A-Za-z0-9._/-]*$`) | `<id> <root> <health_path>` | `cd <root>/<id>/deploy && docker compose -p <id> up -d --build`, then polls `http://<id>-backend:8080<health_path>` from an `alpine:3` container on the `pocket-supplier` network for up to 120 s; expects a `"` in the body (a JSON response). |
| `add-service` | `service_id`, `backend_url` (`^http://[A-Za-z0-9._-]+:[0-9]{2,5}$`), `health_path` (default `/healthz`) | `<id> <url> <health_path>` | Inserts a `services:` block for the id into `relayer-config.yaml` (`timeout_profile: fast`, `max_body_size_bytes: 20971520`, `default_backend: rest`, backend `url`, health check `endpoint`/`interval_seconds: 10`/`timeout_seconds: 5`), then `docker compose -p <project> up -d --force-recreate relayer` and waits for health. Prints `relayer: added <id>` or `relayer: already lists <id>`. |
| `remove-service` | `service_id` | `<id>` | Removes the block; recreates the relayer, or stops it when no services remain. **Not called by `app.js`.** |
| anything else | | | `Unknown supplier step '<step>'.` |

Remote command: `bash '<path>/supplier.sh' <step> '<arg1>' '<arg2>' ...` (each argument single-quoted; values are already regex-validated so no quote escaping is done).

Result:

| Field | Type | Meaning |
|---|---|---|
| `ok` | bool | ssh exit code 0 **and** no line matching `^error:\s*(.*)$` in stdout. |
| `step` | string | Echoed. |
| `out` | string | stdout, last 20,000 characters. |
| `err` | string | The last `error:` line's text, else `Clean-Err` of stderr. |
| `address` | string | From the first `operator:\s*(pokt1[0-9a-z]{38})` match in stdout, else `''`. |
| `lines` | string[] | Non-empty stdout lines. |

History: for every step except `operator` and `keys`: `{ op: "supplier-<step>", extra: "host=<target> <args joined by space>" }`. No local disk writes otherwise. UI: Provision runs `operator` (120 s), `keys` (120 s), optionally `publish` (420 s), `start` (300 s), `status` (120 s); Deploy runs `deploy` (600 s) and `add-service` (240 s) with `backend_url = "http://<service_id>-backend:8080"` and `health_path = readinessPath(id)` (the card's readiness probe path, else `/healthz`). No typed confirmation; Provision confirms only the optional funding transfer.

#### `deploy-ship`

Purpose: copy a service's backend (without `node_modules`) and its deploy compose file to `<deploy_root>/<service_id>/` on the server as one tar archive.

Request: `host`, `port`, `user`, `key_path`, `deploy_root` (absolute Linux path), `service_id`, `folder` (local path of the service folder; must contain `backend\Dockerfile`). No `path`.

Local steps:

1. `robocopy <folder>\backend <work>\stage\backend /E /XD node_modules .git __pycache__ test /XF *.pyc /NFL /NDL /NJH /NJS /NP` (exit code 8 or higher is a failure).
2. Compose file: `<folder>\deploy\docker-compose.yaml` if present (`compose_from = "the service folder"`), else `server\backend-compose.yaml.tmpl` with `{{SERVICE_ID}}` replaced (`compose_from = "the template"`); written to `<work>\stage\deploy\docker-compose.yaml` with LF line endings, no BOM.
3. `%SystemRoot%\System32\tar.exe -cf <work>\bundle.tar -C <work>\stage backend deploy` (falls back to `tar` on `PATH`).

Remote steps:

1. `ssh <target> "mkdir -p '<root>/<id>'"`
2. `scp -q <work>\bundle.tar <target>:<root>/<id>/bundle.tar`
3. `ssh <target> "cd '<root>/<id>' && tar -xf bundle.tar && rm -f bundle.tar && find backend deploy -type f | wc -l"`

Result: `{ ok: true, dest: "<root>/<id>", bytes: <archive size>, files: <file count>, compose_from }`. History `{ op: "deploy-ship", service_id, extra: "host=<target> dest=<dest> bytes=<n>" }`. Disk: `work/` (removed). UI: second step of `runDeploy` (`timeoutMs: 600000`), `deploy_root = server.deployRoot || "/opt/pocket/services"`.

The individual `supplier-run` steps the request listed by name (`deploy`, `add-service`, `remove-service`, `keys`, `operator`, `publish`, `start`, `status`) are steps of `supplier-run`, not separate operations; see the table above.

### 3.5 Testing

#### `relay-call`

Purpose: one relay through the protocol, signed by an application wallet from the keyring, sent with `pocket-ap` in a container. The response body comes back verbatim.

Request:

| Field | Type | Required | Validation |
|---|---|---|---|
| `network` | string | yes | |
| `wallet` | string | no | `Resolve-Signer` (empty = owner wallet). |
| `service_id` | string | yes | |
| `method` | string | yes | Upper-cased; one of `GET`, `POST`, `PUT`, `DELETE`, `HEAD`, `PATCH`. |
| `path` | string | yes | `^/[^\s]*$`. |
| `body` | string | no | Request body text; when non-empty it is written to `work/<id>/body.json`. |

Steps: `Require-Docker`; pocket-ap image must be present (`The pocket-ap image is not downloaded yet. Use "Download pocket-ap" first.`); `Require-Passphrase`; export the key in memory with `pocketd keys export <wallet> --unarmored-hex --unsafe --keyring-backend file` (stdin `y\n<pass>\n<pass>\n`; fail `The wallet key could not be read from the keyring.` / `The keyring returned something that is not a key.`); write `work/<id>/pocket-ap.yaml`:

```
network: <net>
listeners:
  - addr: 127.0.0.1:8550
    service_id: <sid>
    rpc_type: rest
apps: []
```

Command (the key only in the docker CLI's environment):

```
docker run --rm -e POCKET_APP_PRIVATE_KEY -v <work>:/work:ro ghcr.io/pokt-network/pocket-ap:latest call --config /work/pocket-ap.yaml --service <sid> --rpc-type rest -X <METHOD> --path <path> -v --timeout 30s [--data @/work/body.json]
```

Timing with a stopwatch around the docker call; the hex variable is nulled right after; `work/` removed.

Result:

| Field | Type | Meaning |
|---|---|---|
| `ok` | bool | `exit_code == 0` **or** `http >= 400` (a 4xx answer is a successful relay for the bad-input probe). |
| `exit_code` | int | pocket-ap's exit code. |
| `http` | int | From stderr `upstream returned HTTP (\d{3})`; else 200 when the exit code is 0; else 0. |
| `ms` | int | Elapsed milliseconds. |
| `body` | string | stdout, first 200,000 characters. |
| `diagnostics` | string | stderr (`-v` output), last 20,000 characters. |
| `wallet` | string | Resolved signer name. |

Signs: the application wallet's key, inside pocket-ap. Disk: `history.jsonl` `{ op: "relay-test", network, service_id, extra: "wallet=<w> <METHOD> <path> code=<exit> http=<status> ms=<ms>" }` (no `txhash`). UI (`runTest`): builds the probe list from the card's `serving.healthcheck` (plus a `{}` bad-input POST expecting 4xx for each POST probe; defaults `GET /v1/version` and `GET /healthz` without a card), runs them sequentially (`timeoutMs: 120000` each), parses `session:\s*([0-9a-f]{8})` and `attempt \d+: (pokt1[0-9a-z]+) in (\d+ms) via (\S+) -> (\w+)` out of `diagnostics` for narration, grades each (`gradeStep`: JSON-object rule, HTTP status, JSONPath + regex), and appends the run to `relay-tests.log` itself. No confirmation.

#### `validate-card`

Purpose: run the Skill's `validate_card.py` on a card. Not a Docker operation.

Request: `card_path` (must exist: `Card file not found: <path>`), `script` (path to `validate_card.py`; `app.js` sends `<repo>\skills\pocket-service-builder\scripts\validate_card.py`).

Command: `python <script> <card_path>` via `Invoke-Native` (whatever `python` is on `PATH`).

Result: `{ ok: true, skipped: true, reason: "validate_card.py not found next to this tool." }` when the script is missing; `{ ok: true, skipped: true, reason: "python is not installed, so only the built-in checks ran." }` when starting python throws; else `{ ok: <exit code == 0>, code, output: <stdout + "\n" + stderr, trimmed> }`. No side effects. UI: after Create service, from "Validate card only", and inside register preflight.

### 3.6 History

#### `history`

Purpose: return every history entry.

Request: none. Reads `history.jsonl`, skips blank and unparseable lines. Result `{ ok: true, entries: [...] }` (empty array when the file is absent). UI (`loadHistory`): renders newest first; shows `time`, `network`, `op`, `service_id || address`, a badge from `code` when `txhash` exists, and a link to `<lcd>/cosmos/tx/v1beta1/txs/<txhash>` on the entry's own network.

### 3.7 Anything else

- **Unknown operation**: `{ ok: false, error: "Unknown operation '<op>'.", detail: "" }`. The self-test deliberately calls `run("nope", ...)` and records the answer.
- **Missing request file**: `Request file not found: <path>`.
- **Outer catch**: `{ ok: false, error: "The signer hit an unexpected error.", detail: <exception message> }`.

### 3.8 Call-site cross-check

Every `run("...")` in `app.js` and the operation it maps to (line numbers from the current file): `docker-check` 324, 335, 366, 2757; `docker-start` 361; `image-pull` 375; `wallet-status` 384, 2759; `wallet-list` 436, 2761; `wallet-create` 512; `wallet-recover` 552; `wallet-import-app` 578; `wallet-export` 597, 735; `wallet-remove` 626; `tx-fund-wallet` 645; `wallet-import` 706; `wallet-delete` 751; `validate-card` 1103, 1192, 2627; `tx-add-service` 1182 (dry), 1210; `tx-stake-app` 1353 (dry), 1449; `tx-unstake-supplier` 1621; `tx-fund-operator` 1745, 2016; `remote-stake-supplier` 1836 (dry), 1856; `ssh-test` 1967, 2086, 2437; `supplier-ship` 1972; `supplier-run` 1978 (operator), 1983 (keys), 1993 (start), 1996 (status), 2004 (publish), 2095 (deploy), 2099 (add-service); `deploy-ship` 2091; `pocketap-pull` 2140; `relay-call` 2240; `history` 2476, 2764; `nope` 2766 (self-test only). Signer operations with no UI caller: `wallet-set-service`, `supplier-run` step `remove-service`.

Field-name agreement: every field name sent by `app.js` matches what `signer.ps1` reads. The only asymmetries are optional fields the UI never sends (`wallet-delete.force`, `remote-stake-supplier.operator_key_name`, `supplier-ship` port and directory defaults, which the UI does send explicitly) and the settings-to-request renames (`keyPath` -> `key_path`, `deployRoot` -> `deploy_root`, `suppliers[net].dir` -> `path`).

---

## 4. Passphrase and keyring mechanics

### 4.1 Generation

`New-Passphrase`: 32 bytes from `System.Security.Cryptography.RNGCryptoServiceProvider`, Base64-encoded (a 44-character string). Generated once, at the first `wallet-import` when no sealed passphrase exists.

### 4.2 Sealing (as the HTA does it)

`Seal-Passphrase($plain)`:

```powershell
$sec = ConvertTo-SecureString $plain -AsPlainText -Force
$sec | ConvertFrom-SecureString | Set-Content -Path <StateDir>\keyring.pass.dpapi -Encoding ascii
```

`ConvertFrom-SecureString` without `-Key`/`-SecureKey` uses Windows DPAPI. Concretely (PowerShell's `SecureStringHelper.Protect`): the SecureString's characters are taken as **UTF-16LE bytes**, passed to `System.Security.Cryptography.ProtectedData.Protect(bytes, optionalEntropy: null, DataProtectionScope.CurrentUser)`, and the resulting DPAPI blob is written as a **lowercase hexadecimal string** (two hex digits per byte, no separators). The file therefore holds one hex line plus a CRLF, ASCII. Scope: the current Windows user on this machine; **no optional entropy**.

### 4.3 Unsealing

`Unseal-Passphrase`: read the file, `Trim()`, `ConvertTo-SecureString` (hex -> bytes -> `ProtectedData.Unprotect(bytes, null, CurrentUser)` -> UTF-16LE chars), then `Marshal.SecureStringToBSTR` / `PtrToStringBSTR` to get the plain string, and `ZeroFreeBSTR` in a `finally`. Returns `$null` when the file does not exist. The plain passphrase lives only in a local variable for the duration of one operation.

### 4.4 Passing it to pocketd

The passphrase is placed in the environment variable `PSM_STDIN` of the `docker` CLI process (never as a `-e NAME=value` argument, only `-e PSM_STDIN`), and the container's shell runs `printf "%s" "$PSM_STDIN" | pocketd ...`. The text piped is `"<pass>\n<pass>\n"`, optionally preceded by prefix lines (`y\n` for `keys export --unsafe`, `<mnemonic>\n` for `keys add --recover`). The double feed covers both a fresh keyring (asks passphrase + confirmation) and an existing one (reads one line). Reason: feeding docker's own stdin from PowerShell produced mangled lines.

Node equivalent: `spawn('docker', ['run', '--rm', '-v', ..., '-e', 'PSM_STDIN', '--entrypoint', 'sh', image, '-c', shcmd], { env: { ...process.env, PSM_STDIN: text }, stdio: ['ignore', 'pipe', 'pipe'] })`. Keep the printf-pipe technique rather than writing to the child's stdin, so behaviour matches what was verified. Never log `env`.

### 4.5 Keyring backend, volume, image, container

- Backend: `pocketd` `--keyring-backend file` (encrypted with the passphrase). Location inside the container: `/home/pocket/.pocket` (pocketd's default home for the `pocket` user), so the keyring files are under `/home/pocket/.pocket/keyring-file/` on the volume.
- Volume: Docker named volume `pocket-service-manager-keyring`, created by `Ensure-Volume` and chowned to `pocket:pocket` with a one-off `--user root` container.
- Image: `ghcr.io/pokt-network/pocketd:latest` (no pinned tag). The relay client is `ghcr.io/pokt-network/pocket-ap:latest`.
- Invocation: see section 2.5. Mounts: the volume at `/home/pocket/.pocket`; per-operation `<work dir>:/work:ro` for card, stake YAML, pocket-ap config, request body. No working directory, no network flags, no `-i`.
- Server side (not the local keyring): `<stack>/pocket-home` mounted at `/home` with `--keyring-backend test --home /home`; the operator key never leaves the server.

### 4.6 Mapping onto Electron `safeStorage` without changing the keyring

The keyring itself does not care how the passphrase is stored; it only needs the identical string piped in. So the port changes only the sealing of the passphrase file:

1. **Importer (one-time, on first run of the Electron app when `keyring.pass.dpapi` exists and the new file does not):**
   - Read `%LOCALAPPDATA%\PocketServiceManager\keyring.pass.dpapi`, trim, hex-decode to a byte array.
   - Call `CryptUnprotectData` / `ProtectedData.Unprotect(blob, null, CurrentUser)` (no entropy, CurrentUser scope). Options from a Node main process: a native N-API DPAPI binding; or, once only, a hidden `powershell -NoProfile -NonInteractive -Command` child that does exactly what `Unseal-Passphrase` does and writes the plain value to its stdout (captured, never to a file); the first is preferred since the second puts the passphrase on a pipe. Either way, do this once.
   - Decode the plaintext bytes as UTF-16LE; the result is the 44-character Base64 passphrase. Verify: length 44 and matches `^[A-Za-z0-9+/]{43}=$`.
   - Prove it opens the keyring before trusting it: run the equivalent of `Keyring-Address service-manager` and compare with `wallet.json`.
   - Re-seal with `safeStorage.encryptString(passphrase)` (check `safeStorage.isEncryptionAvailable()` first) and write the returned buffer to a new file (for example `keyring.pass.enc`, base64 or raw). On Windows `safeStorage` also uses DPAPI CurrentUser, but through Chromium's OSCrypt framing (a version prefix around the DPAPI blob), so the two file formats are **not** interchangeable; that is why an importer is needed.
   - Do not delete `keyring.pass.dpapi` automatically; leave it so the HTA keeps working during the transition, and offer removal in the UI later. The security posture is unchanged (both are CurrentUser DPAPI).
2. **Unseal in the new app:** read the new file, `safeStorage.decryptString(buffer)`, use for one operation, drop the reference. Fall back to the importer path when only the legacy file exists.
3. **Seal on first import:** `wallet-import`'s "start clean" branch generates 32 random bytes (`crypto.randomBytes(32).toString('base64')`) and seals them with `safeStorage`. Keep the "no passphrase means any leftover keyring is unreadable, so remove the volume and `wallets.json`" rule.
4. **Revoke:** delete both passphrase files (legacy and new) along with `wallet.json` and `wallets.json` after `docker volume rm -f`.

Everything that touches the keyring (`keys show`, `keys list`, `keys add`, `keys import-hex`, `keys export`, `keys delete`, every `tx ... --keyring-backend file`) stays byte-for-byte the same command with the same piped stdin.

---

## 5. Proposed IPC channel map

One channel per operation; names identical to the signer's operation names, prefixed `signer:`. Renderer calls `ipcRenderer.invoke(channel, req)` through a preload-exposed `signer.<camelCase>` API; main registers `ipcMain.handle`. Secrets that the HTA passed via environment variables travel in the request object over IPC (in-process, never serialised to disk) and are placed only in the child's `env`. All handlers return the same result shapes as today so the renderer logic ports unchanged.

Common types:

```ts
type Network = 'beta' | 'main';
interface Fail { ok: false; error: string; detail?: string }
interface SshConn { host: string; port: number; user: string; key_path: string }
interface TxResult { ok: boolean; txhash: string; code: number; raw_log: string; gas: string; error: string; detail: string }
interface DryResult { ok: true; dry: true; command: string }
```

| Channel | Request interface | Response interface |
|---|---|---|
| `signer:docker-check` | `{}` | `{ ok: boolean; running: boolean; docker?: string; image?: boolean; pocketap?: boolean; pocketd?: string; error?: string; detail?: string }` |
| `signer:docker-start` | `{}` | `{ ok: true } \| Fail` |
| `signer:image-pull` | `{}` | `{ ok: true; pocketd: string } \| Fail` |
| `signer:pocketap-pull` | `{}` | `{ ok: true; version: string } \| Fail` |
| `signer:wallet-status` | `{}` | `{ ok: true; imported: boolean; verified: boolean; address?: string; name?: string; imported_at?: string; app_wallets: number; partial?: boolean; error?: string }` |
| `signer:wallet-import` | `{ privateKeyHex: string }` (was env `PSM_IMPORT_KEY`) | `{ ok: true; address: string; name: string } \| Fail` |
| `signer:wallet-import-app` | `{ name: string; service_id?: string; privateKeyHex: string }` | `{ ok: true; name: string; address: string; service_id: string } \| Fail` |
| `signer:wallet-create` | `{ name: string; service_id?: string }` | `{ ok: true; name: string; address: string; service_id: string; mnemonic: string } \| Fail` |
| `signer:wallet-recover` | `{ name: string; service_id?: string; mnemonic: string }` (was env `PSM_IMPORT_MNEMONIC`) | `{ ok: true; name: string; address: string; service_id: string } \| Fail` |
| `signer:wallet-list` | `{}` | `{ ok: true; verified: boolean; parent: { name: string; address: string; present: boolean \| null } \| null; wallets: Array<{ name: string; address: string; service_id: string; created_at: string; source: 'create' \| 'recover' \| 'import'; present: boolean \| null }> }` |
| `signer:wallet-export` | `{ name?: string }` | `{ ok: true; hex: string; name: string } \| Fail` |
| `signer:wallet-remove` | `{ name: string; confirm: string }` | `{ ok: true } \| Fail` |
| `signer:wallet-delete` | `{ force?: boolean }` | `{ ok: true } \| Fail` |
| `signer:wallet-set-service` | `{ name: string; service_id: string }` | `{ ok: true } \| Fail` |
| `signer:tx-add-service` | `{ network: Network; service_id: string; name: string; compute_units_per_relay: number; card_path?: string; dry?: boolean }` | `TxResult \| DryResult \| Fail` |
| `signer:tx-stake-app` | `{ network: Network; service_id: string; stake_upokt: number; from?: string; dry?: boolean }` | `TxResult \| (DryResult & { config: string; from: string }) \| Fail` |
| `signer:tx-delegate-gateway` | `{ network: Network; from?: string; gateway_address: string; dry?: boolean }` | `TxResult \| (DryResult & { from: string }) \| Fail` |
| `signer:tx-undelegate-gateway` | same as above | same as above |
| `signer:tx-fund-wallet` | `{ network: Network; name: string; amount_upokt: number; dry?: boolean }` | `TxResult \| DryResult \| Fail` |
| `signer:tx-fund-operator` | `{ network: Network; to: string; amount_upokt: number; dry?: boolean }` | `TxResult \| DryResult \| Fail` |
| `signer:tx-unstake-supplier` | `{ network: Network; operator_address: string; dry?: boolean }` | `TxResult \| DryResult \| Fail` |
| `signer:tx-unstake-app` | `{ network: Network; from: string; dry?: boolean }` | `TxResult \| DryResult \| Fail` |
| `signer:remote-stake-supplier` | `SshConn & { network: Network; path: string; operator_key_name?: string; owner_address: string; operator_address: string; stake_upokt: number; services: Array<{ service_id: string; url: string; rpc_type: 'REST' \| 'JSON_RPC' \| 'WEBSOCKET' \| 'GRPC' \| 'COMET_BFT' }>; dry?: boolean }` | `TxResult \| (DryResult & { config: string }) \| Fail` |
| `signer:ssh-test` | `SshConn & { path?: string }` | `{ ok: true; hostname: string; docker: string; keyring: boolean } \| Fail` |
| `signer:supplier-ship` | `SshConn & { path: string; network: Network; hostname: string; project?: string; caddy_dir?: string; health_port?: number; relayer_metrics_port?: number; miner_metrics_port?: number; block_time?: number }` | `{ ok: true; files: string[]; relayer_kept: boolean; out: string } \| Fail` |
| `signer:supplier-run` | `SshConn & { path: string; step: 'operator' \| 'keys' \| 'start' \| 'status' } \| SshConn & { path: string; step: 'publish'; network: Network } \| SshConn & { path: string; step: 'deploy'; service_id: string; deploy_root: string; health_path?: string } \| SshConn & { path: string; step: 'add-service'; service_id: string; backend_url: string; health_path?: string } \| SshConn & { path: string; step: 'remove-service'; service_id: string }` | `{ ok: boolean; step: string; out: string; err: string; address: string; lines: string[] } \| Fail` (the port should always include `lines: []` on `Fail`, see 6.14) |
| `signer:deploy-ship` | `SshConn & { deploy_root: string; service_id: string; folder: string }` | `{ ok: true; dest: string; bytes: number; files: string; compose_from: string } \| Fail` |
| `signer:relay-call` | `{ network: Network; wallet?: string; service_id: string; method: string; path: string; body?: string }` | `{ ok: boolean; exit_code: number; http: number; ms: number; body: string; diagnostics: string; wallet: string } \| Fail` |
| `signer:validate-card` | `{ card_path: string; script: string }` | `{ ok: true; skipped: true; reason: string } \| { ok: boolean; code: number; output: string } \| Fail` |
| `signer:history` | `{}` | `{ ok: true; entries: Array<{ time: string; op: string; network?: string; service_id?: string; txhash?: string; code?: number; extra?: string; address?: string }> }` |

Recommended main-process shape: a single `SignerService` with one method per channel, a serial queue for every operation that opens the keyring or the volume (see 6.11), and a `runNative(exe, args, { env, stdin })` helper mirroring `Invoke-Native` (both streams collected, `windowsHide: true`, no shell). Timeouts move from the renderer poll to the handler (`AbortSignal`/`child.kill()` after the same per-operation limits listed in 6.9), and long-running steps can stream progress lines to the renderer over a `signer:progress` event without changing the result contract.

---

## 6. Known quirks a port must preserve or consciously replace

### 6.1 Docker stdin on Windows

Piping into `docker run -i` from PowerShell mangled lines, so the signer never uses docker's stdin. The text goes through `PSM_STDIN` in the docker CLI's environment and `printf "%s" "$PSM_STDIN" | pocketd ...` inside the container. `Invoke-Native` always redirects stdin and closes it immediately when nothing is supplied, so no child ever waits on input. Keep both behaviours; Node's `spawn` with `stdio: ['ignore', ...]` covers the second.

### 6.2 Environment-only secrets

`-e NAME` (no value) makes the docker CLI forward the variable from its own environment, so secrets never appear in `docker run` arguments (which would be visible in process listings). Variables used this way: `PSM_STDIN`, `PSM_IMPORT_KEY`, `POCKET_APP_PRIVATE_KEY`. In the HTA these were set on the whole HTA process for the duration of the launch (`run()` sets and removes them around `sh.Run`), which is a small exposure window the port removes by passing `env` to the specific child only.

### 6.3 Two quoting layers

Windows argument quoting (`Quote-Arg`) for the docker/ssh/scp/robocopy/tar/python process, and POSIX single-quoting (`Sh-Quote`) for the `sh -c` command inside the container. Values that reach `supplier.sh` over ssh are wrapped in single quotes without escaping, which is safe only because every such value was regex-validated first (ids, paths, URLs, hostnames). Keep the validations exactly; they are part of the injection defence.

### 6.4 Output parsing

- `Parse-FirstJson`: first `{` in stdout, then stderr (pocketd `keys add --output json` may print on either).
- `Parse-TxOutput`: stdout as JSON, else from the first `{`; `gas` from stderr `gas estimate:\s*(\d+)`.
- Transaction hash: `json.txhash`; result code `json.code` (0 = accepted by the node); `raw_log` echoed. Rejected-by-node results still get a history line.
- `relay-call`: HTTP status from stderr `upstream returned HTTP (\d{3})`.
- `supplier-run`: operator address from stdout `operator:\s*(pokt1[0-9a-z]{38})`; errors from stdout lines `^error:\s*(.*)$` (the last one wins); `ok` requires exit 0 and no error line.
- `ssh-test`: `PSM_KEYRING_OK` and `PSM_HAVE_RELAYER` (supplier-ship) sentinels in stdout.
- pocket-ap diagnostics regexes used by the UI: `session:\s*([0-9a-f]{8})` and `attempt \d+: (pokt1[0-9a-z]+) in (\d+ms) via (\S+) -> (\w+)`.

### 6.5 Error text cleaning

`Clean-Err`: drop blank lines; skip everything from a line starting `Usage:`, `Flags:`, `Global Flags:`, `Example:`/`Examples:` while subsequent lines start with `-`/`--`, `pocketd `, `$ `, or are indented two or more spaces; drop lines ending `.go:<n>`; drop Go frames starting `github.com/`, `net/http`, `reflect.`, `runtime.`, `main.`, `golang.org`, `google.golang.org`, `created by `; keep the last 3,000 characters.

`Summarize-Err` maps, in order: `card does not match the service card schema: ...` (verbatim up to `Re-run`), `code = NotFound ... account (pokt1...) not found` -> "The account <addr> does not exist on this network yet. It is created by its first deposit, so send it some POKT first.", `insufficient funds`, `account sequence mismatch`, `out of gas`, `too many failed passphrase attempts`, `duplicated address created`, `invalid mnemonic`; otherwise the last non-empty line, with `rpc error: code = X desc = ` stripped; `pocketd failed without a message.` when empty.

### 6.6 Truncations

`relay-call.body` first 200,000 chars; `relay-call.diagnostics` last 20,000; `supplier-run.out` last 20,000; `Clean-Err` last 3,000; the UI's fallback `detail` first 3,000.

### 6.7 Exit-code interpretation

- The signer exits 0 always; results are judged by the JSON `ok`. `.done` is ignored.
- docker/pocketd: non-zero exit is a failure except in `wallet-remove` (tolerated when the key is gone afterwards) and `remote-stake-supplier` (tolerated when stdout has `"txhash"`).
- ssh: 255 means connect/auth failure; `supplier.sh` steps return 1 on their own errors (with an `error:` line), 2 for an unknown step.
- robocopy: exit code 8 or higher is a failure (lower codes are informational).
- python (`validate-card`): 0 = card valid; non-zero = problems, with `output` shown.

### 6.8 Waiting for inclusion

The signer returns at mempool acceptance. `app.js` `pollTx(hash, cb)` queries `<lcd>/cosmos/tx/v1beta1/txs/<hash>` every 3 s for up to 180 s; `tx_response.code === 0` -> `{ ok: true, height }`; non-zero -> `{ ok: false, error: "Failed in block <h> with code <c>: <raw_log>" }`; timeout -> "Not seen in a block after 3 minutes. Check the Activity tab later; the tx hash is <hash>." `supplier.sh publish` does its own inclusion wait on the server (5 s x 60). The UI and the Electron signer measure the block time over the last 1,000 blocks; nothing assumes a fixed interval.

### 6.9 Timeouts (all in the UI today; none in the signer)

Default 240 s. Overrides: `image-pull` and `pocketap-pull` 900 s; `ssh-test` 60 s; `supplier-ship` 180 s; `supplier-run` operator 120 s, keys 120 s, publish 420 s, start 300 s, status 120 s, deploy 600 s, add-service 240 s; `deploy-ship` 600 s; `relay-call` 120 s. `Invoke-Native` has no timeout, so a hung child outlives the UI's timer today; the port should kill the child.

### 6.10 Network-specific defaults

| | beta | main |
|---|---|---|
| `--network` flag value | `beta` | `main` |
| Chain id (supplier-ship tokens) | `pocket-lego-testnet` | `pocket` |
| RPC (stack templates) | `https://sauron-rpc.beta.infra.pocket.network` | `https://sauron-rpc.infra.pocket.network` |
| gRPC (stack templates) | `sauron-grpc.beta.infra.pocket.network:443` | `sauron-grpc.infra.pocket.network:443` |
| LCD (UI reads) | `https://sauron-api.beta.infra.pocket.network` | `https://sauron-api.infra.pocket.network` |
| Explorer | `https://explorer.pocket.network/beta` | `https://explorer.pocket.network` |
| Block-time fallback | 30 s | 60 s |
| Stack ports (health, relayer metrics, miner metrics) | 8081, 9090, 9092 | 8082, 9091, 9093 |
| Stack dir / project default (UI) | `/opt/pocket/supplier-beta`, `pocket-supplier-beta` | `/opt/pocket/supplier-main`, `pocket-supplier-main` |

Chain values the UI reads live (never hardcoded): `add_service_fee`, application `min_stake` and `max_delegated_gateways`, supplier `min_stake`, `compute_units_to_tokens_multiplier`, `compute_unit_cost_granularity`, `num_blocks_per_session`, `session_grid_anchor_height`, `supplier_unbonding_period_sessions`, latest block height/time/chain id.

### 6.11 Concurrency

The HTA does not serialise signer calls. `state.busy` guards the transaction flows, but `docker-check` retries, `wallet-status`, `wallet-list`, and `history` can overlap each other and a transaction. Two `pocketd` processes on the same file keyring at once is possible today. The port should run keyring-touching operations through a single queue.

### 6.12 File encodings

Windows PowerShell 5.1 writes a UTF-8 BOM for `Set-Content`/`Add-Content -Encoding utf8` (`wallet.json`, `wallets.json`, `history.jsonl`). `keyring.pass.dpapi` is ASCII with a trailing newline (trimmed on read). Everything the signer writes for containers or servers is UTF-8 without BOM and LF-terminated (`[IO.File]::WriteAllText` with `UTF8Encoding($false)` and `-replace "`r`n", "`n"`). The UI writes its own files without BOM (`writeUtf8` strips it).

### 6.13 Self-test mode

There is no self-test in the signer. `app.js` enters `selftest()` when launched with `--selftest` or when `%LOCALAPPDATA%\PocketServiceManager\selftest.flag` exists (deleted on read). It sets `state.noSave`, exercises the read paths (`docker-check`, `wallet-status`, `wallet-list`, `history`, an unknown op `nope`), drives every preflight with test values (nothing is signed; `tx-add-service` is stubbed to return the most recent real tx hash from history so the post-broadcast path runs), creates a scratch service under `<StateDir>\selftest-services`, writes `<StateDir>\selftest.txt`, and closes the window. It references a real Beta test server entry (`servers/example-host`) via `state.serversOverride`.

### 6.14 Latent issues worth fixing in the port

- `supplier-run` on a validation `Fail` returns no `lines`; `runDeploy` then evaluates `r3.lines.slice(...)` and throws. Always return `lines: []`.
- `tx-stake-app` updates the wallet's `service_id` in `wallets.json` before knowing whether the transaction succeeded.
- `supplier-ship` leaks its work directory when the first ssh `mkdir` fails; several other paths remove it explicitly. Use try/finally.
- `wallet-import` with no sealed passphrase silently deletes the keyring volume and `wallets.json`; surface this in the UI before doing it.
- The history op for an application-wallet import is `wallet-import`, the same string as the owner import; only `extra: "name=..."` differs.
- `relay-call` sets `http = 200` on exit code 0 without evidence; the UI's grader relies on it.
- `Docker-Check` starts a container for `pocketd version` on every call, including the 10 s retry loop; cache the version after the first success.
- `ghcr.io/pokt-network/pocketd:latest` is unpinned; the UI's compat file (`mcp/src/compat.json`) is the place to record which pocketd the app was verified against.

### 6.15 Other behaviours to keep

- `wallet-status` reports `imported: true, verified: false` from `wallet.json` alone when Docker is down, so the UI can show the address without the keyring.
- `Register-Wallet` replaces an existing entry of the same name (the name check earlier makes this unreachable in practice, but it is the safe default).
- Addresses are always validated with `^pokt1[0-9a-z]{38}$`; wallet names `^[a-z0-9][a-z0-9_-]{0,39}$`; service ids `^[A-Za-z0-9_-]{1,42}$`; service names `^[A-Za-z0-9 _-]{1,169}$`; compute units 1 to 1,048,576; card size at most 262,144 bytes; stack and deploy paths `^/[A-Za-z0-9._/-]+$`; backend URL `^http://[A-Za-z0-9._-]+:[0-9]{2,5}$`; endpoint URL `^https://[^\s]+$`; hostnames `^[A-Za-z0-9.-]+$` (the UI additionally requires a dot and a TLD for the public hostname).
- All timestamps are UTC ISO 8601 round-trip format (`o`), e.g. `2026-09-14T10:11:12.1234567Z`.
- The per-service manifest (`services/<id>/service.json`, written by the UI, not the signer) carries `service_id`, `name`, `compute_units_per_relay`, `card`, optional `application_stake_pokt`, and `networks.<beta|main>` with `register_tx`, `last_update_tx`, `app_stake_tx`, `app_wallet`, `app_address`, `supplier_stake_tx`, `supplier_operator`, `supplier_url`, `deploy_host`, `deploy_path`, `deployed_at`. The renderer will keep writing these.
