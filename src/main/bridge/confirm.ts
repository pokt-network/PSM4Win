// The confirmation gate for bridge calls. The main process owns it: a spend or a
// signature asked for over the bridge does not run until the renderer reports that
// the user approved it in the app window, and the approval is bound to the request
// nonce, so nothing an assistant sends can stand in for the click.
import { randomBytes } from 'node:crypto'
import type { BrowserWindow } from 'electron'

export interface BridgeConfirmRequest {
  id: string
  tool: string
  /** One-paragraph description of what will happen, built by main from the arguments. */
  summary: string
  network: 'beta' | 'main' | null
  /** Token the user must type (MainNet spends, destructive actions); null for a plain Approve. */
  token: string | null
  /** Key facts shown as a table: label and value. */
  facts: Array<[string, string]>
}

const CONFIRM_TIMEOUT_MS = 5 * 60_000

interface Pending {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

export function confirmInWindow(
  getWindow: () => BrowserWindow | null,
  req: Omit<BridgeConfirmRequest, 'id'>
): Promise<boolean> {
  const w = getWindow()
  if (!w || w.isDestroyed()) return Promise.resolve(false)
  const id = randomBytes(12).toString('hex')
  const full: BridgeConfirmRequest = { id, ...req }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      if (!w.isDestroyed()) w.webContents.send('psm:bridge-confirm-expired', id)
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    w.webContents.send('psm:bridge-confirm', full)
  })
}

/** Called from the renderer's reply handler. Unknown ids (expired, replayed) are ignored. */
export function resolveConfirmation(id: unknown, approved: unknown): boolean {
  if (typeof id !== 'string') return false
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  clearTimeout(p.timer)
  p.resolve(approved === true)
  return true
}

export function pendingConfirmations(): number {
  return pending.size
}
