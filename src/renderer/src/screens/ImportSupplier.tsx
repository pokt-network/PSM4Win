// Import a supplier set up by hand (Suppliers, docs/SCREENS.md 3.6): the wizard. It surveys
// the server the supplier lives on, shows the plan (src/core/import.ts), builds the app's
// stack beside theirs with the same operator key, then switches over: new relays stop first,
// their miner finishes proving what it served, and only then does the app's stack start.
// Progress is kept on the stack entry in settings, so an import resumes after a restart.
import { useEffect, useRef, useState } from 'react'
import { useStore, S } from '../store'
import type { Network } from '@core/networks'
import { CADDY_DIR } from '@core/networks'
import { STACK_LAYOUT } from '@core/versions'
import { stackUrl, portOfStackUrl } from '@core/stack'
import {
  planImport,
  stopPhases,
  proofWindowsOf,
  sessionEndOf,
  proofCloseAfter,
  type ImportPlan,
  type ImportProgress,
  type ImportTarget,
  type ProofWindows
} from '@core/import'
import type { SurveyReport } from '@core/survey'
import {
  supplier as supplierAt,
  params as moduleParams,
  latestHeight,
  openClaims,
  type ChainSupplier
} from '@core/lcd'
import { fmtPokt, fmtInt, fmtDuration, shortAddr, POKT } from '@core/format'
import { RE } from '@core/validate'
import {
  Badge,
  NetBadge,
  Busy,
  Checks,
  LogBox,
  StatusLine,
  useLog,
  useStatus,
  ErrText,
  WarnText,
  netLabel,
  type CheckNode
} from '../components/ui'
import {
  servers,
  serverByName,
  stackOf,
  stackState,
  stackDirDefault,
  stackProjectDefault,
  stackPorts,
  hostOfUrl,
  setStack,
  saveServers,
  balanceOf,
  loadHistory,
  setBusy,
  psm,
  goTo,
  copy,
  type ServerEntry
} from '../lib/actions'
import { confirmTx } from '../lib/flows'
import { confirmDialog } from '../lib/modal'

type Sg = ReturnType<typeof psm>['signer']
const errOf = (r: unknown): string => {
  const x = r as { error?: string; detail?: string; err?: string }
  return [x.err || x.error || '', x.detail || ''].filter(Boolean).join(' ')
}
const targetLabel = (t: ImportTarget): string =>
  `${t.kind === 'unit' ? 'service' : 'container'} ${t.name} (${t.role === 'proxy' ? 'web proxy' : t.role === 'miner' ? 'miner' : t.role === 'relayer' ? 'relayer' : 'RelayMiner'})`

/** The server entry of a stack whose import of `operator` is under way on `net`, if any. */
function importingServer(operator: string, net: Network): ServerEntry | null {
  return (
    servers().find((s) => {
      const st = stackOf(s, net)
      return !!st?.import && st.operator === operator
    }) ?? null
  )
}

export function openImport(operator: string, server?: string): void {
  useStore.setState({ impOpen: { operator, server }, supOpen: null })
}

