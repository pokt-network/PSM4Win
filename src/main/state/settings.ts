// settings.json: the HTA's keys plus `window` and `schemaVersion` (docs/MIGRATION.md section 2).
import { dataFiles } from '../paths'
import { readJson, writeJson } from './files'
import type { Network } from '@core/networks'

export interface SupplierStack {
  dir: string
  project: string
  url: string
  operator: string
  provisioned_at?: string
}

export interface ServerEntry {
  name: string
  host: string
  port: number
  user: string
  keyPath: string
  deployRoot: string
  suppliers: Partial<Record<Network, SupplierStack>>
}

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface Settings {
  schemaVersion: number
  network: Network
  theme: 'light' | 'dark'
  lastTab?: string
  lastService?: string
  servicesRoot?: string
  supplierServer?: string
  welcomeSeen?: boolean
  servers: ServerEntry[]
  window?: WindowBounds
  lcdOverrides?: Partial<Record<Network, string>>
  importedFrom?: { path: string; at: string }
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  network: 'beta',
  theme: 'light',
  servers: []
}

let cached: Settings | null = null

/** Port of the HTA's migrateServer: entries written by the first layout carried one stack's
 *  fields (supplierDir, operator, url, network, provisioned_at) at the top level. They move
 *  under suppliers[<network>] with the compose project "pocket-supplier" so the running
 *  containers and volumes are reused. Returns true when the entry changed. */
export function migrateServer(entry: ServerEntry): boolean {
  const s = entry as unknown as Record<string, unknown>
  if (s.suppliers && typeof s.suppliers === 'object') return false
  const suppliers: Partial<Record<Network, SupplierStack>> = {}
  if (s.supplierDir || s.operator || s.url) {
    const net: Network = s.network === 'main' ? 'main' : 'beta'
    suppliers[net] = {
      dir: String(s.supplierDir ?? ''),
      project: 'pocket-supplier',
      url: String(s.url ?? ''),
      operator: String(s.operator ?? ''),
      provisioned_at: String(s.provisioned_at ?? '')
    }
  }
  s.suppliers = suppliers
  delete s.supplierDir
  delete s.operator
  delete s.url
  delete s.network
  delete s.provisioned_at
  return true
}

export async function readSettings(): Promise<Settings> {
  if (cached) return cached
  const s = await readJson<Partial<Settings>>(dataFiles.settings())
  const servers = Array.isArray(s?.servers) ? s!.servers : []
  let migrated = false
  for (const e of servers) if (migrateServer(e)) migrated = true
  cached = {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    servers
  }
  if (migrated) await writeJson(dataFiles.settings(), cached)
  return cached
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await readSettings()
  cached = { ...cur, ...patch }
  await writeJson(dataFiles.settings(), cached)
  return cached
}

export function invalidateSettings(): void {
  cached = null
}
