# Migration: importing the HTA's data into the Electron app

Scope for this phase: the same Windows PC and the same Windows user account. The Electron app takes over the HTA's settings, wallet metadata, activity, and test log, and keeps using the HTA's Docker keyring volume. Nothing is retyped and no key is re-imported. Moving to another machine (the encrypted export and import bundle) is a later phase.

## 1. Where the HTA keeps things

| Data | Location | Secret? | Migrate? |
|---|---|---|---|
| Settings: network, theme, last tab, last service, services folder, server list, supplier server, welcome flag | `%LOCALAPPDATA%\PocketServiceManager\settings.json` | No (contains SSH hosts, user names, and the path of the SSH key file on this PC) | Copy |
| Owner wallet metadata | `...\wallet.json` | No (name and address) | Copy |
| Application wallets | `...\wallets.json` | No (name, address, service) | Copy |
| Activity | `...\history.jsonl` | No | Copy |
| Relay test log | `...\relay-tests.log` | No | Copy |
| Keyring passphrase | `...\keyring.pass.dpapi` | Yes. 32 random bytes sealed with Windows DPAPI in `CurrentUser` scope. | Unseal once, re-seal with `safeStorage`, never copy the file |
| The keyring itself | Docker volume `pocket-service-manager-keyring` | Yes, encrypted by `pocketd` with the passphrase | Do not touch. Both apps use the same volume. |
| Scratch | `...\runs\`, `...\work\`, `...\selftest.txt` | No | Ignore |
| Service folders | `settings.servicesRoot`, or the HTA's default `<service-builder repo>\services\` when unset | No | Do not copy. Record the absolute path in the new settings. |
| Operator keys, RelayMiner stacks, Caddy | On each supplier host under the server entry's `deployRoot` | Yes, on the server | Nothing to do. The server entries in settings point at them. |
| Docker images | `ghcr.io/pokt-network/pocketd`, `pocket-ap` | No | Nothing to do; already on this machine. |

## 2. File shapes as written by the HTA

`settings.json` (observed on 2026-09-14; every key optional, the HTA fills defaults):

```json
{
  "network": "beta | main",
  "theme": "light | dark",
  "lastTab": "string",
  "lastService": "string (service id)",
  "servicesRoot": "absolute path, or absent/empty for the default",
  "supplierServer": "string (server name)",
  "welcomeSeen": true,
  "servers": [
    {
      "name": "string",
      "host": "string",
      "port": 22,
      "user": "string",
      "keyPath": "absolute path of the SSH private key on this PC",
      "deployRoot": "/opt/pocket",
      "suppliers": {
        "beta": { "dir": "string", "project": "string", "url": "https://...", "operator": "pokt1...", "provisioned_at": "ISO date" },
        "main": { "dir": "string", "project": "string", "url": "https://...", "operator": "pokt1...", "provisioned_at": "ISO date" }
      }
    }
  ]
}
```

`wallet.json` and `wallets.json` are written by `signer.ps1` and may start with a UTF-8 byte-order mark. Their exact fields are in `SIGNER-CONTRACT.md` (wallet-import, wallet-create, wallet-list). `history.jsonl` is one JSON object per line; the record shape is in the contract under the transaction operations.

## 3. The importer

Runs from the first-run screen of the Electron app ("Import from Pocket Service Manager"), and again from Settings if the user skips it. Idempotent: it can be re-run and overwrites only what it imported before.

1. **Detect.** If `%LOCALAPPDATA%\PocketServiceManager\settings.json` or `wallet.json` exists, offer the import. Show what was found: network, number of servers, owner wallet address, application wallets by name, number of activity records.
2. **Confirm the services folder.** Compute the HTA's default services root the way `app.js` did: the HTA lived at `<repo>\tools\service-manager\`, so the default was `<repo>\services\`. The importer cannot know where the HTA was, so: if `settings.servicesRoot` is set and exists, use it; otherwise show a folder picker preset to the last known location and require the user to confirm. Write the absolute path into the new `settings.servicesRoot`. Verify it contains at least one folder with a `service.json` and list them.
3. **Copy the plain files.** `settings.json` (with `servicesRoot` resolved, plus `schemaVersion: 1` and `importedFrom: { path, at }`), `wallet.json`, `wallets.json`, `history.jsonl`, `relay-tests.log`. Strip byte-order marks when parsing; write UTF-8 without BOM. Do not copy `runs/`, `work/`, or `selftest.txt`.
4. **Check the SSH key paths.** For each server entry, check that `keyPath` exists. Report missing ones; do not fail the import.
5. **Re-seal the passphrase.** This is the only step that touches a secret. The HTA's file format (`SIGNER-CONTRACT.md` section 4): one ASCII line of lowercase hex, produced by PowerShell's `ConvertFrom-SecureString`, which is a DPAPI blob (`CurrentUser` scope, no optional entropy) of the passphrase's UTF-16LE bytes. The passphrase itself is 44 characters of Base64 (32 random bytes).
   - Read `keyring.pass.dpapi` as text and trim it.
   - Unseal it with the exact inverse the HTA uses, `ConvertTo-SecureString` followed by `SecureStringToBSTR`, in a one-shot PowerShell child (below). This avoids depending on the hex framing.
   - Check the result matches `^[A-Za-z0-9+/]{43}=$`.
   - Seal the result with `safeStorage.encryptString` and write `keyring.pass.enc` into the Electron data folder. The two file formats are not interchangeable: `safeStorage` on Windows wraps DPAPI in Chromium's own framing.
   - Immediately verify: run the signer's `wallet-list` (read-only, no signing) with the re-sealed passphrase and check that the addresses match `wallet.json` and `wallets.json`. If they do not match, delete `keyring.pass.enc` and report the failure.
   - Zero the buffers. Never log the value, its length, or its base64.
   - The HTA's file is left in place, untouched, so the HTA keeps working.
6. **Check Docker.** Confirm the `pocket-service-manager-keyring` volume exists and the pinned `pocketd` image is present; offer to pull it otherwise.
7. **Report.** A narrated run, like every other multi-step operation, ending with the counts imported and the verification result.

### DPAPI unseal without a native module

Node has no DPAPI binding, and adding a native dependency for a single one-time call is not worth it. Spawn Windows PowerShell once with an argument array, the script passed encoded, the sealed hex passed through the environment, output on stdout only, and no files. The script is the HTA's own `Unseal-Passphrase` verbatim, so the framing question never arises:

```ts
import { spawn } from 'node:child_process';

