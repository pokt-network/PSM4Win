// The SSH driver: an explicit server connection from a Settings entry. Nothing
// depends on ~/.ssh/config. Remote strings are built only from regex-validated
// values (SIGNER-CONTRACT.md section 6.3).
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fail } from '@core/errors'
import { RE } from '@core/validate'
import type { SshConn } from '@core/contract'
import { runNative, type NativeResult } from './native'
import type { OpContext } from './context'
import { toolPath } from '../paths'

export interface ResolvedSsh {
  ssh: string[]
  scp: string[]
  target: string
  keyPath: string
}

export function expandHome(p: string): string {
  if (/^~/.test(p)) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    return join(home, p.slice(1).replace(/^[\\/]+/, ''))
  }
  return p
}

export function resolveSsh(req: Partial<SshConn>): ResolvedSsh {
  const host = String(req.host ?? '')
  const user = String(req.user ?? '')
  let key = String(req.key_path ?? '')
  const portRaw =
    req.port === undefined || req.port === null || String(req.port) === '' ? 22 : Number(req.port)
  if (!RE.hostname.test(host)) fail('Server host must be a hostname or IP address.')
  if (!RE.sshUser.test(user)) fail('Server user is required.')
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535)
    fail('Server port must be 1 to 65535.')
  key = expandHome(key)
  if (!key || !existsSync(key))
    fail('The SSH key file for this server was not found on this PC.', key)
  const common = [
    '-i',
    key,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'StrictHostKeyChecking=accept-new'
  ]
  return {
    ssh: [...common, '-p', String(portRaw)],
    scp: [...common, '-P', String(portRaw)],
    target: `${user}@${host}`,
    keyPath: key
  }
}

export async function runSsh(
  conn: ResolvedSsh,
  remote: string,
  ctx: OpContext,
  timeoutMs?: number
): Promise<NativeResult> {
  return runNative(toolPath('ssh'), [...conn.ssh, conn.target, remote], {
    timeoutMs: timeoutMs ?? ctx.timeoutMs,
    signal: ctx.signal
  })
}

export async function runScp(
  conn: ResolvedSsh,
  args: string[],
  ctx: OpContext
): Promise<NativeResult> {
  return runNative(toolPath('scp'), [...conn.scp, '-q', ...args], {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal
  })
}
