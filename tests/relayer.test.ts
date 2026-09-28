import { describe, it, expect } from 'vitest'
import {
  parseRelayerFile,
  backendPortFor,
  backendUrlFor,
  relayPorts,
  routesRelayClash,
  relayerSummary,
  validateBackendPort,
  DEFAULT_RELAYER
} from '@core/relayer'
import { parseRoutesFile } from '@core/routes'
import { supplierStepArgs } from '@core/supplier'
import type { SignerRequests } from '@core/contract'
import { RE } from '@core/validate'

const conn = { host: 'example-host', port: 22, user: 'REPLACE-user', key_path: 'C:\\k', path: '/x' }
const run = (extra: Partial<SignerRequests['supplier-run']>): ReturnType<typeof supplierStepArgs> =>
  supplierStepArgs({ ...conn, step: 'status', ...extra } as SignerRequests['supplier-run'])

// The shape a service keeping one node per network declares (deploy/relayer.json).
const PER_NETWORK = JSON.stringify({
  backend_port: { main: 8080, beta: 8081 },
  purpose: 'Each network has its own node.'
})

describe('deploy/relayer.json', () => {
  it('parses a per-network declaration and keeps the purpose', () => {
    expect(parseRelayerFile(PER_NETWORK)).toEqual({
      ok: true,
      decl: { backend_port: { main: 8080, beta: 8081 }, purpose: 'Each network has its own node.' }
    })
  })
  it('an unlisted network keeps 8080', () => {
    const r = parseRelayerFile('{"backend_port": {"beta": 9001}}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(backendPortFor(r.decl, 'beta')).toBe(9001)
    expect(backendPortFor(r.decl, 'main')).toBe(8080)
    expect(backendPortFor(DEFAULT_RELAYER, 'beta')).toBe(8080)
  })
  it('an empty map is the default everywhere', () => {
    expect(parseRelayerFile('{"backend_port": {}}')).toEqual({
      ok: true,
      decl: { backend_port: {} }
    })
  })
  it.each([
    'not json',
    '[]',
    'null',
    '{}',
    '{"backend_port": [8080]}',
    '{"backend_port": 8081}',
    // A misspelt network is refused, never silently defaulted to the other network's port.
    '{"backend_port": {"mainnet": 8080}}',
    '{"backend_port": {"Beta": 8081}}',
    '{"backend_port": {"beta": 80}}',
    '{"backend_port": {"beta": 1023}}',
    '{"backend_port": {"beta": 65536}}',
    '{"backend_port": {"beta": 8081.5}}',
    '{"backend_port": {"beta": "8081"}}',
    '{"backend_port": {"beta": null}}'
  ])('refuses %s', (text) => {
    const r = parseRelayerFile(text)
    expect(r.ok).toBe(false)
  })
  it('names the file and the problem in its errors', () => {
    const r = parseRelayerFile('{"backend_port": {"mainnet": 8080}}')
    expect(!r.ok && r.error).toMatch(/deploy\/relayer\.json: "mainnet" is not a network/)
  })
})

describe('relay ports', () => {
  it('builds the backend URL on the service backend, which the signer accepts', () => {
    const u = backendUrlFor('example-charts', 8081)
    expect(u).toBe('http://example-charts-backend:8081')
    expect(RE.backendUrl.test(u)).toBe(true)
  })
  it('lists every port a relayer calls, including 8080 for unlisted networks', () => {
    expect(relayPorts(DEFAULT_RELAYER)).toEqual([8080])
    expect(relayPorts({ backend_port: { beta: 8081 } })).toEqual([8080, 8081])
    expect(relayPorts({ backend_port: { beta: 9001, main: 9000 } })).toEqual([8080, 9000, 9001])
  })
  it('refuses a route to any relay port and allows the rest', () => {
    const decl = { backend_port: { main: 8080, beta: 8081 } }
    const ok = parseRoutesFile(
      JSON.stringify({
        routes: [
          { path: '/example-peer', port: 8090 },
          { path: '/example-peer-beta', port: 8091 }
        ]
      })
    )
    expect(ok.ok && routesRelayClash(ok.routes, decl)).toBe('')
    const bad = routesRelayClash([{ path: '/example-peer', port: 8081 }], decl)
    expect(bad).toMatch(/port 8081 is where the beta relayer calls the service/)
    expect(routesRelayClash([{ path: '/p', port: 8081 }], DEFAULT_RELAYER)).toBe('')
  })
  it('summarises only a declaration that changes something', () => {
    const label = (n: string): string => (n === 'main' ? 'MainNet' : 'Beta TestNet')
    expect(relayerSummary(DEFAULT_RELAYER, label)).toBe('')
    expect(relayerSummary({ backend_port: { beta: 8081 } }, label)).toBe(
      "Each network's relayer calls its own port: Beta TestNet 8081, MainNet 8080 (deploy\\relayer.json)."
    )
  })
})

describe('supplier-run deploy', () => {
  const base = {
    step: 'deploy' as const,
    service_id: 'example-charts',
    deploy_root: '/opt/pocket/services'
  }
  it('passes the port after the health path, 8080 when absent', () => {
    expect(run({ ...base, health_path: '/healthz' }).args).toEqual([
      'example-charts',
      '/opt/pocket/services',
      '/healthz',
      '8080'
    ])
    expect(run({ ...base, backend_port: 8081 }).args).toEqual([
      'example-charts',
      '/opt/pocket/services',
      '/healthz',
      '8081'
    ])
  })
  it.each([80, 1023, 65536, 8081.5, '8081; id', -1])('refuses the port %j', (p) => {
    expect(() => run({ ...base, backend_port: p as number })).toThrow(/Backend port/)
  })
  it('validateBackendPort defaults and checks', () => {
    expect(validateBackendPort(undefined)).toBe(8080)
    expect(validateBackendPort(9000)).toBe(9000)
    expect(() => validateBackendPort(8080.1)).toThrow()
  })
})
