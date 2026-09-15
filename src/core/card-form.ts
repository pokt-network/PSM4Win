// The Create screen's form model: validation, the card builder, and the reverse
// mapping from an existing card. Ported from app.js (createForm, validateCreate,
// buildCard, loadCreateFromFolder). The probe notes strings are load-bearing:
// probes are classified by searching them for "identity" / "readiness".
import { todayIsoDate } from './format'

export interface CreateForm {
  id: string
  name: string
  cupr: string
  desc: string
  rpc: string
  hint: string
  endpoints: string
  apis: string
  access: string
  results: string
  specUrl: string
  specKind: string
  docs: string
  backend: string
  impl: string
  disk: string
  ram: string
  opDocs: string
  servingNotes: string
  idPath: string
  idJson: string
  idMatch: string
  rdPath: string
  rdJson: string
  rdMatch: string
  fnPath: string
  fnMethod: string
  fnJson: string
  fnMatch: string
  fnBody: string
}

export interface CreateAuto {
  apis: boolean
  hint: boolean
  impl: boolean
  idMatch: boolean
}

export const EMPTY_CREATE_FORM: CreateForm = {
  id: '',
  name: '',
  cupr: '100',
  desc: '',
  rpc: 'REST',
  hint: '',
  endpoints: '',
  apis: '',
  access: 'public',
  results: 'deterministic',
  specUrl: '',
  specKind: 'openapi',
  docs: '',
  backend: '',
  impl: '',
  disk: '1',
  ram: '1',
  opDocs: '',
  servingNotes: '',
  idPath: '/v1/version',
  idJson: '$.service',
  idMatch: '',
  rdPath: '/healthz',
  rdJson: '$.status',
  rdMatch: '^ok$',
  fnPath: '',
  fnMethod: 'POST',
  fnJson: '',
  fnMatch: '',
  fnBody: ''
}

export interface CheckItem {
  level: 'ok' | 'warn' | 'fail' | 'info'
  text: string
  sub?: string
}

export function hasFail(items: CheckItem[]): boolean {
  return items.some((i) => i.level === 'fail')
}

export function splitList(s: string): string[] {
  return String(s ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function isUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s)
}

interface Parsed {
  id: string
  name: string
  cupr: number
  desc: string
  rpc: string
  hint: string
  endpoints: string
  apis: string[]
  access: string
  results: string
  specUrl: string
  specKind: string
  docs: string
  backend: string
  impl: string[]
  disk: number
  ram: number
  opDocs: string
  servingNotes: string
  idPath: string
  idJson: string
  idMatch: string
  rdPath: string
  rdJson: string
  rdMatch: string
  fnPath: string
  fnMethod: string
  fnJson: string
  fnMatch: string
  fnBody: string
}

function parse(f: CreateForm): Parsed {
  const t = (s: string): string => String(s ?? '').trim()
  return {
    id: t(f.id),
    name: t(f.name),
    cupr: parseInt(f.cupr, 10),
    desc: t(f.desc),
    rpc: f.rpc,
    hint: t(f.hint),
    endpoints: t(f.endpoints),
    apis: splitList(f.apis),
    access: f.access,
    results: f.results,
    specUrl: t(f.specUrl),
    specKind: f.specKind,
    docs: t(f.docs),
    backend: t(f.backend),
    impl: splitList(f.impl),
    disk: parseInt(f.disk, 10),
    ram: parseInt(f.ram, 10),
    opDocs: t(f.opDocs),
    servingNotes: t(f.servingNotes),
    idPath: t(f.idPath),
    idJson: t(f.idJson),
    idMatch: t(f.idMatch),
    rdPath: t(f.rdPath),
    rdJson: t(f.rdJson),
    rdMatch: t(f.rdMatch),
    fnPath: t(f.fnPath),
    fnMethod: f.fnMethod,
    fnJson: t(f.fnJson),
    fnMatch: t(f.fnMatch),
    fnBody: t(f.fnBody)
  }
}

