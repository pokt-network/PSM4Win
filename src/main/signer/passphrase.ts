// The keyring passphrase: 32 random bytes as base64, sealed with Electron
// safeStorage (DPAPI, current user) in <data>/keyring.pass.enc. Unsealed into
// memory for one operation and dropped. The HTA's keyring.pass.dpapi is read
// only by the importer (src/main/migration), never here.
import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dataFiles } from '../paths'
import { ensureDir, exists, removeFile } from '../state/files'
import { fail } from '@core/errors'
import { RE } from '@core/validate'
import { dirname } from 'node:path'

export function newPassphrase(): string {
  return randomBytes(32).toString('base64')
}

export function hasSealedPassphrase(): boolean {
  return exists(dataFiles.passEnc())
}

export async function sealPassphrase(plain: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable())
    fail('Windows data protection is not available, so the keyring passphrase cannot be sealed.')
  if (!RE.passphrase.test(plain)) fail('The passphrase has an unexpected shape and was not sealed.')
  await ensureDir(dirname(dataFiles.passEnc()))
  await fs.writeFile(dataFiles.passEnc(), safeStorage.encryptString(plain))
}

/** Returns the plain passphrase, or null when no sealed file exists. */
export async function unsealPassphrase(): Promise<string | null> {
  if (!hasSealedPassphrase()) return null
  if (!safeStorage.isEncryptionAvailable())
    fail('Windows data protection is not available, so the keyring passphrase cannot be unsealed.')
  const buf = await fs.readFile(dataFiles.passEnc())
  const plain = safeStorage.decryptString(buf)
  if (!RE.passphrase.test(plain))
    fail('The sealed passphrase did not unseal to the expected shape.')
  return plain
}

export async function requirePassphrase(): Promise<string> {
  const p = await unsealPassphrase()
  if (!p)
    fail(
      'No sealed passphrase exists on this machine, so the keyring cannot be opened. Import the owner wallet first.'
    )
  return p
}

export async function deleteSealedPassphrase(): Promise<void> {
  await removeFile(dataFiles.passEnc())
}
