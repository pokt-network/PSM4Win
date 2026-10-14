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

/** Pages createdClaims reads at most. */
const CLAIMS_MAX_PAGES = 50

interface CreatedClaim {
  height: string
  id: string
  sessionId: string
  sessionEndHeight: string
  serviceId: string
  blockTime: string | null
}
const CLAIM_FIELDS = 'height id sessionId sessionEndHeight serviceId blockTime'

/**
 * The claims a supplier made on chain (MsgCreateClaim), newest first, since a time or ever,
 * read `pageRows` at a time, each page after the last row of the one before, until a page comes
 * back empty (a short page is not taken as the end: the indexer may serve fewer rows than
 * asked) or `enough` says the oldest row read is far enough back. `complete` is false when it
 * stopped after CLAIMS_MAX_PAGES pages with more to read; callers must not take that as all.
 */
async function createdClaims(
  net: Network,
  operator: string,
  sinceIso: string | null,
  pageRows: number,
  enough: (oldest: CreatedClaim) => boolean = () => false
): Promise<{ rows: CreatedClaim[]; complete: boolean }> {
  const rows: CreatedClaim[] = []
  let before: CreatedClaim | null = null
  for (let page = 0; page < CLAIMS_MAX_PAGES; page++) {
    const d: { c: CreatedClaim[] } = await gql(
      net,
      `query($op: [String]!, $t: Datetime, $n: Int!, $h: BigInt, $id: String) {
        c: getCreatedClaimsList(suppliers: $op, rangeStart: $t, rowLimit: $n, beforeHeight: $h, beforeId: $id) { ${CLAIM_FIELDS} }
      }`,
      {
        op: [operator],
        t: sinceIso,
        n: pageRows,
        h: before?.height ?? null,
        id: before?.id ?? null
      }
    )
    rows.push(...d.c)
    before = d.c[d.c.length - 1] ?? null
    if (!before || enough(before)) return { rows, complete: true }
  }
  return { rows, complete: false }
}

type LastClaim = { time: string; sessionEnd: number; service: string }
const lastOf = (c: CreatedClaim): LastClaim => ({
  time: c.blockTime ?? '',
  sessionEnd: Number(c.sessionEndHeight) || 0,
  service: c.serviceId
})

/** Suppliers the indexer counts claims for per call at most. */
const COUNT_BATCH = 20

/** A supplier's claims count, or why it could not be read. */
export type ClaimsCount = { claims: number; error: '' } | { claims: null; error: string }

/**
 * The claims each supplier made on chain since a time, 20 suppliers a read. Each supplier gets
 * its own answer: a bad address, a read that failed, or a supplier the indexer left out is an
 * error for that supplier alone, never 0.
 */
export async function claimsCreated(
  net: Network,
  operators: string[],
  sinceIso: string
): Promise<Map<string, ClaimsCount>> {
  const out = new Map<string, ClaimsCount>()
  const ops: string[] = []
  for (const o of new Set(operators))
    if (OP_RE.test(o)) ops.push(o)
    else out.set(o, { claims: null, error: 'not an operator address' })
  const batches = Array.from({ length: Math.ceil(ops.length / COUNT_BATCH) }, (_, i) =>
    ops.slice(i * COUNT_BATCH, (i + 1) * COUNT_BATCH)
  )
  const answers = await Promise.allSettled(
    batches.map((b) =>
      gql<{ c: { supplierId: string; claims: string }[] }>(
        net,
        `query($op: [String]!, $t: Datetime!) {
          c: getCreatedClaimsCountList(suppliers: $op, rangeStart: $t) { supplierId claims }
        }`,
        { op: b, t: sinceIso }
      )
    )
  )
  answers.forEach((a, i) => {
    const got = new Map(
      a.status === 'fulfilled' ? a.value.c.map((r) => [r.supplierId, Number(r.claims) || 0]) : []
    )
    for (const o of batches[i]) {
      const n = got.get(o)
      out.set(
        o,
        a.status === 'rejected'
          ? { claims: null, error: why(a.reason) }
          : n === undefined
            ? { claims: null, error: 'the indexer did not count its claims' }
            : { claims: n, error: '' }
      )
    }
  })
  return out
}