export function validateCreate(form: CreateForm, items: CheckItem[]): boolean {
  const f = parse(form)
  if (!/^[A-Za-z0-9_-]{1,42}$/.test(f.id))
    items.push({ level: 'fail', text: 'Service ID is invalid.' })
  if (!/^[A-Za-z0-9 _-]{1,169}$/.test(f.name))
    items.push({ level: 'fail', text: 'Display name is invalid or empty.' })
  if (!(f.cupr >= 1 && f.cupr <= 1048576))
    items.push({ level: 'fail', text: 'Compute units per relay must be 1 to 1,048,576.' })
  if (!f.desc)
    items.push({
      level: 'fail',
      text: 'Description is empty. It is the only thing a consumer reads before calling you.'
    })
  if (f.desc.length > 2048)
    items.push({ level: 'fail', text: 'Description is longer than 2,048 characters.' })
  if (f.hint.length > 256)
    items.push({ level: 'fail', text: 'Backend hint is longer than 256 characters.' })
  if (f.endpoints.length > 512)
    items.push({ level: 'fail', text: 'Endpoints line is longer than 512 characters.' })
  if (!f.endpoints)
    items.push({
      level: 'warn',
      text: 'No endpoints line. Consumers will not know which paths are guaranteed.'
    })
  if (!f.apis.length)
    items.push({ level: 'fail', text: 'At least one API contract name is needed.' })
  for (const a of f.apis)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a) || a.length > 128)
      items.push({ level: 'fail', text: `API contract name '${a}' is not lowercase kebab-case.` })
  if (f.specUrl && !isUrl(f.specUrl))
    items.push({ level: 'fail', text: 'API spec URL must start with http:// or https://.' })
  if (!f.specUrl)
    items.push({
      level: 'warn',
      text: 'No API spec URL. Add one when the OpenAPI document is published; the card can be updated.'
    })
  if (f.docs && !isUrl(f.docs))
    items.push({ level: 'fail', text: 'Docs URL must start with http:// or https://.' })
  if (f.opDocs && !isUrl(f.opDocs))
    items.push({ level: 'fail', text: 'Operator docs URL must start with http:// or https://.' })
  if (!f.backend)
    items.push({
      level: 'warn',
      text: 'No backend description. Suppliers will not know what to deploy.'
    })
  if (f.backend.length > 1024)
    items.push({ level: 'fail', text: 'Backend description is longer than 1,024 characters.' })
  if (f.servingNotes.length > 2048)
    items.push({ level: 'fail', text: 'Operator notes are longer than 2,048 characters.' })
  if (!(f.disk >= 0) || !(f.ram >= 0))
    items.push({ level: 'fail', text: 'Disk and RAM must be whole numbers of gigabytes.' })
  const probes: [string, string, string, string][] = [
    ['Identity', f.idPath, f.idJson, f.idMatch],
    ['Readiness', f.rdPath, f.rdJson, f.rdMatch]
  ]
  for (const [label, path, json, match] of probes) {
    if (!path) items.push({ level: 'warn', text: `${label} probe has no path, so it is omitted.` })
    else {
      if (path.charAt(0) !== '/')
        items.push({ level: 'fail', text: `${label} probe path must start with /.` })
      if (!json || json.charAt(0) !== '$')
        items.push({ level: 'fail', text: `${label} probe JSON path must start with $.` })
      if (!match)
        items.push({ level: 'fail', text: `${label} probe needs a regular expression to match.` })
    }
  }
  if (f.fnPath) {
    if (f.fnPath.charAt(0) !== '/')
      items.push({ level: 'fail', text: 'Functional probe path must start with /.' })
    if (!f.fnJson || f.fnJson.charAt(0) !== '$')
      items.push({ level: 'fail', text: 'Functional probe JSON path must start with $.' })
    if (!f.fnMatch)
      items.push({ level: 'fail', text: 'Functional probe needs a regular expression to match.' })
    if (f.fnMethod === 'POST' && f.fnBody) {
      try {
        JSON.parse(f.fnBody)
      } catch (e) {
        items.push({
          level: 'fail',
          text: 'Functional probe body is not valid JSON.',
          sub: (e as Error).message
        })
      }
    }
  } else
    items.push({
      level: 'info',
      text: 'No functional probe. Gateways will only check identity and readiness. Add one once the API is final.'
    })
  return !hasFail(items)
}

