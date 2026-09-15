// Every path the main process uses, in one place (docs/PACKAGING.md section 1).
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { APP_DATA_DIR_NAME, HTA_STATE_DIR_NAME } from '@core/versions'

/** Must run before app.whenReady so userData is `%APPDATA%\Pocket Service Manager` regardless of package name. */
export function configureAppPaths(): void {
  app.setPath('userData', join(app.getPath('appData'), APP_DATA_DIR_NAME))
}

export function dataDir(): string {
  return app.getPath('userData')
}

/** resources/ in development, process.resourcesPath when packaged. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

export function serverTemplatesDir(): string {
  return join(resourcesDir(), 'server')
}

export function fontsDir(): string {
  return join(resourcesDir(), 'fonts')
}

export const dataFiles = {
  settings: (): string => join(dataDir(), 'settings.json'),
  wallet: (): string => join(dataDir(), 'wallet.json'),
  wallets: (): string => join(dataDir(), 'wallets.json'),
  history: (): string => join(dataDir(), 'history.jsonl'),
  relayTests: (): string => join(dataDir(), 'relay-tests.log'),
  passEnc: (): string => join(dataDir(), 'keyring.pass.enc'),
  appLog: (): string => join(dataDir(), 'app.log'),
  runs: (): string => join(dataDir(), 'runs'),
  work: (): string => join(dataDir(), 'work'),
  selftest: (): string => join(dataDir(), 'selftest.txt')
}

/** The HTA's state folder. Read once by the importer; never written. */
export function htaStateDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local')
  return join(base, HTA_STATE_DIR_NAME)
}

export const htaFiles = {
  settings: (): string => join(htaStateDir(), 'settings.json'),
  wallet: (): string => join(htaStateDir(), 'wallet.json'),
  wallets: (): string => join(htaStateDir(), 'wallets.json'),
  history: (): string => join(htaStateDir(), 'history.jsonl'),
  relayTests: (): string => join(htaStateDir(), 'relay-tests.log'),
  passDpapi: (): string => join(htaStateDir(), 'keyring.pass.dpapi')
}

/** Prefers the Windows OpenSSH client and the Windows tar, as the HTA did. */
export function toolPath(name: 'ssh' | 'scp' | 'tar' | 'robocopy' | 'docker' | 'python'): string {
  const sys = process.env.SystemRoot ?? 'C:\\Windows'
  if (name === 'ssh' || name === 'scp') {
    const p = join(sys, 'System32', 'OpenSSH', `${name}.exe`)
    if (existsSync(p)) return p
  }
  if (name === 'tar') {
    const p = join(sys, 'System32', 'tar.exe')
    if (existsSync(p)) return p
  }
  return name
}
