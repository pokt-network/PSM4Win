// Runs supplier.sh's import steps (operator-import, operator-adopt) against a scratch stack
// with stand-in docker, python3 and sudo. The stand-in docker records its arguments, the
// key it received through PSM_IMPORT_KEY, and anything on its standard input, and plays a
// keyring that answers `keys show operator` with FAKE_KEYRING_ADDR. What is checked: the
// key never appears in a command line, the stack keeps a key only when it is the
// operator's, and a stack with another operator is refused. Needs bash (Git for Windows).
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

const OP = 'pokt1' + 'a'.repeat(38)
const OTHER = 'pokt1' + 'b'.repeat(38)
// Not real keys: stand-ins the fake keyring never checks.
const HEX = 'c0ffee'.repeat(10) + 'c0de'
const PHRASE = Array.from({ length: 12 }, () => 'abandon').join(' ')

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case " $* " in *" -e PSM_IMPORT_KEY "*) printf '%s' "\${PSM_IMPORT_KEY:-}" > "$FAKE_ENV" ;; esac
case " $* " in *" -i "*) cat > "$FAKE_STDIN" ;; esac
case " $* " in *" keys show operator -a "*) [ -n "\${FAKE_KEYRING_ADDR:-}" ] && echo "$FAKE_KEYRING_ADDR" ;; esac
if [ "$1" = inspect ]; then [ -n "\${FAKE_INSPECT:-}" ] || exit 1; echo "$FAKE_INSPECT"; fi
exit 0
`
// stack_operator reads operator-key.json with python3 -c; keyaddr.py pick answers FAKE_PICK.
const FAKE_PYTHON = `#!/usr/bin/env bash
if [ "$1" = "-c" ]; then sed -n 's/.*"address": *"\\([^"]*\\)".*/\\1/p' "$3"; exit 0; fi
case "$1" in *keyaddr.py) cat >/dev/null; [ -n "\${FAKE_PICK:-}" ] && echo "$FAKE_PICK"; exit 0 ;; esac
cat >/dev/null
exit 0
`
const ENV =
  'PROJECT=pocket-supplier-beta\nNET=beta\nHEALTH_PORT=8081\nSTACK_LAYOUT=3\nRELAYMINER_IMAGE=example/relayminer:v0.1.0\nREDIS_IMAGE=redis:8.10.1-alpine\nPOCKETD_IMAGE=example/pocketd:0.1.35\n'

describe.skipIf(!BASH)('supplier.sh operator import', () => {
  let root = ''
  let stack = ''
  const file = (n: string): string => join(root, n)
  const read = (p: string): string => (existsSync(p) ? lf(readFileSync(p, 'utf8')) : '')

  const sh = (
    args: string[],
    opts: { stdin?: string; env?: Record<string, string> } = {}
  ): { code: number; out: string; calls: string[]; envKey: string; stdin: string } => {
    for (const n of ['docker.log', 'env.txt', 'stdin.txt']) writeFileSync(file(n), '')
    const r = spawnSync(BASH!, [join(stack, 'supplier.sh'), ...args], {
      encoding: 'utf8',
      input: opts.stdin ?? '',
      env: {
        ...process.env,
        PATH: join(root, 'bin') + delimiter + process.env.PATH,
        FAKE_LOG: fwd(file('docker.log')),
        FAKE_ENV: fwd(file('env.txt')),
        FAKE_STDIN: fwd(file('stdin.txt')),
        ...opts.env
      }
    })
    return {
      code: r.status ?? -1,
      out: lf(r.stdout + r.stderr),
      calls: read(file('docker.log')).split('\n').filter(Boolean),
      envKey: read(file('env.txt')),
      stdin: read(file('stdin.txt'))
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psm-import-'))
    stack = join(root, 'supplier-beta')
    mkdirSync(stack)
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 })
    writeFileSync(join(root, 'bin', 'python3'), FAKE_PYTHON, { mode: 0o755 })
    // Runs what it is given (so `sudo -n test -d` answers truthfully), except chown.
    writeFileSync(
      join(root, 'bin', 'sudo'),
      '#!/usr/bin/env bash\n[ "$1" = -n ] && shift\n[ "$1" = chown ] && exit 0\nexec "$@"\n',
      { mode: 0o755 }
    )
    writeFileSync(join(stack, 'stack.env'), ENV)
    writeFileSync(
      join(stack, 'supplier.sh'),
      lf(readFileSync(join(serverDir, 'supplier.sh'), 'utf8')),
      { mode: 0o755 }
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const keyJson = (): string => read(join(stack, 'operator-key.json'))
  const noKeyInArgs = (calls: string[]): void => {
    for (const c of calls) {
      expect(c).not.toContain(HEX)
      expect(c).not.toContain('abandon')
    }
  }

  it('imports a pasted hex key through the container environment, and records the operator', () => {
    const r = sh(['operator-import', OP, 'hex'], {
      stdin: HEX + '\n',
      env: { FAKE_KEYRING_ADDR: OP }
    })
    expect(r.out).toContain(`operator: ${OP}`)
    expect(r.code).toBe(0)
    expect(r.envKey).toBe(HEX)
    noKeyInArgs(r.calls)
    expect(keyJson()).toContain(`"address": "${OP}"`)
    expect(keyJson()).toContain('"imported": "pasted"')
  })

  it('imports a pasted recovery phrase through the container standard input', () => {
    const r = sh(['operator-import', OP, 'mnemonic'], {
      stdin: PHRASE + '\n',
      env: { FAKE_KEYRING_ADDR: OP }
    })
    expect(r.code).toBe(0)
    expect(r.stdin.trim()).toBe(PHRASE)
    expect(r.calls.some((c) => / -i .*keys add operator --recover/.test(c))).toBe(true)
    noKeyInArgs(r.calls)
  })

  it("keeps nothing when the key is not the operator's", () => {
    const r = sh(['operator-import', OP, 'hex'], {
      stdin: HEX + '\n',
      env: { FAKE_KEYRING_ADDR: OTHER }
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(
      `the key imported is ${OTHER}, not the operator ${OP}; nothing was kept`
    )
    expect(r.calls.some((c) => /keys delete operator/.test(c))).toBe(true)
    expect(keyJson()).toBe('')
  })

  it('refuses a stack that already has another operator, and leaves its own alone', () => {
    writeFileSync(join(stack, 'operator-key.json'), `{"address": "${OTHER}"}\n`)
    const r = sh(['operator-import', OP, 'hex'], { stdin: HEX + '\n' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`this stack already has the operator ${OTHER}`)
    expect(r.calls.some((c) => /import-hex|keys add/.test(c))).toBe(false)
    expect(keyJson()).toContain(OTHER)
  })

  it('does nothing when the operator is already in the stack', () => {
    writeFileSync(join(stack, 'operator-key.json'), `{"address": "${OP}"}\n`)
    const r = sh(['operator-import', OP, 'hex'], { stdin: HEX + '\n' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('the operator is already in this stack')
    expect(r.calls).toEqual([])
  })

  it('adopts the key from a keys file on the server without it reaching a command line', () => {
    const keys = join(root, 'their-keys.yaml')
    writeFileSync(keys, `keys:\n  - "${HEX}"\n`)
    const r = sh(['operator-adopt', 'keysfile', fwd(keys), OP], {
      env: { FAKE_PICK: HEX, FAKE_KEYRING_ADDR: OP }
    })
    expect(r.code).toBe(0)
    expect(r.envKey).toBe(HEX)
    noKeyInArgs(r.calls)
    expect(keyJson()).toContain('"imported": "keysfile"')
  })

  it('says so when the keys file holds no key for the operator', () => {
    const keys = join(root, 'their-keys.yaml')
    writeFileSync(keys, 'keys: []\n')
    const r = sh(['operator-adopt', 'keysfile', fwd(keys), OP])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`holds no key for ${OP}`)
    expect(r.calls.some((c) => /import-hex/.test(c))).toBe(false)
  })

  it('stops their RelayMiner container, and refuses anything that is not one', () => {
    const ok = sh(['theirs', 'stop', 'container', 'supplier-relayer-1'], {
      env: {
        FAKE_INSPECT: 'ghcr.io/pokt-network/pocket-relay-miner:v0.1.0  relayer --config /c.yaml'
      }
    })
    expect(ok.code).toBe(0)
    expect(ok.calls).toContain('stop supplier-relayer-1')
    const db = sh(['theirs', 'stop', 'container', 'postgres'], {
      env: { FAKE_INSPECT: 'postgres:16  postgres' }
    })
    expect(db.code).not.toBe(0)
    expect(db.out).toContain('is not a RelayMiner or a web proxy')
    expect(db.calls.some((c) => c.startsWith('stop'))).toBe(false)
    const own = sh(['theirs', 'stop', 'container', 'pocket-supplier-main-relayer'])
    expect(own.code).not.toBe(0)
    expect(own.out).toContain("one of the app's own containers")
    expect(own.calls).toEqual([])
    const disable = sh(['theirs', 'disable', 'container', 'caddy'], {
      env: { FAKE_INSPECT: 'caddy:2  caddy run' }
    })
    expect(disable.calls).toContain('update --restart=no caddy')
  })

  it('joins their backend to the shared network, never an app container', () => {
    const r = sh(['backend-attach', 'supplier-charts-1'], {
      env: { FAKE_INSPECT: 'supplier_default ' }
    })
    expect(r.code).toBe(0)
    expect(r.calls).toContain('network connect pocket-supplier supplier-charts-1')
    const already = sh(['backend-attach', 'supplier-charts-1'], {
      env: { FAKE_INSPECT: 'supplier_default pocket-supplier ' }
    })
    expect(already.out).toContain('already on pocket-supplier')
    expect(already.calls.some((c) => c.startsWith('network connect'))).toBe(false)
    const own = sh(['backend-attach', 'pocket-caddy'])
    expect(own.code).not.toBe(0)
    expect(own.calls).toEqual([])
  })

  it('points to pasting when the keyring has a passphrase (no test keyring)', () => {
    mkdirSync(join(root, 'their-home', 'keyring-file'), { recursive: true })
    const r = sh(['operator-adopt', 'keyring', fwd(join(root, 'their-home')), OP], {
      env: { PATH: join(root, 'bin') + delimiter + process.env.PATH }
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('paste the operator key into the app instead')
  })
})
