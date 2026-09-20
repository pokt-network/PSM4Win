// Test service (docs/SCREENS.md 3.8): the card's probes through pocket-ap, graded, logged.
import { useCallback, useEffect, useState } from 'react'
import { useStore, S } from '../store'
import { fmtDuration } from '@core/format'
import { appServiceIds, checkSession, type SessionCheck } from '@core/chain'
import {
  testProbes,
  gradeStep,
  relayIncomplete,
  type ProbeStep,
  type TestLogEntry
} from '@core/probes'
import type { SignerResult } from '@core/contract'
import {
  Badge,
  Checks,
  LogBox,
  StatusLine,
  useLog,
  useStatus,
  NetBadge,
  Busy,
  WarnText,
  netLabel,
  type CheckNode
} from '../components/ui'
import {
  PARENT,
  ownedServices,
  localServices,
  appRecordOf,
  readCardFor,
  netManifest,
  localById,
  dockerReady,
  loadHistory,
  setBusy,
  psm,
  loadServiceFolders
} from '../lib/actions'
import { confirmDialog, alertDialog } from '../lib/modal'

interface WalletOpt {
  name: string
  address: string
  label: string
  staked: boolean
}

export function TestScreen(): React.JSX.Element {
  const { tst, net, docker, wallets, address, catalog, local, busy } = useStore()
  const set = (patch: Partial<typeof tst>): void =>
    useStore.setState((s) => ({ tst: { ...s.tst, ...patch } }))
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const [walletOpts, setWalletOpts] = useState<WalletOpt[]>([])
  const [pick, setPick] = useState('')
  const [probeInfo, setProbeInfo] = useState<{
    n: number
    fromCard: boolean
    deployed: boolean
  } | null>(null)
  const [client, setClient] = useState<React.ReactNode>('Checking')
  const [sess, setSess] = useState<(SessionCheck & { id: string; wallet: string }) | null>(null)
  const [sessBusy, setSessBusy] = useState(false)
  const [logRows, setLogRows] = useState<TestLogEntry[] | null>(null)
  const [logNote, setLogNote] = useState<string | null>(null)
  const { lines, log, clear } = useLog()
  const label = netLabel(net)
  useEffect(() => {
    void loadServiceFolders()
  }, [])

  const ids: [string, string][] = []
  const seen = new Set<string>()
  for (const o of ownedServices())
    if (!seen.has(o.id)) {
      seen.add(o.id)
      ids.push([o.id, o.name])
    }
  for (const l of localServices())
    if (!seen.has(l.id)) {
      seen.add(l.id)
      ids.push([l.id, l.name])
    }

  useEffect(() => {
    if (ids.length && !ids.some(([i]) => i === tst.id)) set({ id: ids[0][0] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, local, address])

  useEffect(() => {
    if (!docker?.ok) setClient(<Badge cls="bad">Docker is not running</Badge>)
    else if (docker.pocketap) setClient(<Badge cls="ok">pocket-ap ready</Badge>)
    else
      setClient(
        <>
          pocket-ap image not downloaded{' '}
          <button className="btn small" onClick={pullAp}>
            Download pocket-ap
          </button>
        </>
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docker])

  const pullAp = async (): Promise<void> => {
    setClient(<Busy>Downloading the pocket-ap image</Busy>)
    const r = await psm().signer['pocketap-pull']({})
    if (!r.ok) {
      setClient(
        <>
          <Badge cls="bad">download failed</Badge> {r.error}
        </>
      )
      return
    }
    useStore.setState((s) => ({ docker: s.docker ? { ...s.docker, pocketap: true } : s.docker }))
    setClient(<Badge cls="ok">{r.version || 'pocket-ap ready'}</Badge>)
  }

  // onTestServiceChange(): wallet list with stakes, auto-pick, probe count, deployed hint.
  const refresh = useCallback(async () => {
    const id = S().tst.id
    const holders: { name: string; address: string }[] = []
    if (S().address) holders.push({ name: PARENT, address: S().address })
    for (const w of S().wallets) if (w.address) holders.push(w)
    const recs = await Promise.all(holders.map((h) => appRecordOf(h.address)))
    let p = ''
    const opts = holders.map((h, i) => {
      const sids = appServiceIds(recs[i])
      const staked = sids.includes(id)
      if (staked && !p) p = h.name
      return {
        name: h.name,
        address: h.address,
        label: h.name + (recs[i] ? ` (staked for ${sids.join(', ')})` : ' (no application stake)'),
        staked
      }
    })
    setWalletOpts(opts)
    setPick(p)
    if (p) set({ wallet: p })
    else if (!opts.some((o) => o.name === S().tst.wallet)) set({ wallet: opts[0]?.name ?? '' })
    const probes = testProbes(await readCardFor(id), id)
    setProbeInfo({
      n: probes.steps.length,
      fromCard: probes.fromCard,
      deployed: !!netManifest(localById(id)).deployed_at
    })
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh, tst.id, wallets, address, net])

  // A stake joins the session drawn at the last boundary, never the one running, so a
  // service registered and supplied minutes ago answers nothing and every probe fails
  // with the node's session error. Ask the node first and say which block to wait for.
  const runCheck = useCallback(async (): Promise<SessionCheck | null> => {
    const id = S().tst.id
    const name = S().tst.wallet
    const addr = walletOpts.find((o) => o.name === name)?.address ?? ''
    if (!id || !addr) return null
    setSessBusy(true)
    try {
      const c = await checkSession(S().net, S().params, addr, id)
      setSess({ ...c, id, wallet: name })
      return c
    } finally {
      setSessBusy(false)
    }
  }, [walletOpts])

  // An answer is shown only against the service and wallet it was asked about, so a slow
  // one cannot arrive over a different choice and read as that service's verdict.
  const shown = sess && sess.id === tst.id && sess.wallet === tst.wallet ? sess : null

  useEffect(() => {
    void runCheck()
  }, [runCheck, tst.id, tst.wallet, net])

  // Waiting for a boundary ends by itself, so the screen looks again rather than
  // leaving a stale "wait" that the user has to guess is over. A missing supplier does
  // not, so that state is left alone.
  useEffect(() => {
    const r = shown?.readiness
    if (r?.state !== 'waiting' || r.reason !== 'next-session') return
    const t = setTimeout(() => void runCheck(), 20_000)
    return () => clearTimeout(t)
  }, [shown, runCheck])

  const run = async (): Promise<void> => {
    if (S().busy) return
    const id = tst.id
    const wallet = tst.wallet
    if (!id) return setStatus('Choose a service.', 'err')
    if (!wallet) return setStatus('Choose an application wallet.', 'err')
    if (!dockerReady())
      return setStatus('Docker Desktop must be running with the pocketd image downloaded.', 'err')
    if (!S().docker?.pocketap)
      return setStatus('Download the pocket-ap image first (button above).', 'err')
    const ready = await runCheck()
    if (ready?.readiness.state === 'waiting') return setStatus(ready.note, 'err')
    const steps: ProbeStep[] = testProbes(await readCardFor(id), id).steps
    const results: TestLogEntry['steps'] = []
    setBusy(true)
    setLogRows(null)
    setLogNote(null)
    clear()
    setChecks([])
    setStatus(`Running ${steps.length} probes`, 'busy')
    log(
      <>
        Testing <b>{id}</b> on {label} as <b>{wallet}</b>. Each relay looks up the current session,
        picks a supplier, signs the request, and verifies the supplier's signature on the answer.
      </>
    )
    const t0 = Date.now()
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      log(
        `Probe ${i + 1} of ${steps.length}: ${s.label}${s.badInput ? ' with malformed JSON (expecting a 4xx JSON error)' : s.body ? ' with body ' + s.body.substring(0, 120) : ''}${!s.badInput && s.jsonPath ? ` (expecting ${s.jsonPath} to match ${s.matches})` : ''}`
      )
      const send = (): Promise<SignerResult<'relay-call'>> =>
        psm().signer['relay-call']({
          network: S().net,
          wallet,
          service_id: id,
          method: s.method,
          path: s.path,
          body: s.body
        })
      let r = await send()
      // A relay that never completed is not an answer to grade. The first one of a
      // session is where this happens: the response comes back truncated while the
      // supplier's relayer catches up with a session it has only just joined, and
      // reporting that as a failed probe blames a service that was never reached. One
      // more attempt settles it, and the log says so rather than hiding it.
      if ('exit_code' in r && relayIncomplete(r)) {
        log('The relay did not complete. Sending it once more.')
        await new Promise((done) => setTimeout(done, 2000))
        r = await send()
      }
      const res = {
        label: s.label,
        ok: false,
        ms: 'ms' in r ? r.ms : 0,
        http: 'http' in r ? r.http : 0,
        note: ''
      }
      if (!r.ok && 'error' in r && r.error) {
        res.note =
          r.error +
          ((r as { detail?: string }).detail ? ' ' + (r as { detail?: string }).detail : '')
        log('Failed: ' + res.note, 'err')
      } else if ('body' in r) {
        const diag = String(r.diagnostics || '')
        const sess = /session:\s*([0-9a-f]{8})/.exec(diag)
        const att = /attempt \d+: (pokt1[0-9a-z]+) in (\d+ms) via (\S+) -> (\w+)/.exec(diag)
        if (att)
          log(
            `Supplier ${att[1].substring(0, 14)}… answered in ${att[2]} via ${att[3]} (${att[4]})${sess ? `, session ${sess[1]}…` : ''}.`
          )
        const g = gradeStep(s, r)
        res.ok = g.ok
        res.note = g.note
        const preview = String(r.body || '')
          .trim()
          .replace(/\s+/g, ' ')
          .substring(0, 160)
        log(
          <>
            {res.ok ? 'Passed: ' : 'Failed: '}
            {res.note}
            {preview ? (
              <>
                {' '}
                <span className="hint mono">
                  {preview}
                  {preview.length >= 160 ? '…' : ''}
                </span>
              </>
            ) : null}
          </>,
          res.ok ? 'ok' : 'err'
        )
      }
      results.push(res)
      setChecks(
        results.map((x) => ({
          level: x.ok ? 'ok' : 'fail',
          text: x.label + (x.ms ? ` (${x.ms} ms)` : ''),
          sub: x.note
        }))
      )
    }
    const passed = results.filter((x) => x.ok).length
    const entry: TestLogEntry = {
      time: new Date().toISOString(),
      network: S().net,
      service: id,
      wallet,
      passed,
      total: results.length,
      ms: Date.now() - t0,
      steps: results
    }
    const wrote = await psm().files.appendRelayTest(JSON.stringify(entry))
    if (!wrote.ok) log(`Could not write the log file: ${wrote.error ?? ''}`, 'err')
    log(
      `${passed} of ${results.length} probes passed in ${fmtDuration((Date.now() - t0) / 1000)}. Logged.`,
      passed === results.length ? 'ok' : 'err'
    )
    setStatus(
      passed === results.length
        ? 'All probes passed. The service answers through the protocol.'
        : `${passed} of ${results.length} probes passed.`,
      passed === results.length ? 'ok' : 'err'
    )
    setBusy(false)
    void loadHistory()
  }

  const viewLog = async (): Promise<void> => {
    const t = await psm().files.readRelayTests()
    const rows: TestLogEntry[] = []
    for (const line of t.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* skip */
      }
    }
    setLogNote(null)
    setLogRows(rows)
  }
  const clearLog = async (): Promise<void> => {
    if (
      !(await confirmDialog(
        'Delete every logged test result on this machine?',
        'Delete',
        'Clear log',
        'danger solid'
      ))
    )
      return
    const cleared = await psm().files.clearRelayTests()
    if (!cleared.ok) {
      await alertDialog('Could not delete the log: ' + (cleared.error ?? ''))
      return
    }
    setLogRows([])
    setLogNote('Log cleared.')
  }

  return (
    <>
      <div className="panel">
        <h2>
          Test a service <NetBadge />
        </h2>
        <p className="hint" style={{ margin: '0 0 6px 0' }}>
          Sends the service's own health-check probes through the protocol, exactly as a gateway
          would: signed by an application wallet staked for the service, routed to a supplier in the
          current session, and graded against the expectations in the service card. Relays are sent
          with pocket-ap in a container; the wallet key is read from the keyring for the call and
          never displayed.
        </p>
        <div className="row">
          <div>
            <label>Service</label>
            <select id="tstId" value={tst.id} onChange={(e) => set({ id: e.target.value })}>
              {!ids.length ? <option value="">No services</option> : null}
              {ids.map(([i, n]) => (
                <option key={i} value={i}>
                  {i}
                  {n ? ` (${n})` : ''}
                </option>
              ))}
            </select>
            <div className="hint" id="tstIdHint">
              {probeInfo ? (
                <>
                  {probeInfo.fromCard
                    ? `${probeInfo.n} probes from the card.`
                    : `No card found; using the default probes (${probeInfo.n}).`}{' '}
                  {probeInfo.deployed ? null : (
                    <WarnText>
                      Not deployed on {label} from this machine yet: the supplier has no relayer for
                      it until Deploy service runs, so relays will fail.
                    </WarnText>
                  )}
                </>
              ) : (
                "Probes come from the service's card."
              )}
            </div>
          </div>
          <div>
            <label>Application wallet</label>
            <select
              id="tstWallet"
              value={tst.wallet}
              onChange={(e) => set({ wallet: e.target.value })}
            >
              {!walletOpts.length ? <option value="">No wallets</option> : null}
              {walletOpts.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="hint" id="tstWalletHint">
              {pick ? (
                `${pick} is staked for ${tst.id}.`
              ) : (
                <WarnText>
                  No wallet is staked for {tst.id} on {label}. Stake one first (Stake application).
                </WarnText>
              )}
            </div>
          </div>
          <div>
            <label>Relay client</label>
            <div id="tstClient" className="hint" style={{ marginTop: 8 }}>
              {client}
            </div>
          </div>
        </div>
        <div className="hint" id="tstSession" style={{ marginTop: 10 }}>
          {shown ? (
            <>
              {shown.readiness.state === 'ready' ? (
                <Badge cls="ok">in session</Badge>
              ) : shown.readiness.state === 'waiting' ? (
                <Badge cls="warn">not in session yet</Badge>
              ) : (
                <Badge cls="warn">session unknown</Badge>
              )}{' '}
              {shown.readiness.state === 'waiting' ? <WarnText>{shown.note}</WarnText> : shown.note}{' '}
              <button className="btn small" disabled={sessBusy} onClick={() => void runCheck()}>
                {sessBusy ? 'Checking' : 'Check again'}
              </button>
            </>
          ) : sessBusy ? (
            <Busy>Checking which suppliers are in the current session</Busy>
          ) : (
            'Choose a service and a wallet staked for it to check the current session.'
          )}
        </div>
        <div className="btnrow">
          <button
            className="btn primary"
            id="btnTest"
            disabled={busy || shown?.readiness.state === 'waiting' || (!shown && sessBusy)}
            onClick={run}
          >
            Run test
          </button>
          <button className="btn" onClick={viewLog}>
            View log
          </button>
          <button className="btn danger" onClick={clearLog}>
            Clear log
          </button>
        </div>
        <StatusLine status={status} id="tstStatus" />
        <Checks items={checks} id="tstChecks" />
        <LogBox lines={lines} id="tstLog" />
      </div>
      {logRows !== null || logNote ? (
        <div className="panel" id="tstLogPanel">
          <h2>Previous tests</h2>
          <div id="tstLogTable">
            {logNote ? (
              <div className="hint">{logNote}</div>
            ) : !logRows?.length ? (
              <div className="hint">No tests logged yet.</div>
            ) : (
              <table className="hist">
                <thead>
                  <tr>
                    <th>Time (UTC)</th>
                    <th>Network</th>
                    <th>Service</th>
                    <th>Wallet</th>
                    <th>Result</th>
                    <th>Probes</th>
                  </tr>
                </thead>
                <tbody>
                  {logRows.map((e, i) => (
                    <tr key={i}>
                      <td>
                        {String(e.time || '')
                          .substring(0, 19)
                          .replace('T', ' ')}
                      </td>
                      <td>{e.network}</td>
                      <td>{e.service}</td>
                      <td>{e.wallet}</td>
                      <td>
                        <Badge cls={e.passed === e.total ? 'ok' : 'bad'}>
                          {e.passed}/{e.total}
                        </Badge>
                        {e.ms ? <div className="hint">{fmtDuration(e.ms / 1000)}</div> : null}
                      </td>
                      <td>
                        {(e.steps || []).map((s, k) => (
                          <div
                            key={k}
                            className={s.ok ? 'ok' : 'err'}
                            style={{ color: s.ok ? 'var(--ok-text)' : 'var(--danger-text)' }}
                          >
                            {s.ok ? '✓ ' : '✗ '}
                            {s.label}
                            {s.ms ? ` (${s.ms} ms)` : ''}{' '}
                            {s.note ? <span className="hint">{s.note}</span> : null}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}
