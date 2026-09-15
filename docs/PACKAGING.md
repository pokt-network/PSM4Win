# Packaging, CI, and code signing

Windows only. The macOS app is a separate effort outside this repository; nothing here should pre-empt it beyond the existing `# phase 3` markers.

> The in-app updater (docs/ARCHITECTURE.md section 8) reads the latest GitHub release and depends on three asset names staying exactly as the workflow produces them: `PocketServiceManager-Setup-<version>.exe`, `PocketServiceManager-<version>-win-x64.zip`, and `SHA256SUMS`. Tags are `v<version>` and must match `package.json`.

## 1. electron-builder

Config in `electron-builder.yml` at the repo root:

```yaml
appId: network.pocket.servicemanager
productName: Pocket Service Manager
directories:
  output: release
  buildResources: build
files:
  - out/**            # electron-vite output
  - package.json
extraResources:
  - from: resources/server
    to: server         # what Provision ships; byte-identical to reference/hta-app/server
  - from: resources/fonts
    to: fonts
win:
  target:
    - target: nsis      # installer, on the releases page
      arch: [x64]
    - target: zip       # portable build, what the Scoop bucket installs (section 4)
      arch: [x64]
  icon: build/pocket.ico
  artifactName: PocketServiceManager-${version}-win-${arch}.${ext}   # nsis: override to PocketServiceManager-Setup-${version}.exe
  # signing: see section 3; leave unset until credentials exist
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Pocket Service Manager
  deleteAppDataOnUninstall: false   # never delete the data folder; it holds the sealed passphrase
# mac:  # phase 3
```

- `build/pocket.ico` is `reference/hta-app/assets/pocket.ico`.
- `deleteAppDataOnUninstall` must stay false. Uninstalling must not destroy `keyring.pass.enc`; the keyring volume in Docker would become unreadable and the user would have to re-import keys.
- The app reads `process.resourcesPath` for `server/` and `fonts/` in production and the repo paths in development; keep that in one `paths.ts`.

## 2. GitHub Actions

`.github/workflows/build.yml`: on push of a tag `v*` and on manual dispatch.

```yaml
name: build
on:
  push:
    tags: ['v*']
  workflow_dispatch:
jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck && npm test
      - run: npm run build          # electron-vite build
      - run: npx electron-builder --win --publish never
        env:
          # signing credentials go here when they exist; see section 3
          CSC_IDENTITY_AUTO_DISCOVERY: false
      - run: node scripts/checksums.mjs release   # writes release/SHA256SUMS for the .exe and .zip
      - uses: actions/upload-artifact@v4
        with: { name: windows-build, path: "release/*.exe\nrelease/*.zip\nrelease/SHA256SUMS" }
      # on a tag: attach the three files to the GitHub release, then
      # node scripts/update-bucket.mjs <version> release/SHA256SUMS && commit bucket/ to main (section 4.3)
  # macos:  # phase 3: runs-on macos-latest, DMG, notarisation
```

Releases: `electron-builder --publish always` with a `GH_TOKEN` attaches the installer to the GitHub release for the tag. Auto-update through `electron-updater` against GitHub releases is optional and only sensible once builds are signed, because an unsigned update prompts the same warnings as a fresh install.

## 3. Code signing

Unsigned builds work and are fine for development. A browser-downloaded unsigned installer is not a usable path for users: current Windows 11 installs refuse to run it outright, and upgraded installs make the bypass hard to find (product owner, from earlier Electron builds). Scoop is therefore the only supported install path until signing exists. Signing removes the "Unknown publisher" line immediately and the SmartScreen warning after reputation builds (immediately with EV or with Azure Trusted Signing once trusted).

Since June 2023 every code-signing private key must live in certified hardware or a cloud HSM; a `.pfx` file is no longer issued for OV or EV certificates. Options, in order of preference:

| Route | Cost | Requirements | CI friendly | Notes |
|---|---|---|---|---|
| Azure Trusted Signing | about $10/month | Azure subscription; organisation validation (legal entity, typically 3+ years of verifiable history) or individual validation where offered | Yes: `electron-builder` `win.azureSignOptions` with the endpoint, account, and certificate profile; auth via `azure/login` in the workflow | Short-lived certificates issued by Microsoft, good SmartScreen standing quickly |
| OV certificate, cloud signing (SSL.com eSigner, DigiCert KeyLocker, Sectigo cloud) | $200 to $500/year | Organisation or individual validation: registration document, government ID for individuals, one verification callback to a number the CA finds in an independent source (D&B listing, registry, or an attorney/accountant letter). No staffed line needed. | Yes, with the provider's signing tool called from a custom `sign` script | Reputation builds with downloads |
| OV certificate on a USB token | same | same | No: the token must be plugged into the signing machine | Sign locally on the developer PC, upload the signed installer |
| EV certificate | $300 to $700/year | Legal entity only, stricter validation | Depends on delivery (cloud or token) | Immediate SmartScreen reputation |

Individual validation removes the company phone question entirely: the certificate names the person, and the callback goes to their own mobile.

Wiring, kept disabled until credentials exist:

```yaml
# electron-builder.yml, under win:
#  azureSignOptions:
#    endpoint: https://<region>.codesigning.azure.net
#    codeSigningAccountName: <account>
#    certificateProfileName: <profile>
# or, for a provider signing tool:
#  sign: ./build/sign.js
```

`build/sign.js` receives `{ path, hash, isNest }` from electron-builder and calls the provider's CLI with credentials from environment variables. It must exit non-zero on failure so an unsigned artifact is never published by accident once signing is on. Never commit a certificate, a token PIN, or a provider API key; they are GitHub Actions secrets or local environment variables.

