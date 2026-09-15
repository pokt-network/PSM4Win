// Settings (docs/SCREENS.md 3.11): services folder, servers, Provision, welcome.
import { useEffect, useRef, useState } from 'react'
import { useStore, S } from '../store'
import { copy } from '../lib/actions'
import type { Network } from '@core/networks'
import { RE } from '@core/validate'
import { fmtPokt, fmtInt, shortAddr, POKT } from '@core/format'
import {
  Badge,
  Checks,
  LogBox,
  StatusLine,
  useLog,
  useStatus,
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
  CADDY_DIR,
  saveServers,
  saveSettings,
  setStack,
  loadServiceFolders,
  loadHistory,
  balanceOf,
  refreshBalance,
  dockerReady,
  setBusy,
  setNetwork,
  tab,
  psm,
  pollTx,
  type ServerEntry
} from '../lib/actions'
import { confirmDialog } from '../lib/modal'
import { confirmTx } from '../lib/flows'
import { showWelcome } from '../lib/welcome'
import { account } from '@core/lcd'

export function SettingsScreen(): React.JSX.Element {
  return (
    <>
      <ServicesRootPanel />
      <ServersPanel />
      <ProvisionPanel />
      <ClaudeIntegrationPanel />
      <div className="panel">
        <h2>Welcome message</h2>
        <div className="hint">
          The introduction shown on first run: what the app does, what to have ready, and the order
          of the steps.
        </div>
        <div className="btnrow">
          <button className="btn small" onClick={showWelcome}>
            Show Welcome Message
          </button>
        </div>
      </div>
    </>
  )
}

function ServicesRootPanel(): React.JSX.Element {
  const { servicesRoot, settings } = useStore()
  const [path, setPath] = useState(settings?.servicesRoot ?? servicesRoot ?? '')
  const [status, setStatus] = useStatus()
  useEffect(() => {
    setPath(settings?.servicesRoot ?? servicesRoot ?? '')
  }, [servicesRoot, settings?.servicesRoot])
  const use = async (p: string): Promise<void> => {
    const t = p.trim()
    if (!t || !(await psm().files.dirExists(t))) {
      setStatus('That folder does not exist.', 'err')
      return
    }
    await saveSettings({ servicesRoot: t })
    await loadServiceFolders()
    setStatus(`Using ${t}.`, 'ok')
  }
  return (
    <div className="panel">
      <h2>Services folder</h2>
      <div className="hint">
        Each subfolder is one service: its <span className="mono">service.json</span> and{' '}
        <span className="mono">card.json</span>. Set once.
      </div>
      <div className="filerow" style={{ marginTop: 8 }}>
        <input
          type="text"
          id="setRoot"
          placeholder="C:\path\to\services"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button className="btn small" onClick={() => use(path)}>
          Use this folder
        </button>
      </div>
      <div className="btnrow">
        <button
          className="btn small"
          onClick={async () => {
            const p = await psm().settings.pickDir(path || undefined)
            if (p) {
              setPath(p)
              await use(p)
            }
          }}
        >
          Browse
        </button>
        <button
          className="btn small"
          disabled={!servicesRoot}
          onClick={() => servicesRoot && psm().app.openPath(servicesRoot)}
        >
          Open folder
        </button>
        <button className="btn small" onClick={() => loadServiceFolders()}>
          Rescan
        </button>
        <button
          className="btn small"
          onClick={async () => {
            await saveSettings({ servicesRoot: '' })
            await loadServiceFolders()
            setStatus('No folder chosen. Pick one to see and create service folders.', 'ok')
          }}
        >
          Clear
        </button>
      </div>
      <StatusLine status={status} id="setRootStatus" />
    </div>
  )
}

interface ServerForm {
  name: string
  host: string
  port: string
  user: string
  keyPath: string
  deployRoot: string
}
const EMPTY_SERVER: ServerForm = {
  name: '',
  host: '',
  port: '22',
  user: '',
  keyPath: '',
  deployRoot: '/opt/pocket/services'
}

/** app.js serverForm(): trimmed fields, port coerced with a default of 22. */
function serverForm(f: ServerForm): ServerEntry {
  return {
    name: f.name.trim(),
    host: f.host.trim(),
    port: parseInt(f.port, 10) || 22,
    user: f.user.trim(),
    keyPath: f.keyPath.trim(),
    deployRoot: f.deployRoot.trim(),
    suppliers: {}
  }
}

