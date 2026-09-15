// Owner wallet import (docs/SCREENS.md 3.13) and Revoke (3.12), plus the
// first-run importer from the HTA.
import { useEffect, useRef, useState } from 'react'
import { openModal, closeModal, setModalBody, lockModal, alertDialog } from '../lib/modal'
import { S, useStore } from '../store'
import {
  dockerReady,
  walletStatus,
  foot,
  copy,
  loadSettings,
  loadServiceFolders,
  loadHistory
} from '../lib/actions'
import { Busy, ErrText } from '../components/ui'
import { normalizeHexKey } from '@core/validate'
import type { HtaDetection } from '../../../preload/index'

function KeyField({
  onChange,
  onEnter
}: {
  onChange: (v: string) => void
  onEnter: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [v, setV] = useState('')
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])
  return (
    <input
      ref={ref}
      type="password"
      id="impKey"
      autoComplete="off"
      value={v}
      onChange={(e) => {
        setV(e.target.value)
        onChange(e.target.value)
      }}
      onKeyDown={(e) => e.key === 'Enter' && onEnter()}
    />
  )
}

export async function importDialog(): Promise<void> {
  if (!dockerReady()) {
    await alertDialog(
      'Docker Desktop must be running and the pocketd image downloaded before a key can be imported.'
    )
    return
  }
  let raw = ''
  let hint: React.ReactNode = 'Optional 0x prefix is fine.'
  const render = (busy: boolean): void => {
    setModalBody(
      <>
        <p>
          Paste the 64-character hex private key of the wallet that will own your services. This is
          the only time it is entered. It is imported into an encrypted keyring inside a Docker
          volume, the keyring passphrase is random and sealed to your Windows login, and the key is
          never displayed again unless you use Revoke.
        </p>
        <div className="warnbox">
          The key is handed to pocketd through the process environment, never through a file or the
          command line. Close any screen-sharing before pasting.
        </div>
        <label>Private key (hex)</label>
        <KeyField onChange={(v) => (raw = v)} onEnter={go} />
        <div className="hint" id="impHint">
          {hint}
        </div>
      </>,
      [
        { label: 'Cancel', id: 'impCancel', disabled: busy, onClick: closeModal },
        { label: 'Import', cls: 'primary', id: 'impGo', disabled: busy, onClick: go }
      ]
    )
  }
  const go = async (): Promise<void> => {
    let hex: string
    try {
      hex = normalizeHexKey(raw)
    } catch {
      hint = <ErrText>That is not a 64-character hex key.</ErrText>
      render(false)
      return
    }
    hint = 'Importing, this takes a few seconds'
    render(true)
    lockModal(true)
    const r = await window.psm.signer['wallet-import']({ privateKeyHex: hex })
    hex = ''
    raw = ''
    lockModal(false)
    if (!r.ok) {
      hint = <ErrText>{`${r.error} ${r.detail ?? ''}`}</ErrText>
      render(false)
      return
    }
    closeModal()
    foot('Wallet imported: ' + r.address)
    void walletStatus()
  }
  openModal('Import the wallet private key', null, [])
  render(false)
}

export function revokeDialog(): void {
  const apps = S().wallets.length
  let token = ''
  openModal(
    'Revoke the wallet key',
    <>
      <div className="dangerbox">
        Revoking shows the private key one time so you can store it elsewhere, then deletes the
        encrypted keyring, the Docker volume, and the sealed passphrase from this machine.
        Registered services and stakes on the network are not affected.
      </div>
      {apps ? (
        <div className="dangerbox">
          The keyring also holds{' '}
          <b>
            {apps} application wallet{apps === 1 ? '' : 's'}
          </b>
          , which would be deleted with it. Export or remove them on the Wallets tab first; the
          signer refuses to revoke while they exist.
        </div>
      ) : null}
      <p>
        Type <b>REVOKE</b> to continue.
      </p>
      <input
        type="text"
        id="revConfirm"
        autoComplete="off"
        onChange={(e) => (token = e.target.value)}
      />
    </>,
    [
      { label: 'Cancel', onClick: closeModal },
      {
        label: 'Show key and continue',
        cls: 'danger solid',
        onClick: async () => {
          if (token.trim() !== 'REVOKE') return
          setModalBody(
            <p>
              <Busy>Exporting the key from the keyring</Busy>
            </p>,
            []
          )
          lockModal(true)
          const r = await window.psm.signer['wallet-export']({})
          lockModal(false)
          if (!r.ok) {
            setModalBody(<div className="dangerbox">{`${r.error} ${r.detail ?? ''}`}</div>, [
              { label: 'Close', onClick: closeModal }
            ])
            return
          }
          showExported(r.hex)
        }
      }
    ]
  )
}

