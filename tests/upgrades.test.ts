import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  relayminerTarget,
  stackRelayminer,
  relayminerBehind,
  nextVersionCandidates,
  upgradeTxUrl,
  parseUpgradeTx,
  parseCurrentPlan,
  pickUpgrade,
  upgradeEta
} from '@core/upgrades'
import { renderStack, stackNeedsUpdate, type StackTemplates } from '@core/stack'
import { RELAYMINER_IMAGE, RELAYMINER_VERSION, STACK_LAYOUT } from '@core/versions'

const bump = (v: string, by = 1): string => {
  const [a, b, c] = v.replace(/^v/, '').split('.').map(Number)
  return `v${a}.${b}.${c + by}`
}
const newer = bump(RELAYMINER_VERSION)
const ready = { provisioned_at: '2026-10-12T00:00:00Z', layout: STACK_LAYOUT }

describe('RelayMiner target', () => {
  it('follows a newer upstream release and never goes below the floor', () => {
    expect(relayminerTarget(newer)).toBe(newer)
    expect(relayminerTarget(RELAYMINER_VERSION)).toBe(RELAYMINER_VERSION)
    expect(relayminerTarget('v0.0.1')).toBe(RELAYMINER_VERSION)
    expect(relayminerTarget(null)).toBe(RELAYMINER_VERSION)
  })
  it('ignores tags that are not plain vX.Y.Z', () => {
    for (const t of [`${newer}-rc.1`, newer.slice(1), 'latest', `${newer};rm -rf /`, 'v9.9.9 '])
      expect(relayminerTarget(t)).toBe(RELAYMINER_VERSION)
  })
})

describe('stack RelayMiner', () => {
  it('reads the recorded version; a 0.1.27 layout-5 entry ran v0.1.2', () => {
    expect(stackRelayminer({ ...ready, relayminer: newer })).toBe(newer)
    expect(stackRelayminer({ provisioned_at: 'x', layout: 5 })).toBe('v0.1.2')
    expect(stackRelayminer({ provisioned_at: 'x', layout: 4 })).toBeNull()
    expect(stackRelayminer({ layout: 5, relayminer: newer })).toBeNull()
  })
  it('asks for Update stack when the target is newer than what the stack runs', () => {
    const st = { ...ready, relayminer: RELAYMINER_VERSION }
    expect(relayminerBehind(st, newer)).toBe(true)
    expect(stackNeedsUpdate(st, newer)).toBe(true)
    expect(stackNeedsUpdate(st, RELAYMINER_VERSION)).toBe(false)
    expect(stackNeedsUpdate(st)).toBe(false)
    expect(stackNeedsUpdate({ ...st, relayminer: newer }, newer)).toBe(false)
    expect(stackNeedsUpdate({ provisioned_at: 'x', layout: STACK_LAYOUT - 1 })).toBe(true)
  })
})

describe('supplier-ship writes the chosen RelayMiner', () => {
  const rd = (f: string): string => readFileSync(join('resources', 'server', f), 'utf8')
  const templates = {
    'miner-config.yaml.tmpl': rd('miner-config.yaml.tmpl'),
    'relayer-config.yaml.tmpl': rd('relayer-config.yaml.tmpl'),
    'docker-compose.yaml.tmpl': rd('docker-compose.yaml.tmpl'),
    'stack.env.tmpl': rd('stack.env.tmpl'),
    'site.caddy.tmpl': rd('site.caddy.tmpl'),
    'supplier.sh': rd('supplier.sh'),
    'survey_address.py': rd('survey_address.py'),
    'caddy/docker-compose.yaml': rd(join('caddy', 'docker-compose.yaml')),
    'caddy/Caddyfile': rd(join('caddy', 'Caddyfile'))
  } as StackTemplates
  const tokens = {
    network: 'beta' as const,
    blockTime: 30,
    hostname: 'services-beta.example.org',
    project: 'pocket-supplier-beta',
    healthPort: 8081,
    relayerMetricsPort: 9090,
    minerMetricsPort: 9092,
    caddyDir: '/opt/pocket/caddy'
  }
  it('uses the given release, and the pinned image for anything else', () => {
    const env = (rm?: string): string =>
      renderStack(templates, { ...tokens, relayminer: rm }).stack['stack.env']
    expect(env(newer)).toContain(
      `RELAYMINER_IMAGE=ghcr.io/pokt-network/pocket-relay-miner:${newer}\n`
    )
    expect(env()).toContain(`RELAYMINER_IMAGE=${RELAYMINER_IMAGE}\n`)
    expect(env('v1.0.0\nPOCKETD_IMAGE=evil')).toContain(`RELAYMINER_IMAGE=${RELAYMINER_IMAGE}\n`)
  })
})

describe('poktroll upgrades', () => {
  it('looks for the next patch and the next minor version', () => {
    expect(nextVersionCandidates('0.1.35')).toEqual(['v0.1.36', 'v0.2.0'])
    expect(nextVersionCandidates('v1.2.3')).toEqual(['v1.2.4', 'v1.3.0'])
    expect(nextVersionCandidates('')).toEqual([])
    expect(upgradeTxUrl('v0.1.36', 'main')).toBe(
      'https://raw.githubusercontent.com/pokt-network/poktroll/main/tools/scripts/upgrades/upgrade_tx_v0.1.36_main.json'
    )
  })
  const tx = (height: string): unknown => ({
    body: {
      messages: [
        {
          '@type': '/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade',
          plan: { name: 'v0.1.36', height, info: '{}' }
        }
      ]
    }
  })
  it('reads an upgrade file; UPDATE_ME means the height is not set', () => {
    expect(parseUpgradeTx(tx('990000'))).toEqual({
      name: 'v0.1.36',
      height: 990000,
      source: 'repo'
    })
    expect(parseUpgradeTx(tx('UPDATE_ME'))).toEqual({
      name: 'v0.1.36',
      height: null,
      source: 'repo'
    })
    expect(parseUpgradeTx({})).toBeNull()
  })
  it('reads the on-chain plan', () => {
    expect(parseCurrentPlan({ plan: null })).toBeNull()
    expect(parseCurrentPlan({ plan: { name: 'v0.1.36', height: '990000' } })).toEqual({
      name: 'v0.1.36',
      height: 990000,
      source: 'chain'
    })
  })
  it('prefers the chain, and drops an upgrade whose height has been reached', () => {
    const chain = { name: 'v0.1.36', height: 990000, source: 'chain' as const }
    const repo = { name: 'v0.1.36', height: 995000, source: 'repo' as const }
    expect(pickUpgrade(chain, repo, 900000)).toBe(chain)
    expect(pickUpgrade(null, repo, 900000)).toBe(repo)
    expect(pickUpgrade(null, repo, 995000)).toBeNull()
    expect(pickUpgrade(null, { ...repo, height: null }, 999999)?.height).toBeNull()
    expect(pickUpgrade(null, null, 1)).toBeNull()
  })
  it('estimates the time from the measured block time', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    expect(upgradeEta(1100, 1000, 30, now)).toBe('2026-10-12T12:50:00.000Z')
    expect(upgradeEta(null, 1000, 30, now)).toBeNull()
    expect(upgradeEta(1100, 1000, 0, now)).toBeNull()
  })
})
