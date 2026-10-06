// Per-service settings: operator configuration a service declares in deploy/settings.json
// (docs/SCREENS.md, Service settings). Each setting becomes one environment variable of the
// service's backend container, written by the app over SSH into <deploy root>/<id>/settings.env,
// outside the shipped bundle, which the service's compose reads with env_file. The service
// validates again at startup and stays the authority; the app's checks are there so a typo is
// caught in the form rather than in a container log. Nothing here touches disk.
import { fail } from './errors'
import { NETWORKS, isNetwork, type Network } from './networks'
import type { ServerSettingState, ServiceSettingsReadResult } from './contract'

/** The declaration file, relative to the service folder. */
export const SETTINGS_FILE = 'deploy/settings.json'
/** The values file on the server, in <deploy root>/<id>/, next to backend/ and deploy/. */
export const SETTINGS_ENV_FILE = 'settings.env'
/** What the service's deploy/docker-compose.yaml names under env_file. */
export const SETTINGS_ENV_REF = '../settings.env'

export const SETTING_TYPES = ['text', 'number', 'choice', 'boolean', 'url'] as const
export type SettingType = (typeof SETTING_TYPES)[number]
export const SETTING_SCOPES = ['service', 'network'] as const
export type SettingScope = (typeof SETTING_SCOPES)[number]

/** The token a network-scoped name carries; it becomes MAIN or BETA. */
export const NETWORK_TOKEN = '{NETWORK}'
/** The token a network-scoped check command carries; it becomes main or beta. */
export const NETWORK_ARG_TOKEN = '{network}'

export const MAX_SETTINGS = 32
export const MAX_VALUE_LENGTH = 1024
export const MAX_PATTERN_LENGTH = 200
export const MAX_CHECK_ARGS = 16
export const MAX_CHECK_ARG_LENGTH = 200
export const MAX_CHECK_TIMEOUT_S = 60
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
export const CHOICE_VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
/** Names a container's runtime or the shell inside it relies on. */
const RESERVED_NAMES = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'USER',
  'SHELL',
  'PWD',
  'TERM',
  'LANG',
  'TZ',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME'
])
const RESERVED_PREFIXES = ['LD_', 'DOCKER_', 'COMPOSE_']

export interface SettingChoice {
  value: string
  label: string
}

export interface SettingDecl {
  /** The variable's name, with NETWORK_TOKEN in it when scope is network. */
  env: string
  scope: SettingScope
  label: string
  help?: string
  type: SettingType
  /** Stored only on the server, never read back; shown as set or not set. */
  secret: boolean
  required: boolean
  /** Already in the form it is written in (booleans as true/false). */
  default?: string
  pattern?: string
  min_length?: number
  max_length: number
  min?: number
  max?: number
  integer: boolean
  choices?: SettingChoice[]
  /** url only: hosts the URL may point at, exact or *.domain. */
  hosts?: string[]
}

export interface SettingsCheck {
  label: string
  /** An argument list run in the backend container, never through a shell. */
  command: string[]
  scope: SettingScope
  timeout_s: number
}

export interface SettingsDecl {
  settings: SettingDecl[]
  check?: SettingsCheck
}

export type ParsedSettings = { ok: true; decl: SettingsDecl } | { ok: false; error: string }

const SETTING_KEYS: Record<SettingType, readonly string[]> = {
  text: ['pattern', 'min_length', 'max_length'],
  number: ['min', 'max', 'integer'],
  choice: ['choices'],
  boolean: [],
  url: ['hosts']
}
const COMMON_KEYS = ['env', 'scope', 'label', 'help', 'type', 'secret', 'required', 'default']
const CHECK_KEYS = ['label', 'command', 'scope', 'timeout_s']

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_VALUE_LENGTH
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The variable a setting becomes on a network (or for the whole service). */
export function envNameFor(s: Pick<SettingDecl, 'env' | 'scope'>, net?: Network): string {
  if (s.scope === 'service') return s.env
  if (!net) fail(`${s.env} has one value per network; say which network.`)
  return s.env.split(NETWORK_TOKEN).join(net.toUpperCase())
}

