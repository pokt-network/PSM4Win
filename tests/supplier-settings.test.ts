// Runs the shipped supplier.sh settings steps (settings-read, settings-write, settings-check,
// backend-restart) against a scratch service directory, with a stand-in `docker` on PATH
// that records its calls. The values file and the read-back are checked as the app will
// see them, and so is that a secret's value never reaches the output or a docker argument.
// Needs bash (Git for Windows on Windows) and python3; skipped where either is missing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'

const BASH =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(
        existsSync
      )
    : '/bin/bash'
const PYTHON =
  !!BASH &&
  spawnSync(BASH, ['-c', 'python3 -c "print(1)"'], { encoding: 'utf8' }).stdout.trim() === '1'
const lf = (s: string): string => s.replace(/\r\n/g, '\n')
const fwd = (p: string): string => p.replace(/\\/g, '/')
// The deploy root as bash takes it: an absolute POSIX path (Git Bash hands /c/... to python
// as C:/...).
const posix = (p: string): string =>
  fwd(p).replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
const serverDir = join(process.cwd(), 'resources', 'server')
const SECRET = 'https://discord.com/api/webhooks/1/s3cr3t-value'

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  inspect)
    case "$3" in
      *Config.Env*) [ -n "\${FAKE_ENV:-}" ] && echo "$FAKE_ENV" || exit 1 ;;
      *State.Running*) echo "\${FAKE_RUNNING:-true}" ;;
    esac ;;
  exec) echo "ran: \${@:3}"; exit "\${FAKE_CHECK_RC:-0}" ;;
  run) echo '{"ok":true}' ;;
