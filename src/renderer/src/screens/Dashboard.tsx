// Dashboard (docs/SCREENS.md 3.1) with the Recent activity panel (3.10).
import { useCallback, useEffect, useState } from 'react'
import { useStore, S } from '../store'
import { fmtPokt, fmtInt, fmtDuration, shortAddr, POKT } from '@core/format'
import {
  costPerRelayUpokt,
  nextSessionBoundary,
  supplierServiceIds,
  type SupplyState
} from '@core/chain'
import { NETWORK_INFO } from '@core/networks'
import { Badge, NetBadge, Busy, netLabel } from '../components/ui'
import {
  ownedServices,
  supplierRows,
  supplyMap,
  appStakesByService,
  refreshNetwork,
  refreshBalance,
  loadHistory,
  tab,
  psm,
  type SupplierRow,
  type AppStakeHolder
} from '../lib/actions'
import { supplierStatusCell } from './Supply'
import { openSupplier, svcStake } from './Services'

export function DashboardScreen(): React.JSX.Element {
  const {
    net,
    params,
    imported,
    wallets,
    address,
    catalog,
    settings,
    servicesRoot,
    local,
    history,
    balance
  } = useStore()
  const [rows, setRows] = useState<SupplierRow[] | null>(null)
  const [stakes, setStakes] = useState<Record<string, AppStakeHolder[]>>({})
  const [supply, setSupply] = useState<Record<string, SupplyState>>({})
  const label = netLabel(net)

  const load = useCallback(async () => {
    const [r, st] = await Promise.all([supplierRows(), appStakesByService()])
    setRows(r)
    setStakes(st)
    setSupply(await supplyMap(r))
    void loadHistory()
  }, [])
  useEffect(() => {
    void load()
  }, [load, net, imported, wallets, address, catalog, settings?.servers])

  const owned = ownedServices()
  let appStaked = 0
  for (const list of Object.values(stakes)) for (const h of list) appStaked += h.stake
  // Count each wallet once, like app.js (a wallet stakes for exactly one service).
  appStaked = [
    ...new Map(
      Object.values(stakes)
        .flat()
        .map((h) => [h.address, h.stake])
    ).values()
  ].reduce((a, b) => a + b, 0)
  const staked = (rows ?? []).filter((r) => r.rec).length
  const supStaked = (rows ?? []).reduce((a, r) => a + (r.rec ? Number(r.rec.stake.amount) : 0), 0)
  const withOp = (rows ?? []).filter((r) => r.state === 'ready').length
  const ns = nextSessionBoundary(params)
  const min = params.appMinStake || 0
  const alerts: React.ReactNode[] = []

  return (
    <>
      <div className="row">
        <div className="panel">
          <h2>
            Overview <NetBadge />
          </h2>
          <div id="dashStats">
            <div className="stat" onClick={() => tab('services')}>
              <div className="n">{imported ? owned.length : '?'}</div>
              <div className="l">Services owned on {label}</div>
            </div>
            <div className="stat" onClick={() => tab('supply')}>
              <div className="n">
                {staked}
                <small>
                  of {withOp} server{withOp === 1 ? '' : 's'}
                </small>
              </div>
              <div className="l">Suppliers staked</div>
              {supStaked ? <div className="s">{fmtPokt(supStaked)} POKT staked</div> : null}
            </div>
            <div className="stat" onClick={() => tab('wallets')}>
              <div className="n">{wallets.length}</div>
              <div className="l">App wallets</div>
              {appStaked ? (
                <div className="s">{fmtPokt(appStaked)} POKT in application stakes</div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="panel">
          <h2>Chain</h2>
          <table className="kv">
            <tbody>
              <tr>
                <td>Block height</td>
                <td id="dHeight">{params.height ? fmtInt(params.height) : '?'}</td>
              </tr>
              <tr>
                <td>Block time</td>
                <td id="dBlockTime">
                  {params.blockTime
                    ? params.blockTime.toFixed(1) + ' s (measured over 1,000 blocks)'
                    : '?'}
                </td>
              </tr>
              <tr>
                <td>Session</td>
                <td id="dSession">
                  {params.blocksPerSession
                    ? `${params.blocksPerSession} blocks${params.blockTime ? ` (~${fmtDuration(params.blocksPerSession * params.blockTime)})` : ''}`
                    : '?'}
                </td>
              </tr>
              <tr>
                <td>Next session</td>
                <td id="dNext">
                  {ns
                    ? `height ${fmtInt(ns.height)}, in ${ns.blocks} block${ns.blocks === 1 ? '' : 's'}${params.blockTime ? ` (~${fmtDuration(ns.blocks * params.blockTime)})` : ''}`
                    : '?'}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="hint">
            New suppliers, stakes, and price changes take effect at the next session boundary.
          </div>
          <div className="hint" style={{ marginTop: 12 }}>
            <b>Services directory</b>
          </div>
          <div id="dashServicesDir" className="hint">
            {settings?.servicesRoot && servicesRoot ? (
              <>
                <span className="mono">{servicesRoot}</span>
                <div className="hint">
                  {local.length} service folder{local.length === 1 ? '' : 's'}.{' '}
                  <a onClick={() => psm().app.openPath(servicesRoot)}>Open folder</a> or{' '}
                  <a onClick={() => tab('settings')}>change it in Settings</a>.
                </div>
              </>
            ) : (
              <>
                No directory set. <a onClick={() => tab('settings')}>Select it in Settings.</a>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Services</h2>
        <div className="hint">
          Your services on this network: who serves them and whether their application stake has
          margin. Relays are paid from the application stake, and the protocol unstakes an
          application that falls below the minimum.
        </div>
        <div id="dashServices" style={{ marginTop: 8 }}>
          {!imported ? (
            <span className="hint">Import the owner wallet to see its services.</span>
          ) : !owned.length ? (
            <span className="hint">
              No services owned on {label} yet. <a onClick={() => tab('create')}>Create one.</a>
            </span>
          ) : (
            <>
              {(() => {
                const trs = owned.map((s) => {
                  const sp = supply[s.id]
                  const st = stakes[s.id] ?? []
                  const per = costPerRelayUpokt(params, Number(s.compute_units_per_relay))
                  const stakeCells: React.ReactNode[] = []
                  const marginCells: React.ReactNode[] = []
                  for (const e of st) {
                    const margin = e.stake - min
                    const relays = per && margin > 0 ? Math.floor(margin / per) : 0
                    const cls = e.unbonding
                      ? 'bad'
                      : margin <= 0
                        ? 'bad'
                        : margin < min * 0.05
                          ? 'warn'
                          : 'ok'
                    stakeCells.push(
                      <div key={e.name}>
                        {e.name}: {fmtPokt(e.stake)} POKT{' '}
                        {e.unbonding ? <Badge cls="bad">unbonding</Badge> : null}
                      </div>
                    )
                    marginCells.push(
                      <div key={e.name}>
                        <Badge cls={cls}>
                          {e.unbonding
                            ? `stops at block ${fmtInt(e.unbonding)}`
                            : margin <= 0
                              ? 'below minimum'
                              : `${fmtPokt(margin)} POKT`}
                        </Badge>
                        {!e.unbonding && margin > 0 && per ? (
                          <div className="hint">
                            about {fmtInt(relays)} relays before the minimum
                          </div>
                        ) : null}
                      </div>
                    )
                    if (e.unbonding)
                      alerts.push(
                        <span key={e.name + s.id}>
                          <b>{e.name}</b> ({s.id}) is unbonding; its stake stops at block{' '}
                          {fmtInt(e.unbonding)}. Restake it now to cancel that and keep its
                          delegations.
                        </span>
                      )
                    else if (margin <= 0)
                      alerts.push(
                        <span key={e.name + s.id}>
                          <b>{e.name}</b> ({s.id}) is at or below the minimum stake and will be
                          unstaked at the session end. Restake it with a margin.
                        </span>
                      )
                    else if (margin < min * 0.05)
                      alerts.push(
                        <span key={e.name + s.id}>
                          <b>{e.name}</b> ({s.id}) has only {fmtPokt(margin)} POKT of margin left,
                          about {fmtInt(relays)} relays. Top the stake up soon.
                        </span>
                      )
                  }
                  return (
                    <tr key={s.id}>
                      <td className="svcid">
                        {s.id}
                        <div className="hint">{s.name || ''}</div>
                      </td>
                      <td>
                        {sp?.state === 'active' ? (
                          <>
                            <Badge cls="ok">active</Badge>
                            <div className="hint">{sp.server}</div>
                          </>
                        ) : sp?.state === 'pending' ? (
                          <>
                            <Badge cls="warn">pending</Badge>
                            <div className="hint">from block {fmtInt(sp.activation_height)}</div>
                          </>
                        ) : (
                          <Badge cls="muted">no supplier of yours</Badge>
                        )}
                      </td>
                      <td>{st.length ? stakeCells : <Badge cls="muted">none</Badge>}</td>
                      <td>
                        {st.length ? (
                          marginCells
                        ) : (
                          <span className="hint">Stake an application to call the service.</span>
                        )}
                      </td>
                      <td className="actions">
                        <button
                          className={'btn small' + (st.length ? '' : ' primary')}
                          onClick={() => svcStake(s.id)}
                        >
                          {st.length ? 'Restake' : 'Stake application'}
                        </button>
                      </td>
                    </tr>
                  )
                })
                return (
                  <>
                    {alerts.length ? (
                      <div className="dangerbox">
                        {alerts.map((a, i) => (
                          <div key={i}>{a}</div>
                        ))}
                      </div>
                    ) : null}
                    <table className="services">
                      <thead>
                        <tr>
                          <th>Service</th>
                          <th>Supply</th>
                          <th>Application stake</th>
                          <th>Margin above minimum</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>{trs}</tbody>
                    </table>
                  </>
                )
              })()}
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Suppliers</h2>
        <div className="hint">One per configured server. Click a row to manage that supplier.</div>
        <div id="dashSuppliers" style={{ marginTop: 8 }}>
          {rows === null ? (
            <Busy>Reading suppliers</Busy>
          ) : !rows.length ? (
            <span className="hint">
              No server is configured.{' '}
              <a onClick={() => tab('settings')}>Add one under Settings.</a>
            </span>
          ) : (
            <table className="services">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Status</th>
                  <th>Services</th>
                  <th>Operator gas</th>
                  <th>URL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const st = x.stack
                  const ids = supplierServiceIds(x.rec)
                  return (
                    <tr
                      key={x.server.name}
                      className="link"
                      onClick={() =>
                        x.state === 'ready' ? openSupplier(x.server.name) : tab('supply')
                      }
                    >
                      <td className="svcid">
                        {x.server.name}
                        <div className="hint mono">
                          {st?.operator ? shortAddr(st.operator) : `no ${label} stack`}
                        </div>
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
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Recent activity</h2>
        <div className="hint">
          Every transaction this machine broadcast, on either network, newest first.
        </div>
        <div id="histWrap">
          <table className="hist" id="histTable">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Network</th>
                <th>Action</th>
                <th>Service</th>
                <th>Result</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {!history.length ? (
                <tr>
                  <td colSpan={6} className="hint">
                    Nothing yet.
                  </td>
                </tr>
              ) : (
                [...history].reverse().map((e, i) => {
                  const enet = e.network === 'main' || e.network === 'beta' ? e.network : S().net
                  return (
                    <tr key={i}>
                      <td>{(e.time || '').substring(0, 19).replace('T', ' ')}</td>
                      <td>{e.network || ''}</td>
                      <td>{e.op}</td>
                      <td>{e.service_id || e.address || ''}</td>
                      <td>
                        {e.txhash ? (
                          Number(e.code) === 0 ? (
                            <Badge cls="ok">accepted</Badge>
                          ) : (
                            <Badge cls="bad">rejected {e.code}</Badge>
                          )
                        ) : (
                          ''
                        )}
                      </td>
                      <td>
                        {e.txhash ? (
                          <a
                            className="mono"
                            onClick={() =>
                              psm().app.openExternal(
                                `${NETWORK_INFO[enet].lcd}/cosmos/tx/v1beta1/txs/${e.txhash}`
                              )
                            }
                          >
                            {String(e.txhash).substring(0, 12)}&hellip;
                          </a>
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="btnrow">
          <button
            className="btn small"
            onClick={async () => {
              await refreshNetwork()
              void refreshBalance()
              void load()
            }}
          >
            Refresh
          </button>
        </div>
        {balance === undefined ? null : null}
      </div>
    </>
  )
}