/** Why a variable name cannot be used, or '' when it can. */
export function envNameProblem(name: string): string {
  if (!ENV_NAME_RE.test(name))
    return `"${name}" is not a usable variable name: capital letters, digits, and underscores, starting with a letter, at most 64 characters.`
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p)))
    return `"${name}" is a name the container itself relies on; choose another.`
  return ''
}

/** Whether a URL's host is one of the allowed hosts (exact, or under a *.domain entry). */
export function hostAllowed(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase()
  return hosts.some((e) =>
    e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e
  )
}

/** Characters a value may not hold: the file quotes each value in single quotes, one per line. */
export function envValueProblem(v: string): string {
  if (v.length > MAX_VALUE_LENGTH) return `It may be at most ${MAX_VALUE_LENGTH} characters.`
  if (/[\r\n\0]/.test(v)) return 'It must fit on one line.'
  if (v.includes("'")) return "It may not contain a single quote (')."
  return ''
}

/**
 * Why a value cannot be used for a setting, or '' when it can. The value is the form's text
 * as typed; normaliseValue gives what is written. An empty value means "not set" and is
 * checked by the caller against required.
 */
export function valueProblem(s: SettingDecl, raw: string): string {
  const v = raw.trim()
  if (v === '') return ''
  const base = envValueProblem(v)
  if (base) return base
  switch (s.type) {
    case 'text': {
      if (s.min_length !== undefined && v.length < s.min_length)
        return `It must be at least ${s.min_length} characters.`
      if (v.length > s.max_length) return `It may be at most ${s.max_length} characters.`
      if (s.pattern && !new RegExp(s.pattern).test(v)) return 'It is not in the expected form.'
      return ''
    }
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return 'It must be a number.'
      const n = Number(v)
      if (s.integer && !Number.isInteger(n)) return 'It must be a whole number.'
      if (s.min !== undefined && n < s.min) return `It must be at least ${s.min}.`
      if (s.max !== undefined && n > s.max) return `It must be at most ${s.max}.`
      return ''
    }
    case 'choice':
      return s.choices?.some((c) => c.value === v)
        ? ''
        : `It must be one of ${(s.choices ?? []).map((c) => c.value).join(', ')}.`
    case 'boolean':
      return v === 'true' || v === 'false' ? '' : 'It must be true or false.'
    case 'url': {
      let u: URL
      try {
        u = new URL(v)
      } catch {
        return 'It must be a web address starting with https://.'
      }
      if (u.protocol !== 'https:') return 'It must start with https://.'
      if (u.username || u.password) return 'It may not carry a user name or password.'
      if (s.hosts?.length && !hostAllowed(u.hostname, s.hosts))
        return `It must point at ${s.hosts.join(' or ')}.`
      return ''
    }
  }
}

/** The value as written into the file: trimmed, numbers in their plain form. */
export function normaliseValue(s: SettingDecl, raw: string): string {
  const v = raw.trim()
  if (s.type === 'number' && v !== '' && /^-?\d+(\.\d+)?$/.test(v)) return String(Number(v))
  return v
}

