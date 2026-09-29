// Pure rendering of a supplier stack from the server templates (supplier-ship)
// and of the YAML files the transactions mount. Nothing here touches disk.
import { NETWORK_INFO, type Network } from './networks'
import { renderTemplate, toLf } from './text'
import type { StakeService } from './contract'
import { POCKETD_IMAGE, RELAYMINER_IMAGE, REDIS_IMAGE, STACK_LAYOUT } from './versions'

export interface StackTokens {
  network: Network
  blockTime: number
  hostname: string
  project: string
  healthPort: number
  relayerMetricsPort: number
  minerMetricsPort: number
  caddyDir: string
}

/** The template files supplier-ship reads, keyed by file name under resources/server. */
export interface StackTemplates {
  'miner-config.yaml.tmpl': string
  'relayer-config.yaml.tmpl': string
  'docker-compose.yaml.tmpl': string
  'stack.env.tmpl': string
  'site.caddy.tmpl': string
  'supplier.sh': string
  'caddy/docker-compose.yaml': string
  'caddy/Caddyfile': string
}

export interface RenderedStack {
  /** Files for the stack directory. */
  stack: Record<
    | 'docker-compose.yaml'
    | 'miner-config.yaml'
    | 'relayer-config.yaml'
    | 'stack.env'
    | 'supplier.sh',
    string
  >
  /** Files for the shared Caddy directory. */
  caddy: Record<'docker-compose.yaml' | 'Caddyfile', string>
  /** The site file, named `<network>.caddy`. */
  site: { name: string; text: string }
}

export function stackTokenMap(t: StackTokens): Record<string, string> {
  const n = NETWORK_INFO[t.network]
  return {
    '{{NETWORK}}': t.network,
    '{{CHAIN_ID}}': n.chainId,
    '{{RPC_URL}}': n.rpc,
    '{{GRPC_URL}}': n.grpc,
    '{{BLOCK_TIME}}': String(t.blockTime),
    '{{HOSTNAME}}': t.hostname,
    '{{PROJECT}}': t.project,
    '{{HEALTH_PORT}}': String(t.healthPort),
    '{{RELAYER_METRICS_PORT}}': String(t.relayerMetricsPort),
    '{{MINER_METRICS_PORT}}': String(t.minerMetricsPort),
    '{{CADDY_DIR}}': t.caddyDir,
    '{{RELAYMINER_IMAGE}}': RELAYMINER_IMAGE,
    '{{REDIS_IMAGE}}': REDIS_IMAGE,
    '{{POCKETD_IMAGE}}': POCKETD_IMAGE,
    '{{STACK_LAYOUT}}': String(STACK_LAYOUT)
  }
}

/** Renders every file supplier-ship copies to the server, LF-terminated. */
export function renderStack(tpl: StackTemplates, t: StackTokens): RenderedStack {
  const tokens = stackTokenMap(t)
  const r = (s: string): string => toLf(renderTemplate(s, tokens))
  return {
    stack: {
      'docker-compose.yaml': r(tpl['docker-compose.yaml.tmpl']),
      'miner-config.yaml': r(tpl['miner-config.yaml.tmpl']),
      'relayer-config.yaml': r(tpl['relayer-config.yaml.tmpl']),
      'stack.env': r(tpl['stack.env.tmpl']),
      'supplier.sh': toLf(tpl['supplier.sh'])
    },
    caddy: {
      'docker-compose.yaml': toLf(tpl['caddy/docker-compose.yaml']),
      Caddyfile: toLf(tpl['caddy/Caddyfile'])
    },
    site: { name: `${t.network}.caddy`, text: r(tpl['site.caddy.tmpl']) }
  }
}

/**
 * Whether a provisioned stack runs older files than this app ships (STACK_LAYOUT), so
 * provisioning it again is due: it gets the pinned images and whatever else changed.
 * A stack recorded before layouts were tracked is layout 1.
 */
export function stackNeedsUpdate(
  st: { provisioned_at?: string; layout?: number } | null | undefined
): boolean {
  return !!st?.provisioned_at && (st.layout ?? 1) < STACK_LAYOUT
}