export function ImportWizard({
  operator,
  server: preset
}: {
  operator: string
  server?: string
}): React.JSX.Element {
  const { net, address, params, busy } = useStore()
  // Re-rendered when settings change, since the stack entry holds the import's progress.
  useStore((x) => x.settings)
  const [rec, setRec] = useState<ChainSupplier | null | undefined>(undefined)
  const [recErr, setRecErr] = useState('')
  const resuming = importingServer(operator, net)
  const eligible = servers().filter((s) => {
    const st = stackOf(s, net)
    return stackState(st) === 'none' || (!!st?.import && st.operator === operator)
  })
  const [serverName, setServerName] = useState(resuming?.name ?? preset ?? eligible[0]?.name ?? '')
  const s = serverByName(serverName)
  const st = s ? stackOf(s, net) : null
  const progress = st?.import && st.operator === operator ? st.import : null
  const [dir, setDir] = useState(st?.dir || stackDirDefault(net))
  const [report, setReport] = useState<SurveyReport | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [windows, setWindows] = useState<ProofWindows | null>(null)
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const { lines, log, clear } = useLog()
  const [drain, setDrain] = useState<{ height: number; until: number; claims: number } | null>(null)
  const [failedAt, setFailedAt] = useState<ImportProgress['stage'] | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    let on = true
    supplierAt(net, operator)
      .then((r) => on && setRec(r))
      .catch((e) => on && setRecErr(e instanceof Error ? e.message : String(e)))
    moduleParams(net, 'shared')
      .then((p) => on && setWindows(proofWindowsOf(p)))
      .catch(() => on && setWindows(null))
    return () => {
      on = false
    }
  }, [net, operator])

  const stakedUrl = rec?.services?.[0]?.endpoints?.[0]?.url ?? ''
  const host = hostOfUrl(stakedUrl)
  const port = portOfStackUrl(stakedUrl)
  const urlProblem = !rec
    ? ''
    : !stakedUrl
      ? 'It is staked without a public URL.'
      : !/^https:\/\//.test(stakedUrl) || !RE.hostname.test(host) || /^[0-9.]+$/.test(host)
        ? `It is staked at ${stakedUrl}. The app serves suppliers at https:// with a DNS name, which Caddy gets a certificate for, so this one cannot be imported as it is.`
        : ''
  const custodial = !!rec && rec.owner_address === rec.operator_address
  const otherOwner = !!rec && !custodial && rec.owner_address !== address
  const phases = plan ? stopPhases(plan) : null
  const waitBlocks =
    windows && params.height
      ? proofCloseAfter(windows, sessionEndOf(windows, params.height)) - params.height
      : null

  const back = (): void => useStore.setState({ impOpen: null })
  const conn = (): { host: string; port: number; user: string; key_path: string } => ({
    host: s!.host,
    port: s!.port,
    user: s!.user,
    key_path: s!.keyPath
  })
  const saveProgress = async (p: ImportProgress | undefined): Promise<void> => {
    await setStack(s!.name, net, { import: p })
  }

  // ---- 1. survey ----
  const survey = async (): Promise<void> => {
    if (!s) return setStatus('Choose the server the supplier runs on.', 'err')
    setReport(null)
    setPlan(null)
    setStatus(`Looking at ${s.name} (read-only)`, 'busy')
    const r = await psm().signer['server-survey']({ ...conn(), operator_address: operator })
    if (!r.ok) return setStatus(`The survey did not run: ${errOf(r)}`, 'err')
    const hasAppStack = stackState(st) !== 'none' && !progress
    setReport(r.report)
    setPlan(planImport(r.report, { operator, stakedUrl, hasAppStack }))
    setStatus('')
  }

  // ---- 2. the run ----
  const results: CheckNode[] = []
  const mark = (label: string, ok: boolean, note?: string): void => {
    results.push({ level: ok ? 'ok' : 'fail', text: label, sub: note || '' })
    setChecks([...results])
  }

  const stage = async (sg: Sg): Promise<boolean> => {
    const c = { ...conn(), path: dir }
    const project = stackProjectDefault(net)
    const ports = stackPorts(net)
    log(
      `Copying the app's ${netLabel(net)} RelayMiner stack to ${dir}, beside theirs. Nothing of theirs changes yet.`
    )
    const r1 = await sg['supplier-ship']({
      ...c,
      network: net,
      hostname: host,
      project,
      caddy_dir: CADDY_DIR,
      health_port: ports.health,
      relayer_metrics_port: ports.relayer_metrics,
      miner_metrics_port: ports.miner_metrics,
      block_time: Math.round(params.blockTime || 0)
    })
    if (!r1.ok) return (mark('Copy the stack', false, errOf(r1)), false)
    mark('Copy the stack', true, dir)
    if (plan!.key) {
      log(
        `Copying the operator key from ${plan!.key.path} into the new stack. It stays on the server.`
      )
      const r2 = await sg['supplier-run']({
        ...c,
        step: 'operator-adopt',
        source_kind: plan!.key.kind,
        source_path: plan!.key.path,
        operator_address: operator
      })
      if (!r2.ok) return (mark('Operator key', false, errOf(r2)), false)
    } else {
      log('Sending the operator key you pasted to the new stack on the server.')
      const r2 = await sg['supplier-import-operator']({
        ...c,
        operator_address: operator,
        secret
      })
      setSecret('')
      if (!r2.ok) return (mark('Operator key', false, errOf(r2)), false)
    }
    mark('Operator key', true, operator)
    const r3 = await sg['supplier-run']({ ...c, step: 'keys' })
    if (!r3.ok) return (mark('RelayMiner key file', false, errOf(r3)), false)
    mark('RelayMiner key file', true, 'written')
    for (const b of plan!.backends) {
      const r4 = await sg['supplier-run']({ ...c, step: 'backend-attach', container: b.container! })
      if (!r4.ok) return (mark(`Backend for ${b.service}`, false, errOf(r4)), false)
      const r5 = await sg['supplier-run']({
        ...c,
        step: 'add-service',
        service_id: b.service,
        backend_url: b.url!,
        health_path: '/',
        stage: true
      })
      if (!r5.ok) return (mark(`Backend for ${b.service}`, false, errOf(r5)), false)
      mark(`Backend for ${b.service}`, true, `${b.url} (their container ${b.container})`)
    }
    const gas = await balanceOf(operator)
    if (gas !== null && gas < 2 * POKT)
      log(
        `The operator holds ${fmtPokt(gas)} POKT, little for claims and proofs. Top it up from the supplier's page after the import.`
      )
    const ph = stopPhases(plan!)
    await setStack(s!.name, net, {
      dir,
      project,
      url: stackUrl(host, port),
      operator,
      import: {
        stage: 'staged',
        first: ph.first,
        after: ph.after,
        stopped: [],
        started_at: new Date().toISOString()
      }
    })
    return true
  }

  const stopAll = async (
    sg: Sg,
    list: ImportTarget[],
    p: ImportProgress
  ): Promise<ImportProgress | null> => {
    const c = { ...conn(), path: dir }
    let cur = p
    for (const t of list) {
      if (cur.stopped.includes(t.name)) continue
      const base = { ...c, step: 'theirs' as const, their_kind: t.kind, their_name: t.name }
      const r = await sg['supplier-run']({ ...base, their_action: 'stop' })
      if (!r.ok) return (mark(`Stop their ${targetLabel(t)}`, false, errOf(r)), null)
      // Kept from starting again on its own, so a reboot does not bring it back beside the app's.
      await sg['supplier-run']({ ...base, their_action: 'disable' })
      cur = { ...cur, stopped: [...cur.stopped, t.name] }
      await saveProgress(cur)
      mark(`Stop their ${targetLabel(t)}`, true)
    }
    return cur
  }

  /** Waits until their last claims are proved; false when the wizard was left. */
  const waitForClaims = async (p: ImportProgress): Promise<boolean> => {
    const w = windows ?? proofWindowsOf(await moduleParams(net, 'shared'))
    for (;;) {
      if (!live.current) return false
      try {
        const [h, claims] = await Promise.all([latestHeight(net), openClaims(net, operator)])
        const pending = w ? claims.filter((c) => proofCloseAfter(w, c.session_end) >= h) : claims
        setDrain({ height: h, until: p.drainUntil ?? h, claims: pending.length })
        if (h > (p.drainUntil ?? 0) && !pending.length) return true
      } catch (e) {
        log(
          `Could not read the chain just now (${e instanceof Error ? e.message : e}); trying again.`
        )
      }
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }

  const run = async (): Promise<void> => {
    if (S().busy || !s) return
    const sg = psm().signer
    clear()
    setChecks([])
    setFailedAt(null)
    let p: ImportProgress | null = progress ?? null
    if (!p) {
      if (!plan || plan.blockers.length || urlProblem) return
      if (!plan.key && !secret.trim()) return setStatus('Paste the operator key first.', 'err')
    }
    if (!p || p.stage === 'staged') {
      const ok = await confirmTx({
        mainTitle: 'Import this supplier on MainNet',
        mainBody: (
          <div className="dangerbox">
            The app takes over the supplier <b>{operator}</b> on {s.name}. Its RelayMiner stops
            taking new relays, and for about{' '}
            {waitBlocks && params.blockTime
              ? fmtDuration(waitBlocks * params.blockTime)
              : 'a few sessions'}{' '}
            it serves nothing while its last claims are proved. Then the app's stack starts with the
            same operator key. Nothing is staked or sent.
          </div>
        ),
        token: 'IMPORT',
        mainOkLabel: 'Import',
        betaText: `Take over the supplier ${operator} on ${s.name}? It stops taking new relays and serves nothing for a while as its last claims are proved; then the app's stack starts with the same operator key.`,
        betaOkLabel: 'Import'
      })
      if (!ok) return
    }
    setBusy(true)
    setStatus('Importing', 'busy')
    try {
      if (!p) {
        if (!(await stage(sg))) {
          setStatus(
            'The import stopped before anything of theirs was touched. Fix the problem and try again.',
            'err'
          )
          return
        }
        p = stackOf(serverByName(s.name), net)!.import!
      } else mark("The app's stack beside theirs", true, 'ready from before')

      if (p.stage === 'staged') {
        log(
          'Stopping new relays to their supplier. Their miner keeps running to prove what it served.'
        )
        const q = await stopAll(sg, p.first, p)
        if (!q) {
          setFailedAt('staged')
          setStatus(
            'Something of theirs could not be stopped. Put theirs back, or try again.',
            'err'
          )
          return
        }
        const note = stopPhases({ stop: [...p.first, ...p.after] }).note
        const h = await latestHeight(net)
        const w = windows ?? proofWindowsOf(await moduleParams(net, 'shared'))
        const until = note || !w ? h : proofCloseAfter(w, sessionEndOf(w, h))
        if (note) log(note)
        p = { ...q, stage: 'draining', drainUntil: until }
        await saveProgress(p)
      }

      if (p.stage === 'draining') {
        setBusy(false)
        setStatus('Waiting for their last claims to be proved', 'busy')
        log('You can leave this page; the import continues from here when you come back.')
        if (!(await waitForClaims(p))) return
        setBusy(true)
        mark('Their last claims', true, 'proved or settled')
        p = { ...p, stage: 'switching' }
        await saveProgress(p)
      }

      // switching
      const q = await stopAll(sg, p.after, p)
      if (!q) {
        setFailedAt('switching')
        setStatus('Something of theirs could not be stopped. Put theirs back, or try again.', 'err')
        return
      }
      p = q
      log(
        "Starting the app's stack: the shared Caddy takes the supplier's hostname, then Redis, the miner, and the relayer."
      )
      const c = { ...conn(), path: dir }
      const r1 = await sg['supplier-run']({ ...c, step: 'start' })
      if (!r1.ok) {
        mark("Start the app's stack", false, errOf(r1))
        setFailedAt('switching')
        setStatus("The app's stack did not start. Try again, or put theirs back.", 'err')
        return
      }
      mark(
        "Start the app's stack",
        true,
        r1.lines.filter((l) => /^(relayer|caddy|versions):/.test(l)).join(' | ')
      )
      let answers = 0
      for (let i = 0; i < 12 && live.current; i++) {
        answers = await psm().app.probeUrl(stackUrl(host, port))
        if (answers) break
        await new Promise((r) => setTimeout(r, 10_000))
      }
      mark(
        'Public URL',
        !!answers,
        answers
          ? `${stackUrl(host, port)} answers`
          : `${stackUrl(host, port)} does not answer yet; Caddy may still be getting its certificate. Check the supplier's page in a few minutes.`
      )
      await setStack(s.name, net, {
        provisioned_at: new Date().toISOString(),
        layout: STACK_LAYOUT,
        import: undefined
      })
      void loadHistory()
      setStatus('Imported. The app now runs this supplier.', 'ok')
      log('Deploy, test, restake, and unstake it from Suppliers like any other.', 'ok')
    } catch (e) {
      setStatus(`The import stopped: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  // ---- the way back ----
  const putBack = async (): Promise<void> => {
    if (!s || !progress || S().busy) return
    const ok = await confirmDialog(
      "Stop the app's stack for this supplier and start theirs again as it was? The app's files stay on the server; nothing is staked or sent.",
      'Put theirs back'
    )
    if (!ok) return
    const sg = psm().signer
    const c = { ...conn(), path: dir }
    setBusy(true)
    clear()
    setChecks([])
    setStatus('Putting theirs back', 'busy')
    try {
      const r = await sg['supplier-run']({ ...c, step: 'halt' })
      mark("Stop the app's stack", r.ok, r.ok ? r.lines.join(' | ') : errOf(r))
      const all = [...progress.first, ...progress.after]
      for (const name of [...progress.stopped].reverse()) {
        const t = all.find((x) => x.name === name)
        if (!t) continue
        const r2 = await sg['supplier-run']({
          ...c,
          step: 'theirs',
          their_action: 'start',
          their_kind: t.kind,
          their_name: t.name
        })
        mark(`Start their ${targetLabel(t)}`, r2.ok, r2.ok ? '' : errOf(r2))
      }
      const list = servers().map((x) => {
        if (x.name !== s.name) return x
        const sup = { ...(x.suppliers ?? {}) }
        delete sup[net]
        return { ...x, suppliers: sup }
      })
      await saveServers(list)
      setStatus('Theirs is running again. The app no longer counts this supplier as its own.', 'ok')
    } catch (e) {
      setStatus(`Could not put theirs back: ${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  // Resume a wait that was under way when the wizard was left.
  useEffect(() => {
    if (progress?.stage !== 'draining' || S().busy) return
    const t = setTimeout(() => void run(), 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- view ----
  const canStart = !!plan && !plan.blockers.length && !urlProblem && (!!plan.key || !!secret.trim())
  return (
    <div className="panel" id="impPanel">
      <h2>
        Import a supplier <NetBadge />
      </h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        For a supplier set up by hand, outside this app. The app looks at its server, builds its own
        stack there beside it with the same operator key, and then switches over. The stake, the
        owner, and the services on chain do not change.
      </p>

      {rec === undefined && !recErr ? (
        <Busy>Reading the supplier</Busy>
      ) : recErr ? (
        <ErrText>Could not read the supplier: {recErr}</ErrText>
      ) : !rec ? (
        <ErrText>
          No supplier with the operator {operator} is staked on {netLabel(net)}.
        </ErrText>
      ) : (
        <table className="kv">
          <tbody>
            <tr>
              <td>Operator</td>
              <td>
                <a className="mono" title="Click to copy" onClick={() => copy(operator)}>
                  {operator}
                </a>
              </td>
            </tr>
            <tr>
              <td>Owner</td>
              <td>
                <span className="mono">{shortAddr(rec.owner_address)}</span>{' '}
                {custodial ? (
                  <Badge cls="warn">custodial</Badge>
                ) : rec.owner_address === address ? (
                  <Badge cls="ok">your owner wallet</Badge>
                ) : (
                  <Badge cls="warn">another wallet</Badge>
                )}
              </td>
            </tr>
            <tr>
              <td>Services</td>
              <td>{rec.services.map((x) => x.service_id).join(', ') || 'none'}</td>
            </tr>
            <tr>
              <td>Public URL</td>
              <td className="mono">{stakedUrl || 'none'}</td>
            </tr>
            <tr>
              <td>Stake</td>
              <td>{fmtPokt(Number(rec.stake.amount))} POKT</td>
            </tr>
          </tbody>
        </table>
      )}
      {custodial ? (
        <p className="hint">
          This supplier is custodial: its operator is also its owner, so the stake and the revenue
          belong to the operator key. It stays that way after the import.
        </p>
      ) : otherOwner ? (
        <p className="hint">
          <WarnText>
            Its owner is not the owner wallet in this app, so stake changes will need that wallet.
          </WarnText>
        </p>
      ) : null}
      {urlProblem ? (
        <p>
          <ErrText>{urlProblem}</ErrText>
        </p>
      ) : null}

      {rec && !urlProblem ? (
        <>
          <div className="row" style={{ marginTop: 10 }}>
            <div>
              <label>Server it runs on</label>
              <select
                id="impServer"
                value={serverName}
                disabled={!!progress || busy}
                onChange={(e) => {
                  setServerName(e.target.value)
                  setReport(null)
                  setPlan(null)
                }}
              >
                {!eligible.length ? <option value="">No server to use</option> : null}
                {eligible.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
              </select>
              <div className="hint">
                {!eligible.length ? (
                  <>
                    Add the server in Settings first, with the SSH login you use for it.{' '}
                    <a onClick={() => goTo('settings')}>Open Settings</a>
                  </>
                ) : s ? (
                  `${s.user}@${s.host}:${s.port}. It needs no stack from the app on ${netLabel(net)} yet.`
                ) : null}
              </div>
            </div>
            <div>
              <label>Directory for the app's stack</label>
              <input
                type="text"
                id="impDir"
                value={dir}
                disabled={!!progress || busy}
                onChange={(e) => setDir(e.target.value)}
              />
              <div className="hint">A new folder on the server, next to theirs.</div>
            </div>
          </div>

          {!progress ? (
            <div className="btnrow">
              <button className="btn" id="btnImpSurvey" disabled={busy || !s} onClick={survey}>
                {report ? 'Look again' : 'Look at the server'}
              </button>
            </div>
          ) : null}

          {plan && !progress ? (
            <PlanView
              plan={plan}
              phases={phases!}
              waitBlocks={waitBlocks}
              blockTime={params.blockTime}
            />
          ) : null}

          {plan && !progress && !plan.blockers.length && !plan.key ? (
            <div style={{ marginTop: 10 }}>
              <label>Operator key</label>
              <input
                type="password"
                id="impSecret"
                autoComplete="off"
                spellCheck={false}
                placeholder="The operator's private key (64 characters) or its recovery phrase"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <div className="hint">
                It goes once to the new stack on your server and is not kept in this app.
              </div>
            </div>
          ) : null}

          {progress ? (
            <p className="hint">
              {progress.stage === 'staged'
                ? "The app's stack is ready beside theirs; theirs has not been touched yet."
                : progress.stage === 'draining'
                  ? 'New relays to their supplier are stopped; waiting for its last claims to be proved.'
                  : "Their supplier is being stopped and the app's started."}
            </p>
          ) : null}
          {drain ? (
            <p className="hint" id="impDrain">
              Block {fmtInt(drain.height)}
              {drain.height <= drain.until
                ? `, waiting until block ${fmtInt(drain.until)} (about ${fmtDuration((drain.until - drain.height + 1) * (params.blockTime || 0))})`
                : ''}
              {drain.claims
                ? `; ${drain.claims} claim${drain.claims === 1 ? '' : 's'} still open`
                : '; no claims open'}
              .
            </p>
          ) : null}

          <div className="btnrow">
            {progress ? (
              <>
                <button className="btn primary" id="btnImpRun" disabled={busy} onClick={run}>
                  Continue import
                </button>
                <button className="btn" id="btnImpBack" disabled={busy} onClick={putBack}>
                  Put theirs back
                </button>
              </>
            ) : (
              <button
                className="btn primary"
                id="btnImpRun"
                disabled={busy || !canStart}
                onClick={run}
              >
                Start import
              </button>
            )}
            <button className="btn" disabled={busy} onClick={back}>
              Back to suppliers
            </button>
          </div>
          {failedAt ? (
            <p className="hint">
              Put theirs back starts their RelayMiner and proxy again and stops the app's stack.
            </p>
          ) : null}
        </>
      ) : (
        <div className="btnrow">
          <button className="btn" onClick={back}>
            Back to suppliers
          </button>
        </div>
      )}
      <StatusLine status={status} id="impStatus" />
      <Checks items={checks} id="impChecks" />
      <LogBox lines={lines} id="impLog" />
    </div>
  )
}

function PlanView({
  plan,
  phases,
  waitBlocks,
  blockTime
}: {
  plan: ImportPlan
  phases: ReturnType<typeof stopPhases>
  waitBlocks: number | null
  blockTime?: number
}): React.JSX.Element {
  return (
    <div id="impPlan" style={{ marginTop: 10 }}>
      <h3>What the import will do</h3>
      {plan.blockers.length ? (
        <>
          <p>
            <ErrText>It cannot go ahead yet:</ErrText>
          </p>
          <ul>
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </>
      ) : null}
      <ol>
        <li>
          {plan.key
            ? `Copy the operator key from ${plan.key.path} into the app's stack. It stays on the server.`
            : 'Put the operator key you paste below into the app’s stack.'}
        </li>
        <li>
          Serve their services from the app's relayer, calling their backends where they already
          run:
          <ul>
            {plan.backends.map((b) => (
              <li key={b.service}>
                {b.service}:{' '}
                {b.url ? <span className="mono">{b.url}</span> : <ErrText>{b.problem}</ErrText>}
              </li>
            ))}
          </ul>
        </li>
        <li>Stop new relays: {phases.first.map(targetLabel).join(', ') || 'nothing to stop'}.</li>
        <li>
          Wait while their miner proves what it served
          {waitBlocks && blockTime
            ? `, about ${fmtDuration(waitBlocks * blockTime)} (${fmtInt(waitBlocks)} blocks)`
            : ''}
          . The supplier serves nothing in this time.
        </li>
        <li>
          Stop {phases.after.map(targetLabel).join(', ') || 'nothing more'}, then start the app's
          stack. Theirs is kept from starting again on its own; its files are left as they are.
        </li>
      </ol>
      {phases.note ? (
        <p className="hint">
          <WarnText>{phases.note}</WarnText>
        </p>
      ) : null}
      {plan.notes.map((n) => (
        <p className="hint" key={n}>
          {n}
        </p>
      ))}
    </div>
  )
}
