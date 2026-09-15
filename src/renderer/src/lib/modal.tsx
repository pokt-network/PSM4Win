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

export function openModal(
  title: ReactNode,
  body: ReactNode,
  buttons: ModalButton[],
  cls: string | boolean = ''
): void {
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
          closeModal()
          resolve(false)
        }
      },
      {
        label: okLabel,
        cls: okCls,
        onClick: () => {
          closeModal()
          resolve(true)
        }
      }
    ])
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
          closeModal()
          resolve()
        }
      }
    ])
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
      closeModal()
      resolve(true)
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
            closeModal()
            resolve(false)
          }
        },
        { label: opts.okLabel, cls: opts.okCls ?? 'danger solid', onClick: tryGo }
      ]
    )
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
