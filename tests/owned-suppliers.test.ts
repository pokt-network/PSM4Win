import { describe, it, expect, vi, afterEach } from 'vitest'
import { ownedSuppliers, withServices, clearLcdCache } from '@core/lcd'
import { NETWORK_INFO } from '@core/networks'

const OWNER = 'pokt1' + 'q'.repeat(38)
const OP_A = 'pokt1' + 'a'.repeat(38)
const OP_B = 'pokt1' + 'b'.repeat(38)
const OP_C = 'pokt1' + 'c'.repeat(38)

afterEach(() => vi.unstubAllGlobals())

function answer(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => ({ ok, status: ok ? 200 : 502, json: async () => body }))
  vi.stubGlobal('fetch', f)
  return f
}

describe('ownedSuppliers (indexer)', () => {
  it('asks the network indexer for the owner, passing the address as a variable', async () => {
    const f = answer({ data: { suppliers: { nodes: [] } } })
    await ownedSuppliers('main', OWNER)
    const [url, init] = f.mock.calls[0] as unknown as [string, { method: string; body: string }]
    expect(url).toBe(NETWORK_INFO.main.indexer)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.variables).toEqual({ owner: OWNER, after: '' })
    expect(body.query).not.toContain(OWNER)
  })
  it('keeps staked and unstaking suppliers, drops unstaked ones', async () => {
    answer({
      data: {
        suppliers: {
          nodes: [
            { id: OP_A, stakeStatus: 'Staked', stakeAmount: '59900000000' },
            { id: OP_B, stakeStatus: 'Unstaking', stakeAmount: '60000000000' },
            { id: OP_C, stakeStatus: 'Unstaked', stakeAmount: '0' }
          ]
        }
      }
    })
    expect(await ownedSuppliers('beta', OWNER)).toEqual([
      { operator: OP_A, status: 'Staked', stakeUpokt: 59900000000 },
      { operator: OP_B, status: 'Unstaking', stakeUpokt: 60000000000 }
    ])
  })
  it('leaves unstaked suppliers out on the server, in a stable order', async () => {
    const f = answer({ data: { suppliers: { totalCount: 0, nodes: [] } } })
    await ownedSuppliers('main', OWNER)
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.query).toContain('stakeStatus: { notEqualTo: Unstaked }')
    expect(body.query).toContain('orderBy: ID_ASC')
    expect(body.query).toContain('id: { greaterThan: $after }')
  })
  it('reads every page when the owner has more suppliers than the indexer answers at once', async () => {
    const node = (i: number): { id: string; stakeStatus: string; stakeAmount: string } => ({
      id: 'pokt1' + String(i).padStart(38, '0'),
      stakeStatus: 'Staked',
      stakeAmount: '1'
    })
    const pages = [
      Array.from({ length: 1000 }, (_, i) => node(i)),
      Array.from({ length: 37 }, (_, i) => node(1000 + i))
    ]
    const f = vi.fn(async (_url: string, init: { body: string }) => {
      // Keyset: the second page is whatever follows the last address of the first.
      const { after } = JSON.parse(init.body).variables
      const page = after === '' ? pages[0] : pages[1].filter((n) => n.id > after)
      const rest = after === '' ? 1037 : 37
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { suppliers: { totalCount: rest, nodes: page } } })
      }
    })
    vi.stubGlobal('fetch', f)
    const got = await ownedSuppliers('main', OWNER)
    expect(f).toHaveBeenCalledTimes(2)
    const cursors = f.mock.calls.map((c) => JSON.parse(c[1].body).variables.after)
    expect(cursors).toEqual(['', pages[0][999].id])
    expect(got).toHaveLength(1037)
    expect(new Set(got.map((g) => g.operator)).size).toBe(1037)
  })
  it('stops after one request when the owner has exactly as many suppliers as a page holds', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({
      id: 'pokt1' + String(i).padStart(38, '0'),
      stakeStatus: 'Staked',
      stakeAmount: '1'
    }))
    const f = vi.fn(async (_url: string, init: { body: string }) => {
      const { after } = JSON.parse(init.body).variables
      const rest = after === '' ? page : []
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { suppliers: { totalCount: rest.length, nodes: rest } } })
      }
    })
    vi.stubGlobal('fetch', f)
    const got = await ownedSuppliers('main', OWNER)
    expect(f).toHaveBeenCalledTimes(1)
    expect(got).toHaveLength(1000)
  })
  it('keeps reading when the indexer answers fewer rows per page than it was asked for', async () => {
    const all = Array.from({ length: 1037 }, (_, i) => ({
      id: 'pokt1' + String(i).padStart(38, '0'),
      stakeStatus: 'Staked',
      stakeAmount: '1'
    }))
    const f = vi.fn(async (_url: string, init: { body: string }) => {
      const { after } = JSON.parse(init.body).variables
      const rest = all.filter((n) => n.id > after)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { suppliers: { totalCount: rest.length, nodes: rest.slice(0, 500) } }
        })
      }
    })
    vi.stubGlobal('fetch', f)
    const got = await ownedSuppliers('main', OWNER)
    expect(f).toHaveBeenCalledTimes(3)
    expect(got.map((g) => g.operator)).toEqual(all.map((n) => n.id))
  })
  it('never queries for something that is not an address', async () => {
    const f = answer({ data: { suppliers: { nodes: [] } } })
    expect(await ownedSuppliers('main', 'not-an-address')).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })
  it('reports indexer errors instead of an empty list', async () => {
    answer({ errors: [{ message: 'boom' }] })
    await expect(ownedSuppliers('main', OWNER)).rejects.toThrow('boom')
    answer({}, false)
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
        i === 5 || i === 9
          ? { ...o, services: [], url: '' }
          : { ...o, services: [`svc${i}`], url: `https://s${i}` }
      )
    )
  })
})