interface Probe {
  rpc_type: string
  request: { path: string; method: string; body?: unknown }
  expect: { json_path: string; matches: string }
  notes: string
}

function probe(
  rpc: string,
  path: string,
  method: string,
  body: unknown,
  jsonPath: string,
  matches: string,
  notes: string
): Probe {
  const req: Probe['request'] = { path, method }
  if (body) req.body = body
  return { rpc_type: rpc, request: req, expect: { json_path: jsonPath, matches }, notes }
}

export const GATEWAY_SENTENCE_RE = /\s*Gateway operators: configure as type passthrough.*$/

/** Same key order as app.js buildCard so the bytes match. */
export function buildCard(form: CreateForm): Record<string, unknown> {
  const f = parse(form)
  const card: Record<string, unknown> = { schema: 'pocket-service-card/v1', description: f.desc }
  const rt: Record<string, unknown> = { type: f.rpc, intent: 'expected' }
  if (f.hint) rt.backend_hint = f.hint
  if (f.endpoints) rt.notes = f.endpoints
  card.rpc_types = [rt]
  card.apis = f.apis
  if (f.specUrl) card.specs = [{ kind: f.specKind, api: f.apis[0], url: f.specUrl }]
  card.access = f.access
  card.results = f.results
  const sv: Record<string, unknown> = {}
  if (f.backend) sv.backend = f.backend
  if (f.impl.length) sv.implementations = f.impl
  if (f.opDocs) sv.docs = f.opDocs
  sv.min_disk_gb = f.disk
  sv.min_ram_gb = f.ram
  const hc: Probe[] = []
  if (f.idPath)
    hc.push(
      probe(
        f.rpc,
        f.idPath,
        'GET',
        null,
        f.idJson,
        f.idMatch,
        'Identity probe: pins the backend to this service so a wrong backend cannot be staked under this id.'
      )
    )
  if (f.rdPath)
    hc.push(probe(f.rpc, f.rdPath, 'GET', null, f.rdJson, f.rdMatch, 'Readiness probe.'))
  if (f.fnPath)
    hc.push(
      probe(
        f.rpc,
        f.fnPath,
        f.fnMethod,
        f.fnMethod === 'POST' && f.fnBody ? JSON.parse(f.fnBody) : null,
        f.fnJson,
        f.fnMatch,
        'Functional probe with a deterministic expected value.'
      )
    )
  if (hc.length) sv.healthcheck = hc
  const gw = `Gateway operators: configure as type passthrough with rpc_types ["${f.rpc.toLowerCase()}"].`
  sv.notes = f.servingNotes ? f.servingNotes + ' ' + gw : gw
  card.serving = sv
  if (f.docs) card.docs = f.docs
  card.updated = todayIsoDate()
  return card
}

/** The derived fields onCreateIdChange fills while they are still automatic. */
export function deriveFromId(form: CreateForm, auto: CreateAuto): CreateForm {
  const id = form.id.trim()
  if (!/^[A-Za-z0-9_-]{1,42}$/.test(id)) return form
  const out = { ...form }
  if (auto.apis) out.apis = id + '-api'
  if (auto.hint)
    out.hint =
      id +
      (form.rpc === 'REST'
        ? ' HTTP server on :8080; mount at /'
        : ' ' + form.rpc + ' server on :8080')
  if (auto.impl) out.impl = id + ' >= 1.0'
  if (auto.idMatch) out.idMatch = '^' + id + '$'
  return out
}

export type IdHint =
  | { kind: 'default' }
  | { kind: 'warn'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'err'; text: string }

