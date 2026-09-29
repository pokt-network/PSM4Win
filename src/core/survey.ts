// The server survey (server-survey): assembling the script the app runs over SSH, and
// reading what it prints. Pure; the signer ships and runs it (src/main/signer/server.ts).
// The script (resources/server/survey.sh) is read-only and prints no secret.

/** Where survey.sh takes the address code (resources/server/survey_address.py). */
export const SURVEY_ADDRESS_MARK = '@@ADDRESS_PY@@'

/** survey.sh with the address code in place, LF-terminated. */
export function buildSurveyScript(surveySh: string, addressPy: string): string {
  const sh = surveySh.replace(/\r\n/g, '\n')
  const py = addressPy.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (!sh.includes(SURVEY_ADDRESS_MARK))
    throw new Error('survey.sh has no place for the address code')
  // The code sits inside a heredoc closed by a line "PY"; a line like that in it would end it.
  if (/^PY$/m.test(py)) throw new Error('the address code must not contain a line "PY"')
  return sh.replace(SURVEY_ADDRESS_MARK, py)
}

export interface SurveyReport {
  host: string
  os: string
  sudo: boolean
  python: boolean
  memoryMb: number
  /** 'none', 'unreachable', or the Docker version. */
  docker: string
  containers: {
    name: string
    role: string
    image: string
    project: string
    dir: string
    ports: string
  }[]
  configs: { from: string; role: string; path: string }[]
  processes: { pid: string; user: string; args: string }[]
  units: { name: string; active: string; exec: string }[]
  listens: { port: number; process: string }[]
  proxyConfs: { proxy: string; where: string; path: string }[]
  keySources: { kind: string; path: string; config: string }[]
  services: { id: string; backend: string; config: string }[]
  settings: { key: string; value: string; config: string }[]
  keyrings: { dir: string; backend: string; address: string; match: boolean | null }[]
  keysFiles: { path: string; address: string; match: boolean | null }[]
  /** The script reached its last line (a missing python3 ends it early, marked partial). */
  complete: boolean
  partial: boolean
}

/** key=value pairs; `tail` names a key whose value runs to the end of the line. */
function pairs(rest: string, tail?: string): Record<string, string> {
  const out: Record<string, string> = {}
  let s = rest
  if (tail) {
    const i = s.indexOf(` ${tail}=`)
    const j = s.startsWith(`${tail}=`) ? 0 : i >= 0 ? i + 1 : -1
    if (j >= 0) {
      out[tail] = s.slice(j + tail.length + 1)
      s = s.slice(0, j)
    }
  }
  for (const m of s.matchAll(/(\w+)=(\S*)/g)) out[m[1]] = m[2]
  return out
}

const matchOf = (v: string | undefined): boolean | null =>
  v === 'yes' ? true : v === 'no' ? false : null

