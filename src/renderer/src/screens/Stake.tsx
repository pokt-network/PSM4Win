// Stake application with gateway delegation (docs/SCREENS.md 3.5).
import { useCallback, useEffect, useState } from 'react'
import { useStore, S } from '../store'
import { fmtPokt, fmtInt, fmtDuration, shortAddr, POKT } from '@core/format'
import { suggestedAppStake, appUnbonding, appServiceIds } from '@core/chain'
import {
  service as lcdService,
  gateways as lcdGateways,
  type ChainApplication,
  type ChainGateway,
  type LcdError
} from '@core/lcd'
import {
  Checks,
  LogBox,
  PlanBlock,
  StatusLine,
  useLog,
  useStatus,
  WarnText,
  netLabel,
  type CheckNode
} from '../components/ui'
import {
  PARENT,
  ownedServices,
  walletByName,
  walletForService,
  dockerReady,
  dockerCycle,
  refreshNetwork,
  refreshBalance,
  loadHistory,
  loadWallets,
  balanceOf,
  appRecordOf,
  recordManifestFor,
  folderForId,
  setBusy,
  pollTx,
  copy,
  psm,
  type WalletRef
} from '../lib/actions'
import { confirmTx, fundWallet, TxLink } from '../lib/flows'
import { newWalletDialog } from './Wallets'

