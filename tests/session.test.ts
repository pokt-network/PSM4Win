// Session readiness: the Test screen's preflight (docs/SCREENS.md 3.8). The heights
// here are fixtures, not chain values; the app reads every one of them live.
import { describe, it, expect } from 'vitest'
import { classifySession, sessionNote, isNoSupplierError, type LiveParams } from '@core/chain'
import type { ChainSession } from '@core/lcd'

const ID = 'example-charts'

// A 20-block grid anchored at 453361, head at 663706: the session running now
// started at 663701 and the next one starts at 663721.
const params: LiveParams = {
  blocksPerSession: 20,
  sessionAnchor: 453361,
  height: 663706,
  blockTime: 10
}

const sess = (suppliers: number, end = 663720): ChainSession => ({
  session_id: 'a1b2c3d4',
  start_height: 663701,
  end_height: end,
  suppliers: Array.from({ length: suppliers }, (_, i) => `pokt1operator${i}`)
})

/** What the node returns when nothing serves the service at that height. */
const noSuppliers = new Error(
  'HTTP 500 for .../get_session: rpc error: code = Internal desc = could not find suppliers ' +
    `for service ${ID} at height 663706: no suppliers not found for session`
)

describe('isNoSupplierError', () => {
  it('recognises the session failure the node returns', () => {
    expect(isNoSupplierError(noSuppliers)).toBe(true)
    expect(isNoSupplierError(new Error('could not find suppliers for service x'))).toBe(true)
  })
  it('does not swallow an unrelated failure', () => {
    expect(isNoSupplierError(new Error('HTTP 503 for ...: upstream connect error'))).toBe(false)
    expect(isNoSupplierError(new Error('The operation was aborted due to timeout'))).toBe(false)
  })
})

describe('classifySession', () => {
  it('is ready when the session holds suppliers, and counts the blocks left', () => {
    const r = classifySession(params, { ok: true, session: sess(3) }, { staked: 3 })
    expect(r).toEqual({ state: 'ready', suppliers: 3, endHeight: 663720, blocksLeft: 15 })
  })

  it('waits when the node reports no suppliers for the session', () => {
    const r = classifySession(params, { ok: false, error: noSuppliers }, { staked: 1 })
    expect(r).toEqual({ state: 'waiting', reason: 'next-session', readyAt: 663721 })
  })

  it('waits when the session answers with an empty supplier list', () => {
    const r = classifySession(params, { ok: true, session: sess(0) }, { staked: 1 })
    expect(r.state).toBe('waiting')
  })

  it('prefers a known activation height over the next boundary', () => {
    const r = classifySession(
      params,
      { ok: false, error: noSuppliers },
      { staked: 1, activationHeight: 663741 }
    )
    expect(r).toEqual({ state: 'waiting', reason: 'next-session', readyAt: 663741 })
  })

  it('ignores an activation height that has already passed', () => {
    const r = classifySession(
      params,
      { ok: false, error: noSuppliers },
      { staked: 1, activationHeight: 663681 }
    )
    expect(r).toEqual({ state: 'waiting', reason: 'next-session', readyAt: 663721 })
  })

  it('says no supplier is staked when the chain lists none', () => {
    const r = classifySession(params, { ok: false, error: noSuppliers }, { staked: 0 })
    expect(r).toEqual({ state: 'waiting', reason: 'no-supplier', readyAt: null })
  })

  it('still names the boundary when the supplier lookup did not answer', () => {
    const r = classifySession(params, { ok: false, error: noSuppliers }, { staked: null })
    expect(r).toEqual({ state: 'waiting', reason: 'next-session', readyAt: 663721 })
  })

  it('does not block on a failure it cannot read', () => {
    const r = classifySession(
      params,
      { ok: false, error: new Error('HTTP 503 for ...: upstream connect error') },
      { staked: null }
    )
    expect(r.state).toBe('unknown')
  })

  it('leaves the block count out when the head height is unknown', () => {
    const r = classifySession({ blocksPerSession: 20 }, { ok: true, session: sess(1) }, { staked: 1 })
    expect(r).toEqual({ state: 'ready', suppliers: 1, endHeight: 663720, blocksLeft: 0 })
  })
})

describe('sessionNote', () => {
  const note = (r: Parameters<typeof sessionNote>[1]): string => sessionNote(params, r, ID)

  it('tells a ready tester how long the session has to run', () => {
    const t = note(classifySession(params, { ok: true, session: sess(2) }, { staked: 2 }))
    expect(t).toContain('2 suppliers are serving example-charts')
    expect(t).toContain('block 663,720')
    expect(t).toContain('~3 min')
  })

  it('agrees with itself on a single supplier', () => {
    expect(note(classifySession(params, { ok: true, session: sess(1) }, { staked: 1 }))).toContain(
      '1 supplier is serving'
    )
  })

  it('explains the boundary rather than the error, and names the block', () => {
    const t = note(classifySession(params, { ok: false, error: noSuppliers }, { staked: 1 }))
    expect(t).toContain('joins only at a session boundary')
    expect(t).toContain('Sessions start every 20 blocks')
    expect(t).toContain('block 663,721')
    expect(t).not.toMatch(/rpc error|Internal desc/)
  })

  it('sends an unsupplied service to Supply instead of telling it to wait', () => {
    const t = note(classifySession(params, { ok: false, error: noSuppliers }, { staked: 0 }))
    expect(t).toContain('No supplier is staked for example-charts')
    expect(t).toContain('Supply the service')
    expect(t).not.toContain('session boundary')
  })

  it('never claims a stake it did not read', () => {
    const t = note(classifySession(params, { ok: false, error: noSuppliers }, { staked: null }))
    expect(t).toContain('Nothing is serving example-charts')
    expect(t).not.toMatch(/supplier is staked|suppliers are staked/)
  })

  it('says the test will run when the check itself failed', () => {
    const t = note({ state: 'unknown', detail: 'HTTP 503' })
    expect(t).toContain('Could not read the current session')
    expect(t).toContain('will run')
  })
})
