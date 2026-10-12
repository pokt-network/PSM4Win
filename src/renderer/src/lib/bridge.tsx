// Renderer side of the local MCP action bridge: the confirmation dialog an
// assistant's request opens, the refresh after a bridge call, and the status feed
// for the Settings panel. The main process decides what needs confirming and waits
// for the reply; this file only shows the question and reports the answer.
import { useEffect } from 'react'
import { useStore } from '../store'
import { openModal, closeModal, onModalDismiss, useModal } from './modal'
import {
  loadHistory,
  refreshBalance,
  loadWallets,
  loadServiceFolders,
  loadSettings,
  notify
} from './actions'
import { netLabel } from '../components/ui'
import { useState } from 'react'
import type { BridgeConfirmRequest, BridgeStatus } from '../../../preload/index'

function TokenField({
  token,
  onChange
}: {
  token: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const [v, setV] = useState('')
  return (
    <>
      <p>
        Type <b>{token}</b> to approve.
      </p>
      <input
        type="text"
        id="bridgeConfirm"
        autoComplete="off"
        autoFocus
        value={v}
        onChange={(e) => {
          setV(e.target.value)
          onChange(e.target.value)
        }}
      />
    </>
  )
}

// Requests wait their turn: one dialog at a time, in the order they came. A request is
// declined only by Decline, Escape, or main's five-minute expiry, never because another
// dialog opened: before 0.1.28 a second request, or any dialog the app opened, replaced the
// first and silently declined it ("Not approved" seconds after the call, no dialog seen).
const queue: BridgeConfirmRequest[] = []
/** The request whose dialog is showing, if any. */
let showing: BridgeConfirmRequest | null = null
/** Set while the bridge itself closes an expired request, so that is not a decline. */
let expiring = false

function enqueue(req: BridgeConfirmRequest): void {
  queue.push(req)
  if (showing || queue.length > 1) {
    notify(
      `An assistant request (${req.tool}) is waiting; it opens after the current dialog.`,
      'info'
    )
  } else if (useModal.getState().open) {
    notify(
      `An assistant request (${req.tool}) is waiting; it opens when this dialog closes.`,
      'info'
    )
  }
  showNext()
}

/** Opens the oldest waiting request when no dialog is open. */
function showNext(): void {
  if (showing || useModal.getState().open) return
  const req = queue.shift()
  if (req) showConfirm(req)
}

function drop(id: string): void {
  const i = queue.findIndex((r) => r.id === id)
  if (i >= 0) queue.splice(i, 1)
}

/** Main gave up on a request (five minutes): forget it, and close its dialog if it is showing. */
function expire(id: string): void {
  drop(id)
  if (showing?.id !== id) return
  showing = null
  expiring = true
  try {
    closeModal()
  } finally {
    expiring = false
  }
  notify('The assistant request expired.', 'info')
}

function showConfirm(req: BridgeConfirmRequest): void {
  showing = req
  let typed = ''
  let answered = false
  const reply = (approved: boolean): void => {
    if (answered) return
    answered = true
    void window.psm.bridge.reply(req.id, approved)
    showing = null
    closeModal()
    notify(approved ? `Approved ${req.tool} for the assistant.` : `Declined ${req.tool}.`, 'info')
  }
  const approve = (): void => {
    if (req.token && typed.trim() !== req.token) return
    reply(true)
  }
  openModal(
    <>Assistant request{req.network ? `: ${netLabel(req.network)}` : ''}</>,
    <>
      <div className={req.network === 'main' ? 'dangerbox' : 'warnbox'}>{req.summary}</div>
      <table className="kv">
        <tbody>
          <tr>
            <td>Tool</td>
            <td className="mono">{req.tool}</td>
          </tr>
          {req.facts.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className={/^pokt1|@/.test(v) ? 'mono' : ''}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {req.token ? (
        <TokenField token={req.token} onChange={(v) => (typed = v)} />
      ) : (
        <p className="hint">Nothing is signed until you approve. The assistant is waiting.</p>
      )}
    </>,
    [
      { label: 'Decline', id: 'bridgeDecline', onClick: () => reply(false) },
      {
        label: req.network === 'main' ? 'Approve on MainNet' : 'Approve',
        cls: req.network === 'main' || req.token ? 'danger solid' : 'primary',
        id: 'bridgeApprove',
        onClick: approve
      }
    ]
  )
  onModalDismiss((reason) => {
    if (answered || expiring) return
    showing = null
    if (reason === 'replaced') {
      // Another dialog took the window: this request waits and comes back when it closes.
      queue.unshift(req)
      notify(`The assistant request (${req.tool}) opens again when this dialog closes.`, 'info')
    } else {
      // Escape.
      answered = true
      void window.psm.bridge.reply(req.id, false)
      notify(`Declined ${req.tool}.`, 'info')
    }
  })
}

/** Mounted once in App: wires the bridge events to dialogs, refreshes, and the store. */
export function BridgeHost(): null {
  useEffect(() => {
    const offConfirm = window.psm.bridge.onConfirm(enqueue)
    const offExpired = window.psm.bridge.onConfirmExpired(expire)
    // A waiting request opens as soon as no dialog is open (after the closing one has
    // finished its own dismiss handling, hence the deferral).
    const offModal = useModal.subscribe((m, prev) => {
      if (prev.open && !m.open) window.setTimeout(showNext, 0)
    })
    const offStatus = window.psm.bridge.onStatus((st) => useStore.setState({ bridge: st }))
    const offActivity = window.psm.bridge.onActivity(({ tool, ok }) => {
      notify(`Assistant ran ${tool}${ok ? '' : ' (failed)'}.`, ok ? 'info' : 'err')
      void loadHistory()
      void refreshBalance()
      void loadWallets()
      void loadServiceFolders()
      void loadSettings()
    })
    void window.psm.bridge.status().then((st) => useStore.setState({ bridge: st }))
    return () => {
      offConfirm()
      offExpired()
      offModal()
      offStatus()
      offActivity()
    }
  }, [])
  return null
}

export type { BridgeStatus }
