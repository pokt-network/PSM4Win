// Probe building and grading (docs/SCREENS.md 3.8).
import { describe, it, expect } from 'vitest'
import { testProbes, gradeStep, BAD_INPUT_BODY, type ProbeStep } from '@core/probes'
import type { RelayCallResult } from '@core/contract'

const card = (request: Record<string, unknown>): unknown => ({
  serving: {
    healthcheck: [
      {
        request: { path: '/v1/version', method: 'GET' },
        expect: { json_path: '$.service', matches: '^example-charts$' },
        notes: 'Identity probe: pins the backend to this service.'
      },
      { request, expect: { json_path: '$.marks', matches: '^1$' }, notes: 'Functional probe.' }
    ]
  }
})

const answer = (over: Partial<RelayCallResult>): RelayCallResult =>
  ({
    ok: true,
    exit_code: 0,
    http: 200,
    body: '{}',
    diagnostics: '',
    ms: 10,
    ...over
  }) as RelayCallResult

const badStep: ProbeStep = {
  label: 'Bad input POST /v1/launches',
  method: 'POST',
  path: '/v1/launches',
  body: BAD_INPUT_BODY,
  expectStatus: 400,
  badInput: true
}

describe('the bad-input probe', () => {
  it('sends something no JSON parser accepts', () => {
    expect(() => JSON.parse(BAD_INPUT_BODY)).toThrow()
  })

  // An empty object is a legal request to any service whose fields are all optional,
  // so it cannot stand in for bad input: the backend answers 200 and a correct
  // service is graded red.
  it('does not send an empty object, which some services accept', () => {
    expect(BAD_INPUT_BODY).not.toBe('{}')
    expect(JSON.parse('{}')).toEqual({})
  })

  it('follows every POST probe that carries a body', () => {
    const { steps, fromCard } = testProbes(
      card({ path: '/v1/chart', method: 'POST', body: { chart: { type: 'bar' } } }),
      'example-charts'
    )
    expect(fromCard).toBe(true)
    expect(steps.map((s) => s.label)).toEqual([
      'Identity probe GET /v1/version',
      'Functional probe POST /v1/chart',
      'Bad input POST /v1/chart'
    ])
    expect(steps[2]).toMatchObject({ body: BAD_INPUT_BODY, badInput: true, expectStatus: 400 })
  })

  it('is not added for a GET probe or a POST without a body', () => {
    const get = testProbes(card({ path: '/v1/chart', method: 'GET' }), 'example-charts')
    const post = testProbes(card({ path: '/v1/chart', method: 'POST' }), 'example-charts')
    expect(get.steps.some((s) => s.badInput)).toBe(false)
    expect(post.steps.some((s) => s.badInput)).toBe(false)
  })

  it('is left out of the two default probes when there is no card', () => {
    const { steps, fromCard } = testProbes(null, 'example-charts')
    expect(fromCard).toBe(false)
    expect(steps.map((s) => s.label)).toEqual([
      'Identity probe GET /v1/version',
      'Readiness probe GET /healthz'
    ])
  })
})

describe('grading the bad-input probe', () => {
  it('passes on a 4xx carrying a JSON error object', () => {
    const g = gradeStep(badStep, answer({ http: 400, body: '{"error":"invalid_json"}' }))
    expect(g.ok).toBe(true)
    expect(g.note).toContain('HTTP 400')
  })

  it('fails when the backend accepts it and answers 200', () => {
    const g = gradeStep(badStep, answer({ http: 200, body: '{"window_minutes":60}' }))
    expect(g.ok).toBe(false)
    expect(g.note).toContain('expected a 4xx JSON error')
  })

  it('fails on a 5xx, which is never paid', () => {
    const g = gradeStep(badStep, answer({ http: 500, body: '{"error":"boom"}' }))
    expect(g.ok).toBe(false)
  })

  it('fails on a 4xx with no error field to explain it', () => {
    const g = gradeStep(badStep, answer({ http: 400, body: '{"detail":"nope"}' }))
    expect(g.ok).toBe(false)
  })

  it('fails on a 4xx that is not a JSON object at all (the envelope rule)', () => {
    const g = gradeStep(badStep, answer({ http: 400, body: '<html>Bad Request</html>' }))
    expect(g.ok).toBe(false)
    expect(g.note).toContain('not a JSON object')
  })
})
