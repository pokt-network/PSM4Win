// Runs the shipped supplier.sh deploy, add-service, and add-routes against scratch stack
// directories with stand-in `docker` and `curl` on PATH, for the per-network relay port
// (deploy/relayer.json): the health check follows the port, a redeploy that changes the port
// replaces the relayer entry, and no route may reach a port a relayer calls. add-service edits
// the relayer config with the real python3, so these need bash and python3; skipped otherwise.
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
const HAS_PYTHON =
  !!BASH &&
  spawnSync(BASH, ['-c', 'python3 -c "print(1)"'], { encoding: 'utf8' }).stdout.trim() === '1'
const lf = (s: string): string => s.replace(/\r\n/g, '\n')
const fwd = (p: string): string => p.replace(/\\/g, '/')
const serverDir = join(process.cwd(), 'resources', 'server')

// The backend answers its health path only on FAKE_BACKEND_PORT.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [ "$1" = ps ]; then echo pocket-caddy; exit 0; fi
if [ "$1" = run ] && [[ " $* " == *" wget "* ]]; then
  case "$*" in *"-backend:\${FAKE_BACKEND_PORT:-8080}/"*) echo '{"status":"ok"}'; exit 0 ;; esac
  exit 1
fi
if [ "$1" = exec ] && [ "$3" = caddy ] && [ "$4" = validate ]; then echo 'Valid configuration'; exit 0; fi
if [ "$1" = exec ] && [ "$3" = wget ]; then echo '  HTTP/1.1 404 Not Found'; exit 1; fi
exit 0
`
const FAKE_CURL = `#!/usr/bin/env bash
exit 0
`

const entry = (id: string, url: string, hp = '/healthz'): string =>
  `  ${id}:\n    timeout_profile: fast\n    max_body_size_bytes: 20971520\n    default_backend: rest\n    backends:\n      rest:\n        url: "${url}"\n        health_check:\n          endpoint: "${hp}"\n          interval_seconds: 10\n          timeout_seconds: 5\n`

describe.skipIf(!BASH || !HAS_PYTHON)('supplier.sh per-network relay port', () => {
  let root = ''
  let beta = ''
  let main = ''
  let caddy = ''
  let log = ''
  const cfg = (dir: string): string => join(dir, 'relayer-config.yaml')
  const sh = (
    dir: string,
    args: string[],
    env: Record<string, string> = {}
  ): { code: number; out: string; calls: string[] } => {
    writeFileSync(log, '')
    // Git Bash puts /mingw64/bin (with the real curl) ahead of an inherited PATH, so the
    // stand-ins go first from inside bash. Health paths are kept from its Windows path
    // conversion, which would otherwise hand the Windows python3 C:/Program Files/Git/healthz.
    const script = fwd(join(dir, 'supplier.sh'))
    const r = spawnSync(
      BASH!,
      [
        '-c',
        'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || echo "$FAKE_BIN"):$PATH" exec bash "$0" "$@"',
        script,
        ...args
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: join(root, 'bin') + delimiter + process.env.PATH,
          FAKE_BIN: fwd(join(root, 'bin')),
          MSYS2_ARG_CONV_EXCL: '/healthz;/ready',
          FAKE_LOG: fwd(log),
          // A server with 8 GB and 4 CPUs, so the stack's memory sizing passes.
          PSM_MEMINFO: fwd(join(root, 'meminfo')),
          PSM_NPROC: '4',
          ...env
        }
      }
    )
    return {
      code: r.status ?? -1,
      out: lf(r.stdout + r.stderr),
      calls: lf(readFileSync(log, 'utf8')).split('\n').filter(Boolean)
    }
  }
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
      `PROJECT=pocket-supplier-${net}\nNET=${net}\nHEALTH_PORT=8081\nCADDY_DIR=${fwd(caddy)}\nHOSTNAME_PUBLIC=services-${net}.example.org\n` +
        'STACK_LAYOUT=2\nRELAYMINER_IMAGE=example/relayminer:v0.1.0\nREDIS_IMAGE=redis:8.10.1-alpine\nPOCKETD_IMAGE=example/pocketd:0.1.35\n'
    )
    writeFileSync(cfg(dir), lf(readFileSync(join(serverDir, 'relayer-config.yaml.tmpl'), 'utf8')))
    writeFileSync(
      join(caddy, 'sites', `${net}.caddy`),
      lf(readFileSync(join(serverDir, 'site.caddy.tmpl'), 'utf8'))
    )
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psm-relayer-'))
    beta = join(root, 'supplier-beta')
    main = join(root, 'supplier-main')
    caddy = join(root, 'caddy')
    log = join(root, 'docker.log')
    mkdirSync(join(caddy, 'sites', 'routes'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 })
    writeFileSync(join(root, 'bin', 'curl'), FAKE_CURL, { mode: 0o755 })
    writeFileSync(join(root, 'meminfo'), 'MemTotal:        8388608 kB\n')
    makeStack(beta, 'beta')
    makeStack(main, 'main')
    mkdirSync(join(root, 'services', 'svc-a', 'deploy'), { recursive: true })
    writeFileSync(
      join(root, 'services', 'svc-a', 'deploy', 'docker-compose.yaml'),
      'services: {}\n'
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('deploy checks health on the port it is given', () => {
    const r = sh(beta, ['deploy', 'svc-a', fwd(join(root, 'services')), '/healthz', '8081'], {
      FAKE_BACKEND_PORT: '8081'
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('backend: healthy at http://svc-a-backend:8081/healthz')
    expect(r.calls.some((c) => c.includes('http://svc-a-backend:8081/healthz'))).toBe(true)
    expect(r.calls.some((c) => c.includes('svc-a-backend:8080'))).toBe(false)
  })

  it('deploy without a port keeps checking 8080, as the HTA calls it', () => {
    const r = sh(beta, ['deploy', 'svc-a', fwd(join(root, 'services')), '/healthz'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('backend: healthy at http://svc-a-backend:8080/healthz')
  })

  it.each(['80', '65536', '8081;id', 'x'])('deploy refuses the port %j', (p) => {
    const r = sh(beta, ['deploy', 'svc-a', fwd(join(root, 'services')), '/healthz', p])
    expect(r.code).toBe(2)
    expect(r.out).toContain('error: bad backend port')
    expect(r.calls.some((c) => c.includes('wget'))).toBe(false)
  })

  it('add-service adds, keeps an identical entry, and updates one whose URL changed', () => {
    const other = entry('svc-b', 'http://svc-b-backend:8080')
    writeFileSync(
      cfg(beta),
      lf(readFileSync(cfg(beta), 'utf8')).replace('services: {}\n', `services:\n${other}`)
    )
    const add = sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8080', '/healthz'])
    expect(add.code).toBe(0)
    expect(add.out).toContain('relayer: added svc-a')
    const same = sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8080', '/healthz'])
    expect(same.out).toContain('relayer: already lists svc-a at http://svc-a-backend:8080')
    const upd = sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8081', '/healthz'])
    expect(upd.code).toBe(0)
    expect(upd.out).toContain(
      'relayer: updated svc-a to http://svc-a-backend:8081 /healthz (was http://svc-a-backend:8080 /healthz)'
    )
    expect(upd.calls.some((c) => /compose .*up -d --force-recreate relayer/.test(c))).toBe(true)
    const t = lf(readFileSync(cfg(beta), 'utf8'))
    // One entry for the service, with the new URL, and the neighbour and the rest untouched.
    expect(t.match(/^ {2}svc-a:/gm)).toHaveLength(1)
    expect(t).toContain(`services:\n${entry('svc-a', 'http://svc-a-backend:8081')}${other}`)
    expect(t).toContain('default_request_timeout_seconds: 30')
    expect(t).not.toContain('svc-a-backend:8080')
    // A changed health path is also brought up to date.
    const hp = sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8081', '/ready'])
    expect(hp.out).toContain('relayer: updated svc-a')
    expect(lf(readFileSync(cfg(beta), 'utf8'))).toContain('endpoint: "/ready"')
  })

  it('add-service changes only the URL and health path lines, keeping hand edits', () => {
    // An entry someone tuned by hand on the server: its other settings must survive.
    const tuned = entry('svc-a', 'http://svc-a-backend:8080')
      .replace('timeout_profile: fast', 'timeout_profile: streaming')
      .replace('max_body_size_bytes: 20971520', 'max_body_size_bytes: 52428800')
      .replace('interval_seconds: 10', 'interval_seconds: 30')
    const other = entry('svc-b', 'http://svc-b-backend:8080')
    writeFileSync(
      cfg(beta),
      lf(readFileSync(cfg(beta), 'utf8')).replace('services: {}\n', `services:\n${tuned}${other}`)
    )
    const r = sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8081', '/ready'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      'relayer: updated svc-a to http://svc-a-backend:8081 /ready (was http://svc-a-backend:8080 /healthz)'
    )
    const want = tuned
      .replace('url: "http://svc-a-backend:8080"', 'url: "http://svc-a-backend:8081"')
      .replace('endpoint: "/healthz"', 'endpoint: "/ready"')
    expect(lf(readFileSync(cfg(beta), 'utf8'))).toContain(`services:\n${want}${other}`)
  })

  it('add-service replaces a broken entry whole', () => {
    const broken = '  svc-a:\n    timeout_profile: fast\n    backends:\n      rest: {}\n'
    writeFileSync(
      cfg(beta),
      lf(readFileSync(cfg(beta), 'utf8')).replace('services: {}\n', `services:\n${broken}`)
    )
    const r = sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8081', '/healthz'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      'relayer: replaced svc-a to http://svc-a-backend:8081 /healthz (was ? ?)'
    )
    expect(lf(readFileSync(cfg(beta), 'utf8'))).toContain(
      `services:\n${entry('svc-a', 'http://svc-a-backend:8081')}`
    )
  })

  it('add-routes refuses a port a relayer on this server calls the backend on', () => {
    expect(sh(beta, ['add-service', 'svc-a', 'http://svc-a-backend:8081', '/healthz']).code).toBe(0)
    expect(sh(main, ['add-service', 'svc-a', 'http://svc-a-backend:8080', '/healthz']).code).toBe(0)
    // From either stack: the Beta relayer's port is closed to routes.
    for (const dir of [main, beta]) {
      const r = sh(dir, ['add-routes', 'svc-a', '/peer', '8090', '/peer-beta', '8081'])
      expect(r.code).toBe(1)
      expect(r.out).toContain(
        'error: port 8081 is where a relayer on this server calls svc-a-backend'
      )
      expect(existsSync(join(caddy, 'sites', 'routes', 'svc-a.route'))).toBe(false)
    }
    // Other ports are fine, and another service's relay port does not block this one.
    expect(sh(beta, ['add-service', 'svc-b', 'http://svc-b-backend:8092', '/healthz']).code).toBe(0)
    const ok = sh(main, ['add-routes', 'svc-a', '/peer', '8090', '/peer-beta', '8092'])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('route: /peer-beta/ -> svc-a-backend:8092')
  })
})
