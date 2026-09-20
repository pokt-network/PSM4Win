// Deploy service (docs/SCREENS.md 3.7): ship the backend, build, start, add to the relayer.
import { useEffect, useState } from 'react'
import { useStore, S } from '../store'
import { fmtInt } from '@core/format'
import { activationNote } from '@core/chain'
import { readinessPathOf } from '@core/probes'
import {
  Checks,
  LogBox,
  StatusLine,
  useLog,
  useStatus,
  NetBadge,
  netLabel,
  type CheckNode
} from '../components/ui'
import {
  servers,
  serverByName,
  stackOf,
  stackState,
  connOf,
  netManifest,
  localById,
  readCardFor,
  recordManifestFor,
  refreshNetwork,
  supplyMap,
  loadHistory,
  setBusy,
  psm,
  goTo,
  loadServiceFolders
} from '../lib/actions'
import { openSupplier, svcTest } from './Services'

export function DeployScreen(): React.JSX.Element {
  const { dep, local, net, settings, busy, deployed } = useStore()
  const set = (patch: Partial<typeof dep>): void =>
    useStore.setState((s) => ({ dep: { ...s.dep, ...patch } }))
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const [served, setServed] = useState<boolean | null>(null)
  const { lines, log, clear } = useLog()
  const label = netLabel(net)
  useEffect(() => {
    useStore.setState({ deployed: null })
    void loadServiceFolders()
  }, [])
  const deployable = local.filter((l) => l.hasDockerfile)
  const provisioned = servers().filter(
    (s) => stackState(stackOf(s, net)) === 'ready' && stackOf(s, net)?.dir
  )

  useEffect(() => {
    const patch: Partial<typeof dep> = {}
    if (!deployable.some((d) => d.id === dep.id) && deployable.length) patch.id = deployable[0].id
    if (!provisioned.some((p) => p.name === dep.server))
      patch.server =
        provisioned.find((p) => p.name === settings?.supplierServer)?.name ??
        provisioned[0]?.name ??
        ''
    if (Object.keys(patch).length) set(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, settings, net])

  const l = localById(dep.id)
  const nm = netManifest(l)
  const idHint =
    dep.id && l
      ? `Builds ${l.folder}\\backend${l.hasCompose ? " with the service's own deploy compose file." : ' with the standard backend-only compose file.'}${nm.deploy_host ? ` Last deployed to ${nm.deploy_host}.` : ''}`
      : ''

  const run = async (): Promise<void> => {
    if (S().busy) return
    const id = dep.id
    const s = serverByName(dep.server)
    const folder = localById(id)?.folder ?? ''
    if (!id || !folder) return setStatus('Choose a service.', 'err')
    if (!s) return setStatus('Choose a provisioned server.', 'err')
    if (!(await psm().files.fileExists(s.keyPath)))
      return setStatus(`The SSH key file for ${s.name} was not found on this PC.`, 'err')
    const conn = connOf(s)
    const root = s.deployRoot || '/opt/pocket/services'
    const hp = readinessPathOf(await readCardFor(id), id)
    const results: CheckNode[] = []
    setBusy(true)
    useStore.setState({ deployed: null })
    setServed(null)
    clear()
    setChecks([])
    setStatus('Deploying', 'busy')
    const mark = (text: string, ok: boolean, note?: string): void => {
      results.push({ level: ok ? 'ok' : 'fail', text, sub: note || '' })
      setChecks([...results])
    }
    const fail = (msg: string): void => {
      log(msg, 'err')
      setStatus('Deployment stopped.', 'err')
      setBusy(false)
    }
    const sg = psm().signer
    log(
      <>
        Deploying <b>{id}</b> to <b>{s.name}</b> ({`${s.user}@${s.host}`}) for {label}: backend at{' '}
        {`${root}/${id}`}, relayer in {conn.path}
      </>
    )
    const r = await sg['ssh-test']({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      key_path: conn.key_path,
      path: conn.path
    })
    if (!r.ok) {
      mark('SSH connection', false, `${r.error} ${r.detail ?? ''}`)
      return fail('Could not connect.')
    }
    if (!r.keyring) {
      mark(
        'Supplier on the server',
        false,
        `No operator keyring in ${conn.path}. Provision the server first.`
      )
      return fail('Server is not provisioned.')
    }
    mark('SSH connection and supplier', true, r.hostname)
    log(
      'Packing the backend (without node_modules) and its compose file, and copying them to the server.'
    )
    const r2 = await sg['deploy-ship']({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      key_path: conn.key_path,
      deploy_root: root,
      service_id: id,
      folder: `${S().servicesRoot}\\${folder}`
    })
    if (!r2.ok) {
      mark('Ship the backend', false, `${r2.error} ${r2.detail ?? ''}`)
      return fail('Shipping failed.')
    }
    mark(
      'Ship the backend',
      true,
      `${fmtInt(r2.bytes)} bytes, ${r2.files} files, compose from ${r2.compose_from}`
    )
    log(
      <>
        Building the image and starting <span className="mono">{id}-backend</span> on the supplier
        network; waiting for {hp} to answer.
      </>
    )
    const r3 = await sg['supplier-run']({
      ...conn,
      step: 'deploy',
      service_id: id,
      deploy_root: root,
      health_path: hp
    })
    if (!r3.ok) {
      mark(
        'Build and start the backend',
        false,
        `${r3.err || (r3 as { error?: string }).error || ''} ${r3.lines.slice(-5).join(' | ')}`
      )
      return fail('The backend did not start.')
    }
    mark('Build and start the backend', true, r3.lines.slice(-2).join(' | '))
    log('Adding the service to the RelayMiner and recreating the relayer.')
    const r4 = await sg['supplier-run']({
      ...conn,
      step: 'add-service',
      service_id: id,
      backend_url: `http://${id}-backend:8080`,
      health_path: hp
    })
    if (!r4.ok) {
      mark(
        'Connect to the RelayMiner',
        false,
        `${r4.err || (r4 as { error?: string }).error || ''} ${r4.lines.slice(-3).join(' | ')}`
      )
      return fail('The relayer did not come up.')
    }
    mark('Connect to the RelayMiner', true, r4.lines.join(' | '))
    await recordManifestFor(folder, 'deploy_host', s.name)
    await recordManifestFor(folder, 'deploy_path', conn.path)
    await recordManifestFor(folder, 'deployed_at', new Date().toISOString())
    await refreshNetwork()
    const sp = (await supplyMap())[id]
    const isServed = sp?.state === 'active'
    const pendingSp = sp?.state === 'pending'
    const p = S().params
    log(
      isServed
        ? `The supplier on ${label} is active for ${id}: relays can flow now.`
        : pendingSp
          ? `The supplier is staked for ${id} and serves it from ${activationNote(p, sp.activation_height)}.`
          : `The supplier is not yet staked for ${id} on ${label}. Stake it next, then test.`,
      'ok'
    )
    setStatus(
      `Deployed on ${label}. ${isServed ? 'Active now: test it.' : pendingSp ? `Pending: active from ${activationNote(p, sp.activation_height)}.` : 'Now stake the supplier for it.'}`,
      'ok'
    )
    useStore.setState({ deployed: { id, server: s.name } })
    setServed(isServed)
    setBusy(false)
    void loadHistory()
  }

  return (
    <div className="panel">
      <h2>
        Deploy a service <NetBadge />
      </h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        Ships the service's backend to a provisioned server, builds and starts it on the supplier's
        network, and connects it to the RelayMiner. Afterwards, stake the supplier for it
        (Suppliers) and test it (Test service). Safe to run again to redeploy a new version.
      </p>
      <div className="row">
        <div>
          <label>Service</label>
          <select id="depId" value={dep.id} onChange={(e) => set({ id: e.target.value })}>
            {!deployable.length ? <option value="">No deployable services</option> : null}
            {deployable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
                {d.name ? ` (${d.name})` : ''}
              </option>
            ))}
          </select>
          <div className="hint" id="depIdHint">
            {idHint}
          </div>
        </div>
        <div>
          <label>Server</label>
          <select
            id="depServer"
            value={dep.server}
            onChange={(e) => set({ server: e.target.value })}
          >
            {!provisioned.length ? <option value="">No provisioned servers</option> : null}
            {provisioned.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} ({`${p.user}@${p.host}`})
              </option>
            ))}
          </select>
          <div className="hint" id="depServerHint">
            {!provisioned.length ? (
              <>
                No server is provisioned for {label}.{' '}
                <a onClick={() => goTo('settings')}>Provision one under Settings.</a>
              </>
            ) : (
              `Provisioned servers on ${label}.`
            )}
          </div>
        </div>
      </div>
      <div className="btnrow">
        <button className="btn primary" id="btnDeploy" disabled={busy} onClick={run}>
          Deploy
        </button>
        {deployed && served === false ? (
          <button
            className="btn primary"
            id="btnDeployStake"
            onClick={() => openSupplier(deployed.server, deployed.id)}
          >
            Stake the supplier for it
          </button>
        ) : null}
        {deployed ? (
          <button
            className={'btn' + (served ? ' primary' : '')}
            id="btnDeployTest"
            onClick={() => svcTest(deployed.id)}
          >
            Test it
          </button>
        ) : null}
      </div>
      <StatusLine status={status} id="depStatus" />
      <Checks items={checks} id="depChecks" />
      <LogBox lines={lines} id="depLog" />
    </div>
  )
}
