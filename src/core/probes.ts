// Test probes and grading, ported from app.js (testProbes, jsonPathGet, gradeStep).
import type { RelayCallResult } from './contract'

export interface ProbeStep {
  label: string
  method: string
  path: string
  body: string
  jsonPath?: string
  matches?: string
  expectStatus: number
  badInput?: boolean
}

interface HealthcheckLike {
  request?: { path?: string; method?: string; body?: unknown }
  expect?: { json_path?: string; matches?: string }
  notes?: string
}

/**
 * The body the synthetic bad-input probe sends: a lone brace, which is not JSON at all.
 *
 * It used to be `{}`, on the assumption that an empty object is always missing a
 * required field. That holds for a service whose POST needs arguments and fails for
 * one where every field is optional: an empty object is then a legal request, the
 * backend rightly answers 200, and a correct service is graded red. Input no parser
 * accepts is the only bad input every JSON service agrees on, and it is what the
 * Skill's lint_backend.py probes with (references/design-rules.md: 4xx with JSON for
 * bad input, 5xx only for real failures).
 */
export const BAD_INPUT_BODY = '{'

/** The card's serving.healthcheck entries plus a bad-input probe per POST, or two defaults without a card. */
export function testProbes(card: unknown, id: string): { steps: ProbeStep[]; fromCard: boolean } {
  const steps: ProbeStep[] = []
  const serving =
    card && typeof card === 'object'
      ? (card as { serving?: { healthcheck?: HealthcheckLike[] } }).serving
      : undefined
  const hc = Array.isArray(serving?.healthcheck) ? serving!.healthcheck! : []
  for (const h of hc) {
    const rq = h.request ?? {}
    const ex = h.expect ?? {}
    if (!rq.path) continue
    const note = String(h.notes ?? '').toLowerCase()
    const label = note.includes('identity')
      ? 'Identity probe'
      : note.includes('readiness')
        ? 'Readiness probe'
        : 'Functional probe'
    const method = rq.method || 'GET'
    steps.push({
      label: `${label} ${method} ${rq.path}`,
      method,
      path: rq.path,
      body: rq.body ? JSON.stringify(rq.body) : '',
      jsonPath: ex.json_path,
      matches: ex.matches,
      expectStatus: 200
    })
    if (method === 'POST' && rq.body)
      steps.push({
        label: 'Bad input POST ' + rq.path,
        method: 'POST',
        path: rq.path,
        body: BAD_INPUT_BODY,
        expectStatus: 400,
        badInput: true
      })
  }
  if (!steps.length) {
    steps.push({
      label: 'Identity probe GET /v1/version',
      method: 'GET',
      path: '/v1/version',
      body: '',
      jsonPath: '$.service',
      matches: '^' + id + '$',
      expectStatus: 200
    })
    steps.push({
      label: 'Readiness probe GET /healthz',
      method: 'GET',
      path: '/healthz',
      body: '',
      jsonPath: '$.status',
      matches: '^ok$',
      expectStatus: 200
    })
  }
  return { steps, fromCard: hc.length > 0 }
}

/** The readiness probe's path, else /healthz. */
export function readinessPathOf(card: unknown, id: string): string {
  for (const s of testProbes(card, id).steps) if (s.label.startsWith('Readiness')) return s.path
  return '/healthz'
}

