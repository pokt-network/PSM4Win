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
  foot
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

function showConfirm(req: BridgeConfirmRequest): void {
  let typed = ''
  const reply = (approved: boolean): void => {
    void window.psm.bridge.reply(req.id, approved)
    closeModal()
    foot(approved ? `Approved ${req.tool} for the assistant.` : `Declined ${req.tool}.`)
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
  // Escape, or another dialog replacing this one, counts as a decline.
  onModalDismiss(() => void window.psm.bridge.reply(req.id, false))
}

/** Mounted once in App: wires the bridge events to dialogs, refreshes, and the store. */
export function BridgeHost(): null {
  useEffect(() => {
    const offConfirm = window.psm.bridge.onConfirm(showConfirm)
    const offExpired = window.psm.bridge.onConfirmExpired(() => {
      if (useModal.getState().open) {
        closeModal()
        foot('The assistant request expired.')
      }
    })
    const offStatus = window.psm.bridge.onStatus((st) => useStore.setState({ bridge: st }))
    const offActivity = window.psm.bridge.onActivity(({ tool, ok }) => {
      foot(`Assistant ran ${tool}${ok ? '' : ' (failed)'}.`)
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
      offStatus()
      offActivity()
    }
  }, [])
  return null
}

export type { BridgeStatus }
