// Wallets (docs/SCREENS.md 3.9): the owner row plus every application wallet,
// live balances and stakes, and the create / recover / import / export / remove / fund dialogs.
import { useCallback, useEffect, useState } from 'react'
import { useStore, S } from '../store'
import {
  Badge,
  NetBadge,
  Empty,
  Busy,
  ErrText,
  netLabel,
  useStatus,
  StatusLine
} from '../components/ui'
import { fmtPokt, shortAddr } from '@core/format'
import { POKT } from '@core/format'
import { appUnbonding, appServiceIds } from '@core/chain'
import type { ChainApplication } from '@core/lcd'
import {
  PARENT,
  loadWallets,
  walletReady,
  walletByName,
  balanceOf,
  appRecordOf,
  copy,
  foot,
  ownedServices,
  localServices,
  tab
} from '../lib/actions'
import { openModal, closeModal, setModalBody, lockModal } from '../lib/modal'
import { fundWallet } from '../lib/flows'

interface Row {
  name: string
  address: string
  parent: boolean
  service_id: string
  present: boolean | null
  bal: number | null
  app: ChainApplication | null
}

export function WalletsScreen(): React.JSX.Element {
  const { imported, address, wallets, walletsVerified, net } = useStore()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [status] = useStatus()

  const load = useCallback(async () => {
    if (!S().imported) {
      setRows([])
      return
    }
    const base = [
      {
        name: PARENT,
        address: S().address,
        parent: true,
        service_id: '',
        present: true as boolean | null
      },
      ...S().wallets.map((w) => ({ ...w, parent: false }))
    ]
    const out = await Promise.all(
      base.map(async (w) => {
        const [bal, app] = await Promise.all([balanceOf(w.address), appRecordOf(w.address)])
        return { ...w, bal, app }
      })
    )
    setRows(out)
  }, [])

  useEffect(() => {
    void load()
  }, [load, imported, address, wallets, net])

  const refresh = async (): Promise<void> => {
    await loadWallets()
    await load()
  }

  return (
    <div className="panel">
      <h2>
        Wallets <NetBadge />
      </h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        On Pocket an account can be staked as an application for exactly one service, so each
        service you want to call gets its own application wallet. The owner wallet registers
        services and funds these wallets. Every wallet lives in the same encrypted keyring; the app
        can show a wallet's private key on request, and a new wallet's recovery phrase is shown
        once, at creation.
      </p>
      <div id="walList" style={{ marginTop: 10 }}>
        {!imported ? (
          <Empty text="Import the owner wallet first (side panel). Application wallets are created inside its keyring." />
        ) : rows === null ? (
          <Busy>Reading balances and stakes</Busy>
        ) : (
          <>
            <table className="services">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>For service</th>
                  <th>Address</th>
                  <th>Balance</th>
                  <th>Application stake on {netLabel(net)}</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const ids = appServiceIds(w.app)
                  return (
                    <tr key={w.name}>
                      <td>
                        <span className="svcid">{w.name}</span>{' '}
                        {w.parent ? (
                          <Badge cls="blue">owner</Badge>
                        ) : w.present === false ? (
                          <Badge cls="bad">missing from keyring</Badge>
                        ) : null}
                      </td>
                      <td>
                        {w.service_id ? (
                          w.service_id
                        ) : (
                          <span className="hint">
                            {w.parent ? 'registers services' : 'unassigned'}
                          </span>
                        )}
                      </td>
                      <td className="mono" title={w.address}>
                        {shortAddr(w.address)}
                      </td>
                      <td>{w.bal === null ? '?' : fmtPokt(w.bal) + ' POKT'}</td>
                      <td>
                        {w.app ? (
                          <>
                            {fmtPokt(w.app.stake.amount)} POKT for <b>{ids.join(', ') || '?'}</b>{' '}
                            {appUnbonding(w.app) ? <Badge cls="warn">unbonding</Badge> : null}{' '}
                            {!w.parent && w.service_id && ids.length && ids[0] !== w.service_id ? (
                              <Badge cls="warn">not {w.service_id}</Badge>
                            ) : null}
                          </>
                        ) : (
                          <span className="hint">none</span>
                        )}
                      </td>
                      <td className="actions">
                        <button className="btn small" onClick={() => copy(w.address)}>
                          Copy address
                        </button>
                        {!w.parent ? (
                          <>
                            <button
                              className="btn small"
                              onClick={() => fundWalletDialog(w.name, refresh)}
                            >
                              Fund
                            </button>
                            <button
                              className="btn small"
                              onClick={() => svcStakeAs(w.service_id || ids[0] || '', w.name)}
                            >
                              {w.app ? 'Restake' : 'Stake'}
                            </button>
                            <button
                              className="btn small"
                              onClick={() => exportWalletDialog(w.name)}
                            >
                              Export key
                            </button>
                            <button
                              className="btn small danger"
                              onClick={() => removeWalletDialog(w.name, refresh)}
                            >
                              Remove
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!walletsVerified ? (
              <div className="hint" style={{ marginTop: 6 }}>
                Docker is down, so the list could not be checked against the keyring.
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="btnrow">
        <button className="btn primary" onClick={() => newWalletDialog(refresh)}>
          New app wallet
        </button>
        <button className="btn" onClick={() => recoverWalletDialog(refresh)}>
          Recover from phrase
        </button>
        <button className="btn" onClick={() => importAppWalletDialog(refresh)}>
          Import private key
        </button>
        <button className="btn small" onClick={refresh}>
          Refresh
        </button>
      </div>
      <StatusLine status={status} id="walStatus" />
    </div>
  )
}

export function svcStakeAs(id: string, walletName: string): void {
  useStore.setState((s) => ({ stk: { ...s.stk, id: id || s.stk.id, from: walletName } }))
  tab('stake')
}

// ---- dialogs ----

function serviceOptions(selected: string): { ids: string[]; selected: string } {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const o of ownedServices())
    if (!seen.has(o.id)) {
      seen.add(o.id)
      ids.push(o.id)
    }
  for (const l of localServices())
    if (!seen.has(l.id)) {
      seen.add(l.id)
      ids.push(l.id)
    }
  return { ids, selected: ids.includes(selected) ? selected : '' }
}

function ServiceSelect({
  value,
  onChange,
  id
}: {
  value: string
  onChange: (v: string) => void
  id: string
}): React.JSX.Element {
  const { ids } = serviceOptions(value)
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">(choose later)</option>
      {ids.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  )
}

function validWalletName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name))
    return 'Lowercase letters, digits, hyphen, underscore; 1 to 40 characters.'
  if (name === PARENT) return "That is the owner wallet's name."
  if (walletByName(name)) return 'A wallet with that name already exists.'
  return null
}

interface WalletDialogProps {
  kind: 'new' | 'recover' | 'import'
  onDone: () => void
}

function WalletDialogBody({ kind, onDone }: WalletDialogProps): React.JSX.Element {
  const stkId = S().stk.id
  const [service, setService] = useState(serviceOptions(stkId).selected)
  const [name, setName] = useState(service ? 'app-' + service : '')
  const [manual, setManual] = useState(false)
  const [secret, setSecret] = useState('')
  const [hint, setHint] = useState<React.ReactNode>(
    'Lowercase letters, digits, hyphen, underscore.'
  )
  const [busy, setBusy] = useState(false)

  const pickService = (s: string): void => {
    setService(s)
    if (s && (kind !== 'new' || !manual)) setName('app-' + s)
  }

  const go = async (): Promise<void> => {
    const n = name.trim()
    const err = validWalletName(n)
    if (err) {
      setHint(<ErrText>{err}</ErrText>)
      return
    }
    if (kind === 'recover') {
      const phrase = secret.trim().replace(/\s+/g, ' ').toLowerCase()
      const count = phrase ? phrase.split(' ').length : 0
      if (![12, 15, 18, 21, 24].includes(count)) {
        setHint(<ErrText>A recovery phrase has 12 or 24 words; this has {count}.</ErrText>)
        return
      }
    }
    if (kind === 'import') {
      const hex = secret.trim().replace(/^0[xX]/, '')
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        setHint(<ErrText>That is not a 64-character hex key.</ErrText>)
        return
      }
    }
    setBusy(true)
    lockModal(true)
    setHint(
      <Busy>
        {kind === 'new'
          ? 'Creating the key'
          : kind === 'recover'
            ? 'Recovering the key'
            : 'Importing the key'}
      </Busy>
    )
    let r: {
      ok: boolean
      error?: string
      detail?: string
      name?: string
      address?: string
      mnemonic?: string
    }
    if (kind === 'new')
      r = await window.psm.signer['wallet-create']({ name: n, service_id: service })
    else if (kind === 'recover')
      r = await window.psm.signer['wallet-recover']({
        name: n,
        service_id: service,
        mnemonic: secret.trim().replace(/\s+/g, ' ').toLowerCase()
      })
    else
      r = await window.psm.signer['wallet-import-app']({
        name: n,
        service_id: service,
        privateKeyHex: secret.trim().replace(/^0[xX]/, '')
      })
    setSecret('')
    lockModal(false)
    if (!r.ok) {
      setBusy(false)
      setHint(<ErrText>{`${r.error ?? ''} ${r.detail ?? ''}`}</ErrText>)
      return
    }
    if (kind === 'new') {
      showMnemonic(r as { name: string; address: string; mnemonic: string }, onDone)
      return
    }
    closeModal()
    foot(`Wallet ${r.name} ${kind === 'recover' ? 'recovered' : 'imported'}: ${r.address}`)
    onDone()
  }

  return (
    <>
      <p>
        {kind === 'new'
          ? 'Creates a new key in the encrypted keyring, to be staked as an application for one service. Pick the service it will call; the name follows from it.'
          : kind === 'recover'
            ? 'Re-creates a key in the keyring from a 12 or 24 word recovery phrase, for example an application wallet made on another machine.'
            : 'Adds an existing key to the keyring from its 64-character hex private key.'}
      </p>
      <label>Service</label>
      <ServiceSelect
        id={kind === 'new' ? 'nwService' : kind === 'recover' ? 'rwService' : 'iwService'}
        value={service}
        onChange={pickService}
      />
      <label>Wallet name</label>
      <input
        type="text"
        maxLength={40}
        value={name}
        disabled={busy}
        onChange={(e) => {
          setName(e.target.value)
          setManual(true)
        }}
      />
      <div className="hint">{hint}</div>
      {kind === 'recover' ? (
        <>
          <label>Recovery phrase</label>
          <textarea
            rows={3}
            autoComplete="off"
            spellCheck={false}
            value={secret}
            disabled={busy}
            onChange={(e) => setSecret(e.target.value)}
          />
          <div className="warnbox">
            The phrase is handed to pocketd through the process environment, never through a file or
            the command line. Close any screen sharing before pasting.
          </div>
        </>
      ) : kind === 'import' ? (
        <>
          <label>Private key (hex)</label>
          <input
            type="password"
            autoComplete="off"
            value={secret}
            disabled={busy}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <div className="warnbox">
            The key is handed to pocketd through the process environment, never through a file or
            the command line.
          </div>
        </>
      ) : (
        <div className="warnbox">
          The 24-word recovery phrase is shown once, right after creation, and is not stored
          anywhere. Have your password manager ready and close any screen sharing.
        </div>
      )}
      <div id="modalButtons">
        <button className="btn" disabled={busy} onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={go}>
          {kind === 'new' ? 'Create wallet' : kind === 'recover' ? 'Recover' : 'Import'}
        </button>
      </div>
    </>
  )
}

export async function newWalletDialog(onDone: () => void = () => loadWallets()): Promise<void> {
  if (!(await walletReady('creating a wallet'))) return
  openModal('New application wallet', <WalletDialogBody kind="new" onDone={onDone} />, [])
}
export async function recoverWalletDialog(onDone: () => void = () => loadWallets()): Promise<void> {
  if (!(await walletReady('recovering a wallet'))) return
  openModal(
    'Recover a wallet from its phrase',
    <WalletDialogBody kind="recover" onDone={onDone} />,
    []
  )
}
export async function importAppWalletDialog(
  onDone: () => void = () => loadWallets()
): Promise<void> {
  if (!(await walletReady('importing a wallet'))) return
  openModal(
    'Import an application wallet key',
    <WalletDialogBody kind="import" onDone={onDone} />,
    []
  )
}

function MnemonicBody({
  r,
  onDone
}: {
  r: { name: string; address: string; mnemonic: string }
  onDone: () => void
}): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const words = r.mnemonic.split(' ')
  const rowsOfWords: string[][] = []
  for (let i = 0; i < words.length; i += 4) rowsOfWords.push(words.slice(i, i + 4))
  return (
    <>
      <p>
        Wallet <b>{r.name}</b> was created with address <span className="mono">{r.address}</span>.
      </p>
      <div className="dangerbox">
        These {words.length} words are the only way to recover this wallet outside this machine.
        They are shown once and are not stored anywhere. Anyone who has them controls the wallet.
      </div>
      <div className="keybox" id="nwPhrase">
        <table className="kv words" style={{ width: '100%' }}>
          <tbody>
            {rowsOfWords.map((row, ri) => (
              <tr key={ri}>
                {row.map((w, wi) => (
                  <td key={wi} className="mono" style={{ padding: '3px 6px' }}>
                    <span className="hint">{ri * 4 + wi + 1}</span> {w}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btnrow">
        <button className="btn small" onClick={() => copy(r.mnemonic)}>
          Copy phrase to clipboard
        </button>
      </div>
      <p>
        <input
          type="checkbox"
          id="nwSaved"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />{' '}
        <label htmlFor="nwSaved" className="inline">
          I have written down all {words.length} words in order.
        </label>
      </p>
      <div id="modalButtons">
        <button
          className="btn primary"
          id="nwDone"
          disabled={!saved}
          onClick={() => {
            closeModal()
            foot(`Wallet ${r.name} created: ${r.address}`)
            onDone()
          }}
        >
          Done
        </button>
      </div>
    </>
  )
}

function showMnemonic(
  r: { name: string; address: string; mnemonic: string },
  onDone: () => void
): void {
  openModal('Write down the recovery phrase', <MnemonicBody r={r} onDone={onDone} />, [], true)
}

export async function exportWalletDialog(name: string): Promise<void> {
  if (!(await walletReady('exporting a key'))) return
  const w = walletByName(name)
  if (!w || w.parent) return
  let token = ''
  openModal(
    'Show the private key of ' + name,
    <>
      <div className="dangerbox">
        The key stays in the keyring; this only displays it, for example to give a relay client such
        as pocket-ap its <span className="mono">POCKET_APP_PRIVATE_KEY</span>. Anyone who sees it
        controls the wallet and its stake. Close any screen sharing first.
      </div>
      <p>
        Type <b>EXPORT</b> to continue.
      </p>
      <input
        type="text"
        id="exConfirm"
        autoComplete="off"
        onChange={(e) => (token = e.target.value)}
      />
    </>,
    [
      { label: 'Cancel', onClick: closeModal },
      {
        label: 'Show key',
        cls: 'danger solid',
        onClick: async () => {
          if (token.trim() !== 'EXPORT') return
          setModalBody(
            <p>
              <Busy>Reading the key from the keyring</Busy>
            </p>,
            []
          )
          lockModal(true)
          const r = await window.psm.signer['wallet-export']({ name })
          lockModal(false)
          if (!r.ok) {
            setModalBody(<div className="dangerbox">{`${r.error} ${r.detail ?? ''}`}</div>, [
              { label: 'Close', onClick: closeModal }
            ])
            return
          }
          openModal(
            'Private key of ' + name,
            <>
              <p>
                Address <span className="mono">{w.address}</span>
              </p>
              <div className="keybox" id="exKey">
                {r.hex}
              </div>
              <div className="btnrow">
                <button className="btn small" onClick={() => copy(r.hex)}>
                  Copy to clipboard
                </button>
              </div>
              <div className="hint">
                On the supplier host, pocket-ap reads it from the POCKET_APP_PRIVATE_KEY environment
                variable; do not put it in a file that is committed.
              </div>
            </>,
            [{ label: 'Close', cls: 'primary', onClick: closeModal }]
          )
        }
      }
    ]
  )
}

export async function removeWalletDialog(name: string, onDone: () => void): Promise<void> {
  if (!(await walletReady('removing a wallet'))) return
  const w = walletByName(name)
  if (!w || w.parent) return
  const [bal, app] = await Promise.all([balanceOf(w.address), appRecordOf(w.address)])
  let token = ''
  openModal(
    'Remove wallet ' + name,
    <>
      <p>
        Deletes the key <b>{name}</b> ({shortAddr(w.address)}) from the keyring on this machine.
        Nothing on the network changes.
      </p>
      {bal ? (
        <div className="dangerbox">
          This wallet holds <b>{fmtPokt(bal)} POKT</b> on {netLabel(S().net)}. Without its key or
          phrase those funds are lost.
        </div>
      ) : null}
      {app ? (
        <div className="dangerbox">
          This wallet is staked as an application with <b>{fmtPokt(app.stake.amount)} POKT</b> for{' '}
          {appServiceIds(app).join(', ')}. The stake stays on chain and can only be unstaked with
          this key.
        </div>
      ) : null}
      {bal || app ? <p>Export the key first if you have not saved the recovery phrase.</p> : null}
      <p>Type the wallet name to confirm.</p>
      <input
        type="text"
        id="rmConfirm"
        autoComplete="off"
        onChange={(e) => (token = e.target.value)}
      />
    </>,
    [
      { label: 'Cancel', onClick: closeModal },
      {
        label: 'Remove from this machine',
        cls: 'danger solid',
        onClick: async () => {
          if (token.trim() !== name) return
          setModalBody(
            <p>
              <Busy>Removing the key</Busy>
            </p>,
            []
          )
          lockModal(true)
          const r = await window.psm.signer['wallet-remove']({ name, confirm: name })
          lockModal(false)
          if (!r.ok) {
            setModalBody(<div className="dangerbox">{`${r.error} ${r.detail ?? ''}`}</div>, [
              { label: 'Close', onClick: closeModal }
            ])
            return
          }
          closeModal()
          foot(`Wallet ${name} removed.`)
          onDone()
        }
      }
    ]
  )
}

function FundBody({
  name,
  bal,
  onDone
}: {
  name: string
  bal: number
  onDone: () => void
}): React.JSX.Element {
  const min = S().params.appMinStake || 0
  const suggest = Math.max(0, min + 2 * POKT - bal)
  const [amount, setAmount] = useState(suggest ? String(Math.ceil(suggest / POKT)) : '')
  const [status, setStatus] = useStatus()
  return (
    <>
      <p>
        {name} holds {fmtPokt(bal)} POKT on {netLabel(S().net)}. The application minimum stake is{' '}
        {min ? fmtPokt(min) : '?'} POKT, plus about 1 POKT for gas.
      </p>
      <label>Amount (POKT)</label>
      <input
        type="number"
        id="fwAmount"
        min={0}
        step={1}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <StatusLine status={status} id="fwStatus" />
      <div id="modalButtons">
        <button className="btn" id="fwClose" onClick={closeModal}>
          Close
        </button>
        <button
          className="btn primary"
          id="fwGo"
          onClick={async () => {
            const ok = await fundWallet(name, Math.round(parseFloat(amount) * POKT), setStatus)
            if (ok)
              setTimeout(() => {
                closeModal()
                onDone()
              }, 1500)
          }}
        >
          Send
        </button>
      </div>
    </>
  )
}

export async function fundWalletDialog(name: string, onDone: () => void): Promise<void> {
  const w = walletByName(name)
  if (!w || w.parent) return
  const bal = (await balanceOf(w.address)) || 0
  openModal(
    `Fund ${name} from the owner wallet`,
    <FundBody name={name} bal={bal} onDone={onDone} />,
    []
  )
}
