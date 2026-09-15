// Confirmation and transfer flows shared by several screens (docs/SCREENS.md 1.8 and 4.6).
import type { ReactNode } from 'react'
import { S } from '../store'
import { confirmDialog, typedConfirm, openModal, closeModal } from './modal'
import { fmtPokt, fmtInt } from '@core/format'
import { POKT } from '@core/format'
import {
  walletByName,
  dockerReady,
  refreshBalance,
  pollTx,
  loadHistory,
  setBusy,
  psm,
  txUrl
} from './actions'
import type { Status } from '../components/ui'

export interface TxConfirm {
  /** MainNet modal title. */
  mainTitle: string
  /** MainNet modal body (a dangerbox). */
  mainBody: ReactNode
  /** Token to type on MainNet; null for a plain modal with a primary button. */
  token: string | null
  /** Prompt above the token input (default "Type <token> to confirm."). */
  prompt?: ReactNode
  mainOkLabel: string
  /** Beta TestNet confirm() text. */
  betaText: string
  betaOkLabel?: string
  /** For the two-network-agnostic modal case (supplier unstake on Beta uses a modal too). */
  betaModal?: { title: string; body: ReactNode }
}

/** MainNet: typed (or plain) modal. Beta: the in-app confirm. */
export async function confirmTx(c: TxConfirm): Promise<boolean> {
  if (S().net === 'main') {
    if (c.token === null) {
      return new Promise((resolve) =>
        openModal(c.mainTitle, c.mainBody, [
          {
            label: 'Cancel',
            onClick: () => {
              closeModal()
              resolve(false)
            }
          },
          {
            label: c.mainOkLabel,
            cls: 'primary',
            onClick: () => {
              closeModal()
              resolve(true)
            }
          }
        ])
      )
    }
    return typedConfirm({
      title: c.mainTitle,
      body: c.mainBody,
      token: c.token,
      prompt: c.prompt,
      okLabel: c.mainOkLabel
    })
  }
  if (c.betaModal) {
    return new Promise((resolve) =>
      openModal(c.betaModal!.title, c.betaModal!.body, [
        {
          label: 'Cancel',
          onClick: () => {
            closeModal()
            resolve(false)
          }
        },
        {
          label: c.betaOkLabel ?? 'Confirm',
          cls: 'danger solid',
          onClick: () => {
            closeModal()
            resolve(true)
          }
        }
      ])
    )
  }
  return confirmDialog(c.betaText, c.betaOkLabel ?? 'Confirm')
}

type SetStatus = (text: ReactNode, cls?: Status['cls']) => void

/** Sends POKT from the owner wallet to an application wallet (app.js fundWallet). */
export async function fundWallet(
  name: string,
  upokt: number,
  setStatus: SetStatus
): Promise<boolean> {
  const s = S()
  if (s.busy) return false
  const w = walletByName(name)
  if (!w || w.parent) {
    setStatus('Choose an application wallet to fund.', 'err')
    return false
  }
  if (!(upokt > 0)) {
    setStatus('Enter an amount in POKT.', 'err')
    return false
  }
  if (!s.imported || !dockerReady()) {
    setStatus('Owner wallet and Docker must be ready.', 'err')
    return false
  }
  const bal = await refreshBalance()
  if (bal !== null && bal < upokt + 1 * POKT) {
    setStatus(
      `The owner wallet holds ${fmtPokt(bal)} POKT; not enough for ${fmtPokt(upokt)} plus gas.`,
      'err'
    )
    return false
  }
  const ok = await confirmTx({
    mainTitle: 'Confirm MainNet transfer',
    mainBody: (
      <div className="dangerbox">
        This sends <b>{fmtPokt(upokt)} POKT</b> of real funds from the owner wallet to <b>{name}</b>{' '}
        ({w.address}). Transfers cannot be reversed.
      </div>
    ),
    token: 'SEND',
    mainOkLabel: 'Send on MainNet',
    betaText: `Send ${fmtPokt(upokt)} POKT from the owner wallet to ${name} on Beta TestNet?`,
    betaOkLabel: 'Send'
  })
  if (!ok) return false
  setBusy(true)
  setStatus(`Sending ${fmtPokt(upokt)} POKT to ${name}`, 'busy')
  const r = await psm().signer['tx-fund-wallet']({ network: S().net, name, amount_upokt: upokt })
  if (!r.ok || !('txhash' in r)) {
    setBusy(false)
    setStatus(
      `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail ?? ''}`,
      'err'
    )
    return false
  }
  setStatus(`Broadcast, waiting for the block (${r.txhash.substring(0, 10)})`, 'busy')
  const t = await pollTx(r.txhash)
  setBusy(false)
  if (!t.ok) {
    setStatus(t.error ?? '', 'err')
    return false
  }
  void refreshBalance()
  void loadHistory()
  setStatus(`Sent ${fmtPokt(upokt)} POKT to ${name} in block ${fmtInt(t.height)}.`, 'ok')
  return true
}

