// Service routes: extra public paths a service declares in deploy/routes.json, served on
// the supplier's hostname next to the relayer (docs/SIGNER-CONTRACT.md, supplier-run
// add-routes). The target is always <service_id>-backend:<port> on the shared network;
// a declaration names a path and a port, never a host. Nothing here touches disk.
import { fail } from './errors'

export interface ServiceRoute {
  /** A single-segment prefix such as /meadow-peer; Caddy strips it before proxying. */
  path: string
  /** The backend container's port. */
  port: number
  /** Informational; never sent to the server. */
  purpose?: string
}

/** The declaration file, relative to the service folder. */
export const ROUTES_FILE = 'deploy/routes.json'
export const ROUTE_PATH_RE = /^\/[a-z0-9][a-z0-9-]{0,40}$/
/** The backend's relay port. A route to it would serve the paid API without the relayer. */
export const RELAY_PORT = 8080
export const MAX_ROUTES = 8

/** Why a route cannot be used, or '' when it can. */
export function routeProblem(r: { path?: unknown; port?: unknown }): string {
  const path = typeof r.path === 'string' ? r.path : ''
  if (!ROUTE_PATH_RE.test(path))
    return `Route path "${String(r.path ?? '')}" must be one segment of lowercase letters, digits, and hyphens after a slash, such as /peer.`
  const port = r.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535)
    return `Route ${path}: port must be a whole number from 1024 to 65535.`
  if (port === RELAY_PORT)
    return `Route ${path}: port ${RELAY_PORT} is the relay port, which only the relayer may reach.`
  return ''
}

/** Checks a list of routes as the signer receives it; throws on the first problem. */
export function validateRoutes(routes: unknown): ServiceRoute[] {
  if (!Array.isArray(routes) || routes.length === 0) fail('No routes were given.')
  const list = routes as { path?: unknown; port?: unknown }[]
  if (list.length > MAX_ROUTES) fail(`A service may declare at most ${MAX_ROUTES} routes.`)
  const seen = new Set<string>()
  const out: ServiceRoute[] = []
  for (const r of list) {
    const p = routeProblem(r ?? {})
    if (p) fail(p)
    const path = r.path as string
    if (seen.has(path)) fail(`Route ${path} is listed twice.`)
    seen.add(path)
    out.push({ path, port: r.port as number })
  }
  return out
}

export type ParsedRoutes = { ok: true; routes: ServiceRoute[] } | { ok: false; error: string }

/** Parses deploy/routes.json. A missing file is the caller's case: no routes. */
export function parseRoutesFile(text: string): ParsedRoutes {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `deploy/routes.json is not valid JSON: ${(e as Error).message}` }
  }
  const routes = (j as { routes?: unknown } | null)?.routes
  if (!j || typeof j !== 'object' || !Array.isArray(routes))
    return { ok: false, error: 'deploy/routes.json must be an object with a "routes" list.' }
  if (routes.length === 0) return { ok: true, routes: [] }
  try {
    const checked = validateRoutes(routes)
    return {
      ok: true,
      routes: checked.map((r, i) => {
        const purpose = (routes[i] as { purpose?: unknown }).purpose
        return typeof purpose === 'string' && purpose ? { ...r, purpose } : r
      })
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** The arguments add-routes takes after the service id: path, port, path, port, ... */
export function routeArgs(routes: ServiceRoute[]): string[] {
  return routes.flatMap((r) => [r.path, String(r.port)])
}

/** The public URL a route answers on, for a stack URL such as https://host. */
export function routeUrl(stackUrl: string, r: ServiceRoute): string {
  return `${stackUrl.replace(/\/+$/, '')}${r.path}/`
}
