// Runs the shipped supplier.sh add-routes and remove-routes against a scratch stack and
// Caddy directory, with a stand-in `docker` on PATH that records its calls, so the route
// file the server gets is checked byte for byte and the roll-back paths are exercised.
// Needs bash (Git for Windows on Windows); skipped where there is none.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'

const BASH =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(
        existsSync
      )
    : '/bin/bash'
const lf = (s: string): string => s.replace(/\r\n/g, '\n')
const fwd = (p: string): string => p.replace(/\\/g, '/')
const serverDir = join(process.cwd(), 'resources', 'server')

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [ "$1" = ps ]; then [ -n "\${FAKE_NO_CADDY:-}" ] || echo pocket-caddy; exit 0; fi
if [ "$1" = exec ] && [ "$3" = caddy ] && [ "$4" = validate ]; then
  if [ -n "\${FAKE_VALIDATE_FAIL:-}" ]; then echo '{"level":"info"}'; echo 'Error: adapting config using caddyfile: bad route'; exit 1; fi
  echo 'Valid configuration'; exit 0
fi
if [ "$1" = exec ] && [ "$3" = wget ]; then echo '  HTTP/1.1 404 Not Found'; exit 1; fi
exit 0
`
// remove-service edits the relayer config with python3; the stand-in reports the removal
// and lists no remaining services, which is all the route logic after it needs.
const FAKE_PYTHON = `#!/usr/bin/env bash
cat >/dev/null
if [ $# -ge 3 ]; then echo "relayer: removed $3"; fi
exit 0
`

describe.skipIf(!BASH)('supplier.sh service routes', () => {
  let root = ''
  let stack = ''
  let mainStack = ''
  let caddy = ''
  let log = ''
  const routes = (): string => join(caddy, 'sites', 'routes')
  const sh = (
    args: string[],
    env: Record<string, string> = {},
    dir = stack
  ): { code: number; out: string; calls: string[] } => {
    writeFileSync(log, '')
    const r = spawnSync(BASH!, [join(dir, 'supplier.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: join(root, 'bin') + delimiter + process.env.PATH,
        FAKE_LOG: fwd(log),
        ...env
      }
    })
    return {
      code: r.status ?? -1,
      out: lf(r.stdout + r.stderr),
      calls: lf(readFileSync(log, 'utf8')).split('\n').filter(Boolean)
    }
  }
  const site = (withImport: boolean, net = 'beta'): void => {
    let t = lf(readFileSync(join(serverDir, 'site.caddy.tmpl'), 'utf8'))
    if (!withImport) t = t.replace(/^.*sites\/routes\/.*\n/gm, '')
    writeFileSync(join(caddy, 'sites', `${net}.caddy`), t)
  }
  // One stack directory per network, sharing one Caddy directory, as on a real server.
  const makeStack = (dir: string, net: string): void => {
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'supplier.sh'),
      lf(readFileSync(join(serverDir, 'supplier.sh'), 'utf8')),
      {
        mode: 0o755
      }
    )
    writeFileSync(
      join(dir, 'stack.env'),
      `PROJECT=pocket-supplier-${net}\nNET=${net}\nHEALTH_PORT=8081\nCADDY_DIR=${fwd(caddy)}\nHOSTNAME_PUBLIC=services-${net}.example.org\n`
    )
    site(true, net)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psm-routes-'))
    stack = join(root, 'supplier-beta')
    mainStack = join(root, 'supplier-main')
    caddy = join(root, 'caddy')
    log = join(root, 'docker.log')
    mkdirSync(join(caddy, 'sites'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 })
    writeFileSync(join(root, 'bin', 'python3'), FAKE_PYTHON, { mode: 0o755 })
    makeStack(stack, 'beta')
    makeStack(mainStack, 'main')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('writes the route file, validates, reloads, and reports each route', () => {
    const r = sh(['add-routes', 'example-charts', '/example-peer', '8090', '/example-feed', '8091'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(routes(), 'example-charts.route'), 'utf8')).toBe(
      "# example-charts: routes from the service's deploy/routes.json, written by the Pocket Service Manager.\n" +
        '# networks: beta\n' +
        'handle_path /example-peer/* {\n\treverse_proxy example-charts-backend:8090\n}\n' +
        'handle_path /example-feed/* {\n\treverse_proxy example-charts-backend:8091\n}\n'
    )
    expect(r.out).toContain('route: /example-peer/ -> example-charts-backend:8090')
    expect(r.out).toContain('route: example-charts-backend:8091 answers')
    expect(r.out).not.toMatch(/^error:/m)
    const i = r.calls.findIndex((c) => / caddy validate /.test(c))
    const j = r.calls.findIndex((c) => / caddy reload /.test(c))
    expect(i).toBeGreaterThanOrEqual(0)
    expect(j).toBeGreaterThan(i)
  })

  it('refuses a path another service already routes', () => {
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    const r = sh(['add-routes', 'svc-b', '/peer', '9000'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: /peer is already routed to svc-a')
    expect(existsSync(join(routes(), 'svc-b.route'))).toBe(false)
    // The same service may rewrite its own routes.
    expect(sh(['add-routes', 'svc-a', '/peer', '8091']).code).toBe(0)
  })

  it('takes a refused file back out and never reloads', () => {
    const r = sh(['add-routes', 'svc-a', '/peer', '8090'], { FAKE_VALIDATE_FAIL: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: Caddy refused the routes, nothing changed:')
    expect(r.out).toContain('bad route')
    expect(existsSync(join(routes(), 'svc-a.route'))).toBe(false)
    expect(r.calls.some((c) => / caddy reload /.test(c))).toBe(false)
  })

  it('restores the previous routes when a new set is refused', () => {
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    const before = readFileSync(join(routes(), 'svc-a.route'), 'utf8')
    const r = sh(['add-routes', 'svc-a', '/peer', '9999'], { FAKE_VALIDATE_FAIL: '1' })
    expect(r.code).toBe(1)
    expect(readFileSync(join(routes(), 'svc-a.route'), 'utf8')).toBe(before)
  })

  it('refuses when the stack site file predates routes or Caddy is down', () => {
    site(false)
    const r = sh(['add-routes', 'svc-a', '/peer', '8090'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('predates service routes')
    site(true)
    const r2 = sh(['add-routes', 'svc-a', '/peer', '8090'], { FAKE_NO_CADDY: '1' })
    expect(r2.code).toBe(1)
    expect(r2.out).toContain('shared Caddy is not running')
  })

  it('warns about another stack whose site file predates routes', () => {
    writeFileSync(join(caddy, 'sites', 'main.caddy'), 'services.example.org {\n}\n')
    const r = sh(['add-routes', 'svc-a', '/peer', '8090'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('warning: main.caddy predates service routes')
  })

  it.each([
    [['svc-a', '/peer', '8080']],
    [['svc-a', '/peer']],
    [['svc-a', '/Peer', '8090']],
    [['svc-a', "/p'x", '8090']],
    [['svc-a', '/peer', '80']],
    [['svc-a', '/peer', '8090', '/peer', '8091']],
    [["svc'a", '/peer', '8090']]
  ])('refuses bad arguments %j', (args) => {
    const r = sh(['add-routes', ...args])
    expect(r.code).toBe(2)
    expect(existsSync(join(routes(), 'svc-a.route'))).toBe(false)
  })

  it('remove-routes drops the file and reloads; with none it is a no-op', () => {
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    const r = sh(['remove-routes', 'svc-a'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('routes: removed for svc-a')
    expect(existsSync(join(routes(), 'svc-a.route'))).toBe(false)
    expect(r.calls.some((c) => / caddy reload /.test(c))).toBe(true)
    const r2 = sh(['remove-routes', 'svc-a'])
    expect(r2.code).toBe(0)
    expect(r2.out).toContain('routes: svc-a has none')
  })

  it('records every network whose stack installs the routes, once', () => {
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    expect(sh(['add-routes', 'svc-a', '/peer', '8090'], {}, mainStack).code).toBe(0)
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    const t = readFileSync(join(routes(), 'svc-a.route'), 'utf8')
    expect(t.split('\n')[1]).toBe('# networks: beta main')
  })

  it('remove-service keeps routes while another network still serves the service', () => {
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    expect(sh(['add-routes', 'svc-a', '/peer', '8090'], {}, mainStack).code).toBe(0)
    const r = sh(['remove-service', 'svc-a'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('relayer: removed svc-a')
    expect(r.out).toContain('routes: svc-a keeps its extra routes while main still serves it')
    const t = readFileSync(join(routes(), 'svc-a.route'), 'utf8')
    expect(t.split('\n')[1]).toBe('# networks: main')
    expect(t).toContain('reverse_proxy svc-a-backend:8090')
    expect(r.calls.some((c) => / caddy reload /.test(c))).toBe(false)
  })

  it('remove-service drops the routes with the last network that served them', () => {
    expect(sh(['add-routes', 'svc-a', '/peer', '8090']).code).toBe(0)
    expect(sh(['add-routes', 'svc-a', '/peer', '8090'], {}, mainStack).code).toBe(0)
    expect(sh(['remove-service', 'svc-a'], {}, mainStack).code).toBe(0)
    const r = sh(['remove-service', 'svc-a'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('routes: removed for svc-a')
    expect(existsSync(join(routes(), 'svc-a.route'))).toBe(false)
    expect(r.calls.some((c) => / caddy reload /.test(c))).toBe(true)
    // The path is free again for another service.
    expect(sh(['add-routes', 'svc-b', '/peer', '9000']).code).toBe(0)
  })

  it('remove-service on a service with no routes says nothing about routes', () => {
    const r = sh(['remove-service', 'svc-a'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('routes:')
  })
})
