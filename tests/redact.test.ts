import { describe, it, expect } from 'vitest'
import { redact, redactDeep } from '@core/redact'

describe('log redaction (security model)', () => {
  const hex = 'deadbeef'.repeat(8)
  const pass = 'A'.repeat(43) + '='
  const phrase =
    'abandon ability able about above absent absorb abstract absurd abuse access accident'

  it('replaces hex keys', () => {
    expect(redact(`key=${hex} done`)).toBe('key=[redacted-hex] done')
  })
  it('replaces the passphrase shape', () => {
    expect(redact(`pass ${pass} end`)).toBe('pass [redacted] end')
    expect(redact('sha256:' + 'a'.repeat(64))).not.toContain('a'.repeat(64))
  })
  it('replaces recovery phrases', () => {
    expect(redact(`phrase: ${phrase}`)).toBe('phrase: [redacted-phrase]')
    expect(redact('the quick brown fox')).toBe('the quick brown fox')
  })
  it('replaces long hex blobs and env assignments', () => {
    expect(redact('01ab'.repeat(64))).toBe('[redacted-blob]')
    expect(redact('PSM_STDIN=secret\\nsecret')).toBe('PSM_STDIN=[redacted]')
  })
  it('redacts secret fields deeply', () => {
    const r = redactDeep({
      privateKeyHex: hex,
      mnemonic: phrase,
      nested: { hex, note: `x ${hex}` },
      list: [pass]
    })
    expect(r).toEqual({
      privateKeyHex: '[redacted]',
      mnemonic: '[redacted]',
      nested: { hex: '[redacted]', note: 'x [redacted-hex]' },
      list: ['[redacted]']
    })
  })
  it('leaves addresses and tx hashes readable', () => {
    const addr = 'pokt1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y'
    expect(redact(`addr ${addr}`)).toContain(addr)
    // A tx hash is 64 hex and is deliberately treated like a key: better a hidden hash than a leaked key.
    expect(redact('tx ' + 'AB'.repeat(32))).toBe('tx [redacted-hex]')
  })
})
