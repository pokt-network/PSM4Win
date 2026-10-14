// Performance (docs/SCREENS.md 3.16; Electron only): whether each supplier is claiming, and
// what its claims, proofs, and settled claims came to. The warnings come from the main
// process's monitor (every 30 minutes, also from the tray); the tables are read from the
// network's indexer for the network the app is on.
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import type { Network } from '@core/networks'
import { fmtPokt, fmtInt, fmtDuration } from '@core/format'
import {
  supplierActivity,
  earningsByService,
  claimsCreated,
  type SupplierActivity,
  type ServiceEarnings
} from '@core/performance'
import type { StackCheck } from '../../../preload/index'
import {
  Badge,
  Busy,
  ErrText,
  WarnText,
  NetBadge,
  RunButton,
  StatusLine,
  useStatus,
  netLabel,
  errText
} from '../components/ui'
import { Addr } from '../components/Addr'
import { servers, stackOf, stackState, psm, goTo, type ServerEntry } from '../lib/actions'
import { confirmDialog } from '../lib/modal'

const WINDOWS = [
  { id: '24h', label: '24 hours', ms: 864e5 },
  { id: '7d', label: '7 days', ms: 7 * 864e5 },
  { id: '30d', label: '30 days', ms: 30 * 864e5 }
] as const
type WindowId = (typeof WINDOWS)[number]['id']

interface Row {
  server: ServerEntry
  operator: string
  /** Claims made in the window, counted for every supplier in one read; null when it failed. */
  claims: number | null
  claimsError: string
  activity: SupplierActivity | null
  earnings: ServiceEarnings[] | null
  error: string
  /** Read apart from the activity, so one failing leaves the other on screen. */
  earningsError: string
}

function ago(iso: string): string {
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z')
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 90) return 'just now'
  // Whole days past two days: "13 days ago" reads better than a fraction.
  if (s >= 2 * 86400) return `${Math.round(s / 86400)} days ago`
  return `${fmtDuration(s)} ago`
}

const KIND_TITLE: Record<string, string> = {
  'miner-down': 'Miner not running',
  'miner-behind': 'Miner stopped following the network',
  unclaimed: 'Serving relays, claiming none'
}

