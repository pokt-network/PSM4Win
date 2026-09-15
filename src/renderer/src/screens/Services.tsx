// My services (docs/SCREENS.md 3.2): owned services merged with local folders,
// lifecycle badges, and the row actions that prefill other screens.
import { useCallback, useEffect, useState } from 'react'
import { useStore, S, type LocalService } from '../store'
import type { ChainService } from '@core/lcd'
import { fmtPokt, fmtInt } from '@core/format'
import { costPerRelayUpokt, activationNote, type SupplyState } from '@core/chain'
import { Badge, NetBadge, Empty, Busy, WarnText, netLabel } from '../components/ui'
import {
  ownedServices,
  localServices,
  appStakesByService,
  supplyMap,
  refreshNetwork,
  refreshBalance,
  catalogEntry,
  folderForId,
  netManifest,
  servers,
  serverByName,
  tab,
  foot,
  type AppStakeHolder
} from '../lib/actions'
import { formFromCard } from '@core/card-form'

interface Row {
  id: string
  name: string
  cupr: number | null
  chain: boolean
  taken: ChainService | null
  local: LocalService | null
  stake: AppStakeHolder[] | undefined
}

export function ServicesScreen(): React.JSX.Element {
  const { imported, net, catalog, local, wallets, address, params } = useStore()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [supply, setSupply] = useState<Record<string, SupplyState>>({})

  const load = useCallback(async () => {
    const owned = ownedServices()
    const loc = localServices()
    const [stakes, sup] = await Promise.all([appStakesByService(), supplyMap()])
    const seen = new Set<string>()
    const byId = new Map(loc.map((l) => [l.id, l]))
    const out: Row[] = []
    for (const s of owned) {
      seen.add(s.id)
      out.push({
        id: s.id,
        name: s.name,
        cupr: Number(s.compute_units_per_relay),
        chain: true,
        taken: null,
        local: byId.get(s.id) ?? null,
        stake: stakes[s.id]
      })
    }
    for (const l of loc) {
      if (seen.has(l.id)) continue
      out.push({
        id: l.id,
        name: l.name,
        cupr: l.cupr,
        chain: false,
        taken: catalogEntry(l.id),
        local: l,
        stake: stakes[l.id]
      })
    }
    setRows(out)
    setSupply(sup)
  }, [])

  useEffect(() => {
    void load()
  }, [load, imported, net, catalog, local, wallets, address])

  return (
    <div className="panel">
      <h2>
        My services <NetBadge />
      </h2>
      <div className="hint" id="svcListHint">
        {!imported
          ? 'Import the wallet to see which services it owns on the network. Folders on this machine are listed below.'
          : `Services this wallet owns on ${netLabel(net)}, plus service folders on this machine that are not registered there yet.`}
      </div>
      <div id="svcList" style={{ marginTop: 10 }}>
        {rows === null ? (
          <Busy>Reading the catalog</Busy>
        ) : !rows.length ? (
          <Empty
            text={`No services yet on ${netLabel(net)} and no service folders on this machine.`}
            button={
              <button className="btn primary" onClick={() => tab('create')}>
                Create your first service
              </button>
            }
          />
        ) : (
          <table className="services">
            <thead>
              <tr>
                <th>Service</th>
                <th>Name</th>
                <th>Price</th>
                <th>Status on {netLabel(net)}</th>
                <th>App stake</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const u = x.cupr ? costPerRelayUpokt(params, x.cupr) : null
                const sp = supply[x.id]
                const nm = netManifest(x.local)
                let chainCell: React.ReactNode
                if (!x.chain)
                  chainCell = x.taken ? (
                    <Badge cls="bad">ID taken by another owner</Badge>
                  ) : (
                    <>
                      <Badge cls="muted">created</Badge>
                      <div className="hint">not registered here</div>
                    </>
                  )
                else if (sp?.state === 'active')
                  chainCell = (
                    <>
                      <Badge cls="ok">active</Badge>
                      <div className="hint">served by {sp.server}</div>
                      {nm.deployed_at ? null : (
                        <div className="hint">
                          <WarnText>not deployed from this machine on {netLabel(net)}</WarnText>
                        </div>
                      )}
                    </>
                  )
                else if (sp?.state === 'pending')
                  chainCell = (
                    <>
                      <Badge cls="warn">pending</Badge>
                      <div className="hint">
                        {sp.server} serves it from {activationNote(params, sp.activation_height)}
                      </div>
                    </>
                  )
                else
                  chainCell = (
                    <>
                      <Badge cls="info">registered</Badge>
                      <div className="hint">no supplier of yours serves it</div>
                    </>
                  )
                let stakeCell: React.ReactNode = <span className="hint">none</span>
                if (x.stake) {
                  let total = 0
                  let ub = 0
                  for (const h of x.stake) {
                    total += h.stake
                    if (h.unbonding) ub = h.unbonding
                  }
                  stakeCell = (
                    <>
                      {fmtPokt(total)} POKT{' '}
                      {ub ? (
                        <>
                          <Badge cls="warn">unbonding</Badge>
                          <div className="hint">stops at block {fmtInt(ub)}; restake to cancel</div>
                        </>
                      ) : null}
                    </>
                  )
                }
                const deployable = !!x.local?.hasDockerfile
                return (
                  <tr key={x.id}>
                    <td className="svcid">{x.id}</td>
                    <td>{x.name || ''}</td>
                    <td>
                      {x.cupr ? (
                        <>
                          {x.cupr} CU
                          {u !== null ? <div className="hint">{u} uPOKT/relay</div> : null}
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td>
                      {chainCell}{' '}
                      {x.local && !x.local.hasCard ? <Badge cls="warn">no card</Badge> : null}
                    </td>
                    <td>{stakeCell}</td>
                    <td className="actions">
                      {x.chain ? (
                        <>
                          <button className="btn small" onClick={() => svcUpdate(x.id)}>
                            Update
                          </button>
                          <button className="btn small" onClick={() => svcStake(x.id)}>
                            {x.stake ? 'Restake' : 'Stake'}
                          </button>
                          {deployable ? (
                            <button className="btn small" onClick={() => svcDeploy(x.id)}>
                              Deploy
                            </button>
                          ) : null}
                          <button className="btn small" onClick={() => svcSupply(x.id)}>
                            Supply
                          </button>
                          <button className="btn small" onClick={() => svcTest(x.id)}>
                            Test
                          </button>
                        </>
                      ) : !x.taken ? (
                        <button
                          className="btn small primary"
                          onClick={() => svcRegister(x.local!.folder)}
                        >
                          Register
                        </button>
                      ) : null}
                      {x.local ? (
                        <button className="btn small" onClick={() => svcEdit(x.local!.folder)}>
                          Edit card
                        </button>
                      ) : null}
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
          onClick={() => {
            void refreshNetwork()
            void refreshBalance()
          }}
        >
          Refresh
        </button>
        <button className="btn small primary" onClick={() => tab('create')}>
          Create service
        </button>
      </div>
    </div>
  )
}

// ---- row action targets (docs/SCREENS.md 3.2) ----

export async function svcUpdate(id: string): Promise<void> {
  const folder = folderForId(id)
  if (folder) {
    await selectRegisterFolder(folder)
  } else {
    const s = catalogEntry(id)
    useStore.setState((st) => ({
      reg: {
        ...st.reg,
        folder: '',
        id,
        name: s?.name ?? '',
        cupr: String(s?.compute_units_per_relay ?? 100),
        card: ''
      }
    }))
  }
  tab('register')
  foot(
    `Editing '${id}'. Change what you need, run preflight, and the registration becomes an update (gas only).`
  )
}

export async function svcRegister(folder: string): Promise<void> {
  await selectRegisterFolder(folder)
  tab('register')
}

/** onServiceFolder(): fills the Register form (and the stake prefills) from a folder's service.json. */
export async function selectRegisterFolder(folder: string): Promise<void> {
  if (!folder) return
  const l = S().local.find((x) => x.folder === folder)
  const m = l?.manifest ?? {}
  void window.psm.settings.set({ lastService: folder })
  const cardRel = m.card || 'card.json'
  const root = S().servicesRoot ?? ''
  const cardAbs = /^[A-Za-z]:\\|^\\\\|^\//.test(cardRel)
    ? cardRel
    : `${root}\\${folder}\\${cardRel}`
  const cardExists = l ? (m.card ? await window.psm.files.fileExists(cardAbs) : l.hasCard) : false
  useStore.setState((st) => ({
    reg: {
      folder,
      id: m.service_id || st.reg.id || folder,
      name: m.name || st.reg.name,
      cupr: m.compute_units_per_relay ? String(m.compute_units_per_relay) : st.reg.cupr,
      card: cardExists ? cardAbs : m.card ? cardAbs : ''
    },
    stk: {
      ...st.stk,
      amount: m.application_stake_pokt ? String(m.application_stake_pokt) : st.stk.amount,
      id: m.service_id || st.stk.id
    }
  }))
  foot(`Loaded ${folder}${m.service_id ? '' : ' (no service.json yet; save one from the form)'}`)
}

export function svcStake(id: string): void {
  useStore.setState((s) => ({ stk: { ...s.stk, id } }))
  tab('stake')
}

export async function svcEdit(folder: string): Promise<void> {
  const [cardText, manText] = await Promise.all([
    window.psm.files.readServiceFile(folder, 'card.json'),
    window.psm.files.readServiceFile(folder, 'service.json')
  ])
  let card: unknown = null
  let man: unknown = null
  let err = ''
  try {
    card = cardText ? JSON.parse(cardText) : null
  } catch (e) {
    err = `card.json in ${folder} is not valid JSON: ${(e as Error).message}`
  }
  try {
    man = manText ? JSON.parse(manText) : null
  } catch {
    man = null
  }
  useStore.setState({
    cr: formFromCard(folder, card, man),
    crAuto: { apis: false, hint: false, impl: false, idMatch: false },
    crFolder: folder
  })
  useStore.setState({
    crLoadNote: err || `Loaded ${folder}. Edit and press Create to rewrite its card.`,
    crLoadErr: !!err
  } as never)
  tab('create')
}

export function svcDeploy(id: string): void {
  useStore.setState((s) => ({ dep: { ...s.dep, id } }))
  tab('deploy')
}

export function svcTest(id: string): void {
  useStore.setState((s) => ({ tst: { ...s.tst, id } }))
  tab('test')
}

export function svcSupply(id: string): void {
  const sv = servers()
  let name = S().settings?.supplierServer ?? ''
  if (!sv.length) {
    tab('settings')
    foot('Add a server first; a supplier lives on a server.')
    return
  }
  if (!serverByName(name)) name = sv[0].name
  openSupplier(name, id)
}

export function openSupplier(name: string, preselect?: string): void {
  if (!serverByName(name)) {
    tab('supply')
    return
  }
  tab('supply')
  useStore.setState({ supOpen: { server: name, preselect } })
}
