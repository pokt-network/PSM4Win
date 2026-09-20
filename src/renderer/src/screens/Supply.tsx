// Supply service (docs/SCREENS.md 3.6): the suppliers list and the supplier editor
// (services, stake, operator funding, preflight, execute, unstake).
import { useCallback, useEffect, useState } from 'react'
import { useStore, S, type SupplyRow } from '../store'
import type { ChainSupplier } from '@core/lcd'
import { account, readAfterTx } from '@core/lcd'
import { fmtPokt, fmtInt, fmtDuration, shortAddr, POKT } from '@core/format'
import { unbondingOf, unbondingNote, nextSessionBoundary, supplierServiceIds } from '@core/chain'
import { RPC_TYPES } from '@core/validate'
import {
  Badge,
  NetBadge,
  Empty,
  Busy,
  Checks,
  LogBox,
  PlanBlock,
  StatusLine,
  useLog,
  useStatus,
  ErrText,
  netLabel,
  type CheckNode
} from '../components/ui'
import {
  serverByName,
  stackOf,
  supplierRows,
  supplierRecord,
  ownedServices,
  catalogEntry,
  readCardFor,
  balanceOf,
  refreshNetwork,
  refreshBalance,
  loadHistory,
  recordManifestFor,
  folderForId,
  dockerReady,
  setBusy,
  pollTx,
  saveSettings,
  psm,
  goTo,
  type SupplierRow as ListRow
} from '../lib/actions'
import { confirmTx, fundOperator, TxLink } from '../lib/flows'
import { provisionOn } from './Settings'
import { openSupplier } from './Services'

export function SupplyScreen(): React.JSX.Element {
  const supOpen = useStore((s) => s.supOpen)
  return supOpen ? (
    <SupplierEditor server={supOpen.server} preselect={supOpen.preselect} />
  ) : (
    <SuppliersList />
  )
}

export function supplierStatusCell(
  x: ListRow,
  p: import('@core/chain').LiveParams,
  net: import('@core/networks').Network
): React.ReactNode {
  if (x.state === 'none') return <Badge cls="muted">not provisioned on {netLabel(net)}</Badge>
  if (x.state === 'pending') return <Badge cls="warn">provisioning pending</Badge>
  if (x.rec) {
    const u = unbondingOf(p, x.rec)
    return u ? (
      <>
        <Badge cls="warn">unstaking, {fmtPokt(x.rec.stake.amount)} POKT</Badge>
        <div className="hint">{unbondingNote(u)}</div>
      </>
    ) : (
      <Badge cls="ok">staked, {fmtPokt(x.rec.stake.amount)} POKT</Badge>
    )
  }
  return x.status === 404 ? (
    <Badge cls="muted">not staked</Badge>
  ) : (
    <Badge cls="bad">unreadable (HTTP {x.status})</Badge>
  )
}

