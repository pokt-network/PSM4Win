// The same-PC importer (docs/MIGRATION.md section 3). Reads the HTA's state
// folder once, copies the plain files, re-seals the passphrase with safeStorage,
// and verifies the keyring opens before declaring success. Never writes to the
// HTA's folder.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { htaFiles, htaStateDir, dataFiles } from '../paths'
import {
  readJson,
  readText,
  writeJson,
  writeText,
  exists,
  readJsonLines,
  removeFile
} from '../state/files'
import {
  readSettings,
  writeSettings,
  invalidateSettings,
  type Settings,
  type ServerEntry
} from '../state/settings'
import { sealPassphrase, hasSealedPassphrase } from '../signer/passphrase'
import { unsealHtaPassphrase } from './dpapi'
import { signer } from '../signer'
import { expandHome } from '../signer/ssh'
import { log } from '../state/log'
import { nowIso, stripBom } from '@core/text'
import type { HistoryEntry, ProgressEvent } from '@core/contract'
import type { Network } from '@core/networks'
import type { WalletRecord } from '@core/contract'

export interface HtaDetection {
  found: boolean
  path: string
  network?: Network
  servers: number
  ownerAddress?: string
  appWallets: string[]
  historyRecords: number
  servicesRoot?: string
  hasSealedPassphrase: boolean
  alreadyImported: boolean
}

interface HtaSettings {
  network?: Network
  theme?: 'light' | 'dark'
  lastTab?: string
  lastService?: string
  servicesRoot?: string
  supplierServer?: string
  welcomeSeen?: boolean
  servers?: ServerEntry[]
}

export async function detectHta(): Promise<HtaDetection> {
  const path = htaStateDir()
  const settings = await readJson<HtaSettings>(htaFiles.settings())
  const wallet = await readJson<{ address?: string }>(htaFiles.wallet())
  const found = !!settings || !!wallet
  const walletsFile = await readJson<{ wallets?: WalletRecord[] }>(htaFiles.wallets())
  const history = found ? await readJsonLines<HistoryEntry>(htaFiles.history()) : []
  const current = await readSettings()
  return {
    found,
    path,
    network: settings?.network,
    servers: Array.isArray(settings?.servers) ? settings!.servers!.length : 0,
    ownerAddress: wallet?.address,
    appWallets: (walletsFile?.wallets ?? []).map((w) => w.name),
    historyRecords: history.length,
    servicesRoot: settings?.servicesRoot,
    hasSealedPassphrase: exists(htaFiles.passDpapi()),
    alreadyImported: !!current.importedFrom
  }
}

export interface ImportOptions {
  /** The confirmed services folder. Required when the HTA's setting is absent or does not exist. */
  servicesRoot?: string
  progress?: (ev: Omit<ProgressEvent, 'runId' | 'op' | 'time'>) => void
}

export interface ImportResult {
  ok: boolean
  error?: string
  settings: boolean
  wallet: boolean
  wallets: number
  history: number
  relayTests: boolean
  passphrase: 'resealed' | 'kept' | 'absent' | 'failed'
  verified: boolean
  missingKeys: string[]
  servicesRoot?: string
  serviceFolders: string[]
}

