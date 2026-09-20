// Read-only client for the Pocket Shannon Cosmos LCD. Port of reference/mcp/src/lcd.ts.
// Nothing here signs or broadcasts. Used by the renderer (screens) and by main
// (the signer's own preflight reads).
import { NETWORK_INFO, type Network } from './networks'

export class LcdError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'LcdError'
  }
}

let overrides: Partial<Record<Network, string>> = {}

/** Settings may override an LCD host; pass '' or undefined to clear. */
export function setLcdOverrides(o: Partial<Record<Network, string>>): void {
  overrides = { ...o }
}

export function lcdBase(net: Network): string {
  const o = overrides[net]
  return (o && o.trim()) || NETWORK_INFO[net].lcd
}

export function lcd(net: Network, path: string): string {
  return lcdBase(net).replace(/\/+$/, '') + path
}

const cache = new Map<string, { expires: number; value: Promise<unknown> }>()
export const TTL = { params: 30_000, catalog: 60_000, state: 5_000 } as const

/** Screenshot mode only (src/renderer/src/lib/demo.ts): answers some URLs from examples. */
let lcdStub: ((url: string) => unknown | undefined) | null = null
export function setLcdStub(fn: ((url: string) => unknown | undefined) | null): void {
  lcdStub = fn
}

export async function getJson<T>(url: string, ttlMs = 0, timeoutMs = 20_000): Promise<T> {
  if (lcdStub) {
    const v = lcdStub(url)
    if (v !== undefined) {
      const o = v as { code?: number; message?: string }
      if (o && typeof o === 'object' && o.code === 5)
        throw new LcdError(`HTTP 404 for ${url}: ${o.message ?? 'not found'}`, 404)
      return v as T
    }
  }
  const now = Date.now()
  const hit = cache.get(url)
  if (hit && hit.expires > now) return hit.value as Promise<T>
  const p = (async () => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new LcdError(`HTTP ${res.status} for ${url}: ${body}`, res.status)
    }
    return (await res.json()) as T
  })()
  if (ttlMs > 0) {
    cache.set(url, { expires: now + ttlMs, value: p })
    p.catch(() => cache.delete(url))
  }
  return p
}

export function clearLcdCache(): void {
  cache.clear()
}

function isNotFound(e: unknown): boolean {
  return e instanceof LcdError && (e.status === 404 || /not found/i.test(e.message))
}

// ---- module params ----

export async function params(net: Network, module: string): Promise<Record<string, unknown>> {
  const d = await getJson<{ params?: Record<string, unknown> }>(
    lcd(net, `/pokt-network/poktroll/${module}/params`),
    TTL.params
  )
  return d.params ?? {}
}

// ---- services ----

export interface ChainService {
  id: string
  name: string
  compute_units_per_relay: string
  owner_address: string
  metadata?: { card?: string }
}

export async function allServices(net: Network): Promise<ChainService[]> {
  const d = await getJson<{ service?: ChainService[] }>(
    lcd(net, '/pokt-network/poktroll/service/service?pagination.limit=2000'),
    TTL.catalog
  )
  return d.service ?? []
}

