// Runs a child process the way the HTA's Invoke-Native did: argument arrays, no
// shell, both streams collected, stdin closed immediately unless text is given,
// hidden window. Adds what the HTA lacked: a timeout that kills the process tree
// and cancellation through an AbortSignal. Secrets reach a child only through
// `env`, and `env` is never logged.
import { spawn } from 'node:child_process'
import type { NativeOutput } from '@core/pocketd-output'
import { log } from '../state/log'

export interface NativeOptions {
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface NativeResult extends NativeOutput {
  timedOut: boolean
  cancelled: boolean
}

export class NativeStartError extends Error {
  constructor(
    public readonly exe: string,
    public readonly code: string
  ) {
    super(`Could not start ${exe} (${code}).`)
    this.name = 'NativeStartError'
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* best effort */
    }
  } else {
    // phase 3: process groups on macOS
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* best effort */
    }
  }
}

export function runNative(
  exe: string,
  args: readonly string[],
  opts: NativeOptions = {}
): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    log.debug('spawn', { exe, args: args.map((a) => (a.length > 400 ? a.slice(0, 400) + '…' : a)) })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, [...args], {
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
    } catch (e) {
      reject(new NativeStartError(exe, (e as NodeJS.ErrnoException).code ?? 'EUNKNOWN'))
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let cancelled = false
    let settled = false

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const res: NativeResult = {
        code: code ?? -1,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
        timedOut,
        cancelled
      }
      log.debug('exit', { exe, code: res.code, ms: Date.now() - started, timedOut, cancelled })
      resolve(res)
    }

    const timer = setTimeout(
      () => {
        timedOut = true
        killTree(child.pid)
      },
      Math.max(1000, opts.timeoutMs ?? 240_000)
    )
    const onAbort = (): void => {
      cancelled = true
      killTree(child.pid)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (d: Buffer) => {
      out.push(d)
      opts.onStdout?.(d.toString('utf8'))
    })
    child.stderr?.on('data', (d: Buffer) => {
      err.push(d)
      opts.onStderr?.(d.toString('utf8'))
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new NativeStartError(exe, e.code ?? 'EUNKNOWN'))
    })
    child.on('close', (code) => finish(code))

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined)
      child.stdin.write(opts.stdin)
      child.stdin.end()
    }
  })
}