esac
exit 0
`

const DECL = {
  settings: [
    {
      env: 'EXSVC_{NETWORK}_HOOK',
      scope: 'network',
      label: 'Hook',
      type: 'url',
      secret: true,
      hosts: ['discord.com']
    },
    {
      env: 'EXSVC_MODE',
      label: 'Mode',
      type: 'choice',
      choices: ['report', 'problems'],
      default: 'report'
    }
  ],
  check: {
    label: 'Test',
    command: ['sh', '/check.sh', '{network}'],
    scope: 'network',
    timeout_s: 20
  }
}

interface ReadBack {
  declared: unknown
  values: Record<string, { set: boolean; value?: string; applied?: boolean; declared?: boolean }>
  container: boolean
  served: { network: string; port: number }[]
}

describe.skipIf(!BASH || !PYTHON)('supplier.sh service settings', () => {
  let root = ''
  let stack = ''
  let services = ''
  let svc = ''
  let log = ''
  const sh = (
    args: string[],
    opts: { env?: Record<string, string>; input?: string } = {}
  ): { code: number; out: string; calls: string[] } => {
    writeFileSync(log, '')
    const r = spawnSync(BASH!, [join(stack, 'supplier.sh'), ...args], {
      encoding: 'utf8',
      input: opts.input,
      env: {
        ...process.env,
        PATH: join(root, 'bin') + delimiter + process.env.PATH,
        FAKE_LOG: fwd(log),
        ...opts.env
      }
    })
    return {
      code: r.status ?? -1,
      out: lf(r.stdout + r.stderr),
      calls: lf(readFileSync(log, 'utf8')).split('\n').filter(Boolean)
    }
  }
  const read = (env: Record<string, string> = {}): ReadBack => {
    const r = sh(['settings-read', 'exsvc', posix(services)], { env })
    expect(r.code).toBe(0)
    const line = r.out.split('\n').find((l) => l.startsWith('settings: '))
    return JSON.parse(line!.slice('settings: '.length)) as ReadBack
  }
  const write = (patch: unknown): ReturnType<typeof sh> =>
    sh(['settings-write', 'exsvc', posix(services)], { input: JSON.stringify(patch) + '\n' })
  const envFile = (): string => lf(readFileSync(join(svc, 'settings.env'), 'utf8'))
  const makeStack = (dir: string, net: string, port: number): void => {
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'supplier.sh'),
      lf(readFileSync(join(serverDir, 'supplier.sh'), 'utf8')),
      { mode: 0o755 }
    )
    writeFileSync(join(dir, 'stack.env'), `PROJECT=pocket-supplier-${net}\nNET=${net}\n`)
    writeFileSync(
      join(dir, 'relayer-config.yaml'),
      `services:\n  exsvc:\n    backends:\n      rest:\n        url: "http://exsvc-backend:${port}"\n`
    )
  }

  beforeEach(() => {
    // The long name: a CI runner's temp folder is C:\Users\RUNNER~1\..., and supplier.sh rightly
    // refuses a deploy root with a ~ in it.
    root = mkdtempSync(join(realpathSync.native(tmpdir()), 'psm-settings-'))
    stack = join(root, 'stacks', 'supplier-beta')
    services = join(root, 'services')
    svc = join(services, 'exsvc')
    log = join(root, 'docker.log')
    mkdirSync(join(root, 'stacks'))
    mkdirSync(join(svc, 'deploy'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 })
    makeStack(stack, 'beta', 8081)
    makeStack(join(root, 'stacks', 'supplier-main'), 'main', 8080)
    writeFileSync(join(svc, 'deploy', 'settings.json'), JSON.stringify(DECL))
    writeFileSync(join(svc, 'deploy', 'docker-compose.yaml'), 'services: {}\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads the declaration, every declared name, and the networks this backend serves', () => {
    const r = read({ FAKE_ENV: '["PATH=/bin"]' })
    expect(r.declared).toEqual(DECL)
    expect(r.container).toBe(true)
    expect(r.values).toEqual({
      EXSVC_BETA_HOOK: { set: false, applied: true },
      EXSVC_MAIN_HOOK: { set: false, applied: true },
      EXSVC_MODE: { set: false, applied: true }
    })
    expect(r.served).toEqual([
      { network: 'beta', port: 8081 },
      { network: 'main', port: 8080 }
    ])
  })

  it('writes values as single-quoted lines and never prints a secret', () => {
    const w = write({ set: { EXSVC_BETA_HOOK: SECRET, EXSVC_MODE: 'problems' }, clear: [] })
    expect(w.code).toBe(0)
    expect(w.out).toContain('saved: set EXSVC_BETA_HOOK')
    expect(w.out).toContain('saved: set EXSVC_MODE')
    expect(w.out).not.toContain('s3cr3t')
    expect(envFile()).toBe(
      "# This service's settings, written by the Pocket Service Manager (Services, Settings).\n" +
        `EXSVC_BETA_HOOK='${SECRET}'\nEXSVC_MODE='problems'\n`
    )
    if (process.platform !== 'win32') {
      expect(statSync(join(svc, 'settings.env')).mode & 0o777).toBe(0o600)
    }
  })

  it('reads a secret back as set only, and tells what the container was created with', () => {
    write({ set: { EXSVC_BETA_HOOK: SECRET, EXSVC_MODE: 'problems' } })
    const before = sh(['settings-read', 'exsvc', posix(services)], {
      env: { FAKE_ENV: '["EXSVC_MODE=report"]' }
    })
    expect(before.out).not.toContain('s3cr3t')
    expect(before.calls.join('\n')).not.toContain('s3cr3t')
    const r = JSON.parse(before.out.trim().split('\n').pop()!.slice(10)) as ReadBack
    expect(r.values.EXSVC_BETA_HOOK).toEqual({ set: true, applied: false })
    expect(r.values.EXSVC_MODE).toEqual({ set: true, value: 'problems', applied: false })
    const after = read({
      FAKE_ENV: JSON.stringify([`EXSVC_BETA_HOOK=${SECRET}`, 'EXSVC_MODE=problems'])
    })
    expect(after.values.EXSVC_BETA_HOOK).toEqual({ set: true, applied: true })
    expect(after.values.EXSVC_MODE.applied).toBe(true)
  })

  it('without a container, says so and leaves out applied', () => {
    const r = read()
    expect(r.container).toBe(false)
    expect(r.values.EXSVC_MODE).toEqual({ set: false })
  })

  it('keeps what it is not told to change, clears what it is, and hides undeclared names', () => {
    write({ set: { EXSVC_BETA_HOOK: SECRET, EXSVC_MODE: 'problems' } })
    writeFileSync(join(svc, 'settings.env'), envFile() + "OLD_TOKEN='left-over'\n")
    expect(write({ set: { EXSVC_MODE: 'report' } }).code).toBe(0)
    expect(envFile()).toContain(`EXSVC_BETA_HOOK='${SECRET}'`)
    expect(envFile()).toContain("EXSVC_MODE='report'")
    const c = write({ set: {}, clear: ['EXSVC_BETA_HOOK'] })
    expect(c.out).toContain('saved: cleared EXSVC_BETA_HOOK')
    expect(envFile()).not.toContain('EXSVC_BETA_HOOK')
    const r = read()
    expect(r.values.OLD_TOKEN).toEqual({ set: true, declared: false })
  })

  it('refuses undeclared names, values the file cannot hold, and bad arguments', () => {
    const a = write({ set: { PATH: '/x' } })
    expect(a.code).toBe(1)
    expect(a.out).toMatch(/^error: PATH is not declared/m)
    const b = write({ set: { EXSVC_MODE: "it's s3cr3t" } })
    expect(b.code).toBe(1)
    expect(b.out).toMatch(/cannot be written/)
    expect(b.out).not.toContain('s3cr3t')
    expect(existsSync(join(svc, 'settings.env'))).toBe(false)
    expect(sh(['settings-write', 'exsvc', posix(services)], { input: 'nope\n' }).out).toMatch(
      /could not be read/
    )
    expect(sh(['settings-read', 'bad id', posix(services)]).code).toBe(2)
    expect(sh(['settings-read', 'exsvc', 'relative']).code).toBe(2)
    expect(sh(['settings-read', 'nosuch', posix(services)]).out).toMatch(/not deployed/)
    rmSync(join(svc, 'deploy', 'settings.json'))
    expect(write({ set: { EXSVC_MODE: 'report' } }).out).toMatch(/deploy it again first/)
  })

  it('runs the declared check in the container with the network filled in', () => {
    const ok = sh(['settings-check', 'exsvc', posix(services), 'beta'])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('check: passed')
    expect(ok.out).toContain('output: ran: sh /check.sh beta')
    expect(ok.calls).toContain('exec exsvc-backend sh /check.sh beta')
    const bad = sh(['settings-check', 'exsvc', posix(services), 'main'], {
      env: { FAKE_CHECK_RC: '3' }
    })
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('check: failed (exit 3)')
    expect(sh(['settings-check', 'exsvc', posix(services)]).out).toMatch(/which network/)
    expect(
      sh(['settings-check', 'exsvc', posix(services), 'beta'], {
        env: { FAKE_RUNNING: 'false' }
      }).out
    ).toMatch(/is not running/)
    writeFileSync(join(svc, 'deploy', 'settings.json'), JSON.stringify({ settings: DECL.settings }))
    expect(sh(['settings-check', 'exsvc', posix(services), 'beta']).out).toMatch(
      /declares no check/
    )
  })

  it('backend-restart recreates only the backend and waits on every relay port', () => {
    const r = sh(['backend-restart', 'exsvc', posix(services), '/healthz', '8080', '8081'])
    expect(r.code).toBe(0)
    expect(r.calls).toContain('compose -p exsvc up -d --no-build --force-recreate')
    expect(r.out).toContain('backend: healthy at http://exsvc-backend:8080/healthz')
    expect(r.out).toContain('backend: healthy at http://exsvc-backend:8081/healthz')
    expect(r.out).toContain('restarted: exsvc-backend')
    // The values file is made if it is missing, so env_file never fails.
    expect(existsSync(join(svc, 'settings.env'))).toBe(true)
    expect(sh(['backend-restart', 'exsvc', posix(services), '/healthz', '80']).out).toMatch(
      /bad backend port/
    )
  })

  it('deploy makes an empty values file and keeps an existing one', () => {
    const d = (): ReturnType<typeof sh> =>
      sh(['deploy', 'exsvc', posix(services), '/healthz', '8081'])
    expect(d().code).toBe(0)
    expect(readFileSync(join(svc, 'settings.env'), 'utf8')).toBe('')
    write({ set: { EXSVC_MODE: 'problems' } })
    expect(d().code).toBe(0)
    expect(envFile()).toContain("EXSVC_MODE='problems'")
  })
})