export function StakeScreen(): React.JSX.Element {
  const { stk, wallets, params, net, busy, imported, catalog, address } = useStore()
  const set = (patch: Partial<typeof stk>): void =>
    useStore.setState((s) => ({ stk: { ...s.stk, ...patch } }))
  const [status, setStatus] = useStatus()
  const [fundStatus, setFundStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const [plan, setPlan] = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [planOk, setPlanOk] = useState(false)
  const [snap, setSnap] = useState<{
    id: string
    upokt: number
    from: string
    address: string
  } | null>(null)
  const [fromBal, setFromBal] = useState<number | null | undefined>(undefined)
  const [fromRec, setFromRec] = useState<ChainApplication | null>(null)
  const { lines, log, clear } = useLog()

  const owned = ownedServices()
  const w: WalletRef | null = walletByName(stk.from) || walletByName(PARENT)
  const id = stk.id

  // Service list: keep the selection when it exists, else the first owned service.
  useEffect(() => {
    if (owned.length && !owned.some((o) => o.id === stk.id)) set({ id: owned[0].id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, address])

  // onStakeServiceChange: preselect the wallet made for the service and suggest an amount.
  useEffect(() => {
    const wf = walletForService(id)
    const patch: Partial<typeof stk> = {}
    if (wf) patch.from = wf.name
    if (!stk.amount.trim() && params.appMinStake)
      patch.amount = String(suggestedAppStake(params) / POKT)
    if (Object.keys(patch).length) set(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, params.appMinStake, wallets])

  // onStakeFromChange + refreshStakeFromBalance
  const refreshFrom = useCallback(async () => {
    const ww = walletByName(S().stk.from) || walletByName(PARENT)
    if (!ww?.address) {
      setFromBal(undefined)
      setFromRec(null)
      return
    }
    const [bal, rec] = await Promise.all([balanceOf(ww.address), appRecordOf(ww.address)])
    setFromBal(bal)
    setFromRec(rec)
    const ub = appUnbonding(rec)
    if (ub && rec) {
      const cur = Number(rec.stake.amount)
      if (!(parseFloat(S().stk.amount) > cur / POKT))
        set({
          amount: String(
            Math.max(suggestedAppStake(S().params), cur + (S().params.appMinStake || 0) * 0.1) /
              POKT
          )
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    void refreshFrom()
  }, [refreshFrom, stk.from, net, imported, address])

  const stake = poktToUpokt(stk.amount) || suggestedAppStake(params)
  const current = fromRec ? Number(fromRec.stake.amount) : 0
  const need = Math.max(0, stake - current) + 1 * POKT
  useEffect(() => {
    if (
      fromBal !== null &&
      fromBal !== undefined &&
      !w?.parent &&
      fromBal < need &&
      !stk.fund.trim()
    )
      set({ fund: String(Math.ceil((need - fromBal) / POKT)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromBal, need])

  const fromHint = !w ? (
    'Import the owner wallet first.'
  ) : w.parent ? (
    <>
      The owner wallet can hold only one application stake.{' '}
      <a onClick={() => newWalletDialog(() => loadWallets())}>Create an app wallet</a> for{' '}
      {id || 'the service'} instead.
    </>
  ) : w.service_id && id && w.service_id !== id ? (
    <WarnText>
      {w.name} was made for {w.service_id}; staking it here re-points it to {id}.
    </WarnText>
  ) : (
    `Signs and holds the stake. Address ${shortAddr(w.address)}.`
  )
  const ub = appUnbonding(fromRec)
  const balHint =
    fromBal === null
      ? 'Could not read the balance.'
      : fromBal === undefined
        ? 'The staking wallet pays the stake and gas from its own balance.'
        : w?.parent
          ? 'The owner wallet pays from its own balance.'
          : fromBal >= need
            ? `Enough for ${fmtPokt(Math.max(0, stake - current))} POKT of stake plus gas.`
            : `Needs about ${fmtPokt(need - fromBal)} POKT more to cover the stake plus gas.`

  const preflight = async (rechecked = false): Promise<void> => {
    if (S().busy) return
    const sid = stk.id.trim()
    const pokt = parseFloat(stk.amount)
    const items: CheckNode[] = []
    setShowResults(true)
    setPlan(null)
    clear()
    setStatus('')
    setPlanOk(false)
    if (!dockerReady() && !rechecked) {
      setStatus('Checking Docker Desktop and the pocketd image', 'busy')
      await dockerCycle(false)
      return preflight(true)
    }
    const ww = walletByName(stk.from) || walletByName(PARENT)
    const st = S()
    if (!st.imported) items.push({ level: 'fail', text: 'No wallet imported.' })
    if (!ww) items.push({ level: 'fail', text: 'Choose the wallet to stake as.' })
    if (!dockerReady())
      items.push({
        level: 'fail',
        text: st.docker?.ok
          ? 'The pocketd image is not downloaded. Use the Download pocketd button in the top bar.'
          : 'Docker Desktop is not running. Start it (button in the top bar) and run preflight again.',
        sub: st.docker?.detail ?? ''
      })
    if (!/^[A-Za-z0-9_-]{1,42}$/.test(sid))
      items.push({ level: 'fail', text: 'Service ID is invalid.' })
    if (!(pokt > 0)) items.push({ level: 'fail', text: 'Enter a stake amount in POKT.' })
    if (items.some((i) => i.level === 'fail') || !ww) return setChecks(items)
    await refreshNetwork()
    await refreshBalance()
    const p = S().params
    const label = netLabel(S().net)
    const upokt = Math.round(pokt * POKT)
    if (ww.parent)
      items.push({
        level: 'warn',
        text: 'Staking the owner wallet itself. It can hold only one application stake, so a dedicated app wallet is the better choice.',
        sub: "Create one on the Wallets tab and pick it under 'Stake as'."
      })
    else
      items.push({
        level: 'ok',
        text: `Staking as app wallet '${ww.name}' (${ww.address}).${ww.service_id && ww.service_id !== sid ? ` It was made for '${ww.service_id}'; this re-points it.` : ''}`
      })
    if (p.appMinStake === undefined)
      items.push({ level: 'fail', text: 'Could not read the application minimum stake.' })
    else if (upokt < p.appMinStake)
      items.push({
        level: 'fail',
        text: `Stake ${fmtPokt(upokt)} POKT is below the minimum ${fmtPokt(p.appMinStake)} POKT.`
      })
    else if (upokt < p.appMinStake * 1.01)
      items.push({
        level: 'fail',
        text: `Stake ${fmtPokt(upokt)} POKT has no margin above the minimum of ${fmtPokt(p.appMinStake)} POKT.`,
        sub: `Every settled relay is paid from the stake, and the protocol unstakes an application the moment it falls below the minimum. Stake at least ${fmtPokt(suggestedAppStake(p))} POKT.`
      })
    else
      items.push({
        level: 'ok',
        text: `Stake ${fmtPokt(upokt)} POKT is ${fmtPokt(upokt - p.appMinStake)} POKT above the live minimum of ${fmtPokt(p.appMinStake)} POKT; that margin is what relays draw down.`
      })
    try {
      const svc = await lcdService(S().net, sid)
      if (svc)
        items.push({ level: 'ok', text: `Service '${sid}' exists on ${label} ('${svc.name}').` })
      else
        items.push({
          level: 'fail',
          text: `Service '${sid}' is not registered on ${label}. Register it first.`
        })
    } catch (e) {
      items.push({
        level: 'fail',
        text: `Could not check the service (HTTP ${(e as LcdError).status ?? 0}).`
      })
    }
    let cur = 0
    const app = await appRecordOf(ww.address)
    if (app) {
      cur = Number(app.stake.amount)
      const ids = appServiceIds(app)
      if (ids.length && ids[0] !== sid)
        items.push({
          level: 'warn',
          text: `This wallet is already staked as an application for '${ids.join(', ')}' with ${fmtPokt(cur)} POKT.`,
          sub: `Staking again re-points it to '${sid}'. An application stakes for exactly one service; the amount must not be lower than the current stake.`
        })
      else
        items.push({
          level: 'info',
          text: `This wallet already has an application stake of ${fmtPokt(cur)} POKT for '${sid}'. Staking again raises it to the new amount.`,
          sub: 'The new amount must be at least the current stake.'
        })
      if (upokt < cur)
        items.push({
          level: 'fail',
          text: `New stake must be at least the current ${fmtPokt(cur)} POKT (stakes cannot be lowered this way).`
        })
      if (appUnbonding(app))
        items.push({
          level: 'warn',
          text: `This application is unbonding (its stake stops at the session ending at block ${fmtInt(appUnbonding(app))}). Staking now cancels that and keeps its gateway delegations.`
        })
    } else
      items.push({ level: 'ok', text: `This wallet has no application stake yet on ${label}.` })
    const bal = await balanceOf(ww.address)
    setFromBal(bal)
    setFromRec(app)
    const delta = Math.max(0, upokt - cur)
    const nd = delta + 1 * POKT
    if (bal === null || bal === undefined)
      items.push({ level: 'fail', text: "Could not read the staking wallet's balance." })
    else if (bal < nd)
      items.push({
        level: 'fail',
        text: `Balance ${fmtPokt(bal)} POKT cannot cover ${fmtPokt(delta)} POKT of new stake plus about 1 POKT gas.${ww.parent ? '' : ' Fund it from the owner wallet using the box above.'}`
      })
    else
      items.push({
        level: 'ok',
        text: `Balance ${fmtPokt(bal)} POKT covers ${fmtPokt(delta)} POKT of additional stake plus gas.`
      })
    if (items.some((i) => i.level === 'fail')) {
      setChecks(items)
      return setStatus('Fix the red items and run preflight again.', 'err')
    }
    setChecks([...items])
    setStatus('Building the plan', 'busy')
    const r = await psm().signer['tx-stake-app']({
      network: S().net,
      service_id: sid,
      stake_upokt: upokt,
      from: ww.name,
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
    setPlan(r.command + '\n\n# app_stake.yaml\n' + r.config)
    setPlanOk(true)
    setSnap({ id: sid, upokt, from: ww.name, address: ww.address })
    setStatus(`Preflight passed. Review the plan, then press Stake on ${label}.`, 'ok')
  }

  const execute = async (): Promise<void> => {
    if (!planOk || S().busy || !snap) return
    const f = snap
    if (
      f.id !== stk.id.trim() ||
      f.from !== (stk.from || PARENT) ||
      f.upokt !== Math.round(parseFloat(stk.amount) * POKT)
    ) {
      setStatus('The form changed since preflight. Run preflight again.', 'err')
      setPlanOk(false)
      return
    }
    const label = netLabel(S().net)
    const ok = await confirmTx({
      mainTitle: 'Confirm MainNet stake',
      mainBody: (
        <div className="dangerbox">
          This locks <b>{fmtPokt(f.upokt)} POKT</b> of real funds from <b>{f.from}</b> as an
          application stake for <b>{f.id}</b>. Unstaking takes an unbonding period.
        </div>
      ),
      token: f.id,
      mainOkLabel: 'Stake on MainNet',
      betaText: `Stake ${fmtPokt(f.upokt)} POKT from '${f.from}' for '${f.id}' on Beta TestNet now?`,
      betaOkLabel: 'Stake'
    })
    if (!ok) return
    setBusy(true)
    setPlanOk(false)
    clear()
    log(
      `Signing and broadcasting stake-application for '${f.id}' as '${f.from}' with ${fmtPokt(f.upokt)} POKT on ${label}`
    )
    setStatus('Waiting for pocketd (simulating gas, signing, broadcasting)', 'busy')
    const r = await psm().signer['tx-stake-app']({
      network: S().net,
      service_id: f.id,
      stake_upokt: f.upokt,
      from: f.from
    })
    if (!r.ok || !('txhash' in r)) {
      setBusy(false)
      log(
        `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail || (r as { raw_log?: string }).raw_log || ''}`,
        'err'
      )
      return setStatus('Staking failed.', 'err')
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
    const a = await appRecordOf(f.address)
    let okv = false
    if (a) {
      const ids = appServiceIds(a)
      okv = ids.includes(f.id) && Number(a.stake.amount) >= f.upokt
      log(
        `On chain: '${f.from}' staked ${fmtPokt(a.stake.amount)} POKT for '${ids.join(', ')}'.`,
        okv ? 'ok' : 'err'
      )
    }
    setStatus(
      okv
        ? `'${f.from}' is staked as an application for '${f.id}' on ${label}.`
        : 'Transaction succeeded but verification did not match; check the Activity tab.',
      okv ? 'ok' : 'err'
    )
    if (okv) {
      const folder = folderForId(f.id)
      if (folder) {
        await recordManifestFor(folder, 'app_stake_tx', r.txhash)
        await recordManifestFor(folder, 'app_wallet', f.from)
        await recordManifestFor(folder, 'app_address', f.address)
      }
    }
    setBusy(false)
    void refreshBalance()
    void loadHistory()
    await loadWallets()
    void refreshFrom()
  }

  const fund = async (): Promise<void> => {
    if (!w || w.parent)
      return setFundStatus(
        "Pick an application wallet under 'Stake as'; the owner wallet does not fund itself.",
        'err'
      )
    const ok = await fundWallet(w.name, Math.round(parseFloat(stk.fund) * POKT), setFundStatus)
    if (ok) {
      set({ fund: '' })
      void refreshFrom()
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Application stake</h2>
        <p className="hint" style={{ margin: '0 0 6px 0' }}>
          An application stake lets a wallet send relays to a service through a gateway, which is
          how you test the service once a supplier is serving it. On Pocket an application stakes
          for exactly one service, so use a dedicated application wallet per service (Wallets) and
          fund it from the owner wallet below. The stake is drawn down as relays settle, and an
          application whose stake falls below the minimum is unstaked by the protocol, so always
          stake with a margin above it.
        </p>
        {ub && fromRec && w ? (
          <div id="stkAppBox" className="warnbox">
            <b>{w.name} is unbonding.</b> Its application stake of {fmtPokt(fromRec.stake.amount)}{' '}
            POKT
            {Number(fromRec.stake.amount) < (params.appMinStake || 0)
              ? ` fell below the minimum of ${fmtPokt(params.appMinStake)} POKT as relays settled, so the protocol unstaked it`
              : ' is being returned'}
            ; the session it stops at ends at block {fmtInt(ub)}
            {ub - Number(params.height || 0) > 0 && params.blockTime
              ? ` (~${fmtDuration((ub - Number(params.height || 0)) * params.blockTime)})`
              : ''}
            . <b>Staking again cancels the unbonding</b> and keeps its delegations: enter an amount
            with a margin above the minimum, fund the wallet if needed, run preflight, and stake.
          </div>
        ) : null}
        <div className="row">
          <div>
            <label>Service</label>
            <select id="stkId" value={stk.id} onChange={(e) => set({ id: e.target.value })}>
              {!owned.length ? (
                <option value="">No registered services for this wallet on {netLabel(net)}</option>
              ) : null}
              {owned.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} ({o.name})
                </option>
              ))}
            </select>
            <div className="hint">
              Lists the services the owner wallet owns on the selected network. Register a service
              first if the list is empty.
            </div>
          </div>
          <div>
            <label>Stake as</label>
            <select
              id="stkFrom"
              value={stk.from || PARENT}
              onChange={(e) => set({ from: e.target.value })}
            >
              <option value={PARENT}>Owner wallet ({PARENT})</option>
              {wallets.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name} {x.service_id ? `(for ${x.service_id})` : '(unassigned)'}
                </option>
              ))}
            </select>
            <div className="hint" id="stkFromHint">
              {fromHint}
            </div>
          </div>
          <div>
            <label>Stake amount (POKT)</label>
            <input
              type="number"
              id="stkAmount"
              min={0}
              step={1}
              placeholder={params.appMinStake ? String(suggestedAppStake(params) / POKT) : '1000'}
              value={stk.amount}
              onChange={(e) => set({ amount: e.target.value })}
            />
            <div className="hint" id="stkHint">
              {params.appMinStake !== undefined
                ? `Minimum on ${netLabel(net)} right now: ${fmtPokt(params.appMinStake)} POKT. Stake above it; suggested ${fmtPokt(suggestedAppStake(params))} POKT.`
                : 'Minimum is fetched live from the network.'}
            </div>
          </div>
        </div>
        <div className="row">
          <div>
            <label>Staking wallet balance</label>
            <div className="big" id="stkFromBal">
              {fromBal === null || fromBal === undefined ? (
                '?'
              ) : (
                <>
                  {fmtPokt(fromBal)} <small>POKT</small>
                </>
              )}
            </div>
            <div className="hint" id="stkFromBalHint">
              {balHint}
            </div>
          </div>
          <div>
            <label>Fund it from the owner wallet</label>
            <div className="filerow">
              <input
                type="number"
                id="stkFundAmount"
                min={0}
                step={1}
                placeholder="POKT to send"
                value={stk.fund}
                onChange={(e) => set({ fund: e.target.value })}
              />
              <button className="btn small" disabled={busy} onClick={fund}>
                Send from owner
              </button>
            </div>
            <StatusLine status={fundStatus} id="stkFundStatus" />
          </div>
        </div>
        <div className="btnrow">
          <button className="btn primary" disabled={busy} onClick={() => preflight()}>
            Run preflight
          </button>
          <button
            className="btn primary"
            id="btnStake"
            disabled={!planOk || busy}
            onClick={execute}
          >
            Stake on {netLabel(net)}
          </button>
        </div>
      </div>
      {showResults ? (
        <div className="panel" id="stkResults">
          <h2>Preflight</h2>
          <Checks items={checks} id="stkChecks" />
          <PlanBlock label="Exact command the signer will run" text={plan} />
          <StatusLine status={status} id="stkStatus" />
          <LogBox lines={lines} id="stkLog" />
        </div>
      ) : null}
      <DelegationPanel />
    </>
  )
}

function poktToUpokt(v: string): number {
  const n = parseFloat(v)
  return n > 0 ? Math.round(n * POKT) : 0
}

// ---- Gateway delegation ----

interface Holder {
  wallet: WalletRef
  app: ChainApplication
}

function DelegationPanel(): React.JSX.Element {
  const { wallets, address, net, params, busy, imported } = useStore()
  const [holders, setHolders] = useState<Holder[]>([])
  const [from, setFrom] = useState('')
  const [gws, setGws] = useState<ChainGateway[]>([])
  const [gw, setGw] = useState('')
  const [status, setStatus] = useStatus()
  const label = netLabel(net)

  const load = useCallback(async () => {
    const list: WalletRef[] = []
    if (S().address) list.push({ name: PARENT, address: S().address, parent: true, service_id: '' })
    for (const w of S().wallets) list.push({ ...w, parent: false })
    const recs = await Promise.all(list.map((h) => appRecordOf(h.address)))
    const hs: Holder[] = []
    list.forEach((w, i) => {
      if (recs[i]) hs.push({ wallet: w, app: recs[i]! })
    })
    setHolders(hs)
    setFrom((cur) => (hs.some((h) => h.wallet.name === cur) ? cur : (hs[0]?.wallet.name ?? '')))
    let g: ChainGateway[] = []
    try {
      g = await lcdGateways(S().net)
    } catch {
      g = []
    }
    setGws(g)
    setGw((cur) => (g.some((x) => x.address === cur) ? cur : (g[0]?.address ?? '')))
  }, [])
  useEffect(() => {
    void load()
  }, [load, wallets, address, net, imported])

  const h = holders.find((x) => x.wallet.name === from) ?? null
  const list = h?.app.delegatee_gateway_addresses ?? []
  const max = params.appMaxDelegated || 0
  const pend = Object.keys(
    (h?.app as { pending_undelegations?: Record<string, unknown> } | null)?.pending_undelegations ??
      {}
  )

  const tx = async (kind: 'delegate' | 'undelegate', gwArg?: string): Promise<void> => {
    if (S().busy) return
    const target = gwArg || gw
    if (!h) return setStatus('Choose a staked application.', 'err')
    if (!/^pokt1[0-9a-z]{38}$/.test(target)) return setStatus('Choose a gateway.', 'err')
    if (!S().imported || !dockerReady())
      return setStatus('Owner wallet and Docker must be ready.', 'err')
    if (kind === 'delegate' && list.includes(target))
      return setStatus(`${h.wallet.name} is already delegated to that gateway.`, 'err')
    if (kind === 'delegate' && max && list.length >= max)
      return setStatus(
        `This application already uses all ${max} allowed delegations. Undelegate one first.`,
        'err'
      )
    const verb = kind === 'delegate' ? 'Delegate' : 'Undelegate'
    const prep = kind === 'delegate' ? ' to ' : ' from '
    const body = (
      <p>
        {verb} <b>{h.wallet.name}</b> ({h.wallet.address}){prep}gateway <b>{target}</b> on {label}.{' '}
        {kind === 'delegate'
          ? 'The gateway can then sign relays for this application; its stake pays for them.'
          : 'The gateway stops signing for this application when the current session ends.'}{' '}
        Costs gas only.
      </p>
    )
    const ok = await confirmTx({
      mainTitle: `Confirm MainNet ${verb.toLowerCase()}`,
      mainBody: body,
      token: null,
      mainOkLabel: `${verb} on MainNet`,
      betaText: `${verb} ${h.wallet.name}${prep}${target} on Beta TestNet?`,
      betaOkLabel: verb
    })
    if (!ok) return
    setBusy(true)
    setStatus('Waiting for pocketd (simulating gas, signing, broadcasting)', 'busy')
    const r = await psm().signer[
      kind === 'delegate' ? 'tx-delegate-gateway' : 'tx-undelegate-gateway'
    ]({ network: S().net, from: h.wallet.name, gateway_address: target })
    if (!r.ok || !('txhash' in r)) {
      setBusy(false)
      return setStatus(
        `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail ?? ''}`,
        'err'
      )
    }
    setStatus(`Broadcast, waiting for the block (${r.txhash.substring(0, 10)})`, 'busy')
    const t = await pollTx(r.txhash)
    setBusy(false)
    if (!t.ok) return setStatus(t.error ?? '', 'err')
    void loadHistory()
    await load()
    setStatus(
      `${verb}d ${h.wallet.name}${prep}${shortAddr(target)} in block ${fmtInt(t.height)}.${kind === 'undelegate' ? ' It takes effect when the current session ends.' : ''}`,
      'ok'
    )
  }

  return (
    <div className="panel" id="dlgPanel">
      <h2>Gateway delegation</h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        A staked application can let a gateway sign relays on its behalf, which is how a service is
        reached through a gateway such as the one behind the agentic portal instead of by a
        self-signing client. Delegation costs gas only; the application's stake still pays for the
        relays. Undelegating takes effect when the current session ends. The number of gateways an
        application may delegate to is a network parameter read live.
      </p>
      <div className="row">
        <div>
          <label>Application</label>
          <select id="dlgFrom" value={from} onChange={(e) => setFrom(e.target.value)}>
            {!holders.length ? (
              <option value="">No staked application on this network</option>
            ) : null}
            {holders.map((x) => (
              <option key={x.wallet.name} value={x.wallet.name}>
                {x.wallet.name} (staked for {appServiceIds(x.app).join(', ')})
              </option>
            ))}
          </select>
          <div className="hint" id="dlgFromHint">
            {h ? (
              <>
                <div
                  className="addr"
                  style={{ cursor: 'pointer', margin: '4px 0' }}
                  title="Click to copy"
                  onClick={() => copy(h.wallet.address)}
                >
                  {h.wallet.address}
                </div>
                Application address, click to copy; a gateway operator asks for it. {list.length} of{' '}
                {max || '?'} allowed delegations used.{' '}
                {appUnbonding(h.app) ? (
                  <WarnText>
                    This application is unbonding; restake it above (Application stake) to keep the
                    delegation.
                  </WarnText>
                ) : null}
              </>
            ) : (
              'Wallets of this app that hold an application stake here.'
            )}
          </div>
        </div>
        <div>
          <label>Gateway</label>
          <select id="dlgGateway" value={gw} onChange={(e) => setGw(e.target.value)}>
            {!gws.length ? <option value="">No gateways registered on {label}</option> : null}
            {gws.map((g) => (
              <option key={g.address} value={g.address}>
                {g.address} ({fmtPokt(g.stake.amount)} POKT staked)
              </option>
            ))}
          </select>
          <div className="hint" id="dlgGatewayHint">
            {gws.length} gateway{gws.length === 1 ? '' : 's'} registered on {label}, read just now.
            Pick the one that will route requests to your service.
          </div>
        </div>
      </div>
      <div className="btnrow">
        <button
          className="btn primary"
          id="btnDelegate"
          disabled={!holders.length || busy}
          onClick={() => tx('delegate')}
        >
          Delegate
        </button>
      </div>
      <StatusLine status={status} id="dlgStatus" />
      <h2 style={{ marginTop: 14 }}>Current delegations</h2>
      <div id="dlgList" className="hint">
        {!holders.length ? (
          'Stake an application above first.'
        ) : !h ? (
          'Choose an application.'
        ) : (
          <>
            {!list.length ? (
              <div className="hint">
                {h.wallet.name} is not delegated to any gateway. Only self-signing clients such as
                pocket-ap can use it until it is.
              </div>
            ) : (
              <table className="services">
                <thead>
                  <tr>
                    <th>Gateway</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((g) => (
                    <tr key={g}>
                      <td className="mono">{g}</td>
                      <td className="actions">
                        <button
                          className="btn small danger"
                          disabled={busy}
                          onClick={() => tx('undelegate', g)}
                        >
                          Undelegate
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {pend.length ? (
              <div className="hint" style={{ marginTop: 6 }}>
                Pending undelegations, effective when the session ending at{' '}
                {pend.map((k) => 'block ' + fmtInt(k)).join(', ')} closes.
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