/** Reads survey.sh's output. Lines it does not know are ignored. */
export function parseSurvey(out: string): SurveyReport {
  const r: SurveyReport = {
    host: '',
    os: '',
    sudo: false,
    python: false,
    memoryMb: 0,
    docker: 'none',
    containers: [],
    configs: [],
    processes: [],
    units: [],
    listens: [],
    proxyConfs: [],
    keySources: [],
    services: [],
    settings: [],
    keyrings: [],
    keysFiles: [],
    complete: false,
    partial: false
  }
  for (const raw of out.replace(/\r\n/g, '\n').split('\n')) {
    // The last line is "done", or "done: partial (...)" when the server has no python3.
    const done = /^done(?::\s?(.*))?$/.exec(raw.trim())
    if (done) {
      r.complete = true
      r.partial = (done[1] ?? '').startsWith('partial')
      continue
    }
    const m = /^([a-z_0-9]+):\s?(.*)$/.exec(raw.trim())
    if (!m) continue
    const [, key, rest] = m
    switch (key) {
      case 'host':
        r.host = rest
        break
      case 'os':
        r.os = rest
        break
      case 'sudo':
        r.sudo = rest === 'yes'
        break
      case 'python3':
        r.python = rest === 'yes'
        break
      case 'memory_mb':
        r.memoryMb = Number(rest) || 0
        break
      case 'docker':
        r.docker = rest
        break
      case 'container': {
        const p = pairs(rest)
        r.containers.push({
          name: p.name ?? '',
          role: p.role ?? '',
          image: p.image ?? '',
          project: p.project ?? '',
          dir: p.dir ?? '',
          ports: p.ports ?? ''
        })
        break
      }
      case 'config': {
        const p = pairs(rest)
        r.configs.push({ from: p.from ?? '', role: p.role ?? '', path: p.path ?? '' })
        break
      }
      case 'process': {
        const p = pairs(rest, 'args')
        r.processes.push({ pid: p.pid ?? '', user: p.user ?? '', args: p.args ?? '' })
        break
      }
      case 'unit': {
        const p = pairs(rest, 'exec')
        r.units.push({ name: p.name ?? '', active: p.active ?? '', exec: p.exec ?? '' })
        break
      }
      case 'listen': {
        const p = pairs(rest)
        r.listens.push({ port: Number(p.port) || 0, process: p.process ?? '' })
        break
      }
      case 'proxyconf': {
        const p = pairs(rest)
        r.proxyConfs.push({ proxy: p.proxy ?? '', where: p.where ?? '', path: p.path ?? '' })
        break
      }
      case 'keysource': {
        const p = pairs(rest)
        r.keySources.push({
          kind: p.kind ?? '',
          path: p.path ?? p.dir ?? p.name ?? '',
          config: p.config ?? ''
        })
        break
      }
      case 'service': {
        const p = pairs(rest)
        if (p.id) r.services.push({ id: p.id, backend: p.backend ?? '', config: p.config ?? '' })
        break
      }
      case 'setting': {
        const s = /^(\w+)=(\S*)\s+config=(\S*)/.exec(rest)
        if (s) r.settings.push({ key: s[1], value: s[2], config: s[3] })
        break
      }
      case 'keyring': {
        const p = pairs(rest)
        if (p.address)
          r.keyrings.push({
            dir: p.dir ?? '',
            backend: p.backend ?? '',
            address: p.address,
            match: matchOf(p.match)
          })
        break
      }
      case 'keysfile': {
        const p = pairs(rest)
        if (p.address)
          r.keysFiles.push({ path: p.path ?? '', address: p.address, match: matchOf(p.match) })
        break
      }
    }
  }
  return r
}

/** What the survey found that decides how an import can go. */
export interface SurveyVerdict {
  /** The kinds of RelayMiner running: HA (pocket-relay-miner) and/or the legacy pocketd one. */
  relayMiner: ('ha' | 'legacy')[]
  /** Where the operator's key is on the server, or null when it was not found there. */
  operatorKey: { kind: 'keyring' | 'keysfile'; where: string } | null
  /** Each service the RelayMiner serves and the backend it calls, once per service. */
  services: { id: string; backend: string }[]
  /** What answers on ports 80 and 443. */
  webPorts: { port: number; process: string }[]
  /** Plain sentences for things the user must know or fix before an import. */
  notes: string[]
}

export function judgeSurvey(r: SurveyReport): SurveyVerdict {
  const kinds = new Set<'ha' | 'legacy'>()
  for (const c of r.containers) {
    if (c.role === 'relayer' || c.role === 'miner' || c.role === 'relayminer') kinds.add('ha')
    if (c.role === 'legacy-relayminer') kinds.add('legacy')
  }
  for (const p of r.processes) kinds.add(/pocket-relay-miner/.test(p.args) ? 'ha' : 'legacy')
  const ring = r.keyrings.find((k) => k.match === true)
  const file = r.keysFiles.find((k) => k.match === true)
  const operatorKey = file
    ? { kind: 'keysfile' as const, where: file.path }
    : ring
      ? { kind: 'keyring' as const, where: `${ring.dir} (${ring.backend})` }
      : null
  const seen = new Set<string>()
  const services = r.services
    .filter((s) => !seen.has(s.id) && !!seen.add(s.id))
    .map((s) => ({ id: s.id, backend: s.backend }))
  const webPorts = r.listens.filter((l) => l.port === 80 || l.port === 443)
  const notes: string[] = []
  if (!r.complete) notes.push('The survey did not finish, so what follows may be incomplete.')
  if (r.partial) notes.push('The server has no python3, so its configs and keys could not be read.')
  if (r.docker === 'none') notes.push('Docker is not installed on the server.')
  if (r.docker === 'unreachable')
    notes.push('Docker is installed but this user cannot use it: add the user to the docker group.')
  if (!kinds.size) notes.push('No RelayMiner is running on this server.')
  if (kinds.has('legacy'))
    notes.push(
      'This server runs the legacy pocketd relayminer, which cannot claim through the public endpoints; the import replaces it.'
    )
  if (!operatorKey && r.complete)
    notes.push(
      "The operator's key was not found on the server. It can be pasted into the app instead."
    )
  return { relayMiner: [...kinds], operatorKey, services, webPorts, notes }
}