function parseSetting(j: unknown, i: number): SettingDecl | string {
  const at = `deploy/settings.json, setting ${i + 1}`
  if (!isObj(j)) return `${at} must be an object.`
  const env = j.env
  if (!nonEmpty(env)) return `${at} needs an "env": the variable it becomes.`
  const where = `deploy/settings.json, ${env}`
  const type = j.type
  if (!SETTING_TYPES.includes(type as SettingType))
    return `${where}: "type" must be one of ${SETTING_TYPES.join(', ')}.`
  const t = type as SettingType
  for (const k of Object.keys(j))
    if (!COMMON_KEYS.includes(k) && !SETTING_KEYS[t].includes(k))
      return `${where}: "${k}" is not a setting field${Object.values(SETTING_KEYS).some((ks) => ks.includes(k)) ? ` for type ${t}` : ''}.`
  const scope = j.scope ?? 'service'
  if (!SETTING_SCOPES.includes(scope as SettingScope))
    return `${where}: "scope" must be "service" or "network".`
  const sc = scope as SettingScope
  const tokens = env.split(NETWORK_TOKEN).length - 1
  if (sc === 'network' && tokens !== 1)
    return `${where}: a setting with one value per network must have ${NETWORK_TOKEN} once in its name, such as MYSVC_${NETWORK_TOKEN}_KEY.`
  if (sc === 'service' && tokens !== 0)
    return `${where}: ${NETWORK_TOKEN} is only for settings with "scope": "network".`
  for (const net of sc === 'network' ? NETWORKS : [undefined]) {
    const p = envNameProblem(envNameFor({ env, scope: sc }, net))
    if (p) return `deploy/settings.json: ${p}`
  }
  if (!nonEmpty(j.label)) return `${where} needs a "label".`
  if (j.help !== undefined && typeof j.help !== 'string') return `${where}: "help" must be text.`
  for (const k of ['secret', 'required'] as const)
    if (j[k] !== undefined && typeof j[k] !== 'boolean')
      return `${where}: "${k}" must be true or false.`
  const secret = j.secret === true
  if (secret && t !== 'text' && t !== 'url')
    return `${where}: only text and url settings can be secret.`
  const s: SettingDecl = {
    env,
    scope: sc,
    label: j.label.trim(),
    type: t,
    secret,
    required: j.required === true,
    max_length: MAX_VALUE_LENGTH,
    integer: true
  }
  if (typeof j.help === 'string' && j.help.trim()) s.help = j.help.trim()
  if (t === 'text') {
    if (j.pattern !== undefined) {
      if (typeof j.pattern !== 'string' || j.pattern.length > MAX_PATTERN_LENGTH)
        return `${where}: "pattern" must be text of at most ${MAX_PATTERN_LENGTH} characters.`
      if (!j.pattern.startsWith('^') || !j.pattern.endsWith('$'))
        return `${where}: "pattern" must start with ^ and end with $, so it checks the whole value.`
      try {
        new RegExp(j.pattern)
      } catch {
        return `${where}: "pattern" is not a valid regular expression.`
      }
      s.pattern = j.pattern
    }
    for (const k of ['min_length', 'max_length'] as const)
      if (j[k] !== undefined && !isCount(j[k]))
        return `${where}: "${k}" must be a whole number from 0 to ${MAX_VALUE_LENGTH}.`
    if (j.min_length !== undefined) s.min_length = j.min_length as number
    if (j.max_length !== undefined) s.max_length = j.max_length as number
    if ((s.min_length ?? 0) > s.max_length)
      return `${where}: "min_length" is more than "max_length".`
  }
  if (t === 'number') {
    for (const k of ['min', 'max'] as const)
      if (j[k] !== undefined && !isNum(j[k])) return `${where}: "${k}" must be a number.`
    if (j.integer !== undefined && typeof j.integer !== 'boolean')
      return `${where}: "integer" must be true or false.`
    if (j.min !== undefined) s.min = j.min as number
    if (j.max !== undefined) s.max = j.max as number
    s.integer = j.integer !== false
    if (s.min !== undefined && s.max !== undefined && s.min > s.max)
      return `${where}: "min" is more than "max".`
  }
  if (t === 'choice') {
    if (!Array.isArray(j.choices) || j.choices.length === 0)
      return `${where}: a choice setting needs a "choices" list.`
    const out: SettingChoice[] = []
    for (const c of j.choices) {
      const value = typeof c === 'string' ? c : isObj(c) ? c.value : undefined
      const label = typeof c === 'string' ? c : isObj(c) ? c.label : undefined
      if (isObj(c) && Object.keys(c).some((k) => k !== 'value' && k !== 'label'))
        return `${where}: each choice is text, or an object with "value" and "label".`
      if (typeof value !== 'string' || !CHOICE_VALUE_RE.test(value))
        return `${where}: each choice's value must be 1 to 64 letters, digits, or . _ : -.`
      if (!nonEmpty(label)) return `${where}: choice "${value}" needs a label.`
      if (out.some((o) => o.value === value)) return `${where}: choice "${value}" is listed twice.`
      out.push({ value, label: label.trim() })
    }
    s.choices = out
  }
  if (t === 'url' && j.hosts !== undefined) {
    if (
      !Array.isArray(j.hosts) ||
      j.hosts.length === 0 ||
      !j.hosts.every((h) => typeof h === 'string' && HOST_RE.test(h))
    )
      return `${where}: "hosts" must be a list of lowercase host names, such as "example.com" or "*.example.com".`
    s.hosts = j.hosts as string[]
  }
  if (j.default !== undefined) {
    if (secret) return `${where}: a secret cannot have a default.`
    const d = j.default
    const raw =
      typeof d === 'string' && t !== 'number' && t !== 'boolean'
        ? d
        : typeof d === 'boolean' && t === 'boolean'
          ? String(d)
          : isNum(d) && t === 'number'
            ? String(d)
            : null
    if (raw === null || raw.trim() === '')
      return `${where}: "default" must be a ${t === 'number' ? 'number' : t === 'boolean' ? 'true or false' : 'non-empty text'}.`
    const p = valueProblem(s, raw)
    if (p) return `${where}: the default does not fit the setting's own rules. ${p}`
    s.default = normaliseValue(s, raw)
  }
  return s
}