export function PerformanceScreen(): React.JSX.Element {
  const { net, perf, busy } = useStore()
  const [win, setWin] = useState<WindowId>('7d')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [status, setStatus] = useStatus()
  const [restarting, setRestarting] = useState('')

  const mine = servers()
    .map((s) => ({ server: s, st: stackOf(s, net) }))
    .filter((x) => stackState(x.st) === 'ready' && x.st?.operator)
  const key = mine.map((x) => x.st!.operator).join(',')

  const load = useCallback(async () => {
    const since = new Date(Date.now() - WINDOWS.find((w) => w.id === win)!.ms).toISOString()
    setRows(null)
    const why = (x: unknown): string => (x instanceof Error ? x.message : String(x))
    const counted = claimsCreated(
      net,
      mine.map((x) => x.st!.operator),
      since
    ).then(
      (m) => ({ m, error: '' }),
      (e) => ({ m: null, error: why(e) })
    )
    const out = await Promise.all(
      mine.map(async ({ server, st }): Promise<Row> => {
        const operator = st!.operator
        const [a, e] = await Promise.allSettled([
          supplierActivity(net, operator, since),
          earningsByService(net, operator, since)
        ])
        const c = await counted
        return {
          server,
          operator,
          claims: c.m?.get(operator) ?? null,
          claimsError: c.error,
          activity: a.status === 'fulfilled' ? a.value : null,
          earnings: e.status === 'fulfilled' ? e.value : null,
          error: a.status === 'rejected' ? why(a.reason) : '',
          earningsError: e.status === 'rejected' ? why(e.reason) : ''
        }
      })
    )
    setRows(out)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net, win, key])

  useEffect(() => {
    void load()
  }, [load])

  const restart = async (x: StackCheck): Promise<void> => {
    const s = servers().find((e) => e.name === x.server)
    const st = s ? stackOf(s, x.network) : null
    if (!s || !st?.dir)
      return setStatus(`${x.server} has no ${netLabel(x.network)} stack in Settings.`, 'err')
    const ok = await confirmDialog(
      `Restart the miner of ${x.server}'s ${netLabel(x.network)} supplier? The relayer keeps serving relays; the miner, which claims and proves them, starts again and picks up where it can. Sessions whose claim window has already closed cannot be claimed any more.`,
      'Restart miner',
      'Restart the miner'
    )
    if (!ok) return
    setRestarting(`${x.server}|${x.network}`)
    setStatus(`Restarting the miner on ${x.server}`, 'busy')
    try {
      const r = await psm().signer['supplier-run']({
        host: s.host,
        port: s.port,
        user: s.user,
        key_path: s.keyPath,
        path: st.dir,
        step: 'restart-miner'
      })
      if (!r.ok)
        return setStatus(
          /unknown step/.test(r.out)
            ? `This stack's helper predates Performance. Press Update stack for ${x.server} under Suppliers; it also restarts the miner.`
            : `The miner did not restart: ${r.err || errText(r as never)}`,
          'err'
        )
      const lead = r.lines.some((l) => l.startsWith('miner: leading again'))
      setStatus(
        lead
          ? `The miner on ${x.server} is running and leading again. Its next claim should land within a session; checking now.`
          : `The miner on ${x.server} restarted but has not taken the lead yet. Check again in a minute.`,
        lead ? 'ok' : ''
      )
      useStore.setState({ perf: await psm().performance.check() })
    } finally {
      setRestarting('')
    }
  }

  const checks = perf?.stacks ?? []
  const warn = checks.filter((x) => x.verdict && !x.verdict.ok)
  const failed = checks.filter((x) => x.error)
  const verdictFor = (server: string, n: Network): StackCheck | undefined =>
    checks.find((x) => x.server === server && x.network === n)

  return (
    <>
      <div className="panel" id="perfWatch">
        <h2>Performance</h2>
        <p className="hint" style={{ margin: '0 0 6px 0' }}>
          Whether each of your suppliers is claiming the relays it serves. The app checks every 30
          minutes while it runs, also from the system tray, and shows a Windows notification when a
          supplier stops claiming.
        </p>
        {!checks.length ? (
          <p className="hint">
            {perf?.checking ? (
              <Busy>Checking your suppliers</Busy>
            ) : (
              'No supplier has been checked yet. Provisioned suppliers are checked a minute after the app starts.'
            )}
          </p>
        ) : !warn.length && failed.length === checks.length ? (
          <p className="hint">
            None of your suppliers could be checked yet; the reasons are below.
          </p>
        ) : !warn.length ? (
          <p>
            <Badge cls="ok">{failed.length ? 'the rest are claiming' : 'all claiming'}</Badge>{' '}
            <span className="hint">
              {checks.length - failed.length} of {checks.length} supplier stack
              {checks.length > 1 ? 's' : ''} checked
              {perf?.checkedAt ? `, ${ago(perf.checkedAt)}` : ''}.
            </span>
          </p>
        ) : null}
        {warn.map((x) => (
          <div
            className="warnbox"
            key={x.server + x.network}
            id={`perfWarn_${x.server}_${x.network}`}
          >
            <b>
              {x.server}, {netLabel(x.network)}: {KIND_TITLE[x.verdict!.kind] ?? 'Not claiming'}
            </b>
            <div>{x.verdict!.text}</div>
            {x.verdict!.kind === 'unclaimed' ? (
              <div className="hint">
                {x.verdict!.unclaimed} session{x.verdict!.unclaimed > 1 ? 's' : ''} served without a
                claim, ending at blocks {x.verdict!.periods.map((p) => fmtInt(p)).join(', ')}.
              </div>
            ) : null}
            <div className="btnrow">
              <button
                className="btn primary"
                disabled={busy || !!restarting}
                onClick={() => void restart(x)}
              >
                {restarting === `${x.server}|${x.network}` ? 'Restarting' : 'Restart miner'}
              </button>
            </div>
          </div>
        ))}
        {failed.map((x) => (
          <div className="hint" key={'e' + x.server + x.network}>
            {/Update stack/.test(x.error) ? (
              <WarnText>
                {x.server}, {netLabel(x.network)}: not checked yet. {x.error}
              </WarnText>
            ) : (
              <ErrText>
                {x.server}, {netLabel(x.network)}: could not be checked. {x.error}
              </ErrText>
            )}
          </div>
        ))}
        <div className="btnrow">
          <RunButton
            className="btn small"
            failText="Could not check"
            done="Checked"
            onRun={async () => useStore.setState({ perf: await psm().performance.check() })}
          >
            Check now
          </RunButton>
          {perf?.checkedAt ? (
            <span className="hint">Last checked {ago(perf.checkedAt)}.</span>
          ) : null}
        </div>
        <StatusLine status={status} id="perfStatus" />
      </div>

      <div className="panel" id="perfTables">
        <h2>
          Claims and earnings <NetBadge />
        </h2>
        <div className="subtabs" role="tablist" style={{ marginBottom: 10 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              className={win === w.id ? 'on' : ''}
              role="tab"
              onClick={() => setWin(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>
        {!mine.length ? (
          <p className="hint">
            No supplier is provisioned on {netLabel(net)}.{' '}
            <a onClick={() => goTo('settings')}>Provision one under Settings.</a>
          </p>
        ) : rows === null ? (
          <Busy>Reading the network&apos;s indexer</Busy>
        ) : (
          <>
            <table className="services" id="perfClaims">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Claims</th>
                  <th>Proofs</th>
                  <th>Settled</th>
                  <th>Expired</th>
                  <th>Last claim</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const v = verdictFor(r.server.name, net)
                  const a = r.activity
                  return (
                    <tr key={r.server.name}>
                      <td className="svcid">
                        {r.server.name}
                        <div className="hint">
                          <Addr value={r.operator} />
                        </div>
                      </td>
                      {r.error || !a ? (
                        <td colSpan={5}>
                          <ErrText>Could not read: {r.error}</ErrText>
                        </td>
                      ) : (
                        <>
                          <td>
                            {r.claims === null ? (
                              <ErrText>Could not read: {r.claimsError}</ErrText>
                            ) : (
                              fmtInt(r.claims)
                            )}
                          </td>
                          {a.settlementsError ? (
                            <td colSpan={3}>
                              <ErrText>Could not read: {a.settlementsError}</ErrText>
                            </td>
                          ) : a.covered ? (
                            <>
                              <td>{fmtInt(a.proofs)}</td>
                              <td>{fmtInt(a.settled)}</td>
                              <td
                                title={Object.entries(a.expiredReasons)
                                  .map(([k, n]) => `${k}: ${n}`)
                                  .join(', ')}
                              >
                                {a.expired ? <Badge cls="bad">{fmtInt(a.expired)}</Badge> : '0'}
                              </td>
                            </>
                          ) : (
                            <td colSpan={3} className="hint">
                              not covered by the indexer yet
                            </td>
                          )}
                          <td>
                            {a.lastClaimError ? (
                              <span className="hint">could not be read: {a.lastClaimError}</span>
                            ) : a.lastClaim ? (
                              <>
                                {ago(a.lastClaim.time)}
                                <div className="hint">
                                  {a.lastClaim.service}, session ending at{' '}
                                  {fmtInt(a.lastClaim.sessionEnd)}
                                </div>
                              </>
                            ) : (
                              <span className="hint">never</span>
                            )}
                          </td>
                        </>
                      )}
                      <td>
                        {!v ? (
                          <span className="hint">not checked yet</span>
                        ) : v.error ? (
                          <Badge cls="muted">unknown</Badge>
                        ) : v.verdict?.ok ? (
                          <Badge cls="ok">claiming</Badge>
                        ) : (
                          <Badge cls="bad">not claiming</Badge>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="hint">
              Expired claims are rewards the network did not pay, usually because a required proof
              was not sent in time.
            </p>

            <h3 style={{ marginTop: 18 }}>Earned per service</h3>
            <table className="services" id="perfEarnings">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Service</th>
                  <th>Relays</th>
                  <th>Sessions</th>
                  <th>Earned</th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((r) => {
                  const e = r.earnings ?? []
                  const total = e.reduce((t, x) => t + x.earnedUpokt, 0)
                  if (!e.length)
                    return [
                      <tr key={r.server.name}>
                        <td className="svcid">{r.server.name}</td>
                        <td colSpan={4} className="hint">
                          {r.earningsError
                            ? `could not be read: ${r.earningsError}`
                            : r.earnings === null
                              ? 'not covered by the indexer yet'
                              : 'nothing settled in this period'}
                        </td>
                      </tr>
                    ]
                  return [
                    ...e.map((x, i) => (
                      <tr key={r.server.name + x.service}>
                        <td className="svcid">{i === 0 ? r.server.name : ''}</td>
                        <td>{x.service}</td>
                        <td>{fmtInt(x.relays)}</td>
                        <td>{fmtInt(x.sessions)}</td>
                        <td>{fmtPokt(x.earnedUpokt)} POKT</td>
                      </tr>
                    )),
                    <tr key={r.server.name + '_total'}>
                      <td />
                      <td>
                        <b>Total</b>
                      </td>
                      <td />
                      <td />
                      <td>
                        <b>{fmtPokt(total)} POKT</b>
                      </td>
                    </tr>
                  ]
                })}
              </tbody>
            </table>
            <p className="hint">
              Earned is what the supplier&apos;s settled claims paid, from the network&apos;s
              indexer; how it is split follows each service&apos;s revenue share on the stake.
            </p>
          </>
        )}
      </div>
    </>
  )
}