/** Minimal JSONPath: $.a.b[0].c */
export function jsonPathGet(obj: unknown, path: string | undefined): unknown {
  if (!path || path.charAt(0) !== '$') return undefined
  let cur: unknown = obj
  const parts = path
    .substring(1)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
  for (const part of parts) {
    if (part === '') continue
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export interface Grade {
  ok: boolean
  note: string
}

/**
 * Whether the relay never completed, as opposed to the service answering badly.
 *
 * No HTTP status came back and the client exited non-zero, so nothing was graded: the
 * request died at the protocol layer. The first relay of a session is where this shows
 * up, with a truncated RelayResponse reported as an unexpected EOF, and grading it as a
 * failed probe blames a service that was never asked. A relay like this is worth
 * sending again; a 500 from the backend, or a body that is not JSON, is not.
 */
export function relayIncomplete(r: RelayCallResult): boolean {
  return r.exit_code !== 0 && !(r.http || 0)
}

export function gradeStep(step: ProbeStep, r: RelayCallResult): Grade {
  const body = String(r.body ?? '')
  const first = body.trim().charAt(0)
  const out: Grade = { ok: false, note: '' }
  const status = r.http || 0
  if (relayIncomplete(r)) {
    out.note =
      'relay failed: ' +
      (String(r.diagnostics ?? '')
        .trim()
        .split('\n')
        .pop() ?? '')
    return out
  }
  if (first !== '{' && first !== '[') {
    out.note = `response is not a JSON object (starts with '${first}'); gateways penalize this`
    return out
  }
  let json: unknown = null
  try {
    json = JSON.parse(body)
  } catch {
    out.note = 'response is not valid JSON'
    return out
  }
  if (step.badInput) {
    if (
      status >= 400 &&
      status < 500 &&
      json &&
      typeof json === 'object' &&
      'error' in (json as object) &&
      (json as { error: unknown }).error
    ) {
      out.ok = true
      out.note = `HTTP ${status} with a JSON error object, as required`
    } else out.note = 'expected a 4xx JSON error, got HTTP ' + (status || 200)
    return out
  }
  if (status && status !== 200) {
    out.note = 'HTTP ' + status
    return out
  }
  if (step.jsonPath) {
    const v = jsonPathGet(json, step.jsonPath)
    const sv = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    let re: RegExp | null
    try {
      re = new RegExp(step.matches || '')
    } catch {
      re = null
    }
    if (v === undefined) {
      out.note = step.jsonPath + ' is missing from the response'
      return out
    }
    if (re && !re.test(sv)) {
      out.note = `${step.jsonPath} = ${sv.substring(0, 60)} does not match ${step.matches}`
      return out
    }
    out.ok = true
    out.note = `${step.jsonPath} = ${sv.substring(0, 60)}`
    return out
  }
  out.ok = true
  out.note = 'JSON object returned'
  return out
}

/**
 * How long gateways give a relay (design rule 7). Not chain values: they are what
 * gateway operators set. SAGE bounds each attempt by its per-service relay_timeout,
 * typically 10 to 30 s, and PATH's default was 10 s. The RelayMiner's own `fast`
 * profile allows 30 s, so past that nothing on the path waits.
 */
export const GATEWAY_TIMEOUT_LOW_S = 10
export const GATEWAY_TIMEOUT_HIGH_S = 30

/**
 * The supplier's round trip for the attempt that produced the answer, from pocket-ap's
 * diagnostics ("attempt 1: pokt1... in 6021ms via ..."). This is what a gateway's
 * timeout applies to; the wall time of the whole call also counts starting the client
 * container and looking up the session, so it would overstate the service. Null when
 * the diagnostics carry no attempt line.
 */
export function relayLatencyMs(diagnostics: string | undefined): number | null {
  const all = [...String(diagnostics ?? '').matchAll(/attempt \d+: \S+ in (\d+)ms/g)]
  return all.length ? Number(all[all.length - 1][1]) : null
}

/** How a probe's latency sits against gateway timeouts: fine, slow (warn), or too slow (fail). */
export function gradeLatency(ms: number | null): { level: 'ok' | 'warn' | 'fail'; note: string } {
  if (ms === null) return { level: 'ok', note: '' }
  const s = (ms / 1000).toFixed(1)
  if (ms > GATEWAY_TIMEOUT_HIGH_S * 1000)
    return {
      level: 'fail',
      note: `took ${s} s, longer than any gateway waits (${GATEWAY_TIMEOUT_HIGH_S} s at most), so every gateway will cut this request off. Answer quickly, or hand back a job ID and let the caller ask for the result.`
    }
  if (ms > GATEWAY_TIMEOUT_LOW_S * 1000)
    return {
      level: 'warn',
      note: `took ${s} s. Gateways set to wait ${GATEWAY_TIMEOUT_LOW_S} s will cut this request off, and many are. Answer within ${GATEWAY_TIMEOUT_LOW_S} s, or hand back a job ID and let the caller ask for the result.`
    }
  return { level: 'ok', note: '' }
}

export interface TestLogEntry {
  time: string
  network: string
  service: string
  wallet: string
  passed: number
  total: number
  ms: number
  steps: { label: string; ok: boolean; ms: number; http: number; note: string }[]
}
