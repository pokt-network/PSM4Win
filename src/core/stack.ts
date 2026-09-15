// Pure rendering of a supplier stack from the server templates (supplier-ship)
// and of the YAML files the transactions mount. Nothing here touches disk.
import { NETWORK_INFO, type Network } from './networks'
import { renderTemplate, toLf } from './text'
import type { StakeService } from './contract'

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
    '{{CADDY_DIR}}': t.caddyDir
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

export function appStakeYaml(stakeUpokt: number, serviceId: string): string {
  return `stake_amount: ${stakeUpokt}upokt\nservice_ids:\n  - ${serviceId}\n`
}

export function supplierStakeYaml(
  owner: string,
  operator: string,
  stakeUpokt: number,
  services: StakeService[]
): string {
  let y = `owner_address: ${owner}\noperator_address: ${operator}\nstake_amount: ${stakeUpokt}upokt\ndefault_rev_share_percent:\n  ${owner}: 100\nservices:\n`
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
