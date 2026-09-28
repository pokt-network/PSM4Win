// Per-network relay port: which port of <service_id>-backend each network's relayer calls,
// declared in deploy/relayer.json (docs/SCREENS.md 3.7). One backend container serves both
// networks' relayers; a service that keeps a separate node per network listens on one port
// per network, so Beta relays can never reach MainNet state. The host is always the
// service's own backend; a declaration names ports only. Nothing here touches disk.
import { fail } from './errors'
import { NETWORKS, isNetwork, type Network } from './networks'
import { RELAY_PORT, type ServiceRoute } from './routes'

/** The declaration file, relative to the service folder. */
export const RELAYER_FILE = 'deploy/relayer.json'
export const MIN_BACKEND_PORT = 1024
export const MAX_BACKEND_PORT = 65535

export interface RelayerDecl {
  /** Networks the file lists; any other network uses RELAY_PORT. */
  backend_port: Partial<Record<Network, number>>
  /** Informational; never sent to the server. */
  purpose?: string
}

export type ParsedRelayer = { ok: true; decl: RelayerDecl } | { ok: false; error: string }

/** No file: every network's relayer calls the default relay port. */
export const DEFAULT_RELAYER: RelayerDecl = { backend_port: {} }

export function isBackendPort(p: unknown): p is number {
  return (
    typeof p === 'number' && Number.isInteger(p) && p >= MIN_BACKEND_PORT && p <= MAX_BACKEND_PORT
  )
}

/** Checks a backend port as the signer receives it; throws when it is not one. */
export function validateBackendPort(p: unknown): number {
  const n = p === undefined || p === null || p === '' ? RELAY_PORT : p
  if (!isBackendPort(n))
    fail(`Backend port must be a whole number from ${MIN_BACKEND_PORT} to ${MAX_BACKEND_PORT}.`)
  return n
}

/** Parses deploy/relayer.json. A missing file is the caller's case: DEFAULT_RELAYER. */
export function parseRelayerFile(text: string): ParsedRelayer {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `deploy/relayer.json is not valid JSON: ${(e as Error).message}` }
  }
  const map = (j as { backend_port?: unknown } | null)?.backend_port
  if (
    !j ||
    typeof j !== 'object' ||
    Array.isArray(j) ||
    !map ||
    typeof map !== 'object' ||
    Array.isArray(map)
  )
    return {
      ok: false,
      error: `deploy/relayer.json must be an object with a "backend_port" map, such as {"backend_port": {"main": 8080, "beta": 8081}}.`
    }
  const out: Partial<Record<Network, number>> = {}
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    // An unknown key is refused rather than ignored: a misspelt network would quietly
    // fall back to the default port, which is the port the other network's relayer calls.
    if (!isNetwork(k))
      return {
        ok: false,
        error: `deploy/relayer.json: "${k}" is not a network. Use ${NETWORKS.map((n) => `"${n}"`).join(' or ')}.`
      }
    if (!isBackendPort(v))
      return {
        ok: false,
        error: `deploy/relayer.json: the port for "${k}" must be a whole number from ${MIN_BACKEND_PORT} to ${MAX_BACKEND_PORT}.`
      }
    out[k] = v
  }
  const purpose = (j as { purpose?: unknown }).purpose
  return {
    ok: true,
    decl:
      typeof purpose === 'string' && purpose
        ? { backend_port: out, purpose }
        : { backend_port: out }
  }
}

/** The port the relayer on a network calls. */
export function backendPortFor(decl: RelayerDecl, net: Network): number {
  return decl.backend_port[net] ?? RELAY_PORT
}

/** The relayer entry's backend URL: always the service's own backend container. */
export function backendUrlFor(serviceId: string, port: number): string {
  return `http://${serviceId}-backend:${port}`
}

/** Every port some network's relayer calls, including the default for unlisted networks. */
export function relayPorts(decl: RelayerDecl): number[] {
  return [...new Set(NETWORKS.map((n) => backendPortFor(decl, n)).concat(RELAY_PORT))].sort(
    (a, b) => a - b
  )
}

/** Why the routes cannot be used with these relay ports, or '' when they can. A public
 *  route to a port a relayer calls would serve the paid API without the relayer. */
export function routesRelayClash(routes: ServiceRoute[], decl: RelayerDecl): string {
  const ports = relayPorts(decl)
  const r = routes.find((x) => ports.includes(x.port))
  if (!r) return ''
  const nets = NETWORKS.filter((n) => backendPortFor(decl, n) === r.port)
  return `Route ${r.path}: port ${r.port} is where the ${nets.length ? nets.join(' and ') : 'default'} relayer calls the service (deploy/relayer.json), so only a relayer may reach it.`
}

/** One line for the Deploy screen, or '' when the service uses the default everywhere. */
export function relayerSummary(decl: RelayerDecl, label: (n: Network) => string): string {
  if (!Object.keys(decl.backend_port).length) return ''
  return `Each network's relayer calls its own port: ${NETWORKS.map((n) => `${label(n)} ${backendPortFor(decl, n)}`).join(', ')} (deploy\\relayer.json).`
}
