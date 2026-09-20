// The one channel the renderer may write to the structured log. It exists so a
// post-transaction read that failed for network reasons leaves a trace; it must not
// become a way to put a chosen string into app.log.
import { describe, it, expect } from 'vitest'
import { verifyReportSchema } from '../src/main/ipc/schemas'
import type { VerifyReport } from '../src/core/contract'

const report: VerifyReport = {
  what: 'supplier',
  network: 'main',
  txhash: '395A27B1C97CACCB69F3FFA61BD58A4295B4D8C6A9F9032F0EB11CCE71C52BB9',
  height: 930333,
  outcome: 'unreadable',
  status: 0,
  services: ['example-charts', 'example-newcomer']
}

describe('verifyReportSchema', () => {
  it('accepts a report a screen actually sends', () => {
    expect(verifyReportSchema.parse(report)).toEqual(report)
  })

  it('accepts each outcome the screens can report', () => {
    for (const outcome of ['unreadable', 'stake-short', 'not-listed'] as const)
      expect(verifyReportSchema.parse({ ...report, outcome }).outcome).toBe(outcome)
  })

  it('refuses an outcome, network or kind it does not know', () => {
    expect(verifyReportSchema.safeParse({ ...report, outcome: 'something else' }).success).toBe(
      false
    )
    expect(verifyReportSchema.safeParse({ ...report, network: 'mainnet' }).success).toBe(false)
    expect(verifyReportSchema.safeParse({ ...report, what: 'keyring' }).success).toBe(false)
  })

  it('refuses anything that is not a transaction hash', () => {
    for (const txhash of ['', 'not a hash', 'ABC', report.txhash + 'A', report.txhash.slice(0, 63)])
      expect(verifyReportSchema.safeParse({ ...report, txhash }).success).toBe(false)
  })

  // The point of the pattern: a service id cannot carry a sentence, a key, or a phrase.
  it('refuses a service id that is not an id', () => {
    for (const bad of [
      'a phrase with spaces',
      'abandon abandon abandon abandon abandon abandon',
      '0xdeadbeef!',
      'x'.repeat(65),
      ''
    ])
      expect(verifyReportSchema.safeParse({ ...report, services: [bad] }).success).toBe(false)
  })

  it('bounds how many services one report can carry', () => {
    const many = Array.from({ length: 33 }, (_, i) => `example-${i}`)
    expect(verifyReportSchema.safeParse({ ...report, services: many }).success).toBe(false)
    expect(verifyReportSchema.safeParse({ ...report, services: many.slice(0, 32) }).success).toBe(
      true
    )
  })

  it('keeps the status inside HTTP range', () => {
    expect(verifyReportSchema.parse({ ...report, status: 503 }).status).toBe(503)
    expect(verifyReportSchema.safeParse({ ...report, status: 9000 }).success).toBe(false)
    expect(verifyReportSchema.safeParse({ ...report, status: -1 }).success).toBe(false)
  })

  it('strips a field nobody declared rather than passing it through', () => {
    const parsed = verifyReportSchema.parse({ ...report, note: 'a passphrase goes here' })
    expect(parsed).not.toHaveProperty('note')
  })
})