function showExported(hex: string): void {
  openModal(
    'Save this key now',
    <>
      <p>
        This is the wallet private key. It will not be shown again. Copy it into your password
        manager before deleting.
      </p>
      <div className="keybox" id="revKey">
        {hex}
      </div>
      <div className="btnrow">
        <button className="btn small" onClick={() => copy(hex)}>
          Copy to clipboard
        </button>
      </div>
    </>,
    [
      { label: 'Keep the key, cancel revoke', onClick: closeModal },
      {
        label: 'I saved it. Delete from this machine',
        cls: 'danger solid',
        onClick: async () => {
          setModalBody(
            <p>
              <Busy>Deleting the keyring volume and sealed passphrase</Busy>
            </p>,
            []
          )
          lockModal(true)
          const r = await window.psm.signer['wallet-delete']({})
          lockModal(false)
          if (!r.ok) {
            setModalBody(<div className="dangerbox">{`${r.error} ${r.detail ?? ''}`}</div>, [
              { label: 'Close', onClick: closeModal }
            ])
            return
          }
          closeModal()
          foot('Wallet key deleted from this machine.')
          void walletStatus()
        }
      }
    ]
  )
}

// ---- first run: import from the HTA (docs/MIGRATION.md section 3) ----

export function offerHtaImport(det: HtaDetection): void {
  let servicesRoot = det.servicesRoot ?? ''
  const lines: string[] = []
  const render = (busy: boolean, done: boolean): void => {
    setModalBody(
      <>
        <p>
          The Windows HTML Application's data was found on this PC. Importing copies its settings,
          wallet records, activity, and relay log, re-seals the keyring passphrase for this app, and
          verifies the keyring. Nothing is retyped and no key is re-imported; the HTA keeps working.
        </p>
        <table className="kv">
          <tbody>
            <tr>
              <td>Found at</td>
              <td className="mono">{det.path}</td>
            </tr>
            <tr>
              <td>Network</td>
              <td>{det.network ?? '?'}</td>
            </tr>
            <tr>
              <td>Servers</td>
              <td>{det.servers}</td>
            </tr>
            <tr>
              <td>Owner wallet</td>
              <td className="mono">{det.ownerAddress ?? 'none'}</td>
            </tr>
            <tr>
              <td>Application wallets</td>
              <td>{det.appWallets.join(', ') || 'none'}</td>
            </tr>
            <tr>
              <td>Activity records</td>
              <td>{det.historyRecords}</td>
            </tr>
          </tbody>
        </table>
        <label>Services folder</label>
        <div className="filerow">
          <input
            type="text"
            defaultValue={servicesRoot}
            onChange={(e) => (servicesRoot = e.target.value)}
            placeholder="C:\path\to\services"
            disabled={busy || done}
          />
          <button
            className="btn small"
            disabled={busy || done}
            onClick={async () => {
              const p = await window.psm.settings.pickDir(servicesRoot || undefined)
              if (p) {
                servicesRoot = p
                render(false, false)
              }
            }}
          >
            Browse
          </button>
        </div>
        <div className="hint">
          The HTA's default was the service-builder repository's services folder. Confirm where the
          service folders live.
        </div>
        {lines.length ? (
          <div className="log">
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        ) : null}
      </>,
      done
        ? [{ label: 'Close', cls: 'primary', onClick: closeModal }]
        : [
            { label: 'Skip for now', disabled: busy, onClick: closeModal },
            {
              label: 'Import',
              cls: 'primary',
              disabled: busy,
              onClick: async () => {
                render(true, false)
                lockModal(true)
                const off = window.psm.onProgress((ev) => {
                  if (ev.runId === 'import') {
                    lines.push(ev.text + (ev.sub ? ' (' + ev.sub + ')' : ''))
                    render(true, false)
                  }
                })
                const r = await window.psm.migration.import({
                  servicesRoot: servicesRoot || undefined
                })
                off()
                lockModal(false)
                lines.push(r.ok ? 'Import finished.' : 'Import failed: ' + (r.error ?? ''))
                await loadSettings()
                await loadServiceFolders()
                void loadHistory()
                void walletStatus()
                const s = await window.psm.settings.get()
                useStore.setState({ net: s.network, theme: s.theme })
                render(false, true)
              }
            }
          ]
    )
  }
  openModal('Import from Pocket Service Manager', null, [], 'wide')
  render(false, false)
}