export function createIdHint(id: string): IdHint {
  const t = id.trim()
  if (!t) return { kind: 'default' }
  if (!/^[A-Za-z0-9_-]{1,42}$/.test(t))
    return { kind: 'err', text: 'Only letters, digits, hyphen, underscore; 1 to 42 characters.' }
  if (t !== t.toLowerCase())
    return { kind: 'warn', text: 'Allowed, but lowercase is the convention.' }
  return { kind: 'ok', text: 'Folder will be services\\' + t }
}

/** loadCreateFromFolder(): the reverse mapping from card.json and service.json. */
export function formFromCard(folder: string, card: unknown, manifest: unknown): CreateForm {
  const c = (card && typeof card === 'object' ? card : {}) as Record<string, unknown>
  const m = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<string, unknown>
  const rtArr = Array.isArray(c.rpc_types) ? (c.rpc_types as Record<string, unknown>[]) : []
  const rt = rtArr[0] ?? {}
  const specArr = Array.isArray(c.specs) ? (c.specs as Record<string, unknown>[]) : []
  const sp = specArr[0] ?? {}
  const sv = (c.serving && typeof c.serving === 'object' ? c.serving : {}) as Record<
    string,
    unknown
  >
  const hc = Array.isArray(sv.healthcheck) ? (sv.healthcheck as HealthcheckAny[]) : []
  let idp: HealthcheckAny | null = null
  let rdp: HealthcheckAny | null = null
  let fnp: HealthcheckAny | null = null
  for (const h of hc) {
    const n = String(h.notes ?? '').toLowerCase()
    if (!idp && n.includes('identity')) idp = h
    else if (!rdp && (n.includes('readiness') || h.expect?.matches === '^ok$')) rdp = h
    else if (!fnp) fnp = h
  }
  return {
    ...EMPTY_CREATE_FORM,
    id: String(m.service_id ?? folder),
    name: String(m.name ?? ''),
    cupr: String(m.compute_units_per_relay ?? 100),
    desc: String(c.description ?? ''),
    rpc: typeof rt.type === 'string' ? rt.type : 'REST',
    hint: String(rt.backend_hint ?? ''),
    endpoints: String(rt.notes ?? ''),
    apis: (Array.isArray(c.apis) ? c.apis : []).join(', '),
    access: typeof c.access === 'string' ? c.access : 'public',
    results: typeof c.results === 'string' ? c.results : 'deterministic',
    specUrl: String(sp.url ?? ''),
    specKind: typeof sp.kind === 'string' ? sp.kind : 'openapi',
    docs: String(c.docs ?? ''),
    backend: String(sv.backend ?? ''),
    impl: (Array.isArray(sv.implementations) ? sv.implementations : []).join(', '),
    disk: String(sv.min_disk_gb !== undefined ? sv.min_disk_gb : 1),
    ram: String(sv.min_ram_gb !== undefined ? sv.min_ram_gb : 1),
    opDocs: String(sv.docs ?? ''),
    servingNotes: String(sv.notes ?? '').replace(GATEWAY_SENTENCE_RE, ''),
    idPath: idp?.request?.path ?? '',
    idJson: idp?.expect?.json_path ?? '$.service',
    idMatch: idp?.expect?.matches ?? '',
    rdPath: rdp?.request?.path ?? '',
    rdJson: rdp?.expect?.json_path ?? '$.status',
    rdMatch: rdp?.expect?.matches ?? '^ok$',
    fnPath: fnp?.request?.path ?? '',
    fnMethod: fnp?.request?.method ?? 'POST',
    fnJson: fnp?.expect?.json_path ?? '',
    fnMatch: fnp?.expect?.matches ?? '',
    fnBody: fnp?.request?.body ? JSON.stringify(fnp.request.body) : ''
  }
}

interface HealthcheckAny {
  request?: { path?: string; method?: string; body?: unknown }
  expect?: { json_path?: string; matches?: string }
  notes?: string
}
