// readAfterTx: the read a screen does straight after a transaction, and the
// service-config-history shape it has to grade (docs/SCREENS.md 3.10).
import { describe, it, expect } from 'vitest'
import { readAfterTx, type ChainSupplier } from '@core/lcd'
import { supplierServiceIds } from '@core/chain'

type Lookup = { status: number; rec: ChainSupplier | null }

/**
 * A supplier one block after a stake that added a service to an existing one, in the
 * shape the node returns: the new service is not in the active list, it is in the
 * config history with the next session boundary as its activation height, and the
 * service that was already there appears twice, the old entry closed at that same
 * boundary and a new one opening at it.
 */
const justStaked: ChainSupplier = {
  owner_address: 'pokt1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y',
  operator_address: 'pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j',
  stake: { denom: 'upokt', amount: '59900000000' },
  services: [{ service_id: 'example-charts', endpoints: [{ url: 'https://x', rpc_type: 'REST' }] }],
  service_config_history: [
    {
      service: { service_id: 'example-newcomer' },
      activation_height: '930341',
      deactivation_height: '0'
    },
    {
      service: { service_id: 'example-charts' },
      activation_height: '921961',
      deactivation_height: '930341'
    },
    {
      service: { service_id: 'example-charts' },
      activation_height: '930341',
      deactivation_height: '0'
    }
  ]
}

/** The grading the Supply screen does over that record. */
function grade(
  rec: ChainSupplier,
  submitted: string[]
): { pending: Record<string, number>; missing: string[] } {
  const got = supplierServiceIds(rec)
  const scheduled: Record<string, number> = {}
  for (const he of rec.service_config_history ?? [])
    if (he.service && Number(he.deactivation_height || 0) === 0)
      scheduled[he.service.service_id] = Number(he.activation_height || 0)
  const pending: Record<string, number> = {}
  const missing: string[] = []
  for (const id of submitted) {
    if (got.includes(id)) continue
    if (scheduled[id] !== undefined) pending[id] = scheduled[id]
    else missing.push(id)
  }
  return { pending, missing }
}

describe('a stake that adds a service to an existing supplier', () => {
  it('counts the new service as scheduled, not missing', () => {
    const g = grade(justStaked, ['example-charts', 'example-newcomer'])
    expect(g.missing).toEqual([])
    expect(g.pending).toEqual({ 'example-newcomer': 930341 })
  })

  it('does not read the closed history entry as a schedule', () => {
    // The old example-charts entry carries a deactivation height; only the open one counts.
    const g = grade({ ...justStaked, services: [] }, ['example-charts'])
    expect(g.pending).toEqual({ 'example-charts': 930341 })
  })

  it('still reports a service the stake never mentioned', () => {
    const g = grade(justStaked, ['example-charts', 'example-absent'])
    expect(g.missing).toEqual(['example-absent'])
  })
})

describe('readAfterTx', () => {
  const ok = (x: Lookup): boolean => !!x.rec
  const found: Lookup = { status: 200, rec: justStaked }
  const failed: Lookup = { status: 0, rec: null }

  it('takes the first answer when it is usable', async () => {
    let calls = 0
    const r = await readAfterTx(
      () => {
        calls++
        return Promise.resolve(found)
      },
      ok,
      0
    )
    expect(calls).toBe(1)
    expect(r).toBe(found)
  })

  // One unlucky request in the seconds after a transaction is not evidence that the
  // transaction did nothing, which is how it used to be reported.
  it('reads again when the node did not answer, and returns the second answer', async () => {
    let calls = 0
    const r = await readAfterTx(() => Promise.resolve(++calls === 1 ? failed : found), ok, 0)
    expect(calls).toBe(2)
    expect(r).toBe(found)
  })

  it('gives up after the second read and hands the failure back to be graded', async () => {
    let calls = 0
    const r = await readAfterTx(
      () => {
        calls++
        return Promise.resolve(failed)
      },
      ok,
      0
    )
    expect(calls).toBe(2)
    expect(r.rec).toBeNull()
  })
})