export function unsealHtaPassphrase(sealedHex: string): Promise<string> {
  const script = `
    $s = ConvertTo-SecureString $env:PSM_SEALED
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  `;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, PSM_SEALED: sealedHex.trim() },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', () => { /* never surface stderr unredacted */ });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('DPAPI unseal failed (code ' + code + ')'));
      const pass = Buffer.concat(out).toString('utf8');
      if (!/^[A-Za-z0-9+/]{43}=$/.test(pass)) return reject(new Error('Unsealed value has an unexpected shape.'));
      resolve(pass);
    });
  });
}
```

Then:

```ts
import { safeStorage } from 'electron';
const pass = await unsealHtaPassphrase(await fs.readFile(htaPassPath, 'utf8'));
if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
await fs.writeFile(path.join(userData, 'keyring.pass.enc'), safeStorage.encryptString(pass));
```

The passphrase is handed to `pocketd` as that exact string, piped twice inside the container through the `PSM_STDIN` environment variable (`SIGNER-CONTRACT.md` section 4.4). A value that differs by one encoding step opens nothing, which is why step 5 verifies with `wallet-list` before the import is declared done.

Note for Claude sessions in the new repo: the transaction guard hook blocks shell commands containing `ConvertTo-SecureString` or the passphrase file name. That is intended. The importer runs inside the app; test it by running the app, not by pasting its script into a session.

## 4. Coexistence during phase 2

- Both apps read the same keyring volume with the same passphrase. Balances, stakes, and services are on chain, so both show the same state.
- `settings.json`, `wallets.json`, and `history.jsonl` are separate copies after the import. Anything done in one app after the import is not reflected in the other's lists. Creating an application wallet in the HTA after the import, for example, puts a key in the shared keyring that the Electron app's `wallets.json` does not list, and the Electron signer will refuse to sign with an unlisted wallet. Re-running the importer copies the lists again.
- **Revoke in either app deletes the shared keyring volume for both.** Do not use it during the transition.
- When the Electron app reaches parity, the HTA's state folder can be archived. The keyring volume stays; it belongs to whichever app is current.

## 5. Verification checklist

After the import, on Beta TestNet:

- Owner wallet card shows the same address and balance as the HTA.
- Wallets screen lists the same application wallets with the same stakes.
- Settings lists the same servers, and Test connection succeeds for each.
- My services shows the same services with the same lifecycle status.
- Activity shows the same records with working explorer links.
- A read-only signer operation (`wallet-status` or `wallet-list`) succeeds without a passphrase prompt.
- No secret appears in `app.log`.
