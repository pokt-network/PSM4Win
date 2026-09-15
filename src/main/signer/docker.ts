// The Docker driver and the pocketd wrapper (SIGNER-CONTRACT.md sections 2.5 and 4).
// The passphrase travels in the docker CLI's environment (PSM_STDIN) and the
// container pipes it into pocketd with printf. Never docker's stdin from the host.
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { runNative, NativeStartError, type NativeResult } from './native'
import type { OpContext } from './context'
import {
  POCKETD_IMAGE,
  POCKET_AP_IMAGE,
  KEYRING_VOLUME,
  HOME_IN_BOX,
  DOCKER_DESKTOP_EXE
} from '@core/versions'
import { shQuote, firstLine } from '@core/text'
import { fail } from '@core/errors'
import { RE } from '@core/validate'
import type { DockerCheckResult } from '@core/contract'
import { log } from '../state/log'

export interface DockerOptions {
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (s: string) => void
  onStderr?: (s: string) => void
}

export async function docker(
  args: readonly string[],
  opts: DockerOptions = {}
): Promise<NativeResult> {
  return runNative('docker', args, opts)
}

function ctxOpts(ctx?: OpContext): DockerOptions {
  return ctx ? { timeoutMs: ctx.timeoutMs, signal: ctx.signal } : {}
}

export interface InBoxOptions {
  stdinText?: string
  mounts?: string[]
  envExtra?: Record<string, string>
  root?: boolean
  ctx?: OpContext
}

/** Runs a shell command line inside the pocketd image with the keyring volume mounted. */
export async function invokeInBox(shcmd: string, o: InBoxOptions = {}): Promise<NativeResult> {
  const d = ['run', '--rm', '-v', `${KEYRING_VOLUME}:${HOME_IN_BOX}`]
  if (o.root) d.push('--user', 'root')
  for (const m of o.mounts ?? []) d.push('-v', m)
  const env: Record<string, string> = { ...(o.envExtra ?? {}) }
  let cmd = shcmd
  if (o.stdinText) {
    env.PSM_STDIN = o.stdinText
    cmd = 'printf "%s" "$PSM_STDIN" | ' + shcmd
  }
  for (const k of Object.keys(env)) d.push('-e', k)
  d.push('--entrypoint', 'sh', POCKETD_IMAGE, '-c', cmd)
  return docker(d, { ...ctxOpts(o.ctx), env })
}

export interface PocketdOptions {
  pass?: string
  mounts?: string[]
  envExtra?: Record<string, string>
  root?: boolean
  /** Lines fed before the passphrase: "y\n" for --unsafe, "<phrase>\n" for --recover. */
  prefixLines?: string
  ctx?: OpContext
}

/** One pocketd command. The passphrase is fed twice (fresh keyring asks for a confirmation). */
export async function pocketd(
  argv: readonly string[],
  o: PocketdOptions = {}
): Promise<NativeResult> {
  const shcmd = 'pocketd ' + argv.map(shQuote).join(' ')
  let stdin: string | undefined
  if (o.pass) stdin = `${o.prefixLines ?? ''}${o.pass}\n${o.pass}\n`
  else if (o.prefixLines) stdin = o.prefixLines
  return invokeInBox(shcmd, {
    stdinText: stdin,
    mounts: o.mounts,
    envExtra: o.envExtra,
    root: o.root,
    ctx: o.ctx
  })
}

// ---- docker-check ----

let cachedPocketdVersion: { imageId: string; version: string } | null = null

export async function dockerCheck(ctx?: OpContext): Promise<DockerCheckResult> {
  let r: NativeResult
  try {
    r = await docker(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 30_000,
      signal: ctx?.signal
    })
  } catch (e) {
    const detail = e instanceof NativeStartError ? e.message : String(e)
    return {
      ok: false,
      running: false,
      error: 'The docker command was not found. Install Docker Desktop.',
      detail
    }
  }
  if (r.code !== 0)
    return {
      ok: false,
      running: false,
      error: 'Docker Desktop is not running.',
      detail: firstLine(r.err)
    }
  const img = await docker(['image', 'inspect', POCKETD_IMAGE, '--format', '{{.Id}}'], {
    timeoutMs: 30_000,
    signal: ctx?.signal
  })
  const ap = await docker(['image', 'inspect', POCKET_AP_IMAGE, '--format', '{{.Id}}'], {
    timeoutMs: 30_000,
    signal: ctx?.signal
  })
  const res: DockerCheckResult = {
    ok: true,
    running: true,
    docker: r.out.trim(),
    image: img.code === 0,
    pocketap: ap.code === 0,
    pocketd: ''
  }
  if (img.code === 0) {
    const imageId = img.out.trim()
    if (cachedPocketdVersion && cachedPocketdVersion.imageId === imageId) {
      res.pocketd = cachedPocketdVersion.version
    } else {
      const v = await docker(['run', '--rm', POCKETD_IMAGE, 'version'], {
        timeoutMs: 60_000,
        signal: ctx?.signal
      })
      if (v.code === 0) {
        res.pocketd = v.out.trim()
        cachedPocketdVersion = { imageId, version: res.pocketd }
      }
    }
  }
  return res
}