async function validateServer(f: ServerEntry): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(f.name))
    return 'Name: letters, digits, dot, hyphen, underscore; up to 40 characters.'
  if (!/^[A-Za-z0-9.-]+$/.test(f.host)) return 'Host must be a hostname or IP address.'
  if (!(f.port >= 1 && f.port <= 65535)) return 'Port must be 1 to 65535.'
  if (!/^[A-Za-z0-9._-]+$/.test(f.user)) return 'User is required.'
  if (!f.keyPath || !(await psm().files.fileExists(f.keyPath)))
    return 'SSH key file not found on this PC.'
  if (f.deployRoot && !/^\/[A-Za-z0-9._/-]*$/.test(f.deployRoot))
    return 'Deploy root must be an absolute Linux path.'
  return ''
}

function ServersPanel(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const net = useStore((s) => s.net)
  const list = (settings?.servers ?? []) as ServerEntry[]
  const [form, setForm] = useState<ServerForm>(EMPTY_SERVER)
  const [editing, setEditing] = useState('')
  const [status, setStatus] = useStatus()
  const upd = (k: keyof ServerForm, v: string): void => setForm((f) => ({ ...f, [k]: v }))

  const save = async (): Promise<void> => {
    const entry = serverForm(form)
    const err = await validateServer(entry)
    if (err) {
      setStatus(err, 'err')
      return
    }
    let found = false
    const next = servers().map((s) => {
      if (s.name !== entry.name) return s
      found = true
      return { ...entry, suppliers: s.suppliers ?? {} }
    })
    if (!found) next.push(entry)
    await saveServers(next)
    setStatus(`${found ? 'Updated' : 'Added'} server ${entry.name}.`, 'ok')
    setEditing('')
  }
  const edit = (name: string): void => {
    const s = serverByName(name)
    if (!s) return
    setForm({
      name: s.name,
      host: s.host,
      port: String(s.port),
      user: s.user,
      keyPath: s.keyPath,
      deployRoot: s.deployRoot || ''
    })
    setEditing(name)
    setStatus(`Editing ${name}. Save to apply.`)
  }
  const remove = async (name: string): Promise<void> => {
    if (
      !(await confirmDialog(
        `Remove server '${name}' from this app? Nothing on the server changes.`,
        'Remove',
        'Remove server',
        'danger solid'
      ))
    )
      return
    const patch: { servers: ServerEntry[]; supplierServer?: string } = {
      servers: servers().filter((s) => s.name !== name)
    }
    if (S().settings?.supplierServer === name) patch.supplierServer = ''
    await saveSettings(patch as never)
    setStatus(`Removed ${name}.`, 'ok')
  }
  const test = async (): Promise<void> => {
    const f = serverForm(form)
    const err = await validateServer(f)
    if (err) {
      setStatus(err, 'err')
      return
    }
    const stDir = stackOf(serverByName(f.name), net)?.dir ?? ''
    setStatus(`Connecting to ${f.user}@${f.host} on port ${f.port}`, 'busy')
    const r = await psm().signer['ssh-test']({
      host: f.host,
      port: f.port,
      user: f.user,
      key_path: f.keyPath,
      path: stDir
    })
    if (!r.ok) {
      setStatus(`${r.error} ${r.detail ?? ''}`, 'err')
      return
    }
    setStatus(
      `Connected: ${r.hostname}, ${r.docker || 'docker not found'}${stDir ? (r.keyring ? `, ${netLabel(net)} operator keyring found` : `, no pocket-home in ${stDir}`) : ''}.`,
      r.docker && (!stDir || r.keyring) ? 'ok' : 'err'
    )
  }

  return (
    <div className="panel">
      <h2>Servers</h2>
      <div className="hint">
        Where RelayMiners run. A server is an SSH connection and a deploy root; it knows nothing
        about networks. Each network it supplies gets its own stack on it (a RelayMiner, an operator
        key that never leaves the server, and a public hostname), created by Provision. The server's
        Caddy is shared. Nothing here depends on an SSH config file. Only a key path is stored,
        never key material.
      </div>
      <div id="srvList" style={{ marginTop: 10 }}>
        {!list.length ? (
          <div className="hint">
            No servers yet. Fill in the form below, then provision the server for a network.
          </div>
        ) : (
          <table className="services">
            <thead>
              <tr>
                <th>Name</th>
                <th>Connection</th>
                <th>Deploy root</th>
                <th>Beta TestNet</th>
                <th>MainNet</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.name}>
                  <td className="svcid">{s.name}</td>
                  <td className="mono">{`${s.user}@${s.host}:${s.port}`}</td>
                  <td className="mono">{s.deployRoot || '/opt/pocket/services'}</td>
                  <td>
                    <StackCell s={s} net="beta" />
                  </td>
                  <td>
                    <StackCell s={s} net="main" />
                  </td>
                  <td className="actions">
                    <button className="btn small" onClick={() => edit(s.name)}>
                      Edit
                    </button>
                    <button className="btn small danger" onClick={() => remove(s.name)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <h2 id="srvFormTitle" style={{ marginTop: 18 }}>
        {editing ? `Edit server ${editing}` : 'Add new server'}
      </h2>
      <div className="row">
        <div>
          <label>Name</label>
          <input
            type="text"
            placeholder="a short name"
            maxLength={40}
            value={form.name}
            onChange={(e) => upd('name', e.target.value)}
          />
        </div>
        <div>
          <label>Host</label>
          <input
            type="text"
            placeholder="hostname or IP"
            value={form.host}
            onChange={(e) => upd('host', e.target.value)}
          />
        </div>
        <div>
          <label>Port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => upd('port', e.target.value)}
          />
        </div>
        <div>
          <label>User</label>
          <input
            type="text"
            placeholder="ssh user"
            value={form.user}
            onChange={(e) => upd('user', e.target.value)}
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label>SSH private key file</label>
          <div className="filerow">
            <input
              type="text"
              placeholder="C:\path\to\private-key"
              value={form.keyPath}
              onChange={(e) => upd('keyPath', e.target.value)}
            />
            <button
              className="btn small"
              onClick={async () => {
                const p = await psm().settings.pickFile({ initial: form.keyPath || undefined })
                if (p) upd('keyPath', p)
              }}
            >
              Browse
            </button>
          </div>
          <div className="hint">
            An OpenSSH key on this PC. Its passphrase, if any, must be held by ssh-agent.
          </div>
        </div>
        <div>
          <label>Deploy root</label>
          <input
            type="text"
            placeholder="/opt/pocket/services"
            value={form.deployRoot}
            onChange={(e) => upd('deployRoot', e.target.value)}
          />
          <div className="hint">
            Where service backends are shipped. One backend container serves every network's stack.
          </div>
        </div>
      </div>
      <div className="btnrow">
        <button className="btn primary" onClick={save}>
          Save server
        </button>
        <button className="btn" onClick={test}>
          Test connection
        </button>
        <button
          className="btn"
          onClick={() => {
            setForm(EMPTY_SERVER)
            setEditing('')
            setStatus('')
          }}
        >
          Clear form
        </button>
      </div>
      <StatusLine status={status} id="srvStatus" />
    </div>
  )
}

function StackCell({ s, net }: { s: ServerEntry; net: Network }): React.JSX.Element {
  const st = stackOf(s, net)
  const ss = stackState(st)
  if (ss === 'none') return <Badge cls="muted">not provisioned</Badge>
  return (
    <>
      {ss === 'ready' ? (
        <Badge cls="ok">provisioned</Badge>
      ) : (
        <Badge cls="warn">provisioning pending</Badge>
      )}
      <div className="mono" style={{ marginTop: 4 }} title={st?.operator ?? ''}>
        {st?.operator ? shortAddr(st.operator) : ''}
      </div>
      <div className="hint">{hostOfUrl(st?.url)}</div>
      <div className="hint mono">{st?.dir ?? ''}</div>
      {st?.provisioned_at ? (
        <div className="hint">{String(st.provisioned_at).substring(0, 10)}</div>
      ) : null}
    </>
  )
}

// ---- Provision ----

export function openProvision(name: string, net: Network): void {
  const s = serverByName(name)
  if (!s) return
  const st = stackOf(s, net)
  useStore.setState(
    (x) =>
      ({
        prov: {
          ...x.prov,
          server: name,
          net,
          dir: st?.dir || stackDirDefault(net),
          host: st ? hostOfUrl(st.url) : ''
        },
        provOpenAt: Date.now()
      }) as never
  )
}

export async function provisionOn(name: string, net: Network): Promise<void> {
  if (net !== S().net) {
    await setNetwork(net)
    if (S().net !== net) return
  }
  tab('settings')
  openProvision(name, net)
}

function ProvisionPanel(): React.JSX.Element {
  const { prov, settings, net: appNet, params, busy } = useStore()
  const list = (settings?.servers ?? []) as ServerEntry[]
  const panelRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const { lines, log, clear } = useLog()
  const setProv = (patch: Partial<typeof prov>): void =>
    useStore.setState((s) => ({ prov: { ...s.prov, ...patch } }))

  // Default server and, when the directory is blank, the current network's defaults.
  useEffect(() => {
    if (!list.length) {
      if (prov.server) setProv({ server: '', dir: '', host: '' })
      return
    }
    const server = serverByName(prov.server) ? prov.server : list[0].name
    if (server !== prov.server || !prov.dir) {
      const st = stackOf(serverByName(server), prov.net || appNet)
      const n = prov.dir ? prov.net : appNet
      setProv({
        server,
        net: n,
        dir: prov.dir || st?.dir || stackDirDefault(n),
        host: prov.host || (st ? hostOfUrl(st.url) : '')
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, prov.server])

  const provOpenAt = useStore((s) => (s as unknown as { provOpenAt?: number }).provOpenAt)
  useEffect(() => {
    if (provOpenAt) {
      setChecks([])
      clear()
      setStatus('')
      panelRef.current?.scrollIntoView(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provOpenAt])

  const s = serverByName(prov.server)
  const st = s ? stackOf(s, prov.net) : null
  const ss = stackState(st)
  const onNetChange = (n: Network): void => {
    const st2 = s ? stackOf(s, n) : null
    setProv({ net: n, dir: st2?.dir || stackDirDefault(n), host: st2 ? hostOfUrl(st2.url) : '' })
  }
  const dirHint = !list.length
    ? "Holds this network's RelayMiner, operator keyring, and relayer config."
    : ss === 'ready'
      ? `This server already has a ${netLabel(prov.net)} stack there; its operator key and relayer config are kept.`
      : ss === 'pending'
        ? 'Provisioning of this stack was interrupted after its operator key was created. Start provisioning resumes it; finished steps are not repeated.'
        : `A new stack for ${netLabel(prov.net)}; a new operator key is created on the server.`
  const btnLabel =
    ss === 'pending'
      ? 'Continue provisioning'
      : ss === 'ready'
        ? 'Re-provision'
        : 'Start provisioning'

  const run = async (): Promise<void> => {
    if (S().busy || !s) {
      if (!s) setStatus('Choose a server.', 'err')
      return
    }
    const net = prov.net
    const host = prov.host.trim()
    const topup = parseFloat(prov.fund)
    const dir = prov.dir.trim()
    if (!RE.linuxPath.test(dir))
      return setStatus('The stack directory must be an absolute Linux path.', 'err')
    for (const [on, stk] of Object.entries(s.suppliers ?? {})) {
      if (on !== net && stk?.dir === dir)
        return setStatus(
          `That directory already holds the ${netLabel(on as Network)} stack. Each network needs its own directory.`,
          'err'
        )
    }
    const existing = stackOf(s, net) ?? ({} as Partial<typeof st>)
    const project = existing?.project || stackProjectDefault(net)
    const ports = stackPorts(net)
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host))
      return setStatus('Enter the public hostname (a DNS name pointing at the server).', 'err')
    if (!S().imported || !dockerReady())
      return setStatus('Owner wallet and Docker must be ready.', 'err')
    if (net !== S().net)
      return setStatus(
        `Switch the app to ${netLabel(net)} first; the operator is funded and published on the network being provisioned.`,
        'err'
      )
    const conn = { host: s.host, port: s.port, user: s.user, key_path: s.keyPath, path: dir }
    const results: CheckNode[] = []
    let operator = existing?.operator || ''
    setBusy(true)
    clear()
    setChecks([])
    setStatus('Provisioning', 'busy')
    const mark = (label: string, ok: boolean, note?: string): void => {
      results.push({ level: ok ? 'ok' : 'fail', text: label, sub: note || '' })
      setChecks([...results])
    }
    const fail = (msg: string): void => {
      log(msg, 'err')
      setStatus(
        'Provisioning stopped. Fix the problem and start again; finished steps are kept.',
        'err'
      )
      setBusy(false)
    }
    const done = async (): Promise<void> => {
      await setStack(s.name, net, {
        dir,
        project,
        url: 'https://' + host,
        operator,
        provisioned_at: new Date().toISOString()
      })
      log(
        `Server ${s.name} now has a ${netLabel(net)} supplier stack at ${dir}. Deploy a service to it next (Services, Deploy service).`,
        'ok'
      )
      setStatus(`Provisioned. Operator ${operator}.`, 'ok')
      setBusy(false)
      void loadHistory()
    }
    const sg = psm().signer
    log(`Checking the SSH connection to ${s.user}@${s.host} on port ${s.port}`)
    const r = await sg['ssh-test']({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      key_path: conn.key_path
    })
    if (!r.ok) {
      mark('SSH connection', false, `${r.error} ${r.detail ?? ''}`)
      return fail('Could not connect.')
    }
    if (!r.docker) {
      mark('Docker on the server', false, 'Docker Compose was not found on the server.')
      return fail('Install Docker on the server first.')
    }
    mark('SSH connection and Docker', true, `${r.hostname}, ${r.docker}`)
    log(
      `Shipping the ${netLabel(net)} RelayMiner stack to ${dir} (project ${project}) with hostname ${host}, and the shared Caddy to ${CADDY_DIR}`
    )
    const r2 = await sg['supplier-ship']({
      ...conn,
      network: net,
      hostname: host,
      project,
      caddy_dir: CADDY_DIR,
      health_port: ports.health,
      relayer_metrics_port: ports.relayer_metrics,
      miner_metrics_port: ports.miner_metrics,
      block_time: Math.round(params.blockTime || 0)
    })
    if (!r2.ok) {
      mark('Ship the stack', false, `${r2.error} ${r2.detail ?? ''}`)
      return fail('Shipping failed.')
    }
    mark(
      'Ship the stack',
      true,
      `Copied ${r2.files.join(', ')}${r2.relayer_kept ? '; the existing relayer config with its services was kept' : ''}`
    )
    await setStack(s.name, net, { dir, project, url: 'https://' + host })
    log(
      'Creating the operator key on the server (kept if it already exists). It never leaves the server.'
    )
    const r3 = await sg['supplier-run']({ ...conn, step: 'operator' })
    if (!r3.ok || !r3.address) {
      mark(
        'Operator key',
        false,
        r3.err || (r3 as { error?: string }).error || 'no address returned'
      )
      return fail('Operator key step failed.')
    }
    operator = r3.address
    await setStack(s.name, net, { dir, project, operator, url: 'https://' + host })
    mark('Operator key', true, r3.lines.join(' | '))
    log("Writing the RelayMiner's key file from the operator keyring (mode 400).")
    const r4 = await sg['supplier-run']({ ...conn, step: 'keys' })
    if (!r4.ok) {
      mark('RelayMiner key file', false, r4.err || (r4 as { error?: string }).error || '')
      return fail('Key file step failed.')
    }
    mark('RelayMiner key file', true, 'supplier-keys.yaml written')
    const bal = (await balanceOf(operator)) || 0
    log(`Operator ${operator} holds ${fmtPokt(bal)} POKT on ${netLabel(net)}.`)
    const afterFunding = async (): Promise<void> => {
      let published = false
      try {
        published = (await account(net, operator)).hasPubKey
      } catch {
        published = false
      }
      const afterPublish = async (): Promise<void> => {
        log(
          "Starting the server's shared Caddy, then Redis and the miner. The relayer starts with the first deployed service."
        )
        const r6 = await sg['supplier-run']({ ...conn, step: 'start' })
        if (!r6.ok) {
          mark('Start the stack', false, r6.err || (r6 as { error?: string }).error || '')
          return fail('Start failed.')
        }
        mark('Start the stack', true, r6.lines.slice(-3).join(' | '))
        const r7 = await sg['supplier-run']({ ...conn, step: 'status' })
        if (r7.ok) mark('Status', true, r7.lines.join(' | '))
        await done()
      }
      if (published) {
        mark('Operator public key on chain', true, 'already published')
        return afterPublish()
      }
      log("Publishing the operator's public key with a 1 uPOKT self-transfer signed on the server.")
      const r5 = await sg['supplier-run']({ ...conn, step: 'publish', network: net })
      if (!r5.ok) {
        mark(
          'Operator public key on chain',
          false,
          r5.err || (r5 as { error?: string }).error || ''
        )
        return fail('Publishing failed. Is the operator funded?')
      }
      mark('Operator public key on chain', true, r5.lines.join(' | '))
      await afterPublish()
    }
    if (bal >= 5 * POKT) {
      mark('Operator gas', true, `${fmtPokt(bal)} POKT available`)
      return afterFunding()
    }
    if (!(topup > 0)) {
      mark('Operator gas', false, 'The operator needs POKT for gas and no top-up amount was given.')
      return fail('Enter a top-up amount.')
    }
    const upokt = Math.round(topup * POKT)
    log(`Sending ${fmtPokt(upokt)} POKT from the owner wallet to the operator for gas.`)
    const okToSend = await confirmTx({
      mainTitle: 'Confirm MainNet transfer',
      mainBody: (
        <div className="dangerbox">
          This sends <b>{fmtPokt(upokt)} POKT</b> of real funds from the owner wallet to the new
          operator <b>{operator}</b>.
        </div>
      ),
      token: 'SEND',
      mainOkLabel: 'Send on MainNet',
      betaText: `Send ${fmtPokt(upokt)} POKT from the owner wallet to the operator ${operator} on Beta TestNet?`,
      betaOkLabel: 'Send'
    })
    if (!okToSend) return fail('Funding cancelled.')
    const rf = await sg['tx-fund-operator']({ network: net, to: operator, amount_upokt: upokt })
    if (!rf.ok || !('txhash' in rf)) {
      mark(
        'Operator gas',
        false,
        `${(rf as { error?: string }).error ?? ''} ${(rf as { detail?: string }).detail ?? ''}`
      )
      return fail('Funding failed.')
    }
    const t = await pollTx(rf.txhash)
    if (!t.ok) {
      mark('Operator gas', false, t.error ?? '')
      return fail('Funding transaction failed.')
    }
    mark('Operator gas', true, `Sent ${fmtPokt(upokt)} POKT in block ${fmtInt(t.height)}`)
    void refreshBalance()
    void loadHistory()
    await afterFunding()
  }

  return (
    <div className="panel" id="provPanel" ref={panelRef}>
      <h2>Provision a supplier</h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        Creates one network's supplier stack on a server: copies the RelayMiner stack to its own
        directory, creates that stack's operator key there (it never leaves), funds it from the
        owner wallet if needed, publishes its public key, starts the server's shared Caddy with the
        network's hostname, then Redis and the miner. The relayer starts when the first service is
        deployed. Safe to run again on a provisioned stack; existing keys and configs are kept.
      </p>
      <div className="row">
        <div>
          <label>Server</label>
          <select
            id="provServer"
            value={prov.server}
            onChange={(e) => {
              const st2 = stackOf(serverByName(e.target.value), prov.net)
              setProv({
                server: e.target.value,
                dir: st2?.dir || stackDirDefault(prov.net),
                host: st2 ? hostOfUrl(st2.url) : ''
              })
            }}
          >
            {!list.length ? <option value="">No servers</option> : null}
            {list.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
          <div className="hint" id="provServerHint">
            {s ? `${s.user}@${s.host}:${s.port}` : 'Add a server above first.'}
          </div>
        </div>
        <div>
          <label>Network</label>
          <select
            id="provNet"
            value={prov.net}
            onChange={(e) => onNetChange(e.target.value as Network)}
          >
            <option value="beta">Beta TestNet</option>
            <option value="main">MainNet</option>
          </select>
          <div className="hint">
            One stack per network; a server can hold both. Must match the network the app is on.
          </div>
        </div>
        <div>
          <label>Stack directory</label>
          <input
            type="text"
            id="provDir"
            placeholder="/opt/pocket/supplier-main"
            value={prov.dir}
            onChange={(e) => setProv({ dir: e.target.value })}
          />
          <div className="hint" id="provDirHint">
            {dirHint}
          </div>
        </div>
        <div>
          <label>Public hostname</label>
          <input
            type="text"
            id="provHost"
            placeholder="services.example.com"
            value={prov.host}
            onChange={(e) => setProv({ host: e.target.value })}
          />
          <div className="hint">
            One hostname per network, its DNS record already pointing at the server; Caddy requests
            the certificate for it.
          </div>
        </div>
        <div>
          <label>Operator gas top-up (POKT)</label>
          <input
            type="number"
            id="provFund"
            min={0}
            step={1}
            value={prov.fund}
            onChange={(e) => setProv({ fund: e.target.value })}
          />
          <div className="hint">
            Sent from the owner wallet only if the operator holds less than 5 POKT.
          </div>
        </div>
      </div>
      <div className="btnrow">
        <button className="btn primary" id="btnProv" disabled={busy} onClick={run}>
          {btnLabel}
        </button>
      </div>
      <StatusLine status={status} id="provStatus" />
      <Checks items={checks} id="provChecks" />
      <LogBox lines={lines} id="provLog" />
    </div>
  )
}

// ---- Claude Integration (new; the HTA has no equivalent). Endpoint from src/core/versions.ts. ----

function ClaudeIntegrationPanel(): React.JSX.Element {
  const appInfo = useStore((s) => s.appInfo)
  const endpoint = appInfo?.mcpEndpoint ?? ''
  const cli = `claude mcp add --transport http pocket ${endpoint}`
  const mcpJson = JSON.stringify(
    { mcpServers: { pocket: { type: 'http', url: endpoint } } },
    null,
    2
  )
  return (
    <div className="panel" id="claudePanel">
      <h2>Claude Integration</h2>
      <div className="hint">
        The Pocket Service Builder MCP server gives Claude read-only tools for the catalog, live
        parameters, cards, and supplier state. It never signs or spends; this app does. Connect
        either client to the same endpoint.
      </div>
      <label>Endpoint</label>
      <div className="filerow">
        <input type="text" readOnly value={endpoint} />
        <button className="btn small" onClick={() => copy(endpoint)}>
          Copy
        </button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <div>
          <h2 style={{ fontSize: 14, marginTop: 6 }}>Claude Code (terminal)</h2>
          <div className="hint">
            Run once in any terminal, or add the project file below to the repository you work in.
          </div>
          <div className="filerow" style={{ marginTop: 6 }}>
            <input type="text" readOnly value={cli} className="mono" />
            <button className="btn small" onClick={() => copy(cli)}>
              Copy command
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Project file <span className="mono">.mcp.json</span>:
          </div>
          <div className="plan">
            <div className="lbl">.mcp.json</div>
            <pre>{mcpJson}</pre>
          </div>
          <div className="btnrow">
            <button className="btn small" onClick={() => copy(mcpJson)}>
              Copy .mcp.json
            </button>
          </div>
          <ul className="checks">
            <li className="info">
              Then check the tool permissions: every Pocket tool is read-only, so set them to{' '}
              <b>Always allow</b>.
            </li>
          </ul>
        </div>
        <div>
          <h2 style={{ fontSize: 14, marginTop: 6 }}>Claude desktop app</h2>
          <ol className="welcome-steps">
            <li>Open Settings, then Connectors.</li>
            <li>Choose Add custom connector.</li>
            <li>Paste the endpoint above as the URL. No OAuth is needed.</li>
            <li>
              Open the connector's tool permissions and set them to <b>Always allow</b>.
              <span className="sub">
                The desktop connector groups the read-only tools and its default differs from Claude
                Code.
              </span>
            </li>
          </ol>
        </div>
      </div>
      <BridgePanel />
    </div>
  )
}

// ---- Local action bridge (docs/ARCHITECTURE.md section 8) ----

function BridgePanel(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const settings = useStore((s) => s.settings)
  const [portEdit, setPort] = useState<string | null>(null)
  const [busy, setBusyLocal] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const st = bridge
  const port = portEdit ?? String(settings?.bridgePort ?? st?.port ?? '')
  const endpoint = st?.endpoint ?? ''
  const token = st?.token ?? ''
  const cli = `claude mcp add --transport http psm ${endpoint} --header "Authorization: Bearer ${token}"`
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        psm: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } }
      }
    },
    null,
    2
  )
  const toggle = async (): Promise<void> => {
    if (!st) return
    setBusyLocal(true)
    const p = parseInt(port, 10)
    const next = await psm().bridge.setEnabled(!st.running, p >= 1024 && p <= 65535 ? p : undefined)
    useStore.setState({ bridge: next })
    await loadSettingsIntoStore()
    setBusyLocal(false)
  }
  const rotate = async (): Promise<void> => {
    if (
      !(await confirmDialog(
        'Rotate the bridge token? Every client configured with the current token stops working until it is updated.',
        'Rotate',
        'Rotate token',
        'danger solid'
      ))
    )
      return
    useStore.setState({ bridge: await psm().bridge.rotateToken() })
  }
  return (
    <div style={{ marginTop: 14 }} id="bridgePanel">
      <h2 style={{ fontSize: 14 }}>
        Local action bridge{' '}
        {st?.running ? (
          <Badge cls="ok">running on port {st.port}</Badge>
        ) : st?.error ? (
          <Badge cls="bad">stopped</Badge>
        ) : (
          <Badge cls="muted">off</Badge>
        )}
      </h2>
      <div className="hint">
        Lets an assistant on this PC drive this app's own operations over MCP: read state, run dry
        runs, deploy, and start transactions. Every spend or signature still opens a confirmation in
        this window, and on MainNet you type the usual token. Keys and recovery phrases are never
        available to it. It listens on this PC only, with the token below.
      </div>
      {st?.error ? <div className="dangerbox">{st.error}</div> : null}
      <div className="row" style={{ marginTop: 8 }}>
        <div>
          <label>Port</label>
          <input
            type="number"
            id="bridgePort"
            min={1024}
            max={65535}
            value={port}
            disabled={!!st?.running}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <div>
          <label>Endpoint</label>
          <div className="filerow">
            <input type="text" readOnly value={endpoint} className="mono" />
            <button className="btn small" onClick={() => copy(endpoint)}>
              Copy
            </button>
          </div>
        </div>
      </div>
      <label>Token</label>
      <div className="filerow">
        <input
          type={showToken ? 'text' : 'password'}
          readOnly
          value={token}
          className="mono"
          id="bridgeToken"
        />
        <button className="btn small" onClick={() => setShowToken((v) => !v)}>
          {showToken ? 'Hide' : 'Show'}
        </button>
        <button className="btn small" onClick={() => copy(token)}>
          Copy
        </button>
        <button className="btn small" onClick={rotate}>
          Rotate token
        </button>
      </div>
      <div className="btnrow">
        <button
          className={'btn ' + (st?.running ? '' : 'primary')}
          id="btnBridgeToggle"
          disabled={busy || !st}
          onClick={toggle}
        >
          {st?.running ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      {st?.running ? (
        <>
          <div className="hint" style={{ marginTop: 8 }}>
            Claude Code: run once in any terminal (the token is part of the command).
          </div>
          <div className="filerow" style={{ marginTop: 6 }}>
            <input type="text" readOnly value={cli} className="mono" />
            <button className="btn small" onClick={() => copy(cli)}>
              Copy command
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Or a project <span className="mono">.mcp.json</span> (it then holds the token: keep that
            file out of version control):
          </div>
          <div className="plan">
            <div className="lbl">.mcp.json</div>
            <pre>{mcpJson}</pre>
          </div>
          <div className="btnrow">
            <button className="btn small" onClick={() => copy(mcpJson)}>
              Copy .mcp.json
            </button>
          </div>
          <ul className="checks">
            <li className="info">
              The Claude desktop app's custom connectors need a public https URL, so they cannot
              reach this bridge; use Claude Code.
            </li>
          </ul>
        </>
      ) : null}
    </div>
  )
}

async function loadSettingsIntoStore(): Promise<void> {
  const s = await psm().settings.get()
  useStore.setState({ settings: s })
}
