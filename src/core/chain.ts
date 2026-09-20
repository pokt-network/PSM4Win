// Live chain parameters and the arithmetic app.js derived from them. Nothing
// here is hardcoded: every value comes from a fetch at the moment of use.
import {
  getJson,
  lcd,
  params as moduleParams,
  allServices,
  latestBlock,
  latestHeight,
  blockAt,
  session,
  suppliersForService,
  type ChainSession,
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

// ---- session readiness (docs/SCREENS.md 3.8) ----

/**
 * Whether a relay can reach a supplier for a service right now.
 *
 * A stake does not take effect the moment it is signed: the session that is
 * running was drawn at its own start height, so a supplier that staked inside it
 * joins only at the next boundary. Until then the node answers a session query
 * with an error and every relay fails with it, which reads as a broken service
 * rather than one that is a few blocks early.
 */
export type SessionReadiness =
  | { state: 'ready'; suppliers: number; endHeight: number; blocksLeft: number }
  | { state: 'waiting'; reason: 'no-supplier' | 'next-session'; readyAt: number | null }
  | { state: 'unknown'; detail: string }

/** The node reports "no suppliers ... not found for session", not an empty list. */
export function isNoSupplierError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? '')
  return /no suppliers|could not find suppliers|not found for session/i.test(m)
}

/**
 * Grades a session query. `staked` is how many suppliers are staked for the
 * service on chain, or null when that lookup did not answer; the two are kept
 * apart so the note never claims a stake exists that was never read.
 */
export function classifySession(
  p: LiveParams,
  r: { ok: true; session: ChainSession } | { ok: false; error: unknown },
  supply: { staked: number | null; activationHeight?: number | null }
): SessionReadiness {
  const h = Number(p.height || 0)
  if (r.ok && r.session.suppliers.length) {
    const end = Number(r.session.end_height || 0)
    return {
      state: 'ready',
      suppliers: r.session.suppliers.length,
      endHeight: end,
      blocksLeft: end && h ? end - h + 1 : 0
    }
  }
  if (!r.ok && !isNoSupplierError(r.error))
    return { state: 'unknown', detail: r.error instanceof Error ? r.error.message : String(r.error) }
  if (supply.staked === 0) return { state: 'waiting', reason: 'no-supplier', readyAt: null }
  const act = Number(supply.activationHeight || 0)
  const next = nextSessionBoundary(p)
  return { state: 'waiting', reason: 'next-session', readyAt: act > h ? act : (next?.height ?? null) }
}

/** The sentence the Test screen shows under the buttons. */
export function sessionNote(p: LiveParams, r: SessionReadiness, serviceId: string): string {
  if (r.state === 'ready')
    return (
      r.suppliers +
      (r.suppliers === 1 ? ' supplier is' : ' suppliers are') +
      ' serving ' +
      serviceId +
      ' in the session running now' +
      (r.blocksLeft > 0
        ? ', which ends at block ' +
          fmtInt(r.endHeight) +
          ', ' +
          fmtInt(r.blocksLeft) +
          ' block' +
          (r.blocksLeft === 1 ? '' : 's') +
          (p.blockTime ? ' (~' + fmtDuration(r.blocksLeft * p.blockTime) + ')' : '') +
          ' from now'
        : '') +
      '.'
    )
  if (r.state === 'unknown')
    return (
      'Could not read the current session from the network (' +
      r.detail +
      '). The test will run and show whatever the protocol answers.'
    )
  if (r.reason === 'no-supplier')
    return (
      'No supplier is staked for ' +
      serviceId +
      ' yet, so a relay has nowhere to go. Supply the service on a server and deploy it first; ' +
      'testing works from the session after the supplier stake.'
    )
  const every = p.blocksPerSession
    ? ' Sessions start every ' + fmtInt(p.blocksPerSession) + ' blocks.'
    : ''
  return (
    'Nothing is serving ' +
    serviceId +
    ' in the session running now. A supplier joins only at a session boundary, never the moment it stakes.' +
    every +
    (r.readyAt ? ' The next one is ' + activationNote(p, r.readyAt) + '.' : '') +
    ' Relays fail until then, so the test waits.'
  )
}

/**
 * The preflight the Test screen runs before it lets a test go out: ask the node
 * for the session this application and service would relay through, and when
 * there is none, find out whether that is a missing stake or a boundary that has
 * not come round yet.
 */
export interface SessionCheck {
  readiness: SessionReadiness
  /** Built here, with the height that was read for the query rather than a stored one. */
  note: string
  height: number
}

export async function checkSession(
  net: Network,
  p: LiveParams,
  appAddress: string,
  serviceId: string
): Promise<SessionCheck> {
  if (!appAddress || !serviceId) {
    const readiness: SessionReadiness = { state: 'unknown', detail: 'no application wallet' }
    return { readiness, note: sessionNote(p, readiness, serviceId), height: Number(p.height || 0) }
  }
  // The head moves while a screen sits open, and a boundary a few blocks away is the
  // whole point of this check, so the height is read now rather than taken from the store.
  let height = Number(p.height || 0)
  try {
    height = await latestHeight(net)
  } catch {
    /* the stored height stands in */
  }
  const live = height ? { ...p, height } : p
  let r: { ok: true; session: ChainSession } | { ok: false; error: unknown }
  try {
    r = { ok: true, session: await session(net, appAddress, serviceId, height) }
  } catch (e) {
    r = { ok: false, error: e }
  }
  const done = (readiness: SessionReadiness): SessionCheck => ({
    readiness,
    note: sessionNote(live, readiness, serviceId),
    height
  })
  if (r.ok && r.session.suppliers.length) return done(classifySession(live, r, { staked: 1 }))
  let staked: number | null = null
  let activation: number | null = null
  try {
    const sups = await suppliersForService(net, serviceId)
    staked = sups.length
    for (const s of sups)
      for (const e of s.service_config_history ?? []) {
        const act = Number(e.activation_height || 0)
        if (
          e.service?.service_id !== serviceId ||
          String(e.deactivation_height || '0') !== '0' ||
          act <= height
        )
          continue
        if (!activation || act < activation) activation = act
      }
  } catch {
    /* the stake count stays unknown; the note then speaks only of the boundary */
  }
  return done(classifySession(live, r, { staked, activationHeight: activation }))
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
