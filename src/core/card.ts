// Service card validation without pocketd or Python. Port of
// reference/mcp/src/tools/card.ts (itself a port of the Skill's validate_card.py).
// The JSON Schema is the snapshot in assets/; pocketd tx service validate-card
// remains the authoritative check.
import { Validator } from '@cfworker/json-schema'
import schema from './assets/service_card.schema.json'

const RPC_ENUM = new Set(['GRPC', 'WEBSOCKET', 'JSON_RPC', 'REST', 'COMET_BFT'])
export const CARD_MAX_HARD = 256 * 1024
export const CARD_MAX_TARGET = 4 * 1024

let validator: Validator | null = null

function schemaErrors(card: unknown): string[] {
  validator ??= new Validator(schema as never, '2020-12', false)
  const r = validator.validate(card)
  if (r.valid) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of r.errors) {
    const line = `${e.instanceLocation || '#'}: ${e.error}`
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out.slice(0, 60)
}

type AnyObj = Record<string, unknown>
function isObj(v: unknown): v is AnyObj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function structuralErrors(card: unknown): string[] {
  const errs: string[] = []
  if (!isObj(card)) return ['card must be a JSON object']
  if (card.schema !== 'pocket-service-card/v1')
    errs.push('schema must be exactly "pocket-service-card/v1"')
  arr(card.rpc_types).forEach((r, i) => {
    if (!isObj(r)) {
      errs.push(`rpc_types[${i}] must be an object`)
      return
    }
    if ('required' in r)
      errs.push(`rpc_types[${i}] has a 'required' key: forbidden by the schema. Use 'intent'.`)
    if (!RPC_ENUM.has(String(r.type)))
      errs.push(`rpc_types[${i}].type must be one of ${[...RPC_ENUM].sort().join(', ')}`)
  })
  arr(card.specs).forEach((s, i) => {
    if (isObj(s) && !('url' in s)) errs.push(`specs[${i}] requires a url`)
  })
  const serving = isObj(card.serving) ? card.serving : {}
  arr(serving.healthcheck).forEach((h, i) => {
    if (!isObj(h)) {
      errs.push(`serving.healthcheck[${i}] must be an object`)
      return
    }
    if (!RPC_ENUM.has(String(h.rpc_type)))
      errs.push(
        `serving.healthcheck[${i}].rpc_type must be one of ${[...RPC_ENUM].sort().join(', ')}`
      )
    if (!('request' in h)) errs.push(`serving.healthcheck[${i}] requires a request`)
  })
  if (typeof card.description === 'string' && card.description.length > 2048)
    errs.push('description exceeds 2048 chars')
  return errs
}

export function conventionWarnings(card: unknown): string[] {
  if (!isObj(card)) return []
  const warns: string[] = []
  const serving = isObj(card.serving) ? card.serving : {}
  if (!('results' in card))
    warns.push(
      "no 'results' field; set 'deterministic' or 'variable' so consumers know if suppliers are interchangeable"
    )
  if (!('updated' in card)) warns.push("no 'updated' date; every PNF card carries one (YYYY-MM-DD)")
  if ('sync' in serving)
    warns.push(
      'serving.sync is set; it means nothing for a non-blockchain service and should be omitted'
    )
  arr(card.specs).forEach((s, i) => {
    if (isObj(s) && !('api' in s))
      warns.push(
        `specs[${i}] has no 'api' key; PNF convention names the apis[] entry each spec documents`
      )
  })
  if (!arr(serving.healthcheck).length)
    warns.push(
      'no serving.healthcheck; suppliers cannot self-test before staking and gateways have nothing to probe'
    )
  if (!arr(card.rpc_types).length)
    warns.push(
      'no rpc_types; consumers and node runners both read this, and gateways will not route without it'
    )
  const desc = String(card.description ?? '')
  if (!/json/i.test(desc))
    warns.push(
      'description does not mention that every response is a JSON object; consumers and gateway operators rely on that statement'
    )
  return warns
}

export interface CardValidation {
  ok: boolean
  size_bytes: number
  fatal?: string
  size_warning?: string
  schema_errors: string[]
  warnings: string[]
}

/** Validates the exact JSON text of a card (so the size is the size the chain will see). */
export function validateCardText(text: string): CardValidation {
  const size = new TextEncoder().encode(text).length
  const base = { size_bytes: size, schema_errors: [] as string[], warnings: [] as string[] }
  if (size > CARD_MAX_HARD)
    return { ...base, ok: false, fatal: 'over the 256 KiB chain limit; the chain will reject this' }
  const sizeWarning =
    size > CARD_MAX_TARGET
      ? 'over the 4 KiB target; move large content (specs) out of the card'
      : undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      ...base,
      ok: false,
      size_warning: sizeWarning,
      fatal: `not a single JSON object: ${(e as Error).message}`
    }
  }
  const errs = [
    ...schemaErrors(parsed),
    ...structuralErrors(parsed).filter(
      (e) => e.includes("'required' key") || e.includes('must be a JSON object')
    )
  ]
  const uniq = [...new Set(errs)]
  return {
    ...base,
    ok: uniq.length === 0,
    size_warning: sizeWarning,
    schema_errors: uniq,
    warnings: conventionWarnings(parsed)
  }
}

/** Renders a validation as the text block the validate-card operation returns. */
export function formatCardValidation(v: CardValidation): string {
  const lines: string[] = []
  lines.push(`size: ${v.size_bytes} bytes`)
  if (v.size_warning) lines.push(`size: ${v.size_warning}`)
  if (v.fatal) lines.push(`error: ${v.fatal}`)
  for (const e of v.schema_errors) lines.push(`error: ${e}`)
  for (const w of v.warnings) lines.push(`warning: ${w}`)
  lines.push(v.ok ? 'card is valid' : 'card has errors')
  return lines.join('\n')
}

/** Reads the readiness probe path from a card's serving.healthcheck, else /healthz. */
export function readinessPath(card: unknown): string {
  if (!isObj(card)) return '/healthz'
  const serving = isObj(card.serving) ? card.serving : {}
  for (const h of arr(serving.healthcheck)) {
    if (!isObj(h)) continue
    const req = isObj(h.request) ? h.request : null
    const p = req && typeof req.path === 'string' ? req.path : null
    if (p && p.startsWith('/')) return p
  }
  return '/healthz'
}