Timestamping: whichever route, sign with an RFC 3161 timestamp so signatures outlive the certificate.

## 4. Distribution: Scoop is the only supported channel

Decided 2026-09-14. SmartScreen's "Windows protected your PC" dialog fires only for executables that carry Mark-of-the-Web, which browsers attach on download. Scoop downloads with its own client, verifies a SHA-256 from the manifest, and extracts a portable zip, so nothing in that path carries the mark and an unsigned build runs without a warning. This is the normal way node-operator and developer tooling ships. The installer and the portable zip stay on the releases page because Scoop installs from the zip and the checksums live beside it, not as a manual install path: Windows blocks the unsigned files when a browser downloads them.

Rejected on the way here: a downloadable `.cmd` launcher that fetches the package with `curl`. The batch file itself carries the mark and is checked by SmartScreen, batch files cannot be signed so the warning never ages out, and a script that downloads and runs an executable is the shape of a dropper to antivirus heuristics. winget is a later addition for reach, not a bypass: it applies the mark and runs SmartScreen URL checks, and every version needs a reviewed manifest pull request.

### 4.1 What the user does

Four lines in the README, in this order. No administrator rights.

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser   # once; Windows ships with scripts disabled
irm get.scoop.sh | iex                                        # once, if Scoop is not installed (not as administrator)
scoop install git                                             # once; buckets are git clones
scoop bucket add pocket https://github.com/pokt-network/PSM4Win       # once
scoop install pocket-service-manager
scoop update pocket-service-manager                           # every later version
```

Docker Desktop is a prerequisite Scoop cannot install; the README lists it with its download link or `winget install Docker.DockerDesktop`. The app also detects its absence and says so on the first screen, as the HTA did.

### 4.2 The bucket lives in this repo

A Scoop bucket is a git repository with a `bucket/` folder of JSON manifests. Scoop clones the whole repo and reads that folder, so `bucket/pocket-service-manager.json` at the root of this repository is the bucket. `scoop update` pulls the repo; at this size that is fine.

```json
{
  "version": "0.1.0",
  "description": "Register, stake, supply, deploy, and test services on Pocket Network.",
  "homepage": "https://github.com/pokt-network/PSM4Win",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "https://github.com/pokt-network/PSM4Win/releases/download/v0.1.0/PocketServiceManager-0.1.0-win-x64.zip",
      "hash": "sha256:<hash of that zip>"
    }
  },
  "shortcuts": [["Pocket Service Manager.exe", "Pocket Service Manager"]],
  "checkver": "github",
  "autoupdate": {
    "architecture": {
      "64bit": {
        "url": "https://github.com/pokt-network/PSM4Win/releases/download/v$version/PocketServiceManager-$version-win-x64.zip",
        "hash": { "url": "$baseurl/SHA256SUMS" }
      }
    }
  }
}
```

Scoop installs into `%USERPROFILE%\scoop\apps\pocket-service-manager\<version>\` with a `current` junction and a Start menu shortcut under "Scoop Apps". The app's data folder is `%APPDATA%\Pocket Service Manager` regardless of how it was installed, so upgrades and `scoop uninstall` never touch settings or the sealed passphrase. No `persist` entry is needed.

### 4.3 What the build must produce

- `win.target: [nsis, zip]` in `electron-builder.yml`. The zip target packages `win-unpacked` as `PocketServiceManager-<version>-win-x64.zip` with `Pocket Service Manager.exe` at its top level; set `artifactName` per target so the names above hold.
- A `SHA256SUMS` file listing both artifacts, generated in CI after the build and uploaded with the release. Scoop's `autoupdate.hash.url` reads the zip's line from it.
- The release workflow's last job, after the artifacts are attached: rewrite `version`, `url`, and `hash` in `bucket/pocket-service-manager.json` and commit to `main` with the message `Bucket: <version>`. Because the hash is known at build time there is no need for Scoop's excavator action; do it directly with a small Node script.

### 4.4 Updates inside the app

`electron-updater` works only for the NSIS install; it cannot rewrite files inside a Scoop version folder. So:

- The build sets a flag (`process.env.PSM_CHANNEL` baked at build time, or detect the `scoop\apps` path at runtime) and the portable build never initialises the updater.
- Every build checks the latest GitHub release on start and once a day, and shows a banner when it is newer. On the NSIS install the banner offers "Update now" through `electron-updater` once builds are signed, and a download link before that. On the Scoop install it shows `scoop update pocket-service-manager` with a "Copy command" button. This is the one place a command reaches the user; it is the channel they chose, so it stays.

### 4.5 README section

The public README's install section is the Docker Desktop prerequisite, the Scoop sequence (execution policy, Scoop, git, bucket, install, update) as one command per block, a sentence saying Scoop is the only supported way to install and why, and one line saying the releases page holds the files Scoop installs and their checksums, not a manual install path. Nothing else.

## 5. README screenshot

`npm run screenshot` builds the app and runs it with `--screenshot=docs/images/dashboard.png`: the window opens on the Dashboard filled with example data (`src/renderer/src/lib/demo.ts`: placeholder addresses, an example server and stack, two example services, a short activity list; governance parameters and the block height still come from the live network), waits six seconds, captures itself, and exits. No settings, keyring, or history is read. Re-run it whenever the Dashboard changes and commit the PNG.

## 6. Versioning

- `package.json` `version` is the app version; the tag is `v<version>`; the compat string is `electron-<version>`.
- Bump the version, update `reference/mcp/src/compat.json` (and the copy in the service-builder repository) when capabilities change, tag, push, and let the workflow build, publish, and commit the bucket manifest.
- Keep a `CHANGELOG.md` with one line per user-visible change; the Settings screen shows the version and the pinned `pocketd` tag.
