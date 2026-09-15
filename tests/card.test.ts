import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCardText, readinessPath, formatCardValidation } from '@core/card'

const fixtures = join(process.cwd(), 'fixtures', 'services')

describe('card validator (port of validate_card.py)', () => {
  it('accepts the example-charts card', () => {
    const text = readFileSync(join(fixtures, 'example-charts', 'card.json'), 'utf8')
    const v = validateCardText(text)
    expect(v.ok, v.schema_errors.join('; ')).toBe(true)
    expect(v.size_bytes).toBeLessThan(256 * 1024)
    expect(formatCardValidation(v)).toMatch(/card is valid$/)
  })
  it('accepts the beta test service card', () => {
    const text = readFileSync(join(fixtures, 'example-builder-test', 'card.json'), 'utf8')
    expect(validateCardText(text).ok).toBe(true)
  })
  it('rejects the forbidden required key and bad schema id', () => {
    const v = validateCardText(
      JSON.stringify({
        schema: 'pocket-service-card/v2',
        rpc_types: [{ type: 'REST', required: true }]
      })
    )
    expect(v.ok).toBe(false)
    expect(v.schema_errors.some((e) => /'required' key/.test(e))).toBe(true)
  })
  it('flags non-JSON and oversize cards as fatal', () => {
    expect(validateCardText('{not json').fatal).toMatch(/not a single JSON object/)
    expect(validateCardText('"' + 'x'.repeat(300 * 1024) + '"').fatal).toMatch(/256 KiB/)
  })
  it('reads the readiness probe path from the card', () => {
    const card = JSON.parse(readFileSync(join(fixtures, 'example-charts', 'card.json'), 'utf8'))
    expect(readinessPath(card)).toMatch(/^\//)
    expect(readinessPath({})).toBe('/healthz')
  })
})