export async function service(net: Network, id: string): Promise<ChainService | null> {
  try {
    const d = await getJson<{ service: ChainService }>(
      lcd(net, `/pokt-network/poktroll/service/service/${encodeURIComponent(id)}`),
      TTL.state
    )
    return d.service ?? null
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The card is stored as raw bytes and returned base64-encoded. Not gzipped. */
export function cardBytes(svc: ChainService): Uint8Array | null {
  const b64 = svc.metadata?.card
  return b64 ? b64ToBytes(b64) : null
}

export function decodeCard(svc: ChainService): unknown | null {
  const bytes = cardBytes(svc)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

// ---- suppliers ----

export interface ChainSupplier {
  owner_address: string
  operator_address: string
  stake: { denom: string; amount: string }
  services: {
    service_id: string
    endpoints: { url: string; rpc_type: string }[]
    rev_share?: { address: string; rev_share_percentage: string }[]
  }[]
  service_config_history?: {
    service?: { service_id: string }
    activation_height?: string
    deactivation_height?: string
  }[]
  unstake_session_end_height?: string
}

/** The raw lookup the Suppliers screens grade: status is the HTTP status (0 on transport
 *  failure), rec is null for a 404 and for a 200 whose body lacks `supplier`. */
export async function supplierLookup(
  net: Network,
  operator: string
): Promise<{ status: number; rec: ChainSupplier | null }> {
  try {
    const d = await getJson<{ supplier?: ChainSupplier }>(
      lcd(net, `/pokt-network/poktroll/supplier/supplier/${operator}`),
      TTL.state
    )
    return { status: 200, rec: d.supplier ?? null }
  } catch (e) {
    return { status: (e as LcdError).status ?? 0, rec: null }
  }
}

export async function supplier(net: Network, operator: string): Promise<ChainSupplier | null> {
  try {
    const d = await getJson<{ supplier: ChainSupplier }>(
      lcd(net, `/pokt-network/poktroll/supplier/supplier/${operator}`),
      TTL.state
    )
    return d.supplier ?? null
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

export async function suppliersForService(
  net: Network,
  serviceId: string
): Promise<ChainSupplier[]> {
  const d = await getJson<{ supplier?: ChainSupplier[] }>(
    lcd(
      net,
      `/pokt-network/poktroll/supplier/supplier?service_id=${encodeURIComponent(serviceId)}&pagination.limit=500`
    ),
    TTL.state
  )
  return d.supplier ?? []
}

// ---- sessions ----

/** The session a relay is routed through: which suppliers serve an application for a
 *  service, and the heights the session runs between. Port of session() in
 *  reference/mcp/src/lcd.ts. The node answers with an error, not an empty list, when no
 *  supplier serves the service at that height, so callers grade the failure too. */
export interface ChainSession {
  session_id?: string
  start_height: number
  end_height: number
  suppliers: string[]
}

export async function session(
  net: Network,
  app: string,
  serviceId: string,
  height: number
): Promise<ChainSession> {
  const d = await getJson<{
    session?: {
      header?: {
        session_id?: string
        session_start_block_height?: string
        session_end_block_height?: string
      }
      suppliers?: { operator_address?: string }[]
    }
  }>(
    lcd(
      net,
      `/pokt-network/poktroll/session/get_session?application_address=${app}&service_id=${encodeURIComponent(serviceId)}&block_height=${height}`
    )
  )
  const h = d.session?.header ?? {}
  return {
    session_id: h.session_id,
    start_height: Number(h.session_start_block_height || 0),
    end_height: Number(h.session_end_block_height || 0),
    suppliers: (d.session?.suppliers ?? [])
      .map((x) => x.operator_address || '')
      .filter((x) => x.length > 0)
  }
}

// ---- applications, gateways ----

export interface ChainApplication {
  address: string
  stake: { denom: string; amount: string }
  service_configs: { service_id: string }[]
  delegatee_gateway_addresses?: string[]
  unstake_session_end_height?: string
}

export async function application(net: Network, address: string): Promise<ChainApplication | null> {
  try {
    const d = await getJson<{ application: ChainApplication }>(
      lcd(net, `/pokt-network/poktroll/application/application/${address}`),
      TTL.state
    )
    return d.application ?? null
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

export interface ChainGateway {
  address: string
  stake: { denom: string; amount: string }
}

export async function gateways(net: Network): Promise<ChainGateway[]> {
  const d = await getJson<{ gateway?: ChainGateway[] }>(
    lcd(net, '/pokt-network/poktroll/gateway/gateway?pagination.limit=1000'),
    TTL.catalog
  )
  return d.gateway ?? []
}

// ---- chain state ----

export interface LatestBlock {
  height: number
  time: string
  chainId: string
}

export async function latestBlock(net: Network): Promise<LatestBlock> {
  const d = await getJson<{
    block: { header: { height: string; time: string; chain_id: string } }
  }>(lcd(net, '/cosmos/base/tendermint/v1beta1/blocks/latest'), TTL.state)
  return {
    height: Number(d.block.header.height),
    time: d.block.header.time,
    chainId: d.block.header.chain_id
  }
}

export async function latestHeight(net: Network): Promise<number> {
  return (await latestBlock(net)).height
}

export async function blockAt(
  net: Network,
  height: number
): Promise<{ height: number; time: string }> {
  const d = await getJson<{ block: { header: { height: string; time: string } } }>(
    lcd(net, `/cosmos/base/tendermint/v1beta1/blocks/${height}`),
    0
  )
  return { height: Number(d.block.header.height), time: d.block.header.time }
}

/** Average seconds per block over the last `span` blocks. */
export async function measureBlockTime(
  net: Network,
  span = 1000
): Promise<{ seconds: number; height: number }> {
  const latest = await latestBlock(net)
  const from = Math.max(1, latest.height - span)
  const older = await blockAt(net, from)
  const dt = (Date.parse(latest.time) - Date.parse(older.time)) / 1000
  const n = latest.height - from
  if (n <= 0) throw new LcdError('Not enough blocks to measure the block time.', 0)
  return { seconds: dt / n, height: latest.height }
}

export async function balanceUpokt(net: Network, address: string): Promise<number> {
  const d = await getJson<{ balances?: { denom: string; amount: string }[] }>(
    lcd(net, `/cosmos/bank/v1beta1/balances/${address}`),
    TTL.state
  )
  const c = (d.balances ?? []).find((b) => b.denom === 'upokt')
  return c ? Number(c.amount) : 0
}

export interface AccountInfo {
  exists: boolean
  hasPubKey: boolean
  sequence: number
}

export async function account(net: Network, address: string): Promise<AccountInfo> {
  try {
    const d = await getJson<{ account?: { pub_key?: unknown; sequence?: string } }>(
      lcd(net, `/cosmos/auth/v1beta1/accounts/${address}`),
      0
    )
    const a = d.account
    return { exists: !!a, hasPubKey: !!(a && a.pub_key), sequence: Number(a?.sequence ?? 0) }
  } catch (e) {
    if (isNotFound(e)) return { exists: false, hasPubKey: false, sequence: 0 }
    throw e
  }
}

export interface TxLookup {
  found: boolean
  code?: number
  height?: number
  raw_log?: string
}

export async function txByHash(net: Network, txhash: string): Promise<TxLookup> {
  try {
    const d = await getJson<{ tx_response?: { code: number; height: string; raw_log: string } }>(
      lcd(net, `/cosmos/tx/v1beta1/txs/${txhash}`),
      0
    )
    const r = d.tx_response
    if (!r) return { found: false }
    return { found: true, code: Number(r.code), height: Number(r.height), raw_log: r.raw_log }
  } catch (e) {
    if (isNotFound(e)) return { found: false }
    throw e
  }
}

/** Polls until the tx is in a block. Mirrors app.js pollTx: every 3 s for up to 180 s. */
export async function waitForTx(
  net: Network,
  txhash: string,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; height?: number; error?: string }> {
  const interval = opts.intervalMs ?? 3000
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, error: 'Cancelled.' }
    const r = await txByHash(net, txhash).catch(() => ({ found: false }) as TxLookup)
    if (r.found) {
      if (r.code === 0) return { ok: true, height: r.height }
      return {
        ok: false,
        height: r.height,
        error: `Failed in block ${r.height} with code ${r.code}: ${r.raw_log ?? ''}`
      }
    }
    await new Promise((res) => setTimeout(res, interval))
  }
  return {
    ok: false,
    error: `Not seen in a block after 3 minutes. Check the Activity tab later; the tx hash is ${txhash}.`
  }
}

export function upoktToPokt(amount: string | number | undefined): number {
  return Number(amount ?? 0) / 1_000_000
}

export function poktToUpokt(pokt: number): number {
  return Math.round(pokt * 1_000_000)
}
