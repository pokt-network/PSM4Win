// What every operation receives besides its request: cancellation, its time
// budget, and a way to narrate progress to the renderer.
import type { ProgressEvent, SignerOp } from '@core/contract'

export interface OpContext {
  runId: string
  op: SignerOp
  signal: AbortSignal
  /** Remaining budget for child processes, in milliseconds. */
  timeoutMs: number
  progress: (level: ProgressEvent['level'], text: string, sub?: string, step?: string) => void
}

export function noopContext(op: SignerOp, timeoutMs = 240_000): OpContext {
  return {
    runId: 'local',
    op,
    signal: new AbortController().signal,
    timeoutMs,
    progress: () => undefined
  }
}
