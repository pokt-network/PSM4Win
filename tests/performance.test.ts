import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseHealth,
  judgeStack,
  claimWindowClose,
  claimsFromEnd,
  claimedSessions,
  earningsByService,
  supplierActivity,
  type MinerHealth,
  type ClaimParams
} from '@core/performance'

// The live MainNet shape on 2026-10-12: 20-block sessions, claim window open 11, close 10.
const P: ClaimParams = { blocksPerSession: 20, claimOpenOffset: 11, claimCloseOffset: 10 }
const OP = 'pokt1' + 'a'.repeat(38)
const sid = (n: number): string => n.toString(16).padStart(64, '0')

function health(sessions: [number, number][], extra: Partial<MinerHealth> = {}): MinerHealth {
  return {
    network: 'main',
    miner: { status: 'running', started: '2026-10-12T10:54:11Z', restarts: 0 },
    relayer: 'running',
    last_height: 1000,
    last_height_time: '2026-10-12T11:00:00Z',
    sessions: sessions.map(([id, end]) => ({ id: sid(id), service: 'svc', end })),
    ...extra
  }
}

describe('claim window', () => {
  it('closes where the miner logs it: end 949740 closes at 949762', () => {
    expect(claimWindowClose(949740, P)).toBe(949762)
  })
})

describe('judgeStack', () => {
  // Sessions ending at 900, 920, 940, 960 all closed by 1000 (960 + 22 = 982).
  const four: [number, number][] = [
    [1, 900],
    [2, 920],
    [3, 940],
    [4, 960]
  ]
  it('warns when the last four served sessions, all closed, have no claim', () => {
    const v = judgeStack(health(four), new Set(), 1000, P)
    expect(v).toMatchObject({
      ok: false,
      kind: 'unclaimed',
      unclaimed: 4,
      periods: [960, 940, 920, 900]
    })
    expect(v.text).toMatch(/last 4 sessions and claimed none/)
  })
  it('is fine when any of them was claimed', () => {
    expect(judgeStack(health(four), new Set([sid(2)]), 1000, P).ok).toBe(true)
  })
  it('does not count a session whose claim window is still open', () => {
    // 980 closes at 1002, still open at 1000: only three closed periods.
    const h = health([...four.slice(1), [5, 980]])
    expect(judgeStack(h, new Set(), 1000, P).ok).toBe(true)
  })
  it('never warns about a quiet supplier that served nothing', () => {
    expect(judgeStack(health([]), new Set(), 1000, P).ok).toBe(true)
    expect(judgeStack(health([[1, 900]]), new Set(), 1000, P).ok).toBe(true)
  })
  it('counts sessions by period: several services in one session are one period', () => {
    const h = health([
      [1, 900],
      [2, 900],
      [3, 920],
      [4, 940],
      [5, 960]
    ])
    expect(judgeStack(h, new Set(), 1000, P)).toMatchObject({ kind: 'unclaimed', unclaimed: 5 })
  })
  it('warns when the miner is not running, or has not followed the chain for four sessions', () => {
    expect(
      judgeStack(
        health([], { miner: { status: 'exited', started: '', restarts: 3 } }),
        new Set(),
        1000,
        P
      )
    ).toMatchObject({ kind: 'miner-down' })
    // Four 20-block sessions behind is allowed; one block more is not.
    const behind = judgeStack(health([], { last_height: 900 }), new Set(), 980, P)
    expect(behind.ok).toBe(true)
    expect(judgeStack(health([], { last_height: 900 }), new Set(), 981, P)).toMatchObject({
      kind: 'miner-behind'
    })
    // No height in the log window: unknown, not a warning by itself.
    expect(judgeStack(health([], { last_height: 0 }), new Set(), 5000, P).ok).toBe(true)
  })
  it('reads claims from the oldest served session', () => {
    expect(claimsFromEnd(health(four))).toBe(900)
  })
})

describe('parseHealth', () => {
  it('reads the helper line and drops what does not fit', () => {
    const line =
      'noise\nhealth: ' +
      JSON.stringify({
        network: 'main',
        miner: { status: 'running', started: 'x', restarts: 2 },
        relayer: 'running',
        last_height: 961411,
        last_height_time: 't',
        last_leader_time: 't',
        sessions: [
          { id: sid(1), service: 'meadow', end: 959940 },
          { id: 'not hex', service: 'x', end: 1 },
          { id: sid(2), service: 'x', end: 'n' }
        ]
      })
    const h = parseHealth(line)
    if (typeof h === 'string') throw new Error(h)
    expect(h.miner).toEqual({ status: 'running', started: 'x', restarts: 2 })
    expect(h.last_height).toBe(961411)
    expect(h.sessions).toEqual([{ id: sid(1), service: 'meadow', end: 959940 }])
  })
  it('says what is wrong instead of guessing', () => {
    expect(parseHealth('error: unknown step health')).toMatch(/did not report/)
    expect(parseHealth('health: {')).toMatch(/cannot read/)
  })
})