export async function importFromHta(opts: ImportOptions = {}): Promise<ImportResult> {
  const say = (level: ProgressEvent['level'], text: string, sub?: string): void => {
    opts.progress?.({ level, text, sub, step: 'import' })
    log.info('import: ' + text, sub ? { sub } : undefined)
  }
  const res: ImportResult = {
    ok: false,
    settings: false,
    wallet: false,
    wallets: 0,
    history: 0,
    relayTests: false,
    passphrase: 'absent',
    verified: false,
    missingKeys: [],
    serviceFolders: []
  }
  const det = await detectHta()
  if (!det.found) {
    res.error = 'No Pocket Service Manager (HTA) data was found on this PC.'
    say('fail', res.error, det.path)
    return res
  }
  say('info', `Found the HTA's data folder`, det.path)

  // 2. Services folder.
  const hta = (await readJson<HtaSettings>(htaFiles.settings())) ?? {}
  let servicesRoot = opts.servicesRoot ?? hta.servicesRoot ?? ''
  if (servicesRoot && !exists(servicesRoot)) {
    say('warn', 'The services folder recorded by the HTA does not exist on this PC.', servicesRoot)
    if (!opts.servicesRoot) servicesRoot = ''
  }
  if (servicesRoot) {
    try {
      for (const d of await fs.readdir(servicesRoot, { withFileTypes: true })) {
        if (d.isDirectory() && exists(join(servicesRoot, d.name, 'service.json')))
          res.serviceFolders.push(d.name)
      }
      say(
        'ok',
        `Services folder confirmed with ${res.serviceFolders.length} service folder(s).`,
        servicesRoot
      )
    } catch {
      say('warn', 'Could not list the services folder.', servicesRoot)
    }
    res.servicesRoot = servicesRoot
  } else {
    say('warn', 'No services folder was confirmed; choose one in Settings.')
  }

  // 3. Plain files.
  const merged: Partial<Settings> = {
    schemaVersion: 1,
    network: hta.network === 'main' ? 'main' : 'beta',
    theme: hta.theme === 'dark' ? 'dark' : 'light',
    lastTab: hta.lastTab,
    lastService: hta.lastService,
    servicesRoot: servicesRoot || undefined,
    supplierServer: hta.supplierServer,
    welcomeSeen: hta.welcomeSeen,
    servers: Array.isArray(hta.servers) ? hta.servers : [],
    importedFrom: { path: det.path, at: nowIso() }
  }
  await writeSettings(merged)
  invalidateSettings()
  res.settings = true
  say('ok', 'Settings copied.')

  const walletText = await readText(htaFiles.wallet())
  if (walletText) {
    try {
      await writeJson(dataFiles.wallet(), JSON.parse(stripBom(walletText)))
      res.wallet = true
      say('ok', 'Owner wallet record copied.')
    } catch {
      say('warn', 'wallet.json could not be parsed and was skipped.')
    }
  }
  const walletsJson = await readJson<{ wallets?: WalletRecord[] }>(htaFiles.wallets())
  if (walletsJson && Array.isArray(walletsJson.wallets)) {
    await writeJson(dataFiles.wallets(), { wallets: walletsJson.wallets })
    res.wallets = walletsJson.wallets.length
    say('ok', `${res.wallets} application wallet record(s) copied.`)
  }
  const history = await readJsonLines<HistoryEntry>(htaFiles.history())
  if (history.length) {
    await writeText(dataFiles.history(), history.map((h) => JSON.stringify(h)).join('\n') + '\n')
    res.history = history.length
    say('ok', `${res.history} activity record(s) copied.`)
  }
  const relay = await readText(htaFiles.relayTests())
  if (relay !== null) {
    await writeText(dataFiles.relayTests(), relay)
    res.relayTests = true
    say('ok', 'Relay test log copied.')
  }

  // 4. SSH key paths.
  for (const s of merged.servers ?? []) {
    const kp = expandHome(String(s.keyPath ?? ''))
    if (!kp || !exists(kp)) res.missingKeys.push(s.name)
  }
  if (res.missingKeys.length) say('warn', `SSH key file missing for: ${res.missingKeys.join(', ')}`)

  // 5. Re-seal the passphrase.
  if (hasSealedPassphrase()) {
    res.passphrase = 'kept'
    say('info', 'A sealed passphrase already exists in this app; keeping it.')
  } else if (exists(htaFiles.passDpapi())) {
    try {
      const sealedHex = (await readText(htaFiles.passDpapi())) ?? ''
      let pass: string | null = await unsealHtaPassphrase(sealedHex)
      await sealPassphrase(pass)
      pass = null
      res.passphrase = 'resealed'
      say('ok', 'Keyring passphrase re-sealed for this app.')
    } catch (e) {
      res.passphrase = 'failed'
      res.error = 'The keyring passphrase could not be re-sealed: ' + (e as Error).message
      say('fail', res.error)
      return res
    }
  } else {
    say(
      'warn',
      'The HTA has no sealed passphrase; the keyring cannot be opened until the owner wallet is imported.'
    )
  }

  // 5b. Verify with a read-only operation.
  if (res.passphrase === 'resealed' || res.passphrase === 'kept') {
    say('info', 'Checking that the keyring opens with the re-sealed passphrase.')
    const list = await signer.run('wallet-list', {})
    if (list.ok && list.verified) {
      const ownerOk = !list.parent || list.parent.present === true
      const appsOk = list.wallets.every((w) => w.present === true)
      res.verified = ownerOk && appsOk
      if (res.verified) say('ok', 'Keyring verified: every recorded wallet is present.')
      else say('warn', 'The keyring opened, but not every recorded wallet is present in it.')
    } else if (list.ok && !list.verified) {
      say(
        'warn',
        'The keyring could not be verified (Docker down, image missing, or the passphrase did not open it).'
      )
      if (res.passphrase === 'resealed') {
        // A passphrase that does not open the keyring is worse than none: drop it.
        const dc = await signer.run('docker-check', {})
        if (dc.ok && dc.image) {
          await removeFile(dataFiles.passEnc())
          res.passphrase = 'failed'
          res.error = 'The re-sealed passphrase did not open the keyring; it was discarded.'
          say('fail', res.error)
          return res
        }
      }
    } else {
      say('warn', 'wallet-list failed during verification.', (list as { error?: string }).error)
    }
  }

  // 6. Docker.
  const dc = await signer.run('docker-check', {})
  if (!dc.ok) say('warn', 'Docker Desktop is not running; the keyring volume could not be checked.')
  else if (!dc.image)
    say('warn', 'The pinned pocketd image is not downloaded yet. Use "Download pocketd".')
  else say('ok', `Docker ${dc.docker}, pocketd ${dc.pocketd}`)

  res.ok = true
  say('ok', 'Import finished.')
  return res
}
