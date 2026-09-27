import { describe, it, expect } from 'vitest'
import { parseRoutesFile, routeProblem, validateRoutes, routeArgs, routeUrl } from '@core/routes'
import { supplierStepArgs, SUPPLIER_STEPS } from '@core/supplier'
import type { SignerRequests } from '@core/contract'

const conn = { host: 'example-host', port: 22, user: 'REPLACE-user', key_path: 'C:\\k', path: '/x' }
const run = (extra: Partial<SignerRequests['supplier-run']>): ReturnType<typeof supplierStepArgs> =>
  supplierStepArgs({ ...conn, step: 'status', ...extra } as SignerRequests['supplier-run'])

describe('deploy/routes.json', () => {
  it('parses a declaration and keeps the purpose', () => {
    const r = parseRoutesFile(
      JSON.stringify({ routes: [{ path: '/example-peer', port: 8090, purpose: 'Peer API.' }] })
    )
    expect(r).toEqual({
      ok: true,
      routes: [{ path: '/example-peer', port: 8090, purpose: 'Peer API.' }]
    })
  })
  it('an empty list is no routes', () => {
    expect(parseRoutesFile('{"routes": []}')).toEqual({ ok: true, routes: [] })
  })
  it('refuses a file that is not a routes object', () => {
    expect(parseRoutesFile('not json').ok).toBe(false)
    expect(parseRoutesFile('[]').ok).toBe(false)
    expect(parseRoutesFile('{"routes": {}}').ok).toBe(false)
  })
  it('refuses a duplicate path', () => {
    const r = parseRoutesFile(
      JSON.stringify({
        routes: [
          { path: '/a', port: 8090 },
          { path: '/a', port: 8091 }
        ]
      })
    )
    expect(r.ok).toBe(false)
  })
})

describe('route validation', () => {
  it('accepts a single lowercase segment and a backend port', () => {
    expect(routeProblem({ path: '/meadow-peer', port: 8090 })).toBe('')
    expect(routeProblem({ path: '/a', port: 1024 })).toBe('')
    expect(routeProblem({ path: '/' + 'a'.repeat(41), port: 65535 })).toBe('')
  })
  it.each([
    '/',
    '',
    'peer',
    '/Peer',
    '/-peer',
    '/peer/',
    '/a/b',
    '/peer_x',
    '/pe er',
    "/pe'er",
    '/peer;rm',
    '/' + 'a'.repeat(42),
    '/../x'
  ])('refuses the path %j', (path) => {
    expect(routeProblem({ path, port: 8090 })).not.toBe('')
  })
  it.each([0, 80, 1023, 8080, 65536, 8090.5, '8090', null])('refuses the port %j', (port) => {
    expect(routeProblem({ path: '/peer', port })).not.toBe('')
  })
  it('refuses the relay port with a reason', () => {
    expect(routeProblem({ path: '/peer', port: 8080 })).toMatch(/relay port/)
  })
  it('caps the list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `/p${i}`, port: 9000 + i }))
    expect(() => validateRoutes(many)).toThrow(/at most 8/)
    expect(() => validateRoutes([])).toThrow()
    expect(() => validateRoutes('x')).toThrow()
  })
  it('builds path and port pairs and public URLs', () => {
    const rs = validateRoutes([
      { path: '/a', port: 8090 },
      { path: '/b', port: 9000 }
    ])
    expect(routeArgs(rs)).toEqual(['/a', '8090', '/b', '9000'])
    expect(routeUrl('https://services-beta.example.org/', rs[0])).toBe(
      'https://services-beta.example.org/a/'
    )
  })
})

describe('supplier-run arguments', () => {
  it('lists the route steps', () => {
    expect(SUPPLIER_STEPS).toContain('add-routes')
    expect(SUPPLIER_STEPS).toContain('remove-routes')
  })
  it('add-routes: id then path and port pairs', () => {
    expect(
      run({
        step: 'add-routes',
        service_id: 'example-charts',
        routes: [
          { path: '/example-peer', port: 8090 },
          { path: '/example-feed', port: 8091 }
        ]
      })
    ).toEqual({
      step: 'add-routes',
      args: ['example-charts', '/example-peer', '8090', '/example-feed', '8091']
    })
  })
  it('add-routes refuses a bad id, no routes, and a bad route', () => {
    const routes = [{ path: '/p', port: 8090 }]
    expect(() => run({ step: 'add-routes', service_id: "x'; rm -rf /", routes })).toThrow()
    expect(() => run({ step: 'add-routes', service_id: 'x' })).toThrow()
    expect(() =>
      run({ step: 'add-routes', service_id: 'x', routes: [{ path: "/p' ; id", port: 8090 }] })
    ).toThrow()
    expect(() =>
      run({ step: 'add-routes', service_id: 'x', routes: [{ path: '/p', port: 8080 }] })
    ).toThrow()
  })
  it('remove-routes: the id alone', () => {
    expect(run({ step: 'remove-routes', service_id: 'example-charts' })).toEqual({
      step: 'remove-routes',
      args: ['example-charts']
    })
    expect(() => run({ step: 'remove-routes', service_id: '../x' })).toThrow()
  })
  it('refuses an unknown step', () => {
    expect(() => run({ step: 'rm' as never })).toThrow(/Unknown supplier step/)
  })
  it('keeps the existing steps unchanged', () => {
    expect(run({ step: 'publish', network: 'beta' }).args).toEqual(['beta'])
    expect(
      run({
        step: 'add-service',
        service_id: 'example-charts',
        backend_url: 'http://example-charts-backend:8080',
        health_path: '/healthz'
      }).args
    ).toEqual(['example-charts', 'http://example-charts-backend:8080', '/healthz'])
  })
})
