import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderStack,
  appStakeYaml,
  supplierStakeYaml,
  pocketApYaml,
  backendComposeFromTemplate,
  type StackTemplates
} from '@core/stack'

const dir = join(process.cwd(), 'resources', 'server')
const rd = (n: string): string => readFileSync(join(dir, n), 'utf8')
const templates: StackTemplates = {
  'miner-config.yaml.tmpl': rd('miner-config.yaml.tmpl'),
  'relayer-config.yaml.tmpl': rd('relayer-config.yaml.tmpl'),
  'docker-compose.yaml.tmpl': rd('docker-compose.yaml.tmpl'),
  'stack.env.tmpl': rd('stack.env.tmpl'),
  'site.caddy.tmpl': rd('site.caddy.tmpl'),
  'supplier.sh': rd('supplier.sh'),
  'caddy/docker-compose.yaml': rd(join('caddy', 'docker-compose.yaml')),
  'caddy/Caddyfile': rd(join('caddy', 'Caddyfile'))
}

describe('supplier-ship rendering', () => {
  const r = renderStack(templates, {
    network: 'beta',
    blockTime: 30,
    hostname: 'services-beta.agentdata.network',
    project: 'pocket-supplier',
    healthPort: 8081,
    relayerMetricsPort: 9090,
    minerMetricsPort: 9092,
    caddyDir: '/opt/pocket/caddy'
  })
  it('leaves no token behind and uses LF', () => {
    for (const text of [...Object.values(r.stack), ...Object.values(r.caddy), r.site.text]) {
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/)
      expect(text).not.toContain('\r')
    }
  })
  it('reproduces the stack.env the HTA wrote on the reference host', () => {
    const ref = readFileSync(
      join(process.cwd(), 'reference', 'servers', 'cherry', 'supplier-beta', 'stack.env'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    expect(r.stack['stack.env']).toBe(ref)
  })
  it('reproduces the beta site file on the reference host', () => {
    const ref = readFileSync(
      join(process.cwd(), 'reference', 'servers', 'cherry', 'caddy', 'sites', 'beta.caddy'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    expect(r.site.name).toBe('beta.caddy')
    expect(r.site.text).toBe(ref)
  })
  it('renders the miner config with the beta chain id and block time', () => {
    expect(r.stack['miner-config.yaml']).toContain('pocket-lego-testnet')
    expect(r.stack['miner-config.yaml']).toContain('block_time_seconds: 30')
  })
})

describe('YAML the transactions mount', () => {
  it('app stake', () => {
    expect(appStakeYaml(1000000000, 'pretty-charts')).toBe(
      'stake_amount: 1000000000upokt\nservice_ids:\n  - pretty-charts\n'
    )
  })
  it('supplier stake', () => {
    const y = supplierStakeYaml('pokt1owner', 'pokt1op', 59500000000, [
      { service_id: 'a', url: 'https://x', rpc_type: 'REST' }
    ])
    expect(y).toBe(
      'owner_address: pokt1owner\noperator_address: pokt1op\nstake_amount: 59500000000upokt\ndefault_rev_share_percent:\n  pokt1owner: 100\nservices:\n  - service_id: a\n    endpoints:\n      - publicly_exposed_url: https://x\n        rpc_type: REST\n'
    )
  })
  it('pocket-ap config and backend compose', () => {
    expect(pocketApYaml('beta', 'x')).toContain('service_id: x')
    expect(backendComposeFromTemplate('a {{SERVICE_ID}}\r\nb {{SERVICE_ID}}', 'svc')).toBe(
      'a svc\nb svc'
    )
  })
})