/** Sends POKT from the owner wallet to an operator address (app.js fundOperator / provisioning top-up). */
export async function fundOperator(
  op: string,
  upokt: number,
  setStatus: SetStatus,
  opts: { newOperator?: boolean; onCancel?: () => void } = {}
): Promise<{ ok: boolean; height?: number }> {
  const s = S()
  if (s.busy) return { ok: false }
  if (!/^pokt1[0-9a-z]{38}$/.test(op)) {
    setStatus('Enter a valid operator address first.', 'err')
    return { ok: false }
  }
  if (!(upokt > 0)) {
    setStatus('Enter an amount in POKT.', 'err')
    return { ok: false }
  }
  if (!s.imported || !dockerReady()) {
    setStatus('Wallet and Docker must be ready.', 'err')
    return { ok: false }
  }
  const bal = await refreshBalance()
  if (bal !== null && bal < upokt + 1 * POKT) {
    setStatus(
      `The owner wallet holds ${fmtPokt(bal)} POKT; not enough for ${fmtPokt(upokt)} plus gas.`,
      'err'
    )
    return { ok: false }
  }
  const ok = await confirmTx({
    mainTitle: 'Confirm MainNet transfer',
    mainBody: (
      <div className="dangerbox">
        This sends <b>{fmtPokt(upokt)} POKT</b> of real funds from the owner wallet to the{' '}
        {opts.newOperator ? 'new operator' : 'operator'} <b>{op}</b>.
        {opts.newOperator ? '' : ' Transfers cannot be reversed.'}
      </div>
    ),
    token: 'SEND',
    mainOkLabel: 'Send on MainNet',
    betaText: `Send ${fmtPokt(upokt)} POKT from the owner wallet to the operator ${op} on Beta TestNet?`,
    betaOkLabel: 'Send'
  })
  if (!ok) {
    opts.onCancel?.()
    return { ok: false }
  }
  setBusy(true)
  setStatus(`Sending ${fmtPokt(upokt)} POKT to the operator`, 'busy')
  const r = await psm().signer['tx-fund-operator']({
    network: S().net,
    to: op,
    amount_upokt: upokt
  })
  if (!r.ok || !('txhash' in r)) {
    setBusy(false)
    setStatus(
      `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail ?? ''}`,
      'err'
    )
    return { ok: false }
  }
  setStatus(`Broadcast, waiting for the block (${r.txhash.substring(0, 10)})`, 'busy')
  const t = await pollTx(r.txhash)
  setBusy(false)
  if (!t.ok) {
    setStatus(t.error ?? '', 'err')
    return { ok: false }
  }
  void refreshBalance()
  void loadHistory()
  setStatus(`Sent ${fmtPokt(upokt)} POKT to the operator in block ${fmtInt(t.height)}.`, 'ok')
  return { ok: true, height: t.height }
}

export function TxLink({ hash }: { hash: string }): React.JSX.Element {
  const net = S().net
  return (
    <a className="mono" onClick={() => psm().app.openExternal(txUrl(net, hash))}>
      {hash}
    </a>
  )
}