function parseCheck(j: unknown): SettingsCheck | string {
  const at = 'deploy/settings.json, check'
  if (!isObj(j)) return `${at} must be an object.`
  for (const k of Object.keys(j))
    if (!CHECK_KEYS.includes(k)) return `${at}: "${k}" is not a check field.`
  if (!nonEmpty(j.label)) return `${at} needs a "label", the button's text.`
  const cmd = j.command
  if (
    !Array.isArray(cmd) ||
    cmd.length === 0 ||
    cmd.length > MAX_CHECK_ARGS ||
    !cmd.every(
      (a) =>
        typeof a === 'string' && a !== '' && a.length <= MAX_CHECK_ARG_LENGTH && !/[\0\r\n]/.test(a)
    )
  )
    return `${at}: "command" must be a list of 1 to ${MAX_CHECK_ARGS} non-empty words, such as ["node", "check.js"]; it runs without a shell.`
  const scope = j.scope ?? 'service'
  if (!SETTING_SCOPES.includes(scope as SettingScope))
    return `${at}: "scope" must be "service" or "network".`
  const uses = (cmd as string[]).some((a) => a.includes(NETWORK_ARG_TOKEN))
  if (scope === 'network' && !uses)
    return `${at}: a check run per network must have ${NETWORK_ARG_TOKEN} in its command.`
  if (scope === 'service' && uses)
    return `${at}: ${NETWORK_ARG_TOKEN} is only for a check with "scope": "network".`
  const to = j.timeout_s ?? 30
  if (typeof to !== 'number' || !Number.isInteger(to) || to < 1 || to > MAX_CHECK_TIMEOUT_S)
    return `${at}: "timeout_s" must be a whole number of seconds from 1 to ${MAX_CHECK_TIMEOUT_S}.`
  return {
    label: j.label.trim(),
    command: cmd as string[],
    scope: scope as SettingScope,
    timeout_s: to
  }
}

/** Checks a parsed declaration; the same rules whether it came from the folder or the server. */
export function validateSettingsDecl(j: unknown): ParsedSettings {
  if (!isObj(j) || !Array.isArray(j.settings))
    return { ok: false, error: 'deploy/settings.json must be an object with a "settings" list.' }
  for (const k of Object.keys(j))
    if (k !== 'settings' && k !== 'check')
      return { ok: false, error: `deploy/settings.json: "${k}" is not a known field.` }
  if (j.settings.length > MAX_SETTINGS)
    return {
      ok: false,
      error: `deploy/settings.json may declare at most ${MAX_SETTINGS} settings.`
    }
  const settings: SettingDecl[] = []
  const names = new Set<string>()
  for (const [i, raw] of j.settings.entries()) {
    const s = parseSetting(raw, i)
    if (typeof s === 'string') return { ok: false, error: s }
    for (const n of variablesOf(s)) {
      if (names.has(n.name))
        return { ok: false, error: `deploy/settings.json: ${n.name} is declared twice.` }
      names.add(n.name)
    }
    settings.push(s)
  }
  const decl: SettingsDecl = { settings }
  if (j.check !== undefined) {
    const c = parseCheck(j.check)
    if (typeof c === 'string') return { ok: false, error: c }
    decl.check = c
  }
  if (!settings.length && !decl.check)
    return { ok: false, error: 'deploy/settings.json declares no settings.' }
  return { ok: true, decl }
}