export async function requireDocker(ctx?: OpContext): Promise<void> {
  const c = await dockerCheck(ctx)
  if (!c.ok) fail(c.error ?? 'Docker is not available.', c.detail ?? '')
  if (!c.image) fail('The pocketd image is not downloaded yet. Use "Download pocketd" first.')
}

export function dockerStart(): { ok: true } {
  if (!existsSync(DOCKER_DESKTOP_EXE))
    fail('Docker Desktop is not installed at the expected location.', DOCKER_DESKTOP_EXE)
  const child = spawn(DOCKER_DESKTOP_EXE, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return { ok: true }
}

export async function imagePull(ctx: OpContext): Promise<{ ok: true; pocketd: string }> {
  ctx.progress('info', `Downloading ${POCKETD_IMAGE}`)
  const r = await docker(['pull', POCKETD_IMAGE], {
    ...ctxOpts(ctx),
    onStdout: (s) => {
      const l = firstLine(s)
      if (l) ctx.progress('info', l, undefined, 'pull')
    }
  })
  if (r.code !== 0) fail('Could not download the pocketd image.', firstLine(r.err))
  cachedPocketdVersion = null
  const v = await docker(['run', '--rm', POCKETD_IMAGE, 'version'], {
    timeoutMs: 60_000,
    signal: ctx.signal
  })
  return { ok: true, pocketd: v.out.trim() }
}

export async function pocketapPull(ctx: OpContext): Promise<{ ok: true; version: string }> {
  ctx.progress('info', `Downloading ${POCKET_AP_IMAGE}`)
  const r = await docker(['pull', POCKET_AP_IMAGE], {
    ...ctxOpts(ctx),
    onStdout: (s) => {
      const l = firstLine(s)
      if (l) ctx.progress('info', l, undefined, 'pull')
    }
  })
  if (r.code !== 0) fail('Could not download the pocket-ap image.', firstLine(r.err))
  const v = await docker(['run', '--rm', POCKET_AP_IMAGE, 'version'], {
    timeoutMs: 60_000,
    signal: ctx.signal
  })
  return { ok: true, version: firstLine(v.out) }
}

export async function pocketapPresent(ctx?: OpContext): Promise<boolean> {
  const ap = await docker(['image', 'inspect', POCKET_AP_IMAGE, '--format', '{{.Id}}'], {
    timeoutMs: 30_000,
    signal: ctx?.signal
  })
  return ap.code === 0
}

// ---- volume ----

export async function volumeExists(ctx?: OpContext): Promise<boolean> {
  return (
    (
      await docker(['volume', 'inspect', KEYRING_VOLUME], {
        timeoutMs: 30_000,
        signal: ctx?.signal
      })
    ).code === 0
  )
}

export async function ensureVolume(ctx?: OpContext): Promise<void> {
  if (!(await volumeExists(ctx))) {
    const c = await docker(['volume', 'create', KEYRING_VOLUME], {
      timeoutMs: 30_000,
      signal: ctx?.signal
    })
    if (c.code !== 0) throw new Error(`Could not create the keyring volume: ${firstLine(c.err)}`)
  }
  const p = await invokeInBox(`chown pocket:pocket ${HOME_IN_BOX}`, { root: true, ctx })
  if (p.code !== 0) throw new Error(`Could not initialise the keyring volume: ${firstLine(p.err)}`)
}

export async function removeVolume(ctx?: OpContext): Promise<NativeResult> {
  log.warn('removing the keyring volume')
  return docker(['volume', 'rm', '-f', KEYRING_VOLUME], { timeoutMs: 60_000, signal: ctx?.signal })
}

// ---- keyring reads ----

export interface KeyringEntry {
  name: string
  address: string
}

/** Names and addresses in the keyring; [] when empty; null on failure. */
export async function keyringList(pass: string, ctx?: OpContext): Promise<KeyringEntry[] | null> {
  const r = await pocketd(['keys', 'list', '--keyring-backend', 'file', '--output', 'json'], {
    pass,
    ctx
  })
  if (r.code !== 0) return null
  const txt = r.out.trim()
  if (!txt || txt === 'null') return []
  try {
    const v = JSON.parse(txt)
    if (!Array.isArray(v)) return []
    return v.map((k: { name?: string; address?: string }) => ({
      name: String(k.name ?? ''),
      address: String(k.address ?? '')
    }))
  } catch {
    return null
  }
}

export async function keyringAddress(
  name: string,
  pass: string,
  ctx?: OpContext
): Promise<string | null> {
  const r = await pocketd(['keys', 'show', name, '-a', '--keyring-backend', 'file'], { pass, ctx })
  if (r.code !== 0) return null
  const a = r.out.trim()
  return RE.address.test(a) ? a : null
}

/** The address a hex key derives to, computed in a throwaway keyring in the container's /tmp. */
export async function probeHexAddress(hex: string, ctx?: OpContext): Promise<string | null> {
  const cmd =
    'pocketd keys import-hex probe "$PSM_IMPORT_KEY" --keyring-backend test --home /tmp/psm-probe >/dev/null 2>&1 && pocketd keys show probe -a --keyring-backend test --home /tmp/psm-probe'
  const r = await invokeInBox(cmd, { envExtra: { PSM_IMPORT_KEY: hex }, ctx })
  const a = r.out.trim()
  return r.code === 0 && RE.address.test(a) ? a : null
}
