// wallet.json (owner) and wallets.json (application wallets). Nothing secret.
import { dataFiles } from '../paths'
import { readJson, writeJson, removeFile, exists } from './files'
import { addHistory } from './history'
import { OWNER_KEY_NAME, KEYRING_VOLUME } from '@core/versions'
import type { WalletRecord, WalletSource } from '@core/contract'
import { nowIso } from '@core/text'

export interface OwnerWallet {
  name: string
  address: string
  imported_at: string
  volume: string
}

export async function readOwnerWallet(): Promise<OwnerWallet | null> {
  const w = await readJson<OwnerWallet>(dataFiles.wallet())
  return w && typeof w.address === 'string' ? w : null
}

export async function writeOwnerWallet(address: string): Promise<OwnerWallet> {
  const w: OwnerWallet = {
    name: OWNER_KEY_NAME,
    address,
    imported_at: nowIso(),
    volume: KEYRING_VOLUME
  }
  await writeJson(dataFiles.wallet(), w)
  return w
}

export function ownerWalletExists(): boolean {
  return exists(dataFiles.wallet())
}

export async function readWallets(): Promise<WalletRecord[]> {
  const j = await readJson<{ wallets?: unknown }>(dataFiles.wallets())
  if (!j || !Array.isArray(j.wallets)) return []
  return (j.wallets as Partial<WalletRecord>[])
    .filter((w) => w && typeof w.name === 'string')
    .map((w) => ({
      name: String(w.name),
      address: String(w.address ?? ''),
      service_id: String(w.service_id ?? ''),
      created_at: String(w.created_at ?? ''),
      source: (w.source as WalletSource) ?? 'import'
    }))
}

export async function saveWallets(list: WalletRecord[]): Promise<void> {
  await writeJson(dataFiles.wallets(), { wallets: list })
}

export async function findWallet(name: string): Promise<WalletRecord | null> {
  return (await readWallets()).find((w) => w.name === name) ?? null
}

/** Records a new application wallet after pocketd confirmed it. Replaces a same-named entry. */
export async function registerWallet(
  name: string,
  address: string,
  serviceId: string,
  source: WalletSource
): Promise<WalletRecord> {
  const list = (await readWallets()).filter((w) => w.name !== name)
  const entry: WalletRecord = { name, address, service_id: serviceId, created_at: nowIso(), source }
  list.push(entry)
  await saveWallets(list)
  await addHistory({
    op: `wallet-${source}`,
    address,
    service_id: serviceId,
    extra: `name=${name}`
  })
  return entry
}

/** The managed wallet (owner included) that already holds an address, or null. */
export async function walletHolding(address: string): Promise<string | null> {
  const p = await readOwnerWallet()
  if (p && p.address === address) return OWNER_KEY_NAME
  for (const w of await readWallets()) if (w.address === address) return w.name
  return null
}

export async function setWalletService(name: string, serviceId: string): Promise<void> {
  const list = await readWallets()
  for (const w of list) if (w.name === name) w.service_id = serviceId
  await saveWallets(list)
}

export async function removeWalletFiles(): Promise<void> {
  await removeFile(dataFiles.wallet())
  await removeFile(dataFiles.wallets())
}