describe('indexer reads', () => {
  afterEach(() => vi.unstubAllGlobals())
  type Vars = Record<string, unknown>
  /** Answers each indexer call with what `reply` gives for its query and variables. */
  const answer = (reply: (query: string, v: Vars) => unknown): ReturnType<typeof vi.fn> => {
    const f = vi.fn(async (_url: string, init: { body: string }) => {
      const { query, variables } = JSON.parse(init.body) as { query: string; variables: Vars }
      return { ok: true, status: 200, json: async () => reply(query, variables) }
    })
    vi.stubGlobal('fetch', f)
    return f
  }
  // A window the indexer covers whole: from its start to just past its newest block.
  const range = {
    requested_from: '2026-10-05T00:00:00+00:00',
    covered_from: '2026-10-05T00:00:00+00:00',
    covered_to: '2026-10-14T16:47:15.076001+00:00',
    gaps: [],
    end_inclusive: false
  }
  const head = { nodes: [{ timestamp: '2026-10-14T16:47:15.076' }] }
  const claims = (top: number, n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({
      height: String(top - i),
      id: `tx${top - i}-1`,
      sessionId: sid(top - i),
      sessionEndHeight: String(top - i - 12),
      serviceId: `svc${top - i}`,
      blockTime: `T${top - i}`
    }))
  const settlements = (r: unknown = range): unknown => ({
    data: {
      head,
      settled: { range: r, data: [{ settled_claims: '67' }] },
      proofs: { range: r, data: [{ proofs_submitted: '1' }] },
      penalties: {
        range: r,
        data: [
          { kind: 'expired', reason: 'PROOF_MISSING', events: '2' },
          { kind: 'expired', reason: 'PROOF_INVALID', events: '1' },
          { kind: 'slashed', reason: 'unknown', events: '5' }
        ]
      }
    }
  })
  const calls = (f: ReturnType<typeof vi.fn>): { query: string; variables: Vars }[] =>
    f.mock.calls.map((c) => JSON.parse((c as unknown as [string, { body: string }])[1].body))
  const pages = (f: ReturnType<typeof vi.fn>): Vars[] =>
    calls(f)
      .filter((c) => c.query.includes('rowLimit: $n'))
      .map((c) => c.variables)

  it('sums settled claims per service, largest first', async () => {
    answer(() => ({
      data: {
        head,
        s: {
          range,
          data: [
            { service_id: 'b', settled_upokt: '10', relays: '1', settled_claims: '1' },
            { service_id: 'a', settled_upokt: '46123973', relays: '4119', settled_claims: '332' }
          ]
        }
      }
    }))
    expect(await earningsByService('main', OP, '2026-09-12T00:00:00Z')).toEqual([
      { service: 'a', relays: 4119, earnedUpokt: 46123973, sessions: 332 },
      { service: 'b', relays: 1, earnedUpokt: 10, sessions: 1 }
    ])
  })
  it('counts activity, reports expirations by reason, and takes the last claim from the claims read', async () => {
    const f = answer((q, v) =>
      q.includes('getSupplierProofsJson')
        ? settlements()
        : { data: { c: v.h ? [] : claims(961390, 69) } }
    )
    expect(await supplierActivity('main', OP, '2026-10-05T00:00:00Z')).toEqual({
      claims: 69,
      lastClaim: { time: 'T961390', sessionEnd: 961378, service: 'svc961390' },
      claimsError: '',
      proofs: 1,
      settled: 67,
      expired: 3,
      expiredReasons: { PROOF_MISSING: 2, PROOF_INVALID: 1 },
      covered: true,
      settlementsError: ''
    })
    // The settlements read, the claims, and the empty page that ends them; no separate last-claim read.
    expect(f).toHaveBeenCalledTimes(3)
    expect(calls(f).find((c) => c.query.includes('getSupplierProofsJson'))?.variables).toEqual({
      op: [OP],
      t: '2026-10-05T00:00:00Z'
    })
    expect(pages(f)[0]).toEqual({ op: [OP], t: '2026-10-05T00:00:00Z', n: 1000, h: null, id: null })
  })
  it('finds the last claim before the window when none was made in it', async () => {
    const f = answer((q) =>
      q.includes('getSupplierProofsJson')
        ? settlements()
        : q.includes('rowLimit: 1')
          ? { data: { last: claims(900000, 1) } }
          : { data: { c: [] } }
    )
    const a = await supplierActivity('main', OP, '2026-10-05T00:00:00Z')
    expect(a.claims).toBe(0)
    expect(a.lastClaim).toEqual({ time: 'T900000', sessionEnd: 899988, service: 'svc900000' })
    expect(f).toHaveBeenCalledTimes(3)
  })
  it('reads claims until an empty page, each page after the last row of the one before', async () => {
    const f = answer((q, v) =>
      q.includes('getSupplierProofsJson')
        ? settlements()
        : { data: { c: !v.h ? claims(5000, 600) : v.h === '4401' ? claims(4400, 5) : [] } }
    )
    const a = await supplierActivity('main', OP, '2026-10-05T00:00:00Z')
    // A page shorter than asked is not the end.
    expect(a.claims).toBe(605)
    expect(pages(f).map((v) => [v.h, v.id])).toEqual([
      [null, null],
      ['4401', 'tx4401-1'],
      ['4396', 'tx4396-1']
    ])
  })
  it('says the claims could not be counted, keeping the rest, when there are too many', async () => {
    let top = 10_000_000
    answer((q) =>
      q.includes('getSupplierProofsJson')
        ? settlements()
        : { data: { c: claims((top -= 1000), 1000) } }
    )
    const a = await supplierActivity('main', OP, '2026-10-05T00:00:00Z')
    expect(a.claimsError).toMatch(/too many to count/)
    expect(a.lastClaim).toBeNull()
    expect(a.settled).toBe(67)
    expect(a.settlementsError).toBe('')
  })
  it('keeps the claims when the settlements cannot be read, and the reverse', async () => {
    answer((q, v) =>
      q.includes('getSupplierProofsJson')
        ? { errors: [{ message: 'boom' }] }
        : { data: { c: v.h ? [] : claims(961390, 3) } }
    )
    let a = await supplierActivity('main', OP, '2026-10-05T00:00:00Z')
    expect([a.claims, a.claimsError, a.settlementsError]).toEqual([
      3,
      '',
      'the indexer answered: boom'
    ])
    answer((q) =>
      q.includes('getSupplierProofsJson') ? settlements() : { errors: [{ message: 'boom' }] }
    )
    a = await supplierActivity('main', OP, '2026-10-05T00:00:00Z')
    expect([a.settled, a.settlementsError, a.claimsError]).toEqual([
      67,
      '',
      'the indexer answered: boom'
    ])
  })
  it('says a window the indexer does not cover whole is not known yet, not zero', async () => {
    const lagging = { ...range, covered_to: '2026-10-14T16:30:00.000001+00:00' }
    const late = { ...range, covered_from: '2026-10-06T00:00:00+00:00' }
    const gap = { ...range, gaps: [{ from: 'a', to: 'b' }] }
    const none = { ...range, covered_from: null, covered_to: null }
    for (const r of [lagging, late, gap, none]) {
      answer((q) =>
        q.includes('byService')
          ? { data: { head, s: { range: r, data: [] } } }
          : q.includes('getSupplierProofsJson')
            ? settlements(r)
            : { data: { c: [], last: [] } }
      )
      expect(await earningsByService('main', OP, '2026-10-05T00:00:00Z')).toBeNull()
      expect((await supplierActivity('main', OP, '2026-10-05T00:00:00Z')).covered).toBe(false)
    }
  })
  it('reads the monitor claims from the time of the first session end, in small pages', async () => {
    const f = answer((q) =>
      q.includes('block(id')
        ? { data: { b: { timestamp: '2026-10-14T10:00:00' } } }
        : { data: { c: claims(2000, 200) } }
    )
    const c = await claimedSessions('main', OP, 1850)
    expect(calls(f)[0].variables).toEqual({ h: '1850' })
    // One page: its oldest claim (height 1801) already predates session end 1850.
    expect(pages(f)).toEqual([
      { op: [OP], t: '2026-10-14T09:59:00.000Z', n: 200, h: null, id: null }
    ])
    expect(c.complete).toBe(true)
    expect(c.sessions.size).toBe(139)
    expect(c.sessions.has(sid(1862))).toBe(true)
    expect(c.sessions.has(sid(1861))).toBe(false)
  })
  it('says when the monitor could not read every claim, keeping the newest', async () => {
    let top = 10_000_000
    answer((q) =>
      q.includes('block(id') ? { data: { b: null } } : { data: { c: claims((top -= 200), 200) } }
    )
    const c = await claimedSessions('main', OP, 1)
    expect(c.complete).toBe(false)
    expect(c.sessions.size).toBe(10_000)
  })
  it('refuses a non-address, and reports indexer errors instead of zeros', async () => {
    await expect(earningsByService('main', 'x', 't')).rejects.toThrow(/not an operator/)
    answer(() => ({ errors: [{ message: 'boom' }] }))
    await expect(earningsByService('main', OP, 't')).rejects.toThrow('boom')
    await expect(claimedSessions('main', OP, 1)).rejects.toThrow('boom')
    const a = await supplierActivity('main', OP, 't')
    expect([a.claimsError, a.settlementsError]).toEqual([
      'the indexer answered: boom',
      'the indexer answered: boom'
    ])
  })
})
