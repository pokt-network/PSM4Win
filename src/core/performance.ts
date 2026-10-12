// Performance (docs/SCREENS.md 3.16): what each supplier claimed, proved, and earned, from the
// network's indexer, and whether a supplier's miner has stopped claiming, judged from what the
// stack's own miner logged (supplier.sh health) against the claims that reached the chain.
// No Electron, no DOM: the screen and the main-process monitor both use it.
import { NETWORK_INFO, type Network } from './networks'
import { params } from './lcd'

/** One indexer read; throws on HTTP and GraphQL errors so a gap is never shown as zero. */
async function gql<T>(net: Network, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(NETWORK_INFO[net].indexer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from the indexer`)
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (j.errors?.length) throw new Error(`the indexer answered: ${j.errors[0].message}`)
  if (!j.data) throw new Error('the indexer answered nothing')
  return j.data
}

const OP_RE = /^pokt1[0-9a-z]{38}$/

// ---- claims, proofs, earnings ----

export interface SupplierActivity {
  claims: number
  proofs: number
  settled: number
  /** Claims the network expired (their rewards are lost), by reason. */
  expired: number
  expiredReasons: Record<string, number>
  /** The newest claim this supplier made, at any time. */
  lastClaim: { time: string; sessionEnd: number; service: string } | null
}

/** Claims, proofs, settlements, and expirations since a time, plus the newest claim ever. */
export async function supplierActivity(
  net: Network,
  operator: string,
  sinceIso: string
): Promise<SupplierActivity> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  type Count = { totalCount: number }
  const d = await gql<{
    claims: Count
    proofs: Count
    settled: Count
    expired: Count & { groupedAggregates: { keys: string[]; distinctCount: { id: string } }[] }
    last: {
      nodes: { serviceId: string; sessionEndHeight: string; block: { timestamp: string } | null }[]
    }
  }>(
    net,
    `query($op: String!, $t: Datetime!) {
      claims: msgCreateClaims(filter: { supplierId: { equalTo: $op }, block: { timestamp: { greaterThan: $t } } }) { totalCount }
      proofs: msgSubmitProofs(filter: { supplierId: { equalTo: $op }, block: { timestamp: { greaterThan: $t } } }) { totalCount }
      settled: eventClaimSettleds(filter: { supplierId: { equalTo: $op }, block: { timestamp: { greaterThan: $t } } }) { totalCount }
      expired: eventClaimExpireds(filter: { supplierId: { equalTo: $op }, block: { timestamp: { greaterThan: $t } } }) {
        totalCount groupedAggregates(groupBy: EXPIRATION_REASON) { keys distinctCount { id } }
      }
      last: msgCreateClaims(filter: { supplierId: { equalTo: $op } }, orderBy: BLOCK_ID_DESC, first: 1) {
        nodes { serviceId sessionEndHeight block { timestamp } }
      }
    }`,
    { op: operator, t: sinceIso }
  )
  const reasons: Record<string, number> = {}
  for (const g of d.expired.groupedAggregates ?? [])
    reasons[g.keys[0] ?? 'unknown'] = Number(g.distinctCount.id) || 0
  const l = d.last.nodes[0]
  return {
    claims: d.claims.totalCount,
    proofs: d.proofs.totalCount,
    settled: d.settled.totalCount,
    expired: d.expired.totalCount,
    expiredReasons: reasons,
    lastClaim: l
      ? {
          time: l.block?.timestamp ?? '',
          sessionEnd: Number(l.sessionEndHeight) || 0,
          service: l.serviceId
        }
      : null
  }
}

export interface ServiceEarnings {
  service: string
  relays: number
  /** What the settled claims paid, in uPOKT. */
  earnedUpokt: number
  sessions: number
}

/** POKT the supplier's settled claims paid since a time, per service, largest first. */
export async function earningsByService(
  net: Network,
  operator: string,
  sinceIso: string
): Promise<ServiceEarnings[]> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  const d = await gql<{
    s: {
      groupedAggregates: {
        keys: string[]
        sum: { settledAmount: string; numRelays: string }
        distinctCount: { sessionId: string }
      }[]
    }
  }>(
    net,
    `query($op: String!, $t: Datetime!) {
      s: eventClaimSettleds(filter: { supplierId: { equalTo: $op }, block: { timestamp: { greaterThan: $t } } }) {
        groupedAggregates(groupBy: SERVICE_ID) { keys sum { settledAmount numRelays } distinctCount { sessionId } }
      }
    }`,
    { op: operator, t: sinceIso }
  )
  return (d.s.groupedAggregates ?? [])
    .map((g) => ({
      service: g.keys[0] ?? '',
      relays: Number(g.sum.numRelays) || 0,
      earnedUpokt: Number(g.sum.settledAmount) || 0,
      sessions: Number(g.distinctCount.sessionId) || 0
    }))
    .sort((a, b) => b.earnedUpokt - a.earnedUpokt)
}

/** The sessions (by id) the supplier claimed on chain whose session ended at or after a height. */
export async function claimedSessions(
  net: Network,
  operator: string,
  fromEnd: number
): Promise<Set<string>> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  const d = await gql<{ c: { nodes: { sessionId: string }[] } }>(
    net,
    `query($op: String!, $h: BigFloat!) {
      c: msgCreateClaims(filter: { supplierId: { equalTo: $op }, sessionEndHeight: { greaterThanOrEqualTo: $h } }, first: 1000) { nodes { sessionId } }
    }`,
    { op: operator, h: String(fromEnd) }
  )
  return new Set(d.c.nodes.map((n) => n.sessionId))
}

// ---- what the stack's miner logged (supplier.sh health) ----

export interface MinerHealth {
  network: string
  miner: { status: string; started: string; restarts: number }
  relayer: string
  /** The newest block height the miner logged; 0 when it logged none in the window. */
  last_height: number
  last_height_time: string
  /** Sessions the miner opened on their first relay. */
  sessions: { id: string; service: string; end: number }[]
}

/** The helper's one "health: <json>" line, checked; a string says what was wrong. */
export function parseHealth(out: string): MinerHealth | string {
  const line = out
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('health: '))
  if (!line) return 'The server did not report the miner.'
  let j: Record<string, unknown>
  try {
    j = JSON.parse(line.slice('health: '.length)) as Record<string, unknown>
  } catch {
    return 'The server reported the miner in a form the app cannot read.'
  }
  const m = (j.miner ?? {}) as Record<string, unknown>
  const sessions = (Array.isArray(j.sessions) ? j.sessions : [])
    .filter(
      (s): s is { id: string; service: string; end: number } =>
        !!s &&
        typeof (s as { id?: unknown }).id === 'string' &&
        /^[0-9a-f]{16,128}$/.test((s as { id: string }).id) &&
        Number.isInteger((s as { end?: unknown }).end)
    )
    .map((s) => ({ id: s.id, service: String(s.service ?? ''), end: s.end }))
  return {
    network: String(j.network ?? ''),
    miner: {
      status: String(m.status ?? ''),
      started: String(m.started ?? ''),
      restarts: Number(m.restarts) || 0
    },
    relayer: String(j.relayer ?? ''),
    last_height: Number.isInteger(j.last_height) ? (j.last_height as number) : 0,
    last_height_time: String(j.last_height_time ?? ''),
    sessions
  }
}

// ---- the warning ----

export interface ClaimParams {
  blocksPerSession: number
  claimOpenOffset: number
  claimCloseOffset: number
}

/** The shared parameters that place a session's claim window, read live. */
export async function claimParams(net: Network): Promise<ClaimParams> {
  const p = await params(net, 'shared')
  const n = (k: string): number => Number(p[k])
  const out = {
    blocksPerSession: n('num_blocks_per_session'),
    claimOpenOffset: n('claim_window_open_offset_blocks'),
    claimCloseOffset: n('claim_window_close_offset_blocks')
  }
  if (!Object.values(out).every((v) => Number.isInteger(v) && v >= 0) || !out.blocksPerSession)
    throw new Error('the network did not report its session parameters')
  return out
}

/** The last block at which a session ending at `end` can still be claimed. */
export function claimWindowClose(end: number, p: ClaimParams): number {
  return end + 1 + p.claimOpenOffset + p.claimCloseOffset
}

/** How many sessions in a row without a claim make a warning (product owner, 2026-10-12). */
export const UNCLAIMED_SESSIONS_WARN = 4

export type StallKind = '' | 'miner-down' | 'miner-behind' | 'unclaimed'

export interface StackVerdict {
  ok: boolean
  kind: StallKind
  /** One plain sentence for the operator. */
  text: string
  /** Sessions with closed claim windows in which the miner served relays and no claim landed. */
  unclaimed: number
  /** The session end heights those were in, newest first. */
  periods: number[]
}

/**
 * Whether a stack's miner has stopped claiming. Warns when the miner is not running; when
 * it has not followed the chain for UNCLAIMED_SESSIONS_WARN sessions; or when, in each of the
 * last UNCLAIMED_SESSIONS_WARN sessions it served relays in whose claim windows have closed,
 * no claim reached the chain. A quiet supplier that served nothing is never warned about.
 */
export function judgeStack(
  h: MinerHealth,
  claimed: Set<string>,
  head: number,
  p: ClaimParams,
  sessionsInARow = UNCLAIMED_SESSIONS_WARN
): StackVerdict {
  const ok: StackVerdict = { ok: true, kind: '', text: '', unclaimed: 0, periods: [] }
  if (h.miner.status !== 'running')
    return {
      ...ok,
      ok: false,
      kind: 'miner-down',
      text: `The miner is ${h.miner.status || 'missing'}, so nothing this supplier serves is being claimed.`
    }
  const behind = h.last_height > 0 ? head - h.last_height : 0
  if (behind > sessionsInARow * p.blocksPerSession)
    return {
      ...ok,
      ok: false,
      kind: 'miner-behind',
      text: `The miner stopped following the network at block ${h.last_height}, ${behind} blocks ago, so it is not claiming what this supplier serves.`
    }
  const closed = h.sessions.filter((s) => claimWindowClose(s.end, p) < head)
  const periods = [...new Set(closed.map((s) => s.end))]
    .sort((a, b) => b - a)
    .slice(0, sessionsInARow)
  if (periods.length < sessionsInARow) return ok
  const inPeriods = closed.filter((s) => periods.includes(s.end))
  if (inPeriods.some((s) => claimed.has(s.id))) return ok
  return {
    ...ok,
    ok: false,
    kind: 'unclaimed',
    text: `This supplier served relays in its last ${sessionsInARow} sessions and claimed none of them, so it is not being paid for that work.`,
    unclaimed: inPeriods.length,
    periods
  }
}

/** The lowest session end height a verdict needs claims from (the window judgeStack reads). */
export function claimsFromEnd(h: MinerHealth): number {
  return h.sessions.reduce((m, s) => Math.min(m, s.end), Number.MAX_SAFE_INTEGER)
}
