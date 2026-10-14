import { describe, it, expect, vi, afterEach } from 'vitest'
import { ownedSuppliers, withServices, clearLcdCache, OWNED_SUPPLIERS_MAX_PAGES } from '@core/lcd'
import { NETWORK_INFO } from '@core/networks'

const OWNER = 'pokt1' + 'q'.repeat(38)
const OP_A = 'pokt1' + 'a'.repeat(38)
const OP_B = 'pokt1' + 'b'.repeat(38)
const OP_C = 'pokt1' + 'c'.repeat(38)

afterEach(() => vi.unstubAllGlobals())

type N = { id: string; stakeStatus: string; stakeAmount: string }
const node = (i: number, stakeStatus = 'Staked'): N => ({
  id: 'pokt1' + String(i).padStart(38, '0'),
  stakeStatus,
  stakeAmount: '1'
})
const H = 964626
const AT = String(H)
type Read = { query: string; variables: Record<string, string> }
const reads = (f: ReturnType<typeof vi.fn>): Read[] =>
  f.mock.calls.map((c) => JSON.parse((c as unknown as [string, { body: string }])[1].body))

/**
 * A fake indexer: answers every `<alias>: suppliers(... greaterThan: $<var> ...)` in a query
 * with the rows of `pinnedList` (with blockHeight) or `liveList` (without) after the cursor,
 * at most `per` a page, and `_metadata` with height H unless `height` is null.
 */
function indexer(
  pinnedList: N[],
  o: { per?: number; liveList?: N[]; height?: number | null; ignoreCursor?: boolean } = {}
): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as Read
    const data: Record<string, unknown> = {}
    if (query.includes('_metadata') && o.height !== null)
      data._metadata = { lastProcessedHeight: o.height ?? H }
    for (const m of query.matchAll(
      /(\w+): suppliers\(filter: .*? greaterThan: \$(\w+) \} \}, orderBy: ID_ASC, first: 1000(, blockHeight: \$at)?\)/g
    )) {
      const list = m[3] ? pinnedList : (o.liveList ?? pinnedList)
      const rest = list.filter((n) => o.ignoreCursor || n.id > variables[m[2]])
      data[m[1]] = { totalCount: rest.length, nodes: rest.slice(0, o.per ?? 1000) }
    }
    return { ok: true, status: 200, json: async () => ({ data }) }
  })
  vi.stubGlobal('fetch', f)
  return f
}