/** Parses deploy/settings.json. A missing file is the caller's case: no settings. */
export function parseSettingsFile(text: string): ParsedSettings {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `deploy/settings.json is not valid JSON: ${(e as Error).message}` }
  }
  return validateSettingsDecl(j)
}

export interface SettingVariable {
  name: string
  setting: SettingDecl
  /** Set for a network-scoped setting. */
  network?: Network
}

/** The variables one setting becomes, one per network for a network-scoped setting. */
export function variablesOf(
  s: SettingDecl,
  nets: readonly Network[] = NETWORKS
): SettingVariable[] {
  return s.scope === 'service'
    ? [{ name: s.env, setting: s }]
    : nets.map((network) => ({ name: envNameFor(s, network), setting: s, network }))
}

/** Every variable the declaration names, for the given networks. */
export function variablesFor(
  decl: SettingsDecl,
  nets: readonly Network[] = NETWORKS
): SettingVariable[] {
  return decl.settings.flatMap((s) => variablesOf(s, nets))
}

/** A variable as the server reports it: secrets come back as set or not set only. */
export interface SettingState {
  set: boolean
  /** Absent for a secret. */
  value?: string
}

/** Required variables with no value on the server and no default to fall back on. */
export function missingRequired(
  decl: SettingsDecl,
  nets: readonly Network[],
  state: Record<string, SettingState>
): SettingVariable[] {
  return variablesFor(decl, nets).filter(
    (v) => v.setting.required && v.setting.default === undefined && !state[v.name]?.set
  )
}

/** One change from the form: a new value, or null to clear the variable. */
export interface SettingEdit {
  name: string
  value: string | null
}

/** What service-settings-write sends the server: values to set and names to clear. */
export interface SettingsPatch {
  set: Record<string, string>
  clear: string[]
}

/**
 * Checks a list of edits against the declaration as the signer receives them, and gives the
 * patch to send. Throws on the first problem; the message never repeats a value.
 */
export function settingsPatch(
  decl: SettingsDecl,
  edits: unknown,
  nets: readonly Network[] = NETWORKS
): SettingsPatch {
  if (!Array.isArray(edits) || edits.length === 0) fail('No settings were changed.')
  const vars = new Map(variablesFor(decl, nets).map((v) => [v.name, v]))
  const patch: SettingsPatch = { set: {}, clear: [] }
  const seen = new Set<string>()
  for (const e of edits as { name?: unknown; value?: unknown }[]) {
    const name = typeof e?.name === 'string' ? e.name : ''
    const v = vars.get(name)
    if (!v) fail(`${name || 'A setting'} is not declared in the service's deploy/settings.json.`)
    if (seen.has(name)) fail(`${name} is changed twice.`)
    seen.add(name)
    const s = v!.setting
    if (e.value === null) {
      patch.clear.push(name)
      continue
    }
    if (typeof e.value !== 'string') fail(`${s.label}: the value must be text.`)
    const value = e.value as string
    if (value.trim() === '') {
      patch.clear.push(name)
      continue
    }
    const p = valueProblem(s, value)
    if (p) fail(`${s.label}${v!.network ? ` (${v!.network})` : ''}: ${p}`)
    patch.set[name] = normaliseValue(s, value)
  }
  return patch
}

/** The arguments a check runs with on a network: the command with {network} filled in. */
export function checkArgs(check: SettingsCheck, net?: Network): string[] {
  if (check.scope === 'network' && !net) fail('Say which network the check is for.')
  return check.command.map((a) => (net ? a.split(NETWORK_ARG_TOKEN).join(net) : a))
}

/**
 * What is wrong with a service's own deploy/docker-compose.yaml for these settings: it must
 * read the values file with env_file (error), and a variable it also lists under
 * environment: wins over the file, so the setting would be ignored (warning).
 */
