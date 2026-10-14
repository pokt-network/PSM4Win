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

/** Claims the indexer lists per call at most. */
const CLAIMS_PAGE = 1000
/** Pages createdClaims reads at most: 50,000 claims. */
const CLAIMS_MAX_PAGES = 50

interface CreatedClaim {
  height: string
  id: string
  sessionId: string
  sessionEndHeight: string
}

/**
 * The claims a supplier made on chain (MsgCreateClaim), newest first, since a time or ever,
 * read page by page, each after the last row of the one before, until a page comes back empty
 * (a short page is not taken as the end: the indexer may serve fewer rows than asked) or
 * `enough` says the oldest row read is far enough back. Throws rather than return a list cut
 * short.
 */
async function createdClaims(
  net: Network,
  operator: string,
  sinceIso: string | null,
  enough: (oldest: CreatedClaim) => boolean = () => false
): Promise<CreatedClaim[]> {
  const out: CreatedClaim[] = []
  let before: CreatedClaim | null = null
  for (let page = 0; page < CLAIMS_MAX_PAGES; page++) {
    const d: { c: CreatedClaim[] } = await gql(
      net,
      `query($op: [String]!, $t: Datetime, $h: BigInt, $id: String) {
        c: getCreatedClaimsList(suppliers: $op, rangeStart: $t, rowLimit: ${CLAIMS_PAGE}, beforeHeight: $h, beforeId: $id) { height id sessionId sessionEndHeight }
      }`,
      { op: [operator], t: sinceIso, h: before?.height ?? null, id: before?.id ?? null }
    )
    out.push(...d.c)
    before = d.c[d.c.length - 1] ?? null
    if (!before || enough(before)) return out
  }
  throw new Error(
    `the indexer was still answering after ${CLAIMS_MAX_PAGES} pages of claims, so they were not read to the end`
  )
}

/** One row of an indexer `...Json` function: snake_case columns, every number a string. */
type JsonRow = Record<string, string | null>
/** The part of the window asked for that a `...Json` answer covers. */
interface Range {
  requested_from: string | null
  covered_from: string | null
  covered_to: string | null
  gaps: unknown[] | null
}
type JsonRows = { range?: Range; data: JsonRow[] }
/** The newest block the indexer has read, asked for before the `...Json` reads in a document. */
const HEAD = 'head: blocks(first: 1, orderBy: ID_DESC) { nodes { timestamp } }'
type Head = { nodes: { timestamp: string }[] }

/** Block times come without a zone; they are UTC. */
const utc = (t: string): number => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z')

/**
 * Whether an answer covers its whole window: from its start, with no gap, up to the newest
 * block the indexer has read (the tables these functions read can trail it). Where it does
 * not, a 0 or a missing row means not known yet, not that nothing happened.
 */
function covers(r: Range | undefined, head: Head | undefined): boolean {
  const h = head?.nodes[0]?.timestamp
  return (
    !!r?.requested_from &&
    !!r.covered_from &&
    !!r.covered_to &&
    !!h &&
    !r.gaps?.length &&
    utc(r.covered_from) <= utc(r.requested_from) &&
    utc(r.covered_to) >= utc(h)
  )
}

/** A column summed over rows, read as a number. */
const sum = (rows: JsonRow[], col: string): number =>
  rows.reduce((t, r) => t + (Number(r[col]) || 0), 0)

export interface SupplierActivity {
  claims: number
  proofs: number
  settled: number
  /** Claims the network expired (their rewards are lost), by reason. */
  expired: number
  expiredReasons: Record<string, number>
  /** The newest claim this supplier made, at any time. */
  lastClaim: { time: string; sessionEnd: number; service: string } | null
  /** Whether proofs, settled, and expired cover the whole window; when not, they are not known yet. */
  covered: boolean
}

/** Claims, proofs, settlements, and expirations since a time, plus the newest claim ever. */
export async function supplierActivity(
  net: Network,
  operator: string,
  sinceIso: string
): Promise<SupplierActivity> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  const [d, claims] = await Promise.all([
    gql<{
      settled: JsonRows
      proofs: JsonRows
      penalties: JsonRows
      last: { serviceId: string; sessionEndHeight: string; blockTime: string | null }[]
      head: Head
    }>(
      net,
      `query($op: [String]!, $t: Datetime!) {
        ${HEAD}
        settled: getSupplierEarningsJson(suppliers: $op, rangeStart: $t)
        proofs: getSupplierProofsJson(suppliers: $op, rangeStart: $t)
        penalties: getSupplierPenaltiesJson(suppliers: $op, rangeStart: $t)
        last: getCreatedClaimsList(suppliers: $op, rowLimit: 1) { serviceId sessionEndHeight blockTime }
      }`,
      { op: [operator], t: sinceIso }
    ),
    createdClaims(net, operator, sinceIso)
  ])
  const expired = (d.penalties?.data ?? []).filter((r) => r.kind === 'expired')
  const reasons: Record<string, number> = {}
  for (const r of expired) {
    const k = r.reason ?? 'unknown'
    reasons[k] = (reasons[k] ?? 0) + (Number(r.events) || 0)
  }
  const l = d.last[0]
  return {
    claims: claims.length,
    proofs: sum(d.proofs?.data ?? [], 'proofs_submitted'),
    settled: sum(d.settled?.data ?? [], 'settled_claims'),
    expired: sum(expired, 'events'),
    expiredReasons: reasons,
    lastClaim: l
      ? {
          time: l.blockTime ?? '',
          sessionEnd: Number(l.sessionEndHeight) || 0,
          service: l.serviceId
        }
      : null,
    covered:
      covers(d.settled?.range, d.head) &&
      covers(d.proofs?.range, d.head) &&
      covers(d.penalties?.range, d.head)
  }
}

export interface ServiceEarnings {
  service: string
  relays: number
  /** What the settled claims paid, in uPOKT. */
  earnedUpokt: number
  sessions: number
}

/**
 * POKT the supplier's settled claims paid since a time, per service, largest first; null when
 * the indexer does not cover the whole window yet.
 */
export async function earningsByService(
  net: Network,
  operator: string,
  sinceIso: string
): Promise<ServiceEarnings[] | null> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  const d = await gql<{ s: JsonRows; head: Head }>(
    net,
    `query($op: [String]!, $t: Datetime!) {
      ${HEAD}
      s: getSupplierEarningsJson(suppliers: $op, rangeStart: $t, byService: true)
    }`,
    { op: [operator], t: sinceIso }
  )
  if (!covers(d.s?.range, d.head)) return null
  return (d.s?.data ?? [])
    .map((r) => ({
      service: r.service_id ?? '',
      relays: Number(r.relays) || 0,
      earnedUpokt: Number(r.settled_upokt) || 0,
      // One claim per session for a supplier, so settled claims are the sessions paid.
      sessions: Number(r.settled_claims) || 0
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
  // A claim lands after its session ends, so once a claim's own height is at or below fromEnd
  // every older one is for a session that ended before it.
  const c = await createdClaims(net, operator, null, (o) => Number(o.height) <= fromEnd)
  return new Set(c.filter((x) => Number(x.sessionEndHeight) >= fromEnd).map((x) => x.sessionId))
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
