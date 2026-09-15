// Live chain parameters and the arithmetic app.js derived from them. Nothing
// here is hardcoded: every value comes from a fetch at the moment of use.
import {
  getJson,
  lcd,
  params as moduleParams,
  allServices,
  latestBlock,
  blockAt,
  type ChainSupplier,
  type ChainApplication
} from './lcd'
import type { Network } from './networks'
import { fmtInt, fmtDuration, fmtPokt, POKT } from './format'

export interface LiveParams {
  addServiceFee?: number
  appMinStake?: number
  appMaxDelegated?: number
  supMinStake?: number
  cuMultiplier?: number
  cuGranularity?: number
  blocksPerSession?: number
  sessionAnchor?: number
  supplierUnbondingSessions?: number
  height?: number
  chainId?: string
  headTime?: string
  blockTime?: number
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = Number(
    typeof v === 'object' && v && 'amount' in (v as object) ? (v as { amount: string }).amount : v
  )
  return Number.isFinite(n) ? n : undefined
}

/** refreshNetwork() from app.js, with the reads done concurrently. Partial results are kept. */
export async function loadLiveParams(net: Network): Promise<LiveParams> {
  const p: LiveParams = {}
  const [svc, app, sup, shared, head] = await Promise.allSettled([
    moduleParams(net, 'service'),
    moduleParams(net, 'application'),
    moduleParams(net, 'supplier'),
    moduleParams(net, 'shared'),
    latestBlock(net)
  ])
  if (svc.status === 'fulfilled') p.addServiceFee = num(svc.value.add_service_fee)
  if (app.status === 'fulfilled') {
    p.appMinStake = num(app.value.min_stake)
    p.appMaxDelegated = num(app.value.max_delegated_gateways) ?? 0
  }
  if (sup.status === 'fulfilled') p.supMinStake = num(sup.value.min_stake)
  if (shared.status === 'fulfilled') {
    p.cuMultiplier = num(shared.value.compute_units_to_tokens_multiplier)
    p.cuGranularity = num(shared.value.compute_unit_cost_granularity)
    p.blocksPerSession = num(shared.value.num_blocks_per_session)
    p.sessionAnchor = num(shared.value.session_grid_anchor_height)
    p.supplierUnbondingSessions = num(shared.value.supplier_unbonding_period_sessions)
  }
  if (head.status === 'fulfilled') {
    p.height = head.value.height
    p.chainId = head.value.chainId
    p.headTime = head.value.time
    if (p.height > 1000) {
      try {
        const older = await blockAt(net, p.height - 1000)
        const t1 = Date.parse(p.headTime.substring(0, 23) + 'Z')
        const t0 = Date.parse(older.time.substring(0, 23) + 'Z')
        if (t1 > t0) p.blockTime = (t1 - t0) / 1000 / 1000
      } catch {
        /* block time stays unknown */
      }
    }
  }
  return p
}

export async function loadCatalog(net: Network): Promise<import('./lcd').ChainService[] | null> {
  try {
    return await allServices(net)
  } catch {
    return null
  }
}

export function costPerRelayUpokt(p: LiveParams, cupr: number): number | null {
  if (!p.cuMultiplier || !p.cuGranularity) return null
  return (cupr * p.cuMultiplier) / p.cuGranularity
}

/** Live minimum plus 10%, rounded up to a whole POKT. */
export function suggestedAppStake(p: LiveParams): number {
  const min = p.appMinStake || 0
  return Math.ceil((min * 1.1) / POKT) * POKT
}

export function nextSessionBoundary(p: LiveParams): { height: number; blocks: number } | null {
  if (!p.blocksPerSession || !p.height) return null
  const h = Number(p.height)
  const n = p.blocksPerSession
  const a = p.sessionAnchor || 0
  const next = a + Math.ceil((h - a + 1) / n) * n
  return { height: next, blocks: next - h }
}

export function appUnbonding(a: ChainApplication | null | undefined): number {
  const e = a ? Number(a.unstake_session_end_height || 0) : 0
  return e > 0 ? e : 0
}

export function appServiceIds(a: ChainApplication | null | undefined): string[] {
  return (a?.service_configs ?? []).map((s) => s.service_id)
}

export function supplierServiceIds(rec: ChainSupplier | null | undefined): string[] {
  return (rec?.services ?? []).map((s) => s.service_id)
}

export interface Unbonding {
  serving_until: number
  returns_at: number
  blocks_left: number
  eta: string
}

export function unbondingOf(
  p: LiveParams,
  rec: ChainSupplier | null | undefined
): Unbonding | null {
  const end = rec ? Number(rec.unstake_session_end_height || 0) : 0
  if (!end) return null
  const ret = end + (p.supplierUnbondingSessions || 0) * (p.blocksPerSession || 0)
  const h = Number(p.height || 0)
  const left = ret - h
  return {
    serving_until: end,
    returns_at: ret,
    blocks_left: left,
    eta: left > 0 && p.blockTime ? fmtDuration(left * p.blockTime) : ''
  }
}

export function unbondingNote(u: Unbonding | null): string {
  if (!u) return ''
  return (
    'stake returns to the owner wallet at block ' +
    fmtInt(u.returns_at) +
    (u.blocks_left > 0
      ? ', ' + fmtInt(u.blocks_left) + ' blocks' + (u.eta ? ' (~' + u.eta + ')' : '') + ' from now'
      : ', any moment now')
  )
}

export function activationNote(p: LiveParams, act: number): string {
  const h = Number(p.height || 0)
  const blocks = act - h
  const bt = p.blockTime || 0
  return (
    'block ' +
    fmtInt(act) +
    (blocks > 0
      ? ', ' +
        blocks +
        ' block' +
        (blocks === 1 ? '' : 's') +
        (bt ? ' (~' + fmtDuration(blocks * bt) + ')' : '') +
        ' from now at block ' +
        fmtInt(h)
      : '')
  )
}

export type SupplyState =
  | { state: 'active'; server: string }
  | { state: 'pending'; server: string; activation_height: number }

/** supplyStatusMap(): for each service, whether one of our suppliers serves it now or from a scheduled height. */
export function supplyStatusMap(
  p: LiveParams,
  records: { server: string; rec: ChainSupplier | null }[]
): Record<string, SupplyState> {
  const map: Record<string, SupplyState> = {}
  const h = Number(p.height || 0)
  for (const { server, rec } of records) {
    if (!rec) continue
    for (const s of rec.services ?? []) map[s.service_id] = { state: 'active', server }
    for (const e of rec.service_config_history ?? []) {
      const sid = e.service?.service_id
      const act = Number(e.activation_height || 0)
      if (
        !sid ||
        String(e.deactivation_height || '0') !== '0' ||
        act <= h ||
        map[sid]?.state === 'active'
      )
        continue
      map[sid] = { state: 'pending', server, activation_height: act }
    }
  }
  return map
}

export function fmtPoktOrQ(v: number | undefined): string {
  return v !== undefined ? fmtPokt(v) + ' POKT' : '?'
}

/** Any HTTP answer counts as reachable. Main does the request; the renderer's CSP forbids it. */
export type UrlProbe = (url: string) => Promise<number>

export function lcdTxUrl(net: Network, txhash: string): string {
  return lcd(net, `/cosmos/tx/v1beta1/txs/${txhash}`)
}

export { getJson }