/** The part of a server entry that says whether a network's stack finished provisioning. */
export interface ServerStacks {
  suppliers?: Partial<Record<Network, { provisioned_at?: string } | undefined>>
}

/**
 * Whether any configured server has a finished stack for the network. Registering a
 * service before there is anywhere to run it is how a service ends up supplied by hand,
 * outside the app; Register and the bridge both refuse a new service until this holds.
 */
export function hasProvisionedStack(servers: readonly ServerStacks[], net: Network): boolean {
  return servers.some((s) => !!s.suppliers?.[net]?.provisioned_at)
}

/**
 * A stack's public URL, the one its supplier stakes. Caddy always listens on 443 on the
 * server; a public port other than 443 is for a server behind a router that forwards
 * that port to 443 (for example `https://host:8445`). 443, empty, or nothing gives the
 * plain `https://host`.
 */
export function stackUrl(host: string, port?: string | number | null): string {
  const p = String(port ?? '').trim()
  return p && p !== '443' ? `https://${host}:${p}` : `https://${host}`
}

/** The public port in a stack URL, or '' for the default 443. */
export function portOfStackUrl(url: string | undefined | null): string {
  const m = /^https:\/\/[^/:]+:(\d+)(?:\/|$)/.exec(String(url ?? ''))
  return m && m[1] !== '443' ? m[1] : ''
}

/** Checks a public port as typed: empty (443) or a whole number 1 to 65535. */
export function publicPortError(port: string): string | null {
  const p = port.trim()
  if (!p) return null
  if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535)
    return 'The public port is a number from 1 to 65535, or empty for 443.'
  return null
}

export function appStakeYaml(stakeUpokt: number, serviceId: string): string {
  return `stake_amount: ${stakeUpokt}upokt\nservice_ids:\n  - ${serviceId}\n`
}

/** One share of a supplier's revenue: an address and its whole-number percentage. */
export interface RevShare {
  address: string
  percent: number
}

/**
 * The revenue split recorded on a supplier, read from its first service (the app stakes
 * every service with the same default split). Null when the record carries none, or one
 * that does not add up to 100, so the caller falls back to the owner alone.
 */
export function revShareOf(rec: {
  services?: { rev_share?: { address: string; rev_share_percentage: string | number }[] }[]
}): RevShare[] | null {
  const rs = rec.services?.[0]?.rev_share ?? []
  const out = rs
    .map((r) => ({ address: r.address, percent: Number(r.rev_share_percentage) }))
    .filter(
      (r) => /^pokt1[0-9a-z]{38}$/.test(r.address) && Number.isInteger(r.percent) && r.percent > 0
    )
  return out.length && out.reduce((a, r) => a + r.percent, 0) === 100 ? out : null
}

/**
 * The stake config a supplier stakes with. `revShare` defaults to the owner alone, as for
 * a supplier the app made; a restake of an existing supplier passes the split it already
 * has, so an update never moves its revenue.
 */
export function supplierStakeYaml(
  owner: string,
  operator: string,
  stakeUpokt: number,
  services: StakeService[],
  revShare: RevShare[] = [{ address: owner, percent: 100 }]
): string {
  const split = revShare.map((r) => `  ${r.address}: ${r.percent}\n`).join('')
  let y = `owner_address: ${owner}\noperator_address: ${operator}\nstake_amount: ${stakeUpokt}upokt\ndefault_rev_share_percent:\n${split}services:\n`
  for (const s of services) {
    y += `  - service_id: ${s.service_id}\n    endpoints:\n      - publicly_exposed_url: ${s.url}\n        rpc_type: ${s.rpc_type}\n`
  }
  return y
}

export function pocketApYaml(network: Network, serviceId: string): string {
  return `network: ${network}\nlisteners:\n  - addr: 127.0.0.1:8550\n    service_id: ${serviceId}\n    rpc_type: rest\napps: []\n`
}

export function backendComposeFromTemplate(template: string, serviceId: string): string {
  return toLf(template.split('{{SERVICE_ID}}').join(serviceId))
}
