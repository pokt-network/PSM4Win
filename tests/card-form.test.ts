import { describe, it, expect } from 'vitest'
import { buildCard, formFromCard, GATEWAY_SENTENCE_RE, EMPTY_CREATE_FORM } from '@core/card-form'

const strip = (s: string): string => s.replace(GATEWAY_SENTENCE_RE, '')

describe('gateway sentence in serving.notes', () => {
  it('strips the old passthrough wording', () => {
    expect(
      strip(
        'No rate limits. Gateway operators: configure as type passthrough with rpc_types ["rest"].'
      )
    ).toBe('No rate limits.')
  })
  it('strips the new generic wording', () => {
    expect(
      strip(
        'No rate limits. SAGE operators: type generic (its name for passthrough), rpc_types ["rest"].'
      )
    ).toBe('No rate limits.')
  })
  it('strips the new wording with a timeout and repository pointer after it', () => {
    expect(
      strip(
        'Renders finish in under a second. SAGE operators: type generic (its name for passthrough), rpc_types ["rest"], relay_timeout at least 15s; see sage-service.yaml in the service repository.'
      )
    ).toBe('Renders finish in under a second.')
  })
  it('keeps multi-line notes before the sentence and strips across line breaks after it', () => {
    expect(
      strip(
        'Line one.\nLine two.\nSAGE operators: type generic (its name for passthrough),\nrpc_types ["rest"].\nsee sage-service.yaml.'
      )
    ).toBe('Line one.\nLine two.')
    expect(
      strip(
        'Line one.\nLine two. Gateway operators: configure as type passthrough\nwith rpc_types ["rest"].'
      )
    ).toBe('Line one.\nLine two.')
  })
  it('leaves notes without the sentence alone', () => {
    expect(strip('No rate limits to disable.')).toBe('No rate limits to disable.')
  })
  it('writes the generic wording and round-trips build, strip, build without doubling', () => {
    const form = {
      ...EMPTY_CREATE_FORM,
      id: 'example-charts',
      desc: 'Charts.',
      apis: 'example-charts-api',
      servingNotes: 'No rate limits to disable.'
    }
    const card = buildCard(form)
    const notes = (card.serving as { notes: string }).notes
    expect(notes).toBe(
      'No rate limits to disable. SAGE operators: type generic (its name for passthrough), rpc_types ["rest"].'
    )
    expect(notes).not.toMatch(/passthrough with/)
    const loaded = formFromCard('example-charts', card, { service_id: 'example-charts' })
    expect(loaded.servingNotes).toBe('No rate limits to disable.')
    const again = buildCard(loaded)
    expect((again.serving as { notes: string }).notes).toBe(notes)
  })
  it('writes the sentence alone when there are no serving notes', () => {
    const card = buildCard({ ...EMPTY_CREATE_FORM, id: 'x', apis: 'x-api' })
    const notes = (card.serving as { notes: string }).notes
    expect(notes).toBe(
      'SAGE operators: type generic (its name for passthrough), rpc_types ["rest"].'
    )
    expect(formFromCard('x', card, {}).servingNotes).toBe('')
  })
})