function SuppliersList(): React.JSX.Element {
  const { net, params, settings } = useStore()
  const [rows, setRows] = useState<ListRow[] | null>(null)
  const load = useCallback(async () => setRows(await supplierRows()), [])
  useEffect(() => {
    void load()
  }, [load, net, settings?.servers])
  return (
    <div className="panel">
      <h2>
        Suppliers <NetBadge />
      </h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        A supplier is the operator key on one of your servers, staked on chain for one or more
        services behind that server's RelayMiner URL. The owner wallet receives the revenue and the
        returned stake; the operator signs relays and claims and never leaves the server. One
        supplier per server per network; servers come from Settings.
      </p>
      <div id="supList" style={{ marginTop: 10 }}>
        {rows === null ? (
          <Busy>Reading suppliers</Busy>
        ) : !rows.length ? (
          <Empty
            text="No servers configured. A supplier lives on a server."
            button={
              <button className="btn primary" onClick={() => goTo('settings')}>
                Add a server
              </button>
            }
          />
        ) : (
          <table className="services">
            <thead>
              <tr>
                <th>Server</th>
                <th>Status on {netLabel(net)}</th>
                <th>Services</th>
                <th>Operator gas</th>
                <th>URL</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const st = x.stack
                const ids = supplierServiceIds(x.rec)
                return (
                  <tr key={x.server.name}>
                    <td className="svcid">
                      {x.server.name}
                      <div className="hint mono">{st?.operator ? shortAddr(st.operator) : ''}</div>
                    </td>
                    <td>{supplierStatusCell(x, params, net)}</td>
                    <td>{ids.length ? ids.join(', ') : <span className="hint">none</span>}</td>
                    <td>
                      {x.gas === null ? (
                        '?'
                      ) : x.gas < 2 * POKT ? (
                        <Badge cls="warn">{fmtPokt(x.gas)} POKT</Badge>
                      ) : (
                        fmtPokt(x.gas) + ' POKT'
                      )}
                    </td>
                    <td>
                      {st?.url ? (
                        x.answers ? (
                          <Badge cls="ok">answers</Badge>
                        ) : (
                          <Badge cls="bad">no answer</Badge>
                        )
                      ) : (
                        <span className="hint">none</span>
                      )}
                    </td>
                    <td className="actions">
                      {x.state === 'ready' ? (
                        <button
                          className="btn small primary"
                          onClick={() => openSupplier(x.server.name)}
                        >
                          {x.rec ? 'Manage' : 'Stake'}
                        </button>
                      ) : (
                        <button
                          className="btn small primary"
                          onClick={() => provisionOn(x.server.name, net)}
                        >
                          {x.state === 'pending'
                            ? 'Continue provisioning'
                            : `Provision for ${netLabel(net)}`}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="btnrow">
        <button
          className="btn small"
          onClick={async () => {
            await refreshNetwork()
            void load()
          }}
        >
          Refresh
        </button>
        <button className="btn small" onClick={() => goTo('settings')}>
          Add a server
        </button>
      </div>
    </div>
  )
}

// ---- editor ----

interface Snapshot {
  op: string
  upokt: number
  services: { service_id: string; url: string; rpc_type: string }[]
  isUpdate: boolean
  server: string
  conn: { host: string; port: number; user: string; key_path: string; path: string }
  key: string
}

function SupplierEditor({
  server,
  preselect
}: {
  server: string
  preselect?: string
}): React.JSX.Element {
  const { net, params, busy, catalog } = useStore()
  const s = serverByName(server)
  const st = stackOf(s, net)
  const label = netLabel(net)
  const [operator, setOperator] = useState(st?.operator ?? '')
  const [url, setUrl] = useState(st?.url ?? '')
  const [rec, setRec] = useState<ChainSupplier | null>(null)
  const [recStatus, setRecStatus] = useState(0)
  const [rows, setRows] = useState<SupplyRow[]>([])
  const [showAll, setShowAll] = useState(false)
  const [addId, setAddId] = useState('')
  const [amount, setAmount] = useState('')
  const [opBal, setOpBal] = useState<number | null | undefined>(undefined)
  const [opHint, setOpHint] = useState(
    'The operator pays the stake and its ongoing claim and proof gas from this balance.'
  )
  const [fund, setFund] = useState('')
  const [fundStatus, setFundStatus] = useStatus()
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const [plan, setPlan] = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [planOk, setPlanOk] = useState(false)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [unstakeStatus, setUnstakeStatus] = useStatus()
  const { lines, log, clear } = useLog()

  useEffect(() => {
    void saveSettings({ supplierServer: server })
  }, [server])

  // loadSupplierServices(preselect). The HTA runs it at open and after a successful execute
  // only; row edits and the amount persist until then (the amount is set by openSupplier).
  const loadRows = useCallback(
    async (
      opts: { seedAmount?: boolean; usePreselect?: boolean } = {}
    ): Promise<ChainSupplier | null> => {
      const seedAmount = opts.seedAmount ?? true
      const pre = (opts.usePreselect ?? true) ? preselect : undefined
      const sr = await supplierRecord(st?.operator)
      setRec(sr.rec)
      setRecStatus(sr.status)
      const out: SupplyRow[] = []
      const rpcFor = async (id: string): Promise<string> => {
        const c = (await readCardFor(id)) as { rpc_types?: { type?: string }[] } | null
        return c?.rpc_types?.[0]?.type || 'REST'
      }
      for (const sc of sr.rec?.services ?? []) {
        const ep = sc.endpoints?.[0] ?? {}
        out.push({
          id: sc.service_id,
          name: catalogEntry(sc.service_id)?.name ?? '',
          url: ep.url || st?.url || '',
          rpc: ep.rpc_type || 'REST',
          checked: true,
          staked: true
        })
      }
      for (const o of ownedServices())
        if (!out.some((r) => r.id === o.id))
          out.push({
            id: o.id,
            name: o.name,
            url: st?.url ?? '',
            rpc: await rpcFor(o.id),
            checked: false,
            staked: false
          })
      if (pre) {
        const pr = out.find((r) => r.id === pre)
        if (pr) pr.checked = true
        else
          out.push({
            id: pre,
            name: catalogEntry(pre)?.name ?? '',
            url: st?.url ?? '',
            rpc: await rpcFor(pre),
            checked: true,
            staked: false
          })
      }
      setRows(out)
      if (seedAmount) {
        const current = sr.rec ? Number(sr.rec.stake.amount) : 0
        setAmount(String(Math.max(current, S().params.supMinStake || 0) / POKT))
      }
      return sr.rec
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, net, preselect, st?.operator, st?.url]
  )

  // Seed once the catalog has loaded (the HTA's reads are synchronous, so it always has it);
  // a later catalog refresh must not re-seed and discard the user's ticks.
  const catalogLoaded = catalog !== null
  useEffect(() => {
    if (catalogLoaded) void loadRows()
  }, [loadRows, catalogLoaded])

  // refreshOperatorBalance()
  const refreshOp = useCallback(async () => {
    const op = operator.trim()
    if (!/^pokt1[0-9a-z]{38}$/.test(op)) {
      setOpBal(undefined)
      setOpHint('Enter the operator address to see its balance.')
      return null
    }
    const [bal, existing] = await Promise.all([balanceOf(op), supplierRecord(op)])
    setOpBal(bal)
    const pokt = parseFloat(amount)
    const stake = pokt > 0 ? Math.round(pokt * POKT) : 0
    const current = existing.rec ? Number(existing.rec.stake.amount) : 0
    const need = Math.max(0, stake - current) + 5 * POKT
    if (bal === null) setOpHint('Could not read the operator balance.')
    else if (bal >= need)
      setOpHint(
        `Enough for ${stake > current ? fmtPokt(stake - current) + ' POKT of stake plus' : ''} gas. Keep a few POKT here for claims and proofs.`
      )
    else {
      setOpHint(
        `Needs about ${fmtPokt(need - bal)} POKT more to cover ${stake > current ? fmtPokt(stake - current) + ' POKT of stake plus' : ''} gas.`
      )
      setFund((f) => f.trim() || String(Math.ceil((need - bal) / POKT)))
    }
    return bal
  }, [operator, amount])
  useEffect(() => {
    void refreshOp()
    // The HTA refreshes on open, server change, after fund, and after execute; not while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, net])

  const invalidate = (): void => setPlanOk(false)
  const setRow = (i: number, patch: Partial<SupplyRow>): void => {
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
    invalidate()
  }
  const owned = ownedServices()
  const addList = (showAll ? (catalog ?? []) : owned).filter(
    (c) => !rows.some((r) => r.id === c.id)
  )
  const ownedIds = new Set(owned.map((o) => o.id))
  const addService = async (): Promise<void> => {
    if (!addId || rows.some((r) => r.id === addId)) return
    const c = (await readCardFor(addId)) as { rpc_types?: { type?: string }[] } | null
    setRows((r) => [
      ...r,
      {
        id: addId,
        name: catalogEntry(addId)?.name ?? '',
        url: st?.url ?? '',
        rpc: c?.rpc_types?.[0]?.type || 'REST',
        checked: true,
        staked: false
      }
    ])
    setAddId('')
    invalidate()
  }

  const preflight = async (): Promise<void> => {
    if (S().busy) return
    const op = operator.trim()
    const pokt = parseFloat(amount)
    const items: CheckNode[] = []
    const sshPath = st?.dir ?? ''
    setShowResults(true)
    setPlan(null)
    clear()
    setStatus('')
    setPlanOk(false)
    if (!S().imported)
      items.push({
        level: 'fail',
        text: 'No wallet imported (it is the owner named in the stake).'
      })
    if (!s)
      items.push({ level: 'fail', text: 'Choose a server. Servers are configured under Settings.' })
    else if (!/^\/[A-Za-z0-9._/-]+$/.test(sshPath))
      items.push({
        level: 'fail',
        text: `Server '${s.name}' has no ${label} stack. Provision it under Settings.`
      })
    else if (!(await psm().files.fileExists(s.keyPath)))
      items.push({
        level: 'fail',
        text: `The SSH key file for '${s.name}' was not found on this PC.`,
        sub: s.keyPath
      })
    if (!/^pokt1[0-9a-z]{38}$/.test(op))
      items.push({
        level: 'fail',
        text: 'Operator address must be a pokt1 address (43 characters).'
      })
    if (!(pokt > 0)) items.push({ level: 'fail', text: 'Enter a stake amount in POKT.' })
    if (op && S().address && op === S().address)
      items.push({
        level: 'fail',
        text: 'The operator must be a different key from the owner wallet (non-custodial). Generate it on the server.'
      })
    const chosen = rows.filter((r) => r.checked)
    const dropped = rows.filter((r) => !r.checked && r.staked).map((r) => r.id)
    if (!chosen.length)
      items.push({ level: 'fail', text: 'Tick at least one service for this supplier to serve.' })
    for (const c of chosen) {
      if (!/^https:\/\/[^\s]+$/.test(c.url.trim()))
        items.push({ level: 'fail', text: `Endpoint URL for '${c.id}' must start with https://.` })
      if (!catalogEntry(c.id))
        items.push({ level: 'fail', text: `Service '${c.id}' is not registered on ${label}.` })
    }
    if (items.some((i) => i.level === 'fail') || !s) return setChecks(items)

    await refreshNetwork()
    await refreshBalance()
    const p = S().params
    const upokt = Math.round(pokt * POKT)
    if (p.supMinStake === undefined)
      items.push({ level: 'fail', text: 'Could not read the supplier minimum stake.' })
    else if (upokt < p.supMinStake)
      items.push({
        level: 'fail',
        text: `Stake ${fmtPokt(upokt)} POKT is below the minimum ${fmtPokt(p.supMinStake)} POKT.`
      })
    else if (upokt === p.supMinStake)
      items.push({
        level: 'warn',
        text: `Stake equals the live minimum of ${fmtPokt(p.supMinStake)} POKT with no margin.`,
        sub: 'A stake that drops below the minimum (a slash, or a raised minimum) is auto-unstaked. Add a few hundred POKT of margin.'
      })
    else
      items.push({
        level: 'ok',
        text: `Stake ${fmtPokt(upokt)} POKT is above the live minimum of ${fmtPokt(p.supMinStake)} POKT.`
      })
    items.push({
      level: 'ok',
      text: `Serving ${chosen.length} service${chosen.length === 1 ? '' : 's'}: ${chosen.map((x) => `${x.id} (${x.rpc})`).join(', ')}.`
    })
    if (dropped.length)
      items.push({
        level: 'warn',
        text: `Unticked services will stop being served by this supplier: ${dropped.join(', ')}.`,
        sub: 'The stake list on chain is replaced by the ticked services.'
      })
    try {
      const acct = await account(S().net, op)
      if (acct.exists) {
        if (acct.hasPubKey)
          items.push({
            level: 'ok',
            text: 'Operator account exists and its public key is on chain.'
          })
        else
          items.push({
            level: 'fail',
            text: 'Operator account exists but has never signed a transaction, so its public key is not on chain.',
            sub: 'Send any transaction from the operator once (for example 1 uPOKT to itself), then run preflight again.'
          })
      } else
        items.push({
          level: 'fail',
          text: `Operator account does not exist on ${label} yet.`,
          sub: 'Fund it with a little POKT and send one transaction from it so its public key is published.'
        })
    } catch {
      items.push({
        level: 'fail',
        text: `Operator account does not exist on ${label} yet.`,
        sub: 'Fund it with a little POKT and send one transaction from it so its public key is published.'
      })
    }
    const opB = (await balanceOf(op)) || 0
    const existing = await supplierRecord(op)
    let current = 0
    let isUpdate = false
    if (existing.rec) {
      isUpdate = true
      current = Number(existing.rec.stake.amount)
      if (existing.rec.owner_address !== S().address)
        items.push({
          level: 'fail',
          text: `This operator already belongs to a supplier owned by ${existing.rec.owner_address}, not the owner wallet.`
        })
      items.push({
        level: 'info',
        text: `Supplier already staked with ${fmtPokt(current)} POKT for ${supplierServiceIds(existing.rec).join(', ') || 'no services'}. This is an update.`,
        sub: 'The new amount must be at least the current stake.'
      })
      if (upokt < current)
        items.push({
          level: 'fail',
          text: `New stake must be at least the current ${fmtPokt(current)} POKT.`
        })
    } else if (existing.status === 404)
      items.push({
        level: 'ok',
        text: 'No supplier exists for this operator yet; this creates one.'
      })
    else
      items.push({
        level: 'fail',
        text: `Could not read the supplier record (HTTP ${existing.status}).`
      })
    const delta = Math.max(0, upokt - current)
    const need = delta + 1 * POKT
    if (opB < need) {
      items.push({
        level: 'fail',
        text: `Operator holds ${fmtPokt(opB)} POKT but needs ${fmtPokt(delta)} POKT of stake plus gas. Fund it from the owner wallet using the box above.`,
        sub: `Suggested: ${fmtPokt(need - opB + 4 * POKT)} POKT.`
      })
      if (!fund.trim()) setFund(String(Math.ceil((need - opB + 4 * POKT) / POKT)))
    } else if (opB - delta < 2 * POKT)
      items.push({
        level: 'warn',
        text: `After staking, the operator would keep only ${fmtPokt(opB - delta)} POKT for claim and proof gas. Consider topping it up.`
      })
    else
      items.push({
        level: 'ok',
        text: `Operator holds ${fmtPokt(opB)} POKT: covers ${fmtPokt(delta)} POKT of stake plus gas, leaving ${fmtPokt(opB - delta)} POKT for claims and proofs.`
      })
    const urls = [...new Set(chosen.map((c) => c.url.trim()))]
    const reach = await Promise.all(urls.map((u) => psm().app.probeUrl(u)))
    urls.forEach((u, i) =>
      items.push(
        reach[i]
          ? { level: 'ok', text: `${u} answered (HTTP ${reach[i]}).` }
          : {
              level: 'warn',
              text: `Could not reach ${u} from this PC. Gateways will not be able to either unless it is a temporary outage.`
            }
      )
    )
    const ns = nextSessionBoundary(p)
    if (ns)
      items.push({
        level: 'info',
        text: `The stake takes effect at the next session boundary: height ${fmtInt(ns.height)}, about ${ns.blocks} block${ns.blocks === 1 ? '' : 's'}${p.blockTime ? ` (~${fmtDuration(ns.blocks * p.blockTime)})` : ''} from now.`
      })
    if (p.supplierUnbondingSessions)
      items.push({
        level: 'info',
        text: `Unstaking later takes ${fmtInt(p.supplierUnbondingSessions)} sessions${p.blockTime && p.blocksPerSession ? `, about ${fmtDuration(p.supplierUnbondingSessions * p.blocksPerSession * p.blockTime)},` : ''} before the POKT returns to the owner wallet.`
      })
    if (items.some((i) => i.level === 'fail')) {
      setChecks(items)
      return setStatus('Fix the red items and run preflight again.', 'err')
    }
    setChecks([...items])
    setStatus('Building the plan', 'busy')
    const services = chosen.map((x) => ({
      service_id: x.id,
      url: x.url.trim(),
      rpc_type: x.rpc as (typeof RPC_TYPES)[number]
    }))
    const conn = { host: s.host, port: s.port, user: s.user, key_path: s.keyPath, path: sshPath }
    const r = await psm().signer['remote-stake-supplier']({
      network: S().net,
      ...conn,
      owner_address: S().address,
      operator_address: op,
      stake_upokt: upokt,
      services,
      dry: true
    })
    if (!r.ok || !('config' in r)) {
      items.push({
        level: 'fail',
        text: 'The signer refused the plan.',
        sub: `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail ?? ''}`
      })
      setChecks([...items])
      return setStatus('', 'err')
    }
    setPlan(r.command + '\n\n# supplier_stake.yaml (copied to the server)\n' + r.config)
    setPlanOk(true)
    setSnap({ op, upokt, services, isUpdate, server: s.name, conn, key: JSON.stringify(services) })
    setStatus(`Preflight passed. Review the plan, then press Stake supplier on ${label}.`, 'ok')
  }

  const execute = async (): Promise<void> => {
    if (!planOk || S().busy || !snap) return
    const f = snap
    const chosenNow = rows
      .filter((r) => r.checked)
      .map((r) => ({ service_id: r.id, url: r.url.trim(), rpc_type: r.rpc }))
    if (
      f.server !== server ||
      f.op !== operator.trim() ||
      f.upokt !== Math.round(parseFloat(amount) * POKT) ||
      f.key !== JSON.stringify(chosenNow)
    ) {
      setStatus('The form changed since preflight. Run preflight again.', 'err')
      setPlanOk(false)
      return
    }
    const ids = f.services.map((x) => x.service_id)
    const ok = await confirmTx({
      mainTitle: 'Confirm MainNet supplier stake',
      mainBody: (
        <div className="dangerbox">
          This locks <b>{fmtPokt(f.upokt)} POKT</b> of real funds as a supplier stake for operator{' '}
          <b>{f.op}</b>, serving <b>{ids.join(', ')}</b>. Unstaking takes{' '}
          {S().params.supplierUnbondingSessions || 'many'} sessions.
        </div>
      ),
      token: f.server,
      prompt: (
        <p>
          Type the server name (<b>{f.server}</b>) to confirm.
        </p>
      ),
      mainOkLabel: 'Stake supplier on MainNet',
      betaText: `Stake ${fmtPokt(f.upokt)} POKT as the supplier on '${f.server}' for ${ids.join(', ')} on Beta TestNet now?`,
      betaOkLabel: 'Stake supplier'
    })
    if (!ok) return
    setBusy(true)
    setPlanOk(false)
    clear()
    log(
      `Copying the stake config to ${f.server} and signing with the operator key there, ${fmtPokt(f.upokt)} POKT for ${ids.join(', ')} on ${label}`
    )
    setStatus('Waiting for the server (simulating gas, signing, broadcasting)', 'busy')
    const r = await psm().signer['remote-stake-supplier']({
      network: S().net,
      ...f.conn,
      owner_address: S().address,
      operator_address: f.op,
      stake_upokt: f.upokt,
      services: f.services as never
    })
    if (!r.ok || !('txhash' in r)) {
      setBusy(false)
      log(
        `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail || (r as { raw_log?: string }).raw_log || ''}`,
        'err'
      )
      return setStatus('Supplier stake failed.', 'err')
    }
    log(
      <>
        Accepted into the mempool. Tx <TxLink hash={r.txhash} />
        {r.gas ? ` (gas estimate ${fmtInt(r.gas)})` : ''}
      </>
    )
    setStatus('Waiting for the transaction to be included in a block', 'busy')
    const t = await pollTx(r.txhash)
    if (!t.ok) {
      setBusy(false)
      log(t.error ?? '', 'err')
      return setStatus('The transaction did not succeed.', 'err')
    }
    log(`Included in block ${fmtInt(t.height)}.`, 'ok')
    const v = await readAfterTx(
      () => supplierRecord(f.op),
      (x) => !!x.rec
    )
    let okv = false
    let short = false
    let pendingAt = 0
    const pending: string[] = []
    const missing: string[] = []
    if (!v.rec)
      log(
        `The supplier record could not be read back (${v.status ? 'HTTP ' + v.status : 'the node did not answer'}). The transaction itself is in a block.`,
        'err'
      )
    else {
      const got = supplierServiceIds(v.rec)
      const scheduled: Record<string, number> = {}
      for (const he of v.rec.service_config_history ?? [])
        if (he.service && Number(he.deactivation_height || 0) === 0)
          scheduled[he.service.service_id] = Number(he.activation_height || 0)
      short = Number(v.rec.stake.amount) < f.upokt
      for (const id of ids) {
        if (got.includes(id)) continue
        // A stake never adds a service to the session already running: the service sits
        // in the config history with the next boundary as its activation height and
        // joins the active list there. Scheduled is success, not a missing service.
        if (scheduled[id] !== undefined) {
          pending.push(id)
          pendingAt = Math.max(pendingAt, scheduled[id])
        } else missing.push(id)
      }
      okv = !short && !missing.length
      log(
        `On chain: supplier ${f.op} staked ${fmtPokt(v.rec.stake.amount)} POKT; active for ${got.join(', ') || 'nothing yet'}${pending.length ? `; ${pending.join(', ')} scheduled, ${pending.length === 1 ? 'activates' : 'activate'} at block ${fmtInt(pendingAt)}` : ''}${missing.length ? `; ${missing.join(', ')} neither active nor scheduled` : ''}.`,
        okv ? 'ok' : 'err'
      )
    }
    // The screen's own log dies with the next reload, and chain reads never reach
    // app.log, so a verification that did not confirm is recorded here or nowhere.
    if (!okv)
      void psm().app.logVerification({
        what: 'supplier',
        network: S().net,
        txhash: r.txhash,
        height: t.height ?? 0,
        outcome: !v.rec ? 'unreadable' : short ? 'stake-short' : 'not-listed',
        status: v.status,
        services: v.rec ? missing : ids
      })
    setStatus(
      okv
        ? `Supplier staked on ${label} for ${ids.join(', ')}.${pending.length ? ` ${pending.join(', ')} ${pending.length === 1 ? 'is scheduled and activates' : 'are scheduled and activate'} at block ${fmtInt(pendingAt)}, the next session boundary.` : ''}`
        : !v.rec
          ? `Staked in block ${fmtInt(t.height)}, but the supplier record could not be read back just now, so this is unconfirmed. Open Suppliers in a moment to check it.`
          : short
            ? `Transaction succeeded but the supplier holds ${fmtPokt(v.rec.stake.amount)} POKT on chain, less than the ${fmtPokt(f.upokt)} POKT submitted; check the Activity list.`
            : `Transaction succeeded but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} neither active nor scheduled on the supplier; check the Activity list.`,
      okv ? 'ok' : v.rec ? 'err' : ''
    )
    if (okv) {
      for (const svc of f.services) {
        const folder = folderForId(svc.service_id)
        if (!folder) continue
        await recordManifestFor(folder, 'supplier_stake_tx', r.txhash)
        await recordManifestFor(folder, 'supplier_operator', f.op)
        await recordManifestFor(folder, 'supplier_url', svc.url)
        await recordManifestFor(folder, 'deploy_host', f.server)
        await recordManifestFor(folder, 'deploy_path', f.conn.path)
      }
    }
    setBusy(false)
    void refreshBalance()
    void refreshOp()
    void loadHistory()
    void loadRows({ seedAmount: false, usePreselect: false })
  }

  const doFund = async (): Promise<void> => {
    const r = await fundOperator(
      operator.trim(),
      Math.round(parseFloat(fund) * POKT),
      setFundStatus
    )
    if (r.ok) {
      await refreshOp()
      setFund('')
    }
  }

  const unstake = async (): Promise<void> => {
    if (S().busy || !rec) return
    const op = rec.operator_address
    if (unbondingOf(params, rec))
      return setUnstakeStatus('This supplier is already unstaking.', 'err')
    if (!S().imported || !dockerReady())
      return setUnstakeStatus('Owner wallet and Docker must be ready.', 'err')
    if (rec.owner_address !== S().address)
      return setUnstakeStatus(
        `This supplier is owned by ${rec.owner_address}, not the owner wallet.`,
        'err'
      )
    await refreshNetwork()
    const p = S().params
    const ns = nextSessionBoundary(p)
    const sessions = p.supplierUnbondingSessions || 0
    const blocks = sessions * (p.blocksPerSession || 0)
    const ret = ns ? ns.height + blocks : 0
    const eta = p.blockTime ? fmtDuration(((ns ? ns.blocks : 0) + blocks) * p.blockTime) : ''
    const ids = supplierServiceIds(rec)
    const body = (
      <>
        <div className="dangerbox">
          This unstakes the supplier on <b>{server}</b> (operator <b>{op}</b>) on {label}. It stops
          serving <b>{ids.join(', ') || 'its services'}</b> when the current session ends
          {ns ? ` at block ${fmtInt(ns.height)}` : ''}.
        </div>
        <p>
          Its <b>{fmtPokt(rec.stake.amount)} POKT</b> stake is then locked for{' '}
          <b>{fmtInt(sessions)} sessions</b>
          {eta ? (
            <>
              {' '}
              (about <b>{eta}</b>)
            </>
          ) : null}
          {ret ? ` and returns to the owner wallet around block ${fmtInt(ret)}` : ''}. The unbonding
          period is a network parameter read just now. To serve again after that, provision is kept
          and the supplier is staked anew.
        </p>
      </>
    )
    const ok = await confirmTx({
      mainTitle: 'Confirm MainNet unstake',
      mainBody: body,
      token: 'UNSTAKE',
      mainOkLabel: 'Unstake on MainNet',
      betaText: '',
      betaOkLabel: 'Unstake on Beta TestNet',
      betaModal: { title: 'Unstake this supplier', body }
    })
    if (!ok) return
    setBusy(true)
    setUnstakeStatus('Waiting for pocketd (simulating gas, signing, broadcasting)', 'busy')
    const r = await psm().signer['tx-unstake-supplier']({ network: S().net, operator_address: op })
    if (!r.ok || !('txhash' in r)) {
      setBusy(false)
      return setUnstakeStatus(
        `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail ?? ''}`,
        'err'
      )
    }
    setUnstakeStatus(`Broadcast, waiting for the block (${r.txhash.substring(0, 10)})`, 'busy')
    const t = await pollTx(r.txhash)
    setBusy(false)
    if (!t.ok) return setUnstakeStatus(t.error ?? '', 'err')
    const v = await supplierRecord(op)
    setRec(v.rec)
    await refreshNetwork()
    void loadHistory()
    void refreshBalance()
    const u = unbondingOf(S().params, v.rec)
    setUnstakeStatus(
      `Unstake accepted in block ${fmtInt(t.height)}.${u ? ` Serving until block ${fmtInt(u.serving_until)}; ${unbondingNote(u)}.` : ''}`,
      'ok'
    )
  }

  const u = unbondingOf(params, rec)
  if (!s) return <SuppliersList />
  return (
    <>
      <div className="panel">
        <h2>
          Supplier on <span id="supEditName">{server}</span>{' '}
          <span className="hint mono">{`${s.user}@${s.host}`}</span>
          <button
            className="btn small"
            style={{ float: 'right' }}
            onClick={() => useStore.setState({ supOpen: null })}
          >
            Back to suppliers
          </button>
        </h2>
        <p className="hint" style={{ margin: '0 0 6px 0' }}>
          Only the operator may set the service list, so the stake config is copied to the server
          over SSH and signed there with the operator key, paid from the operator's balance (fund it
          from the owner wallet below). One stake covers every service ticked below; the list on
          chain is replaced on each stake, so leave existing services ticked to keep serving them.
        </p>
        <div className="row">
          <div>
            <label>Operator address</label>
            <input
              type="text"
              id="supOperator"
              placeholder="pokt1..."
              maxLength={43}
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />
            <div className="hint" id="supServerHint">
              Signs on {`${s.user}@${s.host}`} with the {label} operator keyring in{' '}
              {st?.dir ? (
                <span className="mono">{st.dir}</span>
              ) : (
                <ErrText>a stack that is not provisioned (Settings)</ErrText>
              )}
              .
            </div>
          </div>
          <div>
            <label>Public HTTPS URL of the RelayMiner</label>
            <input
              type="text"
              id="supUrl"
              placeholder="https://..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="hint">
              From the server entry; used for every service below unless a row overrides it.
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Services this supplier serves</h2>
        <div className="row">
          <div>
            <label>Add a service</label>
            <div className="filerow">
              <select id="supAdd" value={addId} onChange={(e) => setAddId(e.target.value)}>
                {!addList.length ? (
                  <option value="">
                    {showAll
                      ? 'Every service is already listed'
                      : 'All your services are listed; tick Show all to add others'}
                  </option>
                ) : null}
                {addList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(ownedIds.has(c.id) ? '★ ' : '') + c.id + (c.name ? ` (${c.name})` : '')}
                  </option>
                ))}
              </select>
              <button className="btn small" onClick={addService}>
                Add
              </button>
            </div>
            <div className="hint">
              <input
                type="checkbox"
                id="supShowAll"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />{' '}
              <label htmlFor="supShowAll" className="inline">
                Show all services on the network
              </label>{' '}
              (off: only services the owner wallet owns)
            </div>
          </div>
          <div />
        </div>
        <div id="supServices" style={{ marginTop: 10 }}>
          {!rows.length ? (
            <div className="hint">
              No services yet. Register one, or tick Show all and add one from the catalog.
            </div>
          ) : (
            <table className="services">
              <thead>
                <tr>
                  <th />
                  <th>Service</th>
                  <th>Protocol</th>
                  <th>Endpoint URL</th>
                  <th>Now</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.checked}
                        onChange={(e) => setRow(i, { checked: e.target.checked })}
                      />
                    </td>
                    <td className="svcid">
                      {r.id}
                      {r.name ? <div className="hint">{r.name}</div> : null}
                    </td>
                    <td>
                      <select
                        value={r.rpc}
                        disabled={!r.checked}
                        onChange={(e) => setRow(i, { rpc: e.target.value })}
                      >
                        {RPC_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={r.url}
                        disabled={!r.checked}
                        onChange={(e) => setRow(i, { url: e.target.value })}
                      />
                    </td>
                    <td>
                      {r.staked ? (
                        r.checked ? (
                          <Badge cls="ok">staked</Badge>
                        ) : (
                          <Badge cls="bad">will be dropped</Badge>
                        )
                      ) : r.checked ? (
                        <Badge cls="info">to add</Badge>
                      ) : (
                        <Badge cls="muted">not served</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Stake</h2>
        <div className="row">
          <div>
            <label>Stake amount (POKT)</label>
            <input
              type="number"
              id="supAmount"
              min={0}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <div className="hint" id="supHint">
              {params.supMinStake !== undefined
                ? `Minimum on ${label} right now: ${fmtPokt(params.supMinStake)} POKT. One stake covers every service the supplier lists.`
                : 'Minimum is fetched live from the network. Keep a margin above it: a stake that drops below the minimum is auto-unstaked.'}
            </div>
          </div>
          <div>
            <label>Operator liquid balance</label>
            <div className="big" id="supOpBal">
              {opBal === null || opBal === undefined ? (
                '?'
              ) : (
                <>
                  {fmtPokt(opBal)} <small>POKT</small>
                </>
              )}
            </div>
            <div className="hint" id="supOpBalHint">
              {opHint}
            </div>
            <div className="filerow" style={{ marginTop: 8 }}>
              <input
                type="number"
                id="supFundAmount"
                min={0}
                step={1}
                placeholder="POKT to send"
                value={fund}
                onChange={(e) => setFund(e.target.value)}
              />
              <button className="btn small" disabled={busy} onClick={doFund}>
                Send from owner wallet
              </button>
            </div>
            <StatusLine status={fundStatus} id="supFundStatus" />
          </div>
        </div>
        <div className="btnrow">
          <button className="btn primary" disabled={busy} onClick={preflight}>
            Run preflight
          </button>
          <button
            className="btn primary"
            id="btnSupply"
            disabled={!planOk || busy}
            onClick={execute}
          >
            Stake supplier on {label}
          </button>
        </div>
      </div>
      {showResults ? (
        <div className="panel" id="supResults">
          <h2>Preflight</h2>
          <Checks items={checks} id="supChecks" />
          <PlanBlock label="Exact command the signer will run" text={plan} />
          <StatusLine status={status} id="supStatus" />
          <LogBox lines={lines} id="supLog" />
        </div>
      ) : null}
      {rec ? (
        <div className="panel" id="supUnstakePanel">
          <h2>Unstake this supplier</h2>
          {u ? (
            <div id="supUnstakeBox" className="warnbox">
              <b>Unstaking.</b> This supplier serves until block {fmtInt(u.serving_until)} and its{' '}
              {fmtPokt(rec.stake.amount)} POKT {unbondingNote(u)}. The record clears when the stake
              returns.
            </div>
          ) : (
            <>
              <p className="hint" style={{ margin: '0 0 6px 0' }} id="supUnstakeHint">
                Stops supplying every service from the end of the current session. The stake then
                stays locked for the unbonding period, a network parameter read live, and returns to
                the owner wallet. Signed by the owner wallet on this PC; the operator key on the
                server is not involved.
              </p>
              <div className="btnrow">
                <button className="btn danger" id="btnUnstake" disabled={busy} onClick={unstake}>
                  Unstake supplier
                </button>
              </div>
            </>
          )}
          <StatusLine status={unstakeStatus} id="supUnstakeStatus" />
          {recStatus ? null : null}
        </div>
      ) : null}
    </>
  )
}