describe('ownedSuppliers (indexer)', () => {
  it('asks the network indexer for the owner, passing the address as a variable', async () => {
    const f = indexer([])
    await ownedSuppliers('main', OWNER)
    const [url, init] = f.mock.calls[0] as unknown as [string, { method: string; body: string }]
    expect(url).toBe(NETWORK_INFO.main.indexer)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.variables).toEqual({ owner: OWNER, after: '' })
    expect(body.query).not.toContain(OWNER)
  })
  it('keeps staked and unstaking suppliers, drops unstaked ones', async () => {
    indexer([
      { id: OP_A, stakeStatus: 'Staked', stakeAmount: '59900000000' },
      { id: OP_B, stakeStatus: 'Unstaking', stakeAmount: '60000000000' },
      { id: OP_C, stakeStatus: 'Unstaked', stakeAmount: '0' }
    ])
    expect(await ownedSuppliers('beta', OWNER)).toEqual([
      { operator: OP_A, status: 'Staked', stakeUpokt: 59900000000 },
      { operator: OP_B, status: 'Unstaking', stakeUpokt: 60000000000 }
    ])
  })
  it('leaves unstaked suppliers out on the server, in a stable order', async () => {
    const f = indexer([])
    await ownedSuppliers('main', OWNER)
    const { query } = reads(f)[0]
    expect(query).toContain('stakeStatus: { notEqualTo: Unstaked }')
    expect(query).toContain('orderBy: ID_ASC')
    expect(query).toContain('id: { greaterThan: $after }')
  })
  it('reads two pages in two requests, both as of the block the first one reported', async () => {
    const all = Array.from({ length: 1037 }, (_, i) => node(i))
    const f = indexer(all)
    const got = await ownedSuppliers('main', OWNER)
    expect(f).toHaveBeenCalledTimes(2)
    const [r1, r2] = reads(f)
    expect(r1.query).toContain('_metadata { lastProcessedHeight }')
    expect(r1.query).not.toContain('blockHeight')
    // The second request reads page 1 again and page 2, both pinned.
    expect(r2.variables).toEqual({ owner: OWNER, after: '', next: all[999].id, at: AT })
    expect(r2.query.match(/blockHeight: \$at/g)).toHaveLength(2)
    expect(got).toHaveLength(1037)
    expect(new Set(got.map((g) => g.operator)).size).toBe(1037)
  })
  it('keeps going from the pinned page 1 when it no longer ends where the first read did', async () => {
    // A supplier staked between the two reads, so the pinned page 1 ends one address earlier.
    const pinned = Array.from({ length: 1037 }, (_, i) => node(i))
    const live = pinned.filter((_, i) => i !== 5)
    const f = indexer(pinned, { liveList: live })
    const got = await ownedSuppliers('main', OWNER)
    expect(got.map((g) => g.operator)).toEqual(pinned.map((n) => n.id))
    // The second request's page 2 was cut after the live cursor, so it is read again pinned.
    expect(f).toHaveBeenCalledTimes(3)
    expect(reads(f)[2].variables).toEqual({ owner: OWNER, after: pinned[999].id, at: AT })
  })
  it('reads a page that lists an address twice again, as of the block the indexer reported', async () => {
    // While a block is being written, a restaked supplier shows its old and new version.
    const pinned = [node(1), node(2, 'Unstaking'), node(3)]
    const live = [node(1), node(2), node(2, 'Unstaking'), node(3)]
    const f = indexer(pinned, { liveList: live })
    const got = await ownedSuppliers('main', OWNER)
    expect(f).toHaveBeenCalledTimes(2)
    expect(reads(f)[1].variables.at).toBe(AT)
    expect(got.map((g) => [g.operator, g.status])).toEqual(pinned.map((n) => [n.id, n.stakeStatus]))
  })
  it('stops after one request when the owner has exactly as many suppliers as a page holds', async () => {
    const f = indexer(Array.from({ length: 1000 }, (_, i) => node(i)))
    expect(await ownedSuppliers('main', OWNER)).toHaveLength(1000)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('keeps reading when the indexer answers fewer rows per page than it was asked for', async () => {
    const all = Array.from({ length: 1037 }, (_, i) => node(i))
    const f = indexer(all, { per: 500 })
    const got = await ownedSuppliers('main', OWNER)
    // 500 unpinned; then 500 + 500 pinned in one request; then the last 37.
    expect(f).toHaveBeenCalledTimes(3)
    expect(got.map((g) => g.operator)).toEqual(all.map((n) => n.id))
  })
  it('stops with an error when the indexer hands back the same page instead of the next', async () => {
    const page = Array.from({ length: 1037 }, (_, i) => node(i))
    // An indexer that ignores the cursor: always the first rows, always more remaining.
    const f = indexer(page, { per: 500, ignoreCursor: true })
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow('did not move on')
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('gives up after a bounded number of pages rather than reading forever', async () => {
    const f = indexer(
      Array.from({ length: 200 }, (_, i) => node(i)),
      { per: 1 }
    )
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow(
      `after ${OWNED_SUPPLIERS_MAX_PAGES} pages`
    )
    expect(f).toHaveBeenCalledTimes(OWNED_SUPPLIERS_MAX_PAGES)
  })
  it('stops with an error when the rows read do not add up to what the indexer counted', async () => {
    // The pinned page 1 counts two suppliers but lists one, and nothing follows it.
    const f = vi.fn(async (_url: string, init: { body: string }) => {
      const { query } = JSON.parse(init.body) as Read
      const one = { totalCount: 2, nodes: [{ id: OP_A, stakeStatus: 'Staked', stakeAmount: '1' }] }
      const data = query.includes('_metadata')
        ? { _metadata: { lastProcessedHeight: H }, s: one }
        : { a: one, b: { totalCount: 0, nodes: [] } }
      return { ok: true, status: 200, json: async () => ({ data }) }
    })
    vi.stubGlobal('fetch', f)
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow('counted 2 suppliers but listed 1')
  })
  it('needs the block the indexer reached only to read a second page', async () => {
    indexer([node(1)], { height: null })
    expect(await ownedSuppliers('main', OWNER)).toHaveLength(1)
    const f = indexer(
      Array.from({ length: 1001 }, (_, i) => node(i)),
      { height: null }
    )
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow('which block')
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('never queries for something that is not an address', async () => {
    const f = indexer([])
    expect(await ownedSuppliers('main', 'not-an-address')).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })
  it('reports indexer errors instead of an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'boom' }] })
      }))
    )
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow('boom')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }))
    )
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow('HTTP 502')
  })
})

describe('withServices (LCD)', () => {
  afterEach(() => clearLcdCache())

  it('reads eight at a time, keeps the order given, and leaves a failed or unknown supplier with no services', async () => {
    const ops = Array.from({ length: 17 }, (_, i) => 'pokt1' + String(i).padStart(38, '0'))
    const owned = ops.map((operator) => ({ operator, status: 'Staked', stakeUpokt: 1 }))
    let done = 0
    const startedAfter: number[] = []
    const f = vi.fn(async (url: string) => {
      const i = ops.indexOf(url.split('/').at(-1) ?? '')
      startedAfter.push(done)
      // Later suppliers answer first, so the order out cannot come from the order answered.
      await new Promise((r) => setTimeout(r, 17 - i))
      done++
      if (i === 5) return { ok: false, status: 500, text: async () => 'boom' }
      if (i === 9) return { ok: false, status: 404, text: async () => 'not found' }
      if (i === 12) throw new TypeError('fetch failed')
      const service = {
        service_id: `svc${i}`,
        endpoints: [{ url: `https://s${i}`, rpc_type: 'JSON_RPC' }]
      }
      return { ok: true, status: 200, json: async () => ({ supplier: { services: [service] } }) }
    })
    vi.stubGlobal('fetch', f)
    const got = await withServices('main', owned)
    // Each read starts only after every read of the batch before it answered: 8, 8, then 1.
    expect(startedAfter).toEqual([...Array(8).fill(0), ...Array(8).fill(8), 16])
    expect(got).toEqual(
      owned.map((o, i) =>
        i === 5 || i === 9 || i === 12
          ? { ...o, services: [], url: '' }
          : { ...o, services: [`svc${i}`], url: `https://s${i}` }
      )
    )
  })
})
