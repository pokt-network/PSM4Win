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
import { POCKETD_IMAGE, RELAYMINER_IMAGE, REDIS_IMAGE, STACK_LAYOUT } from '@core/versions'

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
    hostname: 'services-beta.example.org',
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
  it('writes stack.env with the versions this app release pins', () => {
    expect(r.stack['stack.env']).toBe(
      '# Per-stack settings read by supplier.sh. Written by the Pocket Service Manager.\n' +
        'PROJECT=pocket-supplier\nNET=beta\nHEALTH_PORT=8081\nCADDY_DIR=/opt/pocket/caddy\n' +
        'HOSTNAME_PUBLIC=services-beta.example.org\n' +
        '# The versions this stack runs, pinned by the app release that provisioned it. The\n' +
        "# RelayMiner's relayer and miner always share one exact tag.\n" +
        `STACK_LAYOUT=${STACK_LAYOUT}\nRELAYMINER_IMAGE=${RELAYMINER_IMAGE}\n` +
        `REDIS_IMAGE=${REDIS_IMAGE}\nPOCKETD_IMAGE=${POCKETD_IMAGE}\n`
    )
  })
  it('pins exact images: no moving tags, Redis new enough for the RelayMiner', () => {
    expect(RELAYMINER_IMAGE).toMatch(/:v\d+\.\d+\.\d+$/)
    expect(POCKETD_IMAGE).toMatch(/:\d+\.\d+\.\d+$/)
    const [maj, min] = REDIS_IMAGE.replace(/^redis:/, '')
      .split('.')
      .map(Number)
    expect(maj > 8 || (maj === 8 && min >= 10)).toBe(true)
    const compose = r.stack['docker-compose.yaml']
    expect(compose).not.toMatch(/:rc\b|:latest\b|allkeys-lru/)
    expect(compose).toContain('--maxmemory-policy noeviction')
    expect(compose).toContain('image: ${RELAYMINER_IMAGE}')
    expect(compose).toMatch(/miner: \{ condition: service_healthy \}/)
  })
  it('validates relays before they reach the backend (no per-service body queue)', () => {
    expect(r.stack['relayer-config.yaml']).toMatch(/^default_validation_mode: eager$/m)
  })
  it('leaves out the config keys RelayMiner v0.1.0 rejects', () => {
    expect(r.stack['miner-config.yaml']).not.toMatch(/^\s+output:/m)
    expect(r.stack['relayer-config.yaml']).not.toMatch(/^\s+chain_id:/m)
    expect(r.stack['miner-config.yaml']).toMatch(/^\s+chain_id: "pocket-lego-testnet"/m)
  })
  it('reproduces the beta site file on the reference host, plus the service routes import', () => {
    // The reference host predates service routes (0.1.9) and reference/ is a snapshot that
    // is never edited, so the expected file is the reference with exactly the two lines
    // the template gained. Any other drift from the reference still fails here.
    const ref = readFileSync(
      join(process.cwd(), 'reference', 'servers', 'example-host', 'caddy', 'sites', 'beta.caddy'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    const relayer = '\treverse_proxy pocket-supplier-relayer:8080\n'
    expect(ref).toContain(relayer)
    const expected = ref.replace(
      relayer,
      '\t# Extra routes services declare (sites/routes/<id>.route); matching none is fine.\n' +
        '\timport /etc/caddy/sites/routes/*.route\n' +
        relayer
    )
    expect(r.site.name).toBe('beta.caddy')
    expect(r.site.text).toBe(expected)
  })
  it('renders the miner config with the beta chain id and block time', () => {
    expect(r.stack['miner-config.yaml']).toContain('pocket-lego-testnet')
    expect(r.stack['miner-config.yaml']).toContain('block_time_seconds: 30')
  })
})

describe('YAML the transactions mount', () => {
  it('app stake', () => {
    expect(appStakeYaml(1000000000, 'example-charts')).toBe(
      'stake_amount: 1000000000upokt\nservice_ids:\n  - example-charts\n'
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
