import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseHealth,
  judgeStack,
  claimWindowClose,
  claimsFromEnd,
  claimedSessions,
  claimsBySupplier,
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
  /** The node's block at a height (the LCD, a GET); null = the node cannot say (404). */
  let nodeBlockTime: string | null = null
  /** Answers each indexer call with what `reply` gives for its query and variables. */
  const answer = (reply: (query: string, v: Vars) => unknown): ReturnType<typeof vi.fn> => {
    nodeBlockTime = null
    const f = vi.fn(async (url: string, init?: { body: string }) => {
      if (!init?.body)
        return nodeBlockTime
          ? {
              ok: true,
              status: 200,
              json: async () => ({
                block: { header: { height: url.split('/').at(-1), time: nodeBlockTime } }
              })
            }
          : { ok: false, status: 404, text: async () => 'not found' }
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
  // The newest block and the one before it.
  const head = {
    nodes: [{ timestamp: '2026-10-14T16:47:15.076' }, { timestamp: '2026-10-14T16:46:14.5' }]
  }
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
      settled: {
        range: r,
        data: [
          { service_id: 'b', settled_upokt: '10', relays: '1', settled_claims: '1' },
          { service_id: 'a', settled_upokt: '46123973', relays: '4119', settled_claims: '66' }
        ]
      },
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
    f.mock.calls
      .map((c) => (c as unknown as [string, { body?: string } | undefined])[1]?.body)
      .filter((b): b is string => !!b)
      .map((b) => JSON.parse(b))
  const pages = (f: ReturnType<typeof vi.fn>): Vars[] =>
    calls(f)
      .filter((c) => c.query.includes('rowLimit: $n'))
      .map((c) => c.variables)

  /** A claims read: the count for the batch, and each supplier's newest claim as l<k>. */
  const claimsAnswer = (
    op: string[],
    count = (i: number) => String(i),
    r: unknown = range
  ): unknown => ({
    data: {
      head,
      c: op.map((o, i) => ({ supplierId: o, claims: count(i) })),
      ...Object.fromEntries(
        op.map((_, k) => [
          `l${k}`,
          {
            range: r,
            data:
              k === 2
                ? []
                : [
                    {
                      block_time: `T${961390 - k}`,
                      session_end_height: String(961378 - k),
                      service_id: `svc${961390 - k}`
                    }
                  ]
          }
        ])
      )
    }
  })
  it('reads the claims count and newest claim of every supplier in one read per 20', async () => {
    const ops = Array.from({ length: 23 }, (_, i) => 'pokt1' + String(i).padStart(38, '0'))
    const f = answer((_q, v) => claimsAnswer(v.op as string[]))
    const m = await claimsBySupplier('main', [...ops, ops[0]], '2026-10-05T00:00:00Z')
    expect(calls(f).map((c) => (c.variables.op as string[]).length)).toEqual([20, 3])
    const first = calls(f)[0]
    expect(first.variables.t).toBe('2026-10-05T00:00:00Z')
    expect(first.variables.o19).toEqual([ops[19]])
    expect(first.query).toContain('getCreatedClaimsCountList(suppliers: $op, rangeStart: $t)')
    // The newest claim is read within the window only.
    expect(first.query).toContain(
      'l19: getCreatedClaimsJson(suppliers: $o19, rangeStart: $t, rowLimit: 1)'
    )
    const last = { time: 'T961390', sessionEnd: 961378, service: 'svc961390' }
    expect(m.get(ops[0])).toEqual({ claims: 0, lastClaim: last, covered: true, error: '' })
    expect(m.get(ops[21])).toEqual({
      claims: 1,
      lastClaim: { ...last, time: 'T961389', sessionEnd: 961377, service: 'svc961389' },
      covered: true,
      error: ''
    })
    // None in the window: no last claim, not "never".
    expect(m.get(ops[2])).toEqual({ claims: 2, lastClaim: null, covered: true, error: '' })
  })
  it('says the claims are not covered when the indexed blocks do not span the window', async () => {
    const late = { ...range, covered_from: '2026-10-06T00:00:00+00:00' }
    answer((_q, v) => claimsAnswer(v.op as string[], (i) => String(i), late))
    expect((await claimsBySupplier('main', [OP], '2026-10-05T00:00:00Z')).get(OP)?.covered).toBe(
      false
    )
  })
  it('keeps the other suppliers when one is bad, left out, or in a read that failed', async () => {
    const ops = Array.from({ length: 21 }, (_, i) => 'pokt1' + String(i).padStart(38, '0'))
    const f = answer((_q, v) => {
      const op = v.op as string[]
      // The second read (one supplier) fails; the first leaves ops[1] out of the count.
      if (op.length === 1) return { errors: [{ message: 'boom' }] }
      const a = claimsAnswer(op, () => '7') as { data: { c: { supplierId: string }[] } }
      a.data.c = a.data.c.filter((r) => r.supplierId !== ops[1])
      return a
    })
    const m = await claimsBySupplier('main', ['x', ...ops], 't')
    // The bad address is never sent.
    expect(calls(f).flatMap((c) => c.variables.op as string[])).not.toContain('x')
    const fail = (error: string): unknown => ({
      claims: null,
      lastClaim: null,
      covered: false,
      error
    })
    expect(m.get('x')).toEqual(fail('not an operator address'))
    expect(m.get(ops[0])?.claims).toBe(7)
    expect(m.get(ops[1])).toEqual(fail('the indexer did not count its claims'))
    expect(m.get(ops[20])).toEqual(fail('the indexer answered: boom'))
  })
  it('reads settlements and earnings per service in one read', async () => {
    const f = answer(() => settlements())
    expect(await supplierActivity('main', OP, '2026-10-05T00:00:00Z')).toEqual({
      proofs: 1,
      settled: 67,
      expired: 3,
      expiredReasons: { PROOF_MISSING: 2, PROOF_INVALID: 1 },
      earnings: [
        { service: 'a', relays: 4119, earnedUpokt: 46123973, sessions: 66 },
        { service: 'b', relays: 1, earnedUpokt: 10, sessions: 1 }
      ],
      covered: true,
      settlementsError: ''
    })
    expect(f).toHaveBeenCalledTimes(1)
    expect(calls(f)[0].query).toContain(
      'getSupplierEarningsJson(suppliers: $op, rangeStart: $t, byService: true)'
    )
    expect(calls(f)[0].variables).toEqual({ op: [OP], t: '2026-10-05T00:00:00Z' })
  })
  it('takes a window covered up to the block before the newest as covered', async () => {
    const oneBehind = { ...range, covered_to: '2026-10-14T16:46:14.500001+00:00' }
    answer(() => settlements(oneBehind))
    expect((await supplierActivity('main', OP, '2026-10-05T00:00:00Z')).covered).toBe(true)
  })
  it('says a window the indexer does not cover whole is not known yet, not zero', async () => {
    // Two blocks behind the newest.
    const lagging = { ...range, covered_to: '2026-10-14T16:45:13.000001+00:00' }
    const late = { ...range, covered_from: '2026-10-06T00:00:00+00:00' }
    const gap = { ...range, gaps: [{ from: 'a', to: 'b' }] }
    const none = { ...range, covered_from: null, covered_to: null }
    for (const r of [lagging, late, gap, none]) {
      answer(() => settlements(r))
      expect((await supplierActivity('main', OP, '2026-10-05T00:00:00Z')).covered).toBe(false)
    }
  })
  it('reads the monitor claims from the time the node gives for the first session end, in one indexer request', async () => {
    const f = answer(() => ({ data: { c: claims(2000, 200) } }))
    nodeBlockTime = '2026-10-14T10:00:00Z'
    const c = await claimedSessions('main', OP, 1850)
    expect(String(f.mock.calls[0][0])).toMatch(/\/blocks\/1850$/)
    // One page: its oldest claim (height 1801) already predates session end 1850.
    expect(calls(f)).toHaveLength(1)
    expect(pages(f)).toEqual([
      { op: [OP], t: '2026-10-14T09:00:00.000Z', n: 200, h: null, id: null }
    ])
    expect(c.complete).toBe(true)
    expect(c.sessions.size).toBe(139)
    expect(c.sessions.has(sid(1862))).toBe(true)
    expect(c.sessions.has(sid(1861))).toBe(false)
  })
  it('reads monitor claims until an empty page, each page after the last row of the one before', async () => {
    const f = answer((_q, v) => ({
      data: { c: !v.h ? claims(5000, 150) : v.h === '4851' ? claims(4850, 5) : [] }
    }))
    const c = await claimedSessions('main', OP, 1)
    // A page shorter than asked (150 of 200) is not the end; the node could not say the
    // block's time, so the whole history is read.
    expect(pages(f).map((v) => [v.t, v.h, v.id])).toEqual([
      [null, null, null],
      [null, '4851', 'tx4851-1'],
      [null, '4846', 'tx4846-1']
    ])
    expect(c).toEqual(expect.objectContaining({ complete: true }))
    expect(c.sessions.size).toBe(155)
  })
  it('says when the monitor could not read every claim, keeping the newest', async () => {
    let top = 10_000_000
    answer(() => ({ data: { c: claims((top -= 200), 200) } }))
    const c = await claimedSessions('main', OP, 1)
    expect(c.complete).toBe(false)
    expect(c.sessions.size).toBe(10_000)
  })
  it('refuses a non-address, and reports indexer errors instead of zeros', async () => {
    await expect(supplierActivity('main', 'x', 't')).rejects.toThrow(/not an operator/)
    answer(() => ({ errors: [{ message: 'boom' }] }))
    await expect(claimedSessions('main', OP, 1)).rejects.toThrow('boom')
    expect((await claimsBySupplier('main', [OP], 't')).get(OP)).toEqual({
      claims: null,
      lastClaim: null,
      covered: false,
      error: 'the indexer answered: boom'
    })
    expect((await supplierActivity('main', OP, 't')).settlementsError).toBe(
      'the indexer answered: boom'
    )
  })
})
