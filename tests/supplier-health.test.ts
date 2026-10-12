// supplier.sh health and restart-miner (Performance), run against a scratch stack with a
// stand-in `docker` that answers inspect and logs the way the real one does.
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
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { parseHealth } from '@core/performance'

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
const serverDir = join(process.cwd(), 'resources', 'server')
const SID = 'ab'.repeat(32)

// The miner's own log lines, as RelayMiner v0.1.x writes them.
const LOG = [
  '2026/10/12 10:54:12 maxprocs: Honoring GOMAXPROCS="2" as set in environment',
  JSON.stringify({
    level: 'info',
    component: 'cache_orchestrator',
    height: 961407,
    time: '2026-10-12T10:55:01Z',
    replica: 'leader',
    message: 'refreshed all caches (leader)'
  }),
  JSON.stringify({
    level: 'info',
    component: 'smst_snapshot_manager',
    session_id: SID,
    service: 'meadow',
    start_height: 961401,
    end_height: 961420,
    time: '2026-10-12T10:56:00Z',
    replica: 'leader',
    message: 'session created on first relay'
  }),
  JSON.stringify({
    level: 'info',
    component: 'session_lifecycle',
    current_height: 961410,
    time: '2026-10-12T10:58:00Z',
    replica: 'leader',
    message: 'lifecycle_check: transition batch summary'
  })
].join('\n')

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  inspect)
    case "$3" in
      *RestartCount*) [ -n "\${FAKE_NO_MINER:-}" ] && exit 1; echo "\${FAKE_MINER_STATE:-running}|2026-10-12T10:54:11Z|0" ;;
      *State.Status*) echo running ;;
      *) [ -n "\${FAKE_NO_MINER:-}" ] && exit 1; echo '{}' ;;
    esac ;;
  logs) [ "$2" = --since ] && [ "$3" = 2m ] && { [ -n "\${FAKE_NO_LEAD:-}" ] || echo '{"message":"leader controller started - all resources active"}'; exit 0; }
        cat "$FAKE_MINER_LOG" ;;
  compose) echo " Container x-miner  Restarting" ;;
esac
exit 0
`

describe.skipIf(!BASH || !PYTHON)('supplier.sh health and restart-miner', () => {
  let root = ''
  let stack = ''
  let log = ''
  const sh = (
    args: string[],
    env: Record<string, string> = {}
  ): { code: number; out: string; calls: string[] } => {
    writeFileSync(log, '')
    const r = spawnSync(BASH!, [join(stack, 'supplier.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: join(root, 'bin') + delimiter + process.env.PATH,
        FAKE_LOG: fwd(log),
        FAKE_MINER_LOG: fwd(join(root, 'miner.log')),
        ...env
      }
    })
    return {
      code: r.status ?? -1,
      out: lf(r.stdout + r.stderr),
      calls: lf(readFileSync(log, 'utf8')).split('\n').filter(Boolean)
    }
  }
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync.native(tmpdir()), 'psm-health-'))
    stack = join(root, 'supplier-main')
    log = join(root, 'docker.log')
    mkdirSync(stack)
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 })
    writeFileSync(join(root, 'miner.log'), LOG + '\n')
    writeFileSync(
      join(stack, 'supplier.sh'),
      lf(readFileSync(join(serverDir, 'supplier.sh'), 'utf8')),
      { mode: 0o755 }
    )
    writeFileSync(
      join(stack, 'stack.env'),
      'PROJECT=pocket-supplier-main\nNET=main\nHEALTH_PORT=8082\nSTACK_LAYOUT=5\nRELAYMINER_IMAGE=example/relayminer:v0.1.2\nREDIS_IMAGE=redis:8.10.1-alpine\nPOCKETD_IMAGE=example/pocketd:0.1.35\n'
    )
    writeFileSync(join(stack, 'compose.env'), 'REDIS_MEM_LIMIT=100m\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("health reports the miner's state, its newest height, and the sessions it opened", () => {
    const r = sh(['health'])
    expect(r.code).toBe(0)
    expect(r.calls).toContain('logs --since 48h pocket-supplier-main-miner')
    const h = parseHealth(r.out)
    if (typeof h === 'string') throw new Error(h + '\n' + r.out)
    expect(h).toMatchObject({
      network: 'main',
      miner: { status: 'running', started: '2026-10-12T10:54:11Z', restarts: 0 },
      relayer: 'running',
      last_height: 961410,
      last_height_time: '2026-10-12T10:58:00Z',
      sessions: [{ id: SID, service: 'meadow', end: 961420 }]
    })
  })
  it('health says so when the miner is missing, and refuses a bad window', () => {
    const h = parseHealth(sh(['health'], { FAKE_NO_MINER: '1' }).out)
    expect(typeof h !== 'string' && h.miner.status).toBe('missing')
    expect(sh(['health', '12; rm -rf /']).out).toMatch(/bad hours/)
    expect(sh(['health', '6']).calls).toContain('logs --since 6h pocket-supplier-main-miner')
  })
  it('restart-miner restarts the miner alone and waits until it leads', () => {
    const r = sh(['restart-miner'])
    expect(r.code).toBe(0)
    expect(r.calls.some((c) => /^compose -p pocket-supplier-main .*restart miner$/.test(c))).toBe(
      true
    )
    expect(r.calls.some((c) => /restart (relayer|redis)/.test(c))).toBe(false)
    expect(r.out).toContain('miner: leading again')
    expect(r.out).toContain('restarted: pocket-supplier-main-miner')
  })
  it('restart-miner refuses when there is no miner', () => {
    const r = sh(['restart-miner'], { FAKE_NO_MINER: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/does not exist/)
  })
})
