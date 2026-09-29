import { describe, it, expect } from 'vitest'
import { supplierStepArgs, normalizeOperatorSecret, SUPPLIER_STEPS } from '@core/supplier'
import type { SupplierStep } from '@core/contract'
import { BRIDGE_EXCLUDED_OPS, BRIDGE_REFUSED_STEPS, BRIDGE_TOOLS } from '@core/bridge'
import { SIGNER_OPS } from '@core/contract'
import type { SignerRequests } from '@core/contract'

const OP = 'pokt1' + 'a'.repeat(38)
const conn = { host: 'h', port: 22, user: 'u', key_path: 'k', path: '/opt/pocket/supplier-beta' }
const adopt = (x: Partial<SignerRequests['supplier-run']>): SignerRequests['supplier-run'] => ({
  ...conn,
  step: 'operator-adopt',
  ...x
})

describe('import: operator key placement', () => {
  it('adopt takes a source kind, a Linux path, and the operator address', () => {
    expect(SUPPLIER_STEPS).toContain('operator-adopt')
    expect(
      supplierStepArgs(
        adopt({
          source_kind: 'keysfile',
          source_path: '/opt/relay/keys.yaml',
          operator_address: OP
        })
      )
    ).toEqual({ step: 'operator-adopt', args: ['keysfile', '/opt/relay/keys.yaml', OP] })
    expect(
      supplierStepArgs(
        adopt({ source_kind: 'keyring', source_path: '/root/.pocket', operator_address: OP })
      ).args[0]
    ).toBe('keyring')
  })
  it('adopt refuses anything else', () => {
    expect(() =>
      supplierStepArgs(
        adopt({ source_kind: 'env' as never, source_path: '/x', operator_address: OP })
      )
    ).toThrow(/keys file or a keyring/)
    expect(() =>
      supplierStepArgs(
        adopt({ source_kind: 'keysfile', source_path: "/x'; rm -rf /", operator_address: OP })
      )
    ).toThrow()
    expect(() =>
      supplierStepArgs(
        adopt({ source_kind: 'keysfile', source_path: '/x', operator_address: 'nope' })
      )
    ).toThrow(/pokt1/)
  })
  it('a pasted secret is a 64-hex key or a 12 to 24 word phrase, normalised', () => {
    const hex = 'AB'.repeat(32)
    expect(normalizeOperatorSecret('  0x' + hex + '\n')).toEqual({
      kind: 'hex',
      value: hex.toLowerCase()
    })
    const words = Array.from({ length: 24 }, () => 'zoo')
    expect(normalizeOperatorSecret('  ' + words.join('   ').toUpperCase() + ' ')).toEqual({
      kind: 'mnemonic',
      value: words.join(' ')
    })
    for (const bad of [
      '',
      'ab'.repeat(31),
      'zoo '.repeat(11),
      'zoo '.repeat(13),
      'zoo1 '.repeat(12)
    ])
      expect(() => normalizeOperatorSecret(bad)).toThrow(/neither/)
  })
  it('a refused secret is never echoed in the message', () => {
    const secretish = 'f'.repeat(63)
    try {
      normalizeOperatorSecret(secretish)
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secretish)
    }
  })
  it('backend-attach and theirs take only names from the survey, never the app containers', () => {
    const run = (step: SupplierStep, x: Partial<SignerRequests['supplier-run']>): string[] =>
      supplierStepArgs({ ...conn, step, ...x }).args
    expect(run('backend-attach', { container: 'supplier-charts-1' })).toEqual(['supplier-charts-1'])
    expect(() => run('backend-attach', { container: 'pocket-caddy' })).toThrow(/own containers/)
    expect(() => run('backend-attach', { container: 'x; rm -rf /' })).toThrow(/container name/)
    expect(
      run('theirs', { their_action: 'stop', their_kind: 'container', their_name: 'caddy' })
    ).toEqual(['stop', 'container', 'caddy'])
    expect(
      run('theirs', {
        their_action: 'disable',
        their_kind: 'unit',
        their_name: 'relayminer.service'
      })
    ).toEqual(['disable', 'unit', 'relayminer.service'])
    expect(() =>
      run('theirs', { their_action: 'rm' as never, their_kind: 'container', their_name: 'caddy' })
    ).toThrow(/Unknown action/)
    expect(() =>
      run('theirs', { their_action: 'stop', their_kind: 'unit', their_name: 'sshd' })
    ).toThrow(/systemd service/)
    expect(() =>
      run('theirs', {
        their_action: 'stop',
        their_kind: 'container',
        their_name: 'pocket-supplier-main-miner'
      })
    ).toThrow(/own containers/)
  })
  it('the key-carrying import is off the bridge, and so is adopting a key', () => {
    expect(SIGNER_OPS).toContain('supplier-import-operator')
    expect(BRIDGE_EXCLUDED_OPS).toContain('supplier-import-operator')
    expect(BRIDGE_TOOLS.some((t) => t.op === 'supplier-import-operator')).toBe(false)
    for (const s of ['operator-adopt', 'backend-attach', 'theirs'])
      expect(BRIDGE_REFUSED_STEPS).toContain(s)
    const run = BRIDGE_TOOLS.find((t) => t.op === 'supplier-run')
    expect(JSON.stringify(run?.inputSchema)).not.toContain('operator-adopt')
  })
})
