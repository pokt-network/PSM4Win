// The single modal host (docs/SCREENS.md 1.5) plus the in-app replacements for
// the HTA's native confirm() and alert(), and the typed-confirmation dialog (1.8).
import { create } from 'zustand'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface ModalButton {
  label: string
  cls?: string
  id?: string
  disabled?: boolean
  onClick?: () => void
}

interface ModalState {
  open: boolean
  title: ReactNode
  body: ReactNode
  buttons: ModalButton[]
  cls: string
  /** When true, Escape does not close (a busy step is running). */
  locked: boolean
}

export const useModal = create<ModalState>(() => ({
  open: false,
  title: '',
  body: null,
  buttons: [],
  cls: '',
  locked: false
}))

/** Called once when the open dialog goes away without one of its buttons resolving it
 *  (Escape, or another modal replacing it). Promise-backed dialogs use it so a caller that
 *  awaits them is never left hanging (the HTA's native confirm()/alert() always return). */
let dismiss: (() => void) | null = null
function fireDismiss(): void {
  const d = dismiss
  dismiss = null
  d?.()
}
export function onModalDismiss(fn: () => void): void {
  dismiss = fn
}

export function openModal(
  title: ReactNode,
  body: ReactNode,
  buttons: ModalButton[],
  cls: string | boolean = ''
): void {
  fireDismiss()
  useModal.setState({
    open: true,
    title,
    body,
    buttons,
    cls: cls === true ? 'wide' : cls || '',
    locked: false
  })
}
export function setModalBody(body: ReactNode, buttons?: ModalButton[]): void {
  useModal.setState((s) => ({ body, buttons: buttons ?? s.buttons }))
}
export function setModalButtons(buttons: ModalButton[]): void {
  useModal.setState({ buttons })
}
export function lockModal(locked: boolean): void {
  useModal.setState({ locked })
}
export function closeModal(): void {
  useModal.setState({ open: false, body: null, buttons: [], locked: false })
  fireDismiss()
}

/**
 * A modal that reports on work already under way.
 *
 * There is one modal at a time, and a typed confirmation closes it when the user
 * confirms. Anything that asks for confirmation from inside a dialog therefore loses
 * the dialog, and with it the status line it was writing to: the window went quiet for
 * the minute a transaction takes to reach a block. This opens a fresh modal after the
 * confirmation, so the work is narrated where the user is already looking. It cannot be
 * dismissed until the work ends.
 */
interface ProgressState {
  text: ReactNode
  cls: 'busy' | 'ok' | 'err'
}
const useProgress = create<ProgressState>(() => ({ text: '', cls: 'busy' }))

function ProgressBody(): React.JSX.Element {
  const { text, cls } = useProgress()
  return <div className={'status ' + cls}>{text}</div>
}

export interface Progress {
  /** A step, while the work continues. */
  set: (text: ReactNode) => void
  /** The outcome, leaving a Close button. */
  finish: (text: ReactNode, ok: boolean) => void
}

export function progressModal(title: ReactNode, first: ReactNode = ''): Progress {
  useProgress.setState({ text: first, cls: 'busy' })
  openModal(title, <ProgressBody />, [])
  lockModal(true)
  return {
    set: (text) => useProgress.setState({ text, cls: 'busy' }),
    finish: (text, ok) => {
      useProgress.setState({ text, cls: ok ? 'ok' : 'err' })
      lockModal(false)
      setModalButtons([{ label: 'Close', cls: ok ? 'primary' : '', onClick: closeModal }])
    }
  }
}

/** In-app replacement for native confirm(). */
export function confirmDialog(
  text: ReactNode,
  okLabel = 'OK',
  title = 'Confirm',
  okCls = 'primary'
): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(title, <p>{text}</p>, [
      {
        label: 'Cancel',
        onClick: () => {
          resolve(false)
          closeModal()
        }
      },
      {
        label: okLabel,
        cls: okCls,
        onClick: () => {
          resolve(true)
          closeModal()
        }
      }
    ])
    onModalDismiss(() => resolve(false))
  })
}

/** In-app replacement for native alert(). */
export function alertDialog(text: ReactNode, title = 'Pocket Service Manager'): Promise<void> {
  return new Promise((resolve) => {
    openModal(title, <p>{text}</p>, [
      {
        label: 'OK',
        cls: 'primary',
        onClick: () => {
          resolve()
          closeModal()
        }
      }
    ])
    onModalDismiss(() => resolve())
  })
}

/** Typed confirmation: the action button does nothing until the token is typed exactly. */
export function typedConfirm(opts: {
  title: string
  body: ReactNode
  token: string
  prompt?: ReactNode
  okLabel: string
  okCls?: string
  cancelLabel?: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    let value = ''
    const tryGo = (): void => {
      if (value.trim() !== opts.token) return
      resolve(true)
      closeModal()
    }
    openModal(
      opts.title,
      <>
        {opts.body}
        {opts.prompt ?? (
          <p>
            Type <b>{opts.token}</b> to confirm.
          </p>
        )}
        <TokenInput onChange={(v) => (value = v)} onEnter={tryGo} />
      </>,
      [
        {
          label: opts.cancelLabel ?? 'Cancel',
          onClick: () => {
            resolve(false)
            closeModal()
          }
        },
        { label: opts.okLabel, cls: opts.okCls ?? 'danger solid', onClick: tryGo }
      ]
    )
    onModalDismiss(() => resolve(false))
  })
}

function TokenInput({
  onChange,
  onEnter
}: {
  onChange: (v: string) => void
  onEnter: () => void
}): React.JSX.Element {
  const [v, setV] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <input
      ref={ref}
      type="text"
      id="mainConfirm"
      autoComplete="off"
      value={v}
      onChange={(e) => {
        setV(e.target.value)
        onChange(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter()
      }}
    />
  )
}

export function ModalHost(): React.JSX.Element | null {
  const m = useModal()
  useEffect(() => {
    if (!m.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !m.locked) closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [m.open, m.locked])
  if (!m.open) return null
  return (
    <div id="modalWrap">
      <div id="modal" className={m.cls}>
        <h3 id="modalTitle">{m.title}</h3>
        <div id="modalBody">{m.body}</div>
        <div id="modalButtons">
          {m.buttons.map((b, i) => (
            <button
              key={b.id ?? i}
              id={b.id}
              className={'btn ' + (b.cls ?? '')}
              disabled={b.disabled}
              onClick={() => b.onClick?.()}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
