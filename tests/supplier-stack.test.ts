// Runs the shipped supplier.sh stack steps (start, add-service, prepare, status) against
// a scratch stack with stand-in docker, curl, sudo and python3 that record their calls:
// memory sizing from the server, the pinned images, and that nothing restarts unless
// the pinned RelayMiner accepts both configs. Needs bash (Git for Windows on Windows).
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
if [ "$1" = ps ]; then echo pocket-caddy; exit 0; fi
case " $* " in
  *" validate "*)
    for w in \${FAKE_VALIDATE_FAIL:-}; do
      case " $* " in *" $w validate "*) echo "Error: config is INVALID: 1 key(s) this $w does not understand"; exit 1 ;; esac
    done
    exit 0 ;;
  *" pull "*) [ -n "\${FAKE_PULL_FAIL:-}" ] && { echo "pull access denied"; exit 1; }; exit 0 ;;
esac
exit 0
`
// Lists no services (so the relayer is not started or checked) and edits nothing.
const FAKE_PYTHON = `#!/usr/bin/env bash
cat >/dev/null
exit 0
`
const PINS =
  'STACK_LAYOUT=2\nRELAYMINER_IMAGE=example/relayminer:v0.1.0\nREDIS_IMAGE=redis:8.10.1-alpine\nPOCKETD_IMAGE=example/pocketd:0.1.35\n'

describe.skipIf(!BASH)('supplier.sh stack steps', () => {
  let root = ''
  let stack = ''
  let log = ''
  const mem = (mb: number): void =>
    writeFileSync(join(root, 'meminfo'), `MemTotal:       ${mb * 1024} kB\nMemFree: 1 kB\n`)
  const env = (pins = true): void =>
    writeFileSync(
      join(stack, 'stack.env'),
      `PROJECT=pocket-supplier-beta\nNET=beta\nHEALTH_PORT=8081\nCADDY_DIR=${fwd(join(root, 'caddy'))}\nHOSTNAME_PUBLIC=services-beta.example.org\n` +
        (pins ? PINS : '')
    )
  const sh = (
    args: string[],
    extra: Record<string, string> = {}
  ): { code: number; out: string; calls: string[] } => {
    writeFileSync(log, '')
    const r = spawnSync(BASH!, [join(stack, 'supplier.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: join(root, 'bin') + delimiter + process.env.PATH,
        FAKE_LOG: fwd(log),
        PSM_MEMINFO: fwd(join(root, 'meminfo')),
        PSM_NPROC: '4',
        ...extra
      }
    })
    return {
      code: r.status ?? -1,
      out: lf(r.stdout + r.stderr),
      calls: lf(readFileSync(log, 'utf8')).split('\n').filter(Boolean)
    }
  }
  const idx = (calls: string[], re: RegExp): number => calls.findIndex((c) => re.test(c))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psm-stack-'))
    stack = join(root, 'supplier-beta')
    log = join(root, 'docker.log')
    mkdirSync(stack)
    mkdirSync(join(root, 'caddy', 'sites'), { recursive: true })
    writeFileSync(join(root, 'caddy', 'docker-compose.yaml'), 'name: pocket-caddy\n')
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 })
    writeFileSync(join(root, 'bin', 'python3'), FAKE_PYTHON, { mode: 0o755 })
    writeFileSync(join(root, 'bin', 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(root, 'bin', 'sudo'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    writeFileSync(
      join(stack, 'supplier.sh'),
      lf(readFileSync(join(serverDir, 'supplier.sh'), 'utf8')),
      { mode: 0o755 }
    )
    writeFileSync(
      join(stack, 'relayer-config.yaml'),
      'listen_addr: "0.0.0.0:8080"\n\npocket_node:\n  chain_id: "pocket-lego-testnet"\n  query_node_rpc_url: "https://rpc"\n  grpc_insecure: false\n\nservices: {}\n'
    )
    writeFileSync(
      join(stack, 'miner-config.yaml'),
      'pocket_node:\n  chain_id: "pocket-lego-testnet"\n'
    )
    env()
    mem(8192)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('sizes the stack from the server: a quarter kept back, the rest split by two networks, 40/40/20', () => {
    const r = sh(['start'])
    expect(r.code).toBe(0)
    // 8192 MB: 2048 kept, 3072 per stack; redis 1228 (maxmemory 982), miner 1228, relayer 614.
    expect(r.out).toContain(
      'resources: 8192 MB and 4 CPUs on this server; this stack gets redis 1228 MB (maxmemory 982 MB), miner 1228 MB, relayer 614 MB'
    )
    const ce = lf(readFileSync(join(stack, 'compose.env'), 'utf8'))
    expect(ce).toContain('RELAYMINER_IMAGE=example/relayminer:v0.1.0\n')
    expect(ce).toContain('REDIS_IMAGE=redis:8.10.1-alpine\n')
    expect(ce).toContain(
      'REDIS_MEM_LIMIT=1228m\nREDIS_MAXMEMORY=982mb\nMINER_MEM_LIMIT=1228m\nMINER_GOMEMLIMIT=1105MiB\nRELAYER_MEM_LIMIT=614m\nRELAYER_GOMEMLIMIT=552MiB\nGOMAXPROCS=2\n'
    )
    expect(r.out).toContain(
      'versions: relayminer v0.1.0, redis 8.10.1-alpine, pocketd 0.1.35, layout 2'
    )
  })

  it('keeps at least 1 GiB back on a small server and refuses one too small for two stacks', () => {
    mem(4096)
    expect(sh(['start']).out).toContain('this stack gets redis 614 MB')
    mem(2048)
    const r = sh(['start'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: this server has 2048 MB of memory')
    expect(r.out).toContain('the server needs at least 3072 MB')
    expect(r.calls.some((c) => / pull | up /.test(c))).toBe(false)
  })

  it('downloads, then validates with the pinned image, then starts, always with compose.env', () => {
    const r = sh(['start'])
    const pull = idx(r.calls, /compose .* pull/)
    const val = idx(r.calls, /example\/relayminer:v0\.1\.0 miner validate/)
    const up = idx(r.calls, /-p pocket-supplier-beta .* up -d/)
    expect(pull).toBeGreaterThanOrEqual(0)
    expect(val).toBeGreaterThan(pull)
    expect(up).toBeGreaterThan(val)
    for (const c of r.calls.filter((c) => c.startsWith('compose -p pocket-supplier-beta')))
      expect(c).toContain('--env-file')
    expect(r.calls[up]).toMatch(/up -d --remove-orphans redis miner$/)
  })

  it('restarts nothing when the pinned RelayMiner rejects a config', () => {
    const r = sh(['start'], { FAKE_VALIDATE_FAIL: 'miner' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the miner config does not pass the check of RelayMiner v0.1.0')
    expect(r.out).toContain('does not understand')
    expect(idx(r.calls, / up -d/)).toBe(-1)
  })

  it('restarts nothing when the images cannot be downloaded', () => {
    const r = sh(['start'], { FAKE_PULL_FAIL: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: could not download the stack')
    expect(idx(r.calls, / validate | up -d/)).toBe(-1)
  })

  it('asks for provisioning again when stack.env predates pinned versions', () => {
    env(false)
    const r = sh(['start'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('this stack predates pinned versions; provision it again')
    const s = sh(['status'])
    expect(s.out).toContain('versions: layout 1 (unpinned images)')
  })

  it('puts the relayer config back when the pinned RelayMiner rejects the edit', () => {
    const before = readFileSync(join(stack, 'relayer-config.yaml'), 'utf8')
    const r = sh(
      ['add-service', 'example-charts', 'http://example-charts-backend:8080', '/healthz'],
      {
        FAKE_VALIDATE_FAIL: 'miner'
      }
    )
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the relayer config was put back as it was')
    expect(readFileSync(join(stack, 'relayer-config.yaml'), 'utf8')).toBe(before)
    expect(existsSync(join(stack, 'relayer-config.yaml.before'))).toBe(false)
    expect(idx(r.calls, /force-recreate relayer/)).toBe(-1)
  })

  it('prepare drops the chain_id RelayMiner v0.1.0 no longer reads from the kept relayer config', () => {
    const r = sh(['prepare'])
    expect(r.code).toBe(0)
    const relayer = lf(readFileSync(join(stack, 'relayer-config.yaml'), 'utf8'))
    expect(relayer).not.toContain('chain_id')
    expect(relayer).toContain(
      'pocket_node:\n  query_node_rpc_url: "https://rpc"\n  grpc_insecure: false\n'
    )
    expect(readFileSync(join(stack, 'miner-config.yaml'), 'utf8')).toContain('chain_id')
  })

  it('status reports the pinned versions and the limits in force', () => {
    sh(['start'])
    const r = sh(['status'])
    expect(r.out).toContain('versions: relayminer v0.1.0, redis 8.10.1-alpine')
    expect(r.out).toMatch(
      /limits: REDIS_MEM_LIMIT=1228m MINER_MEM_LIMIT=1228m RELAYER_MEM_LIMIT=614m/
    )
  })
})
