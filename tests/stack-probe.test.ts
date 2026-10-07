// ssh-test's read-only look at a stack directory, so a PC can adopt a stack another PC
// provisioned: the shell lines run for real with bash against a scratch directory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStackProbe, stackProbeCommand } from '@core/stack'

const BASH =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(
        existsSync
      )
    : '/bin/bash'
const OP = 'pokt1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y'
const posix = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)

describe('parseStackProbe', () => {
  it('reads what the stack declares', () => {
    expect(
      parseStackProbe(
        `psm-lab\nPSM_KEYRING_OK\nPSM_STACK_ENV PROJECT=pocket-supplier-main NET=main HOSTNAME_PUBLIC=services.example.org STACK_LAYOUT=3 \nPSM_STACK_OP ${OP}\n`
      )
    ).toEqual({
      operator: OP,
      project: 'pocket-supplier-main',
      network: 'main',
      hostname: 'services.example.org',
      layout: 3
    })
  })
  it('is null without a stack, and blanks what does not fit its pattern', () => {
    expect(parseStackProbe('psm-lab\n')).toBeNull()
    expect(
      parseStackProbe(
        'PSM_STACK_ENV PROJECT=Bad_Name NET=mars HOSTNAME_PUBLIC=a;b\nPSM_STACK_OP \n'
      )
    ).toEqual({ operator: '', project: '', network: '', hostname: '', layout: 1 })
  })
})

describe.skipIf(!BASH)('stackProbeCommand', () => {
  let dir = ''
  beforeEach(() => {
    dir = join(mkdtempSync(join(realpathSync.native(tmpdir()), 'psm-probe-')), 'supplier-main')
    mkdirSync(dir)
  })
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))
  const run = (): string =>
    spawnSync(BASH!, ['-c', 'true;' + stackProbeCommand(posix(dir)) + '; true'], {
      encoding: 'utf8'
    }).stdout

  it('reports nothing for an empty directory', () => {
    expect(parseStackProbe(run())).toBeNull()
  })
  it("reads an app stack's stack.env and operator", () => {
    writeFileSync(join(dir, 'supplier.sh'), '#!/bin/bash\n')
    writeFileSync(
      join(dir, 'stack.env'),
      '# written by the app\nPROJECT=pocket-supplier-main\nNET=main\nHEALTH_PORT=8082\nCADDY_DIR=/opt/pocket/caddy\nHOSTNAME_PUBLIC=services.example.org\nSTACK_LAYOUT=3\nRELAYMINER_IMAGE=x\n'
    )
    writeFileSync(
      join(dir, 'operator-key.json'),
      `{"name":"operator","address":"${OP}","pubkey":"x"}\n`
    )
    expect(parseStackProbe(run())).toEqual({
      operator: OP,
      project: 'pocket-supplier-main',
      network: 'main',
      hostname: 'services.example.org',
      layout: 3
    })
  })
  it('still finds the stack when the operator key file is missing', () => {
    writeFileSync(join(dir, 'supplier.sh'), '')
    writeFileSync(join(dir, 'stack.env'), 'PROJECT=pocket-supplier-main\nNET=main\n')
    expect(parseStackProbe(run())?.operator).toBe('')
  })
})
