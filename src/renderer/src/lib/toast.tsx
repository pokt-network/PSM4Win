// Toasts: a short message near the bottom of the window that fades on its own, for an
// action whose result is otherwise invisible or far away (a copy, a link opened in the
// browser, a dialog that closed after doing its work). Drawn above the modal layer, so a
// copy inside a dialog is acknowledged too. The footer still records the last message.
import { create } from 'zustand'

export type ToastKind = 'ok' | 'info' | 'err'

interface ToastItem {
  id: number
  text: string
  kind: ToastKind
  leaving: boolean
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }))

const SHOW_MS = { ok: 2200, info: 2600, err: 5000 } as const
const FADE_MS = 300
const MAX = 3
let nextId = 1

/** Shows a toast. The same text shown again while it is still up restarts it instead of stacking. */
export function toast(text: string, kind: ToastKind = 'ok'): void {
  const id = nextId++
  useToasts.setState((s) => ({
    items: [...s.items.filter((t) => t.text !== text), { id, text, kind, leaving: false }].slice(
      -MAX
    )
  }))
  window.setTimeout(() => {
    useToasts.setState((s) => ({
      items: s.items.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    }))
    window.setTimeout(() => {
      useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }))
    }, FADE_MS)
  }, SHOW_MS[kind])
}

export function ToastHost(): React.JSX.Element {
  const items = useToasts((s) => s.items)
  return (
    <div id="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}${t.leaving ? ' leaving' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
