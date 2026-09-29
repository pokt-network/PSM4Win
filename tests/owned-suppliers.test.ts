import { describe, it, expect, vi, afterEach } from 'vitest'
import { ownedSuppliers } from '@core/lcd'
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
    expect(body.variables).toEqual({ owner: OWNER })
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
