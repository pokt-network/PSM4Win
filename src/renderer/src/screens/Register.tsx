// Register service (docs/SCREENS.md 3.4): form, card check, manifest save, preflight, execute.
import { useState } from 'react'
import { useStore, S, type Manifest } from '../store'
import { fmtPokt, fmtInt, POKT } from '@core/format'
import { costPerRelayUpokt } from '@core/chain'
import { service as lcdService, type LcdError } from '@core/lcd'
import {
  Checks,
  LogBox,
  PlanBlock,
  StatusLine,
  useLog,
  useStatus,
  ErrText,
  WarnText,
  netLabel,
  type CheckNode
} from '../components/ui'
import {
  dockerReady,
  dockerCycle,
  refreshNetwork,
  refreshBalance,
  loadHistory,
  recordManifestFor,
  writeManifest,
  setBusy,
  browseForServiceFolder,
  psm
} from '../lib/actions'
import { confirmTx, TxLink } from '../lib/flows'
import { alertDialog } from '../lib/modal'
import { selectRegisterFolder } from './Services'
import type { ValidateCardResult, FailResult } from '@core/contract'

type VC = ValidateCardResult | FailResult

interface Snapshot {
  id: string
  name: string
  cupr: number
  card: string
}

export function RegisterScreen(): React.JSX.Element {
  const { reg, local, net, params, busy } = useStore()
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const [plan, setPlan] = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [planOk, setPlanOk] = useState(false)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [isUpdate, setIsUpdate] = useState(false)
  const { lines, log, clear } = useLog()
  const set = (patch: Partial<typeof reg>): void => {
    useStore.setState((s) => ({ reg: { ...s.reg, ...patch } }))
  }
  const browseFolder = async (): Promise<void> => {
    const r = await browseForServiceFolder()
    if (!r.ok) {
      if (r.reason) setStatus(r.reason, 'err')
      return
    }
    await selectRegisterFolder(r.folder)
  }
  const form = (): Snapshot => ({
    id: reg.id.trim(),
    name: reg.name.trim(),
    cupr: parseInt(reg.cupr, 10),
    card: reg.card.trim()
  })

  const idT = reg.id.trim()
  const idOk = /^[A-Za-z0-9_-]{1,42}$/.test(idT)
  const idHint = !idT ? (
    'Permanent once registered. Lowercase, letters, digits, hyphen, underscore. Up to 42 characters.'
  ) : idOk ? (
    idT !== idT.toLowerCase() ? (
      <WarnText>Allowed, but lowercase is the convention.</WarnText>
    ) : (
      'Looks valid. Preflight checks the catalog.'
    )
  ) : (
    <ErrText>Only letters, digits, hyphen, underscore; 1 to 42 characters.</ErrText>
  )
  const cuprN = parseInt(reg.cupr, 10)
  const u = cuprN >= 1 && cuprN <= 1048576 ? costPerRelayUpokt(params, cuprN) : null
  const cuprHint = !(cuprN >= 1 && cuprN <= 1048576) ? (
    <ErrText>Must be a whole number from 1 to 1,048,576.</ErrText>
  ) : u === null ? (
    'Sets the price of one relay. Fetch the network to see the cost.'
  ) : (
    `One relay costs ${u} uPOKT (${(u / POKT).toFixed(6).replace(/0+$/, '')} POKT) at today's multiplier on ${netLabel(net)}.`
  )

  async function cardChecks(path: string, items: CheckNode[]): Promise<{ validate: VC } | null> {
    if (!path) {
      items.push({
        level: 'warn',
        text: 'No service card given.',
        sub: 'Allowed, but gateways and agents cannot discover what the service does. Add one with a later add-service.'
      })
      return null
    }
    const r = await psm().signer['validate-card']({ card_path: path })
    if (!r.ok && 'error' in r && /not found/.test(String(r.error))) {
      items.push({ level: 'fail', text: 'Card file not found.', sub: path })
      return null
    }
    if (!r.ok && !('output' in r)) {
      items.push({
        level: 'fail',
        text: 'Could not read the card.',
        sub: `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail ?? ''}`
      })
      return null
    }
    // The signer reads the file; the size and JSON checks below use the same file through it.
    const txt = 'output' in r ? r.output : ''
    const size = /size: (\d+) bytes/.exec(txt)
    const bytes = size ? Number(size[1]) : 0
    if (bytes > 262144) {
      items.push({
        level: 'fail',
        text: `Card is ${fmtInt(bytes)} bytes; the chain limit is 262,144.`
      })
      return null
    }
    if (/error: not a single JSON object/.test(txt)) {
      items.push({
        level: 'fail',
        text: 'Card is not valid JSON.',
        sub: txt
          .split('\n')
          .find((l) => l.startsWith('error:'))
          ?.slice(7)
      })
      return null
    }
    if (/error: card must be a JSON object/.test(txt)) {
      items.push({ level: 'fail', text: 'Card must be a single JSON object.' })
      return null
    }
    items.push({
      level: bytes > 4096 ? 'warn' : 'ok',
      text: `Card parses; ${fmtInt(bytes)} bytes.${bytes > 4096 ? ' Larger than the 4 KiB target.' : ''}`,
      sub: path
    })
    const cardSid = 'service_id' in r ? r.service_id : undefined
    if (cardSid && cardSid !== reg.id.trim())
      items.push({
        level: 'warn',
        text: "Card's service_id differs from the form.",
        sub: `${cardSid} vs ${reg.id.trim()}`
      })
    return { validate: r }
  }

  const validateOnly = async (): Promise<void> => {
    const items: CheckNode[] = []
    const path = reg.card.trim()
    setShowResults(true)
    setPlan(null)
    clear()
    setStatus('')
    const c = await cardChecks(path, items)
    setChecks([...items])
    if (!path || items.some((i) => i.level === 'fail')) return
    setStatus('Validating the card', 'busy')
    const r: VC = c?.validate ?? (await psm().signer['validate-card']({ card_path: path }))
    if ('skipped' in r && r.skipped)
      items.push({ level: 'info', text: 'Schema validation skipped.', sub: r.reason })
    else if ('output' in r)
      items.push({
        level: r.ok ? 'ok' : 'fail',
        text: r.ok ? 'Card validation passed.' : 'Card validation reported problems.',
        sub: <pre>{r.output}</pre>
      })
    setChecks([...items])
    setStatus('')
  }

  const saveManifest = async (): Promise<void> => {
    if (!reg.folder) {
      await alertDialog(
        'Choose a service folder first. Create one under services/ and press Rescan.'
      )
      return
    }
    const l = local.find((x) => x.folder === reg.folder)
    const m: Manifest = { ...(l?.manifest ?? {}) }
    m.service_id = reg.id.trim()
    m.name = reg.name.trim()
    m.compute_units_per_relay = parseInt(reg.cupr, 10)
    let card = reg.card.trim()
    const folderPath = `${S().servicesRoot ?? ''}\\${reg.folder}`
    if (card.toLowerCase().startsWith(folderPath.toLowerCase() + '\\'))
      card = card.substring(folderPath.length + 1)
    m.card = card
    const stk = parseFloat(S().stk.amount)
    if (stk > 0) m.application_stake_pokt = stk
    m.networks = m.networks || {}
    await writeManifest(reg.folder, m)
    useStore.setState({ foot: `Saved ${folderPath}\\service.json` })
  }

  const preflight = async (rechecked = false): Promise<void> => {
    if (S().busy) return
    const f = form()
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
    const st = S()
    if (!st.imported) items.push({ level: 'fail', text: 'No wallet imported.' })
    if (!dockerReady())
      items.push({
        level: 'fail',
        text: st.docker?.ok
          ? 'The pocketd image is not downloaded. Use the Download pocketd button in the top bar.'
          : 'Docker Desktop is not running. Start it (button in the top bar) and run preflight again.',
        sub: st.docker?.detail ?? ''
      })
    if (!/^[A-Za-z0-9_-]{1,42}$/.test(f.id))
      items.push({ level: 'fail', text: 'Service ID is invalid.' })
    if (!/^[A-Za-z0-9 _-]{1,169}$/.test(f.name))
      items.push({ level: 'fail', text: 'Display name is invalid or empty.' })
    if (!(f.cupr >= 1 && f.cupr <= 1048576))
      items.push({ level: 'fail', text: 'Compute units per relay must be 1 to 1,048,576.' })
    if (items.some((i) => i.level === 'fail')) return setChecks(items)

    await refreshNetwork()
    const bal = await refreshBalance()
    const p = S().params
    const label = netLabel(S().net)
    if (p.addServiceFee === undefined)
      items.push({ level: 'fail', text: 'Could not read the registration fee from the network.' })
    let update = false
    try {
      const s = await lcdService(S().net, f.id)
      if (s) {
        if (s.owner_address === S().address) {
          update = true
          items.push({
            level: 'warn',
            text: `Service '${f.id}' already exists and this wallet owns it. This will be an UPDATE.`,
            sub: `Name '${s.name}', ${s.compute_units_per_relay} CU/relay today. Only fields you pass change; omitting the card keeps the current card. The registration fee is charged on creation only, so this costs gas alone.`
          })
        } else
          items.push({
            level: 'fail',
            text: `Service ID '${f.id}' is already taken by another owner. IDs are permanent; choose a different one.`,
            sub: `Owner ${s.owner_address}`
          })
      } else items.push({ level: 'ok', text: `Service ID '${f.id}' is free on ${label}.` })
    } catch (e) {
      items.push({
        level: 'fail',
        text: `Could not check the catalog (HTTP ${(e as LcdError).status ?? 0}).`
      })
    }
    const catalog = S().catalog
    if (catalog) {
      const lowerId = f.id.toLowerCase().replace(/[-_]/g, '')
      const lowerName = f.name.toLowerCase()
      for (const c of catalog) {
        if (c.id === f.id) continue
        if (c.id.toLowerCase().replace(/[-_]/g, '') === lowerId)
          items.push({
            level: 'warn',
            text: `Existing service '${c.id}' differs only in case or separators.`,
            sub: 'Consider supplying that service instead of registering a near duplicate.'
          })
        if ((c.name || '').toLowerCase() === lowerName && lowerName)
          items.push({
            level: 'warn',
            text: `Another service already uses the name '${c.name}' (ID ${c.id}).`
          })
      }
    }
    const cardRes = await cardChecks(f.card, items)
    const fee = update ? 0 : p.addServiceFee || 0
    const margin = 1 * POKT
    if (bal === null || bal === undefined)
      items.push({ level: 'fail', text: 'Could not read the wallet balance.' })
    else if (bal < fee + margin)
      items.push({
        level: 'fail',
        text: `Balance ${fmtPokt(bal)} POKT is below the fee ${fmtPokt(fee)} POKT plus about 1 POKT for gas.`
      })
    else
      items.push({
        level: 'ok',
        text: `Balance ${fmtPokt(bal)} POKT covers ${update ? 'the update (gas only)' : `the registration fee of ${fmtPokt(fee)} POKT plus gas`}.`,
        sub: `Fee read live from the ${label} service module.`
      })
    const uu = costPerRelayUpokt(p, f.cupr)
    if (uu !== null)
      items.push({
        level: 'info',
        text: `Price: ${f.cupr} CU/relay = ${uu} uPOKT per relay at today's multiplier.`
      })
    if (items.some((i) => i.level === 'fail')) {
      setChecks(items)
      return setStatus('Fix the red items and run preflight again.', 'err')
    }
    setChecks([...items])
    setStatus('Validating the card and building the plan', 'busy')
    if (f.card) {
      const r = cardRes?.validate
      if (r && 'skipped' in r && r.skipped)
        items.push({ level: 'info', text: 'Schema validation skipped.', sub: r.reason })
      else if (r && 'output' in r && r.ok)
        items.push({ level: 'ok', text: 'Card validation passed.', sub: <pre>{r.output}</pre> })
      else if (r && 'output' in r) {
        items.push({
          level: 'fail',
          text: 'Card validation reported problems.',
          sub: <pre>{r.output}</pre>
        })
        setChecks([...items])
        return setStatus('Fix the card and run preflight again.', 'err')
      }
    }
    const dry = await psm().signer['tx-add-service']({
      network: S().net,
      service_id: f.id,
      name: f.name,
      compute_units_per_relay: f.cupr,
      card_path: f.card,
      dry: true
    })
    if (!dry.ok || !('command' in dry)) {
      items.push({
        level: 'fail',
        text: 'The signer refused the plan.',
        sub: `${(dry as { error?: string }).error ?? ''} ${(dry as { detail?: string }).detail ?? ''}`
      })
      setChecks([...items])
      return setStatus('Fix the red items and run preflight again.', 'err')
    }
    setPlan(dry.command)
    setChecks([...items])
    setPlanOk(true)
    setIsUpdate(update)
    setSnap(f)
    setStatus(`Preflight passed. Review the plan, then press Register on ${label}.`, 'ok')
  }

  const execute = async (): Promise<void> => {
    if (!planOk || S().busy || !snap) return
    const f = snap
    if (JSON.stringify(f) !== JSON.stringify(form())) {
      setStatus('The form changed since preflight. Run preflight again.', 'err')
      setPlanOk(false)
      return
    }
    const label = netLabel(S().net)
    const ok = await confirmTx({
      mainTitle: 'Confirm MainNet registration',
      mainBody: (
        <div className="dangerbox">
          This spends real POKT:{' '}
          {isUpdate ? (
            'gas for the update (the registration fee is charged on creation only)'
          ) : (
            <>
              the registration fee of <b>{fmtPokt(S().params.addServiceFee)} POKT</b> plus gas
            </>
          )}
          . The service ID <b>{f.id}</b> is permanent.
        </div>
      ),
      token: f.id,
      prompt: <p>Type the service ID to confirm.</p>,
      mainOkLabel: 'Register on MainNet',
      betaText: `Register '${f.id}' on Beta TestNet now?`,
      betaOkLabel: 'Register'
    })
    if (!ok) return
    setBusy(true)
    setPlanOk(false)
    clear()
    log(`Signing and broadcasting add-service for '${f.id}' on ${label}`)
    setStatus('Waiting for pocketd (simulating gas, signing, broadcasting)', 'busy')
    const r = await psm().signer['tx-add-service']({
      network: S().net,
      service_id: f.id,
      name: f.name,
      compute_units_per_relay: f.cupr,
      card_path: f.card
    })
    if (!r.ok || !('txhash' in r)) {
      setBusy(false)
      log(
        `${(r as { error?: string }).error ?? ''} ${(r as { detail?: string }).detail || (r as { raw_log?: string }).raw_log || ''}`,
        'err'
      )
      return setStatus(
        'Registration failed. Nothing was charged unless a tx hash is shown above.',
        'err'
      )
    }
    log(
      <>
        Accepted into the mempool. Tx <TxLink hash={r.txhash} />
        {r.gas ? ` (gas estimate ${fmtInt(r.gas)})` : ''}
      </>
    )
    setStatus('Waiting for the transaction to be included in a block', 'busy')
    const t = await (await import('../lib/actions')).pollTx(r.txhash)
    if (!t.ok) {
      setBusy(false)
      log(t.error ?? '', 'err')
      return setStatus('The transaction did not succeed.', 'err')
    }
    log(`Included in block ${fmtInt(t.height)}.`, 'ok')
    let v: Awaited<ReturnType<typeof lcdService>> = null
    try {
      v = await lcdService(S().net, f.id)
    } catch {
      v = null
    }
    if (v && v.owner_address === S().address) {
      log(
        `Verified on chain: '${v.name}', ${v.compute_units_per_relay} CU/relay, owner ${v.owner_address}.`,
        'ok'
      )
      setStatus(`Service '${f.id}' is registered on ${label}.`, 'ok')
      if (reg.folder)
        await recordManifestFor(reg.folder, isUpdate ? 'last_update_tx' : 'register_tx', r.txhash)
      useStore.setState((s) => ({ stk: { ...s.stk, id: f.id } }))
    } else {
      log(
        'The transaction succeeded but the service could not be read back yet. Refresh the network in a moment.',
        'err'
      )
      setStatus('Registered, verification pending.', 'ok')
    }
    setBusy(false)
    void refreshBalance()
    void refreshNetwork()
    void loadHistory()
  }

  return (
    <>
      <div className="panel">
        <h2>Register a service</h2>
        <label>Service folder</label>
        <div className="filerow">
          <input
            id="svcFolder"
            type="text"
            readOnly
            value={reg.folder}
            placeholder="Choose a folder in services/"
          />
          <button type="button" className="btn small" onClick={browseFolder}>
            Browse&hellip;
          </button>
          <button type="button" className="btn small" onClick={() => set({ folder: '' })}>
            Clear
          </button>
        </div>
        <div className="hint">
          Browsing to a folder fills the form from its service.json and uses its card.json. You can
          still edit every field. No folder yet? Use Create service.
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <div>
            <label>Service ID</label>
            <input
              type="text"
              id="svcId"
              placeholder="example-charts"
              maxLength={42}
              value={reg.id}
              onChange={(e) => set({ id: e.target.value })}
            />
            <div className="hint" id="svcIdHint">
              {idHint}
            </div>
          </div>
          <div>
            <label>Display name</label>
            <input
              type="text"
              placeholder="Example Charts"
              maxLength={169}
              value={reg.name}
              onChange={(e) => set({ name: e.target.value })}
            />
            <div className="hint">
              Shown in the catalog. Letters, digits, spaces, hyphen, underscore. Can be changed
              later.
            </div>
          </div>
        </div>
        <div className="row">
          <div>
            <label>Compute units per relay</label>
            <input
              type="number"
              min={1}
              max={1048576}
              value={reg.cupr}
              onChange={(e) => set({ cupr: e.target.value })}
            />
            <div className="hint" id="cuprHint">
              {cuprHint}
            </div>
          </div>
          <div>
            <label>Service card (JSON file)</label>
            <div className="filerow">
              <input
                type="text"
                id="svcCard"
                placeholder="C:\path\to\card.json"
                value={reg.card}
                onChange={(e) => set({ card: e.target.value })}
              />
              <button
                className="btn small"
                onClick={async () => {
                  const p = await psm().settings.pickFile({
                    initial: reg.card || undefined,
                    json: true
                  })
                  if (p) set({ card: p })
                }}
              >
                Browse
              </button>
            </div>
            <div className="hint">
              Optional but recommended. Describes the service to gateways and agents. Validated
              before anything is sent.
            </div>
          </div>
        </div>
        <div className="btnrow">
          <button className="btn" onClick={validateOnly}>
            Check card
          </button>
          <button className="btn" onClick={saveManifest}>
            Save to service.json
          </button>
          <button className="btn primary" disabled={busy} onClick={() => preflight()}>
            Run preflight
          </button>
          <button
            className="btn primary"
            id="btnRegister"
            disabled={!planOk || busy}
            onClick={execute}
          >
            Register on {netLabel(net)}
          </button>
        </div>
      </div>
      {showResults ? (
        <div className="panel" id="regResults">
          <h2>Preflight</h2>
          <Checks items={checks} id="regChecks" />
          <PlanBlock
            label="Exact command the signer will run (the passphrase never touches the command line)"
            text={plan}
          />
          <StatusLine status={status} id="regStatus" />
          <LogBox lines={lines} id="regLog" />
        </div>
      ) : null}
    </>
  )
}