export function composeSettingsProblems(
  compose: string,
  decl: SettingsDecl
): { error: string; warnings: string[] } {
  const text = compose.replace(/\r\n/g, '\n')
  const refers = /env_file\s*:[\s\S]{0,300}?\.\.\/settings\.env(?![\w.])/.test(text)
  const error = refers
    ? ''
    : `The service's deploy/docker-compose.yaml does not read its settings. Add "env_file: ${SETTINGS_ENV_REF}" to the backend service.`
  const warnings: string[] = []
  for (const v of variablesFor(decl)) {
    const re = new RegExp(`^\\s*(-\\s*)?["']?${v.name}["']?\\s*[:=]`, 'm')
    if (re.test(text))
      warnings.push(
        `${v.name} is also listed under environment: in deploy/docker-compose.yaml, which overrides the setting; remove it there.`
      )
  }
  return { error, warnings }
}

// ---- what the server's helper answers (supplier.sh settings-read, settings-check) ----

/** What a server whose helper predates service settings is told. */
export const SETTINGS_HELPER_TOO_OLD =
  "This server's helper predates service settings. Press Update stack for this server under Suppliers, then try again."

/** Whether the helper on the server does not know the step it was asked for. */
export function helperTooOld(out: string): boolean {
  return /^error: unknown step (settings-|backend-restart)/m.test(out)
}

/** settings-read's one "settings: <json>" line, checked; a string says what was wrong. */
export function parseSettingsRead(out: string): Omit<ServiceSettingsReadResult, 'ok'> | string {
  const line = out
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('settings: '))
  if (!line) return 'The server did not report the settings.'
  let j: unknown
  try {
    j = JSON.parse(line.slice('settings: '.length))
  } catch {
    return 'The server reported the settings in a form the app cannot read.'
  }
  if (!isObj(j) || !isObj(j.values)) return 'The server reported the settings without values.'
  let declared: SettingsDecl | null = null
  let declared_error = ''
  if (j.declared !== null && j.declared !== undefined) {
    const p = validateSettingsDecl(j.declared)
    if (p.ok) declared = p.decl
    else declared_error = `On the server: ${p.error}`
  }
  const values: Record<string, ServerSettingState> = {}
  for (const [name, v] of Object.entries(j.values)) {
    if (!ENV_NAME_RE.test(name) || !isObj(v)) continue
    const st: ServerSettingState = { set: v.set === true }
    if (typeof v.value === 'string') st.value = v.value
    if (typeof v.applied === 'boolean') st.applied = v.applied
    if (v.declared === false) st.declared = false
    values[name] = st
  }
  // A secret's value is never read back; drop one if a helper ever sent it.
  if (declared)
    for (const v of variablesFor(declared))
      if (v.setting.secret && values[v.name]) delete values[v.name].value
  for (const st of Object.values(values)) if (st.declared === false) delete st.value
  const served = (Array.isArray(j.served) ? j.served : [])
    .filter(
      (s): s is { network: Network; port: number } =>
        isObj(s) && isNetwork(s.network) && typeof s.port === 'number' && Number.isInteger(s.port)
    )
    .map((s) => ({ network: s.network, port: s.port }))
  return { declared, declared_error, values, container: j.container === true, served }
}

/** settings-check's answer: "check: passed" or why not, then "output: ..." lines. */
export function parseSettingsCheck(out: string): {
  passed: boolean
  summary: string
  output: string[]
} {
  const lines = out.split(/\r?\n/)
  const summary = lines.find((l) => l.startsWith('check: '))?.slice('check: '.length) ?? ''
  return {
    passed: summary === 'passed',
    summary,
    output: lines.filter((l) => l.startsWith('output: ')).map((l) => l.slice('output: '.length))
  }
}

/** The relay ports a restart waits on: whole numbers 1024 to 65535, each once, at most 4. */
export function restartPorts(ports: unknown): number[] {
  const list = Array.isArray(ports) && ports.length ? ports : [8080]
  const out = [...new Set(list)]
  if (out.length > 4) fail('A backend is waited on at most 4 ports.')
  for (const p of out)
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1024 || p > 65535)
      fail('Backend ports must be whole numbers from 1024 to 65535.')
  return out as number[]
}
