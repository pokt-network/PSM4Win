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

export async function readSettings(): Promise<Settings> {
  if (cached) return cached
  const s = await readJson<Partial<Settings>>(dataFiles.settings())
  cached = {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    servers: Array.isArray(s?.servers) ? s!.servers : []
  }
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