/** The newest claim a supplier made, at any time. */
async function newestClaim(net: Network, operator: string): Promise<LastClaim | null> {
  const d = await gql<{ last: CreatedClaim[] }>(
    net,
    `query($op: [String]!) { last: getCreatedClaimsList(suppliers: $op, rowLimit: 1) { ${CLAIM_FIELDS} } }`,
    { op: [operator] }
  )
  return d.last[0] ? lastOf(d.last[0]) : null
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
/** The newest two blocks the indexer has read, asked for before the `...Json` reads in a document. */
const HEAD = 'head: blocks(first: 2, orderBy: ID_DESC) { nodes { timestamp } }'
type Head = { nodes: { timestamp: string }[] }

/** Block times come without a zone; they are UTC. */
const utc = (t: string): number => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z')

/**
 * Whether an answer covers its whole window: from its start, with no gap, up to the newest
 * block the indexer has read, or the one before it (the tables these functions read are
 * written a moment after the block, so one block behind is normal). Where it does not, a 0 or
 * a missing row means not known yet, not that nothing happened.
 */
function covers(r: Range | undefined, head: Head | undefined): boolean {
  const h = (head?.nodes[1] ?? head?.nodes[0])?.timestamp
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

/**
 * Proofs, settled claims and what they paid per service, and expirations since a time, from
 * the indexer's money tables, in one read so all of them share one coverage verdict.
 */
async function settlementsSince(
  net: Network,
  operator: string,
  sinceIso: string
): Promise<
  Pick<
    SupplierActivity,
    'proofs' | 'settled' | 'expired' | 'expiredReasons' | 'earnings' | 'covered'
  >
> {
  const d = await gql<{ settled: JsonRows; proofs: JsonRows; penalties: JsonRows; head: Head }>(
    net,
    `query($op: [String]!, $t: Datetime!) {
      ${HEAD}
      settled: getSupplierEarningsJson(suppliers: $op, rangeStart: $t, byService: true)
      proofs: getSupplierProofsJson(suppliers: $op, rangeStart: $t)
      penalties: getSupplierPenaltiesJson(suppliers: $op, rangeStart: $t)
    }`,
    { op: [operator], t: sinceIso }
  )
  const expired = (d.penalties?.data ?? []).filter((r) => r.kind === 'expired')
  const reasons: Record<string, number> = {}
  for (const r of expired) {
    const k = r.reason ?? 'unknown'
    reasons[k] = (reasons[k] ?? 0) + (Number(r.events) || 0)
  }
  return {
    proofs: sum(d.proofs?.data ?? [], 'proofs_submitted'),
    settled: sum(d.settled?.data ?? [], 'settled_claims'),
    expired: sum(expired, 'events'),
    expiredReasons: reasons,
    earnings: (d.settled?.data ?? [])
      .map((r) => ({
        service: r.service_id ?? '',
        relays: Number(r.relays) || 0,
        earnedUpokt: Number(r.settled_upokt) || 0,
        // One claim per session for a supplier, so settled claims are the sessions paid.
        sessions: Number(r.settled_claims) || 0
      }))
      .sort((a, b) => b.earnedUpokt - a.earnedUpokt),
    covered:
      covers(d.settled?.range, d.head) &&
      covers(d.proofs?.range, d.head) &&
      covers(d.penalties?.range, d.head)
  }
}

export interface SupplierActivity {
  /** The newest claim this supplier made, at any time. */
  lastClaim: LastClaim | null
  /** Why the last claim could not be read; empty when it was. */
  lastClaimError: string
  proofs: number
  settled: number
  /** Claims the network expired (their rewards are lost), by reason. */
  expired: number
  expiredReasons: Record<string, number>
  /** What the settled claims paid since the time, per service, largest first. */
  earnings: ServiceEarnings[]
  /**
   * Whether proofs, settled, expired, and earnings cover the whole window; when not, they are
   * not known yet.
   */
  covered: boolean
  /** Why proofs, settled, expired, and earnings could not be read; empty when they were. */
  settlementsError: string
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Proofs, settlements, and expirations since a time, plus the newest claim ever (the claims
 * made are counted for every supplier at once by claimsCreated). The two are read apart, so
 * one failing leaves the other, with its error said.
 */
export async function supplierActivity(
  net: Network,
  operator: string,
  sinceIso: string
): Promise<SupplierActivity> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  const [c, s] = await Promise.allSettled([
    newestClaim(net, operator),
    settlementsSince(net, operator, sinceIso)
  ])
  return {
    lastClaim: c.status === 'fulfilled' ? c.value : null,
    lastClaimError: c.status === 'rejected' ? why(c.reason) : '',
    ...(s.status === 'fulfilled'
      ? { ...s.value, settlementsError: '' }
      : {
          proofs: 0,
          settled: 0,
          expired: 0,
          expiredReasons: {},
          earnings: [],
          covered: false,
          settlementsError: why(s.reason)
        })
  }
}

export interface ServiceEarnings {
  service: string
  relays: number
  /** What the settled claims paid, in uPOKT. */
  earnedUpokt: number
  sessions: number
}

/** Claims the monitor reads per call: a check usually needs a few dozen. */
const MONITOR_PAGE = 200

/**
 * The sessions (by id) the supplier claimed on chain whose session ended at or after a height.
 * It reads at most CLAIMS_MAX_PAGES pages of MONITOR_PAGE claims (10,000); when there were
 * more, it returns what it read, the newest, with `complete` false.
 */
export async function claimedSessions(
  net: Network,
  operator: string,
  fromEnd: number
): Promise<{ sessions: Set<string>; complete: boolean }> {
  if (!OP_RE.test(operator)) throw new Error('not an operator address')
  // A claim lands after its session ends: the read starts at that block's time (a minute
  // early, so a clock that stepped back loses nothing), and once a claim's own height is at
  // or below fromEnd every older one is for a session that ended before it.
  const b = await gql<{ b: { timestamp: string } | null }>(
    net,
    'query($h: BigFloat!) { b: block(id: $h) { timestamp } }',
    { h: String(fromEnd) }
  )
  const since = b.b ? new Date(utc(b.b.timestamp) - 60_000).toISOString() : null
  const c = await createdClaims(
    net,
    operator,
    since,
    MONITOR_PAGE,
    (o) => Number(o.height) <= fromEnd
  )
  return {
    sessions: new Set(
      c.rows.filter((x) => Number(x.sessionEndHeight) >= fromEnd).map((x) => x.sessionId)
    ),
    complete: c.complete
  }
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
