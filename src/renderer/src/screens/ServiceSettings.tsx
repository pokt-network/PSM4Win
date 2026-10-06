// Service settings (docs/SCREENS.md 3.15; Electron only): the operator settings a service
// declares in deploy/settings.json, read from and saved to the server it is deployed on.
// The form is drawn from the server's own copy of the declaration, with no per-service code.
// The server is the source of truth: values are read back from it, secrets only as set or
// not set, and nothing secret is kept on this PC.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { NETWORKS, type Network } from '@core/networks'
import { readinessPathOf } from '@core/probes'
import {
  variablesFor,
  valueProblem,
  type SettingDecl,
  type SettingEdit,
  type SettingVariable,
  type ParsedSettings
} from '@core/service-settings'
import type { SignerResults } from '@core/contract'
import {
  Badge,
  Busy,
  StatusLine,
  useStatus,
  netLabel,
  errText,
  ErrText,
  WarnText
} from '../components/ui'
import {
  servers,
  serverByName,
  stackState,
  localById,
  readCardFor,
  readSettingsFor,
  settingsTargetOf,
  loadServiceFolders,
  netManifest,
  setBusy,
  psm,
  goTo
} from '../lib/actions'
import { confirmDialog } from '../lib/modal'
import { groupServiceFolders } from '@core/service-folders'

type ReadBack = SignerResults['service-settings-read']
/** A change in the form: a typed value, or for a secret a replacement or a clear. */
type Draft = { value: string } | { clear: true }

/** Servers with at least one provisioned stack: where a backend can be deployed. */
function settingsServers(): ReturnType<typeof servers> {
  return servers().filter((s) =>
    Object.values(s.suppliers ?? {}).some((st) => stackState(st ?? null) === 'ready' && st?.dir)
  )
}

/** Opens the screen on one service, on the server it was last deployed to. */
export function openServiceSettings(id: string, server?: string): void {
  useStore.setState((s) => ({ svs: { ...s.svs, id, server: server ?? '' } }))
  goTo('svcsettings')
}

export function ServiceSettingsScreen(): React.JSX.Element {
  const { svs, local, settings, net, busy } = useStore()
  const set = (patch: Partial<typeof svs>): void =>
    useStore.setState((s) => ({ svs: { ...s.svs, ...patch } }))
  const [status, setStatus] = useStatus()
  const [localDecl, setLocalDecl] = useState<ParsedSettings | null>(null)
  const [read, setRead] = useState<ReadBack | null>(null)
  const [readErr, setReadErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [replacing, setReplacing] = useState<Record<string, boolean>>({})
  const [checkNet, setCheckNet] = useState<Network>(net)
  const [check, setCheck] = useState<SignerResults['service-settings-check'] | null>(null)
  const [checkErr, setCheckErr] = useState('')
  const [working, setWorking] = useState<'' | 'save' | 'restart' | 'check'>('')

  useEffect(() => {
    void loadServiceFolders()
  }, [])

  const choices = groupServiceFolders(local)
    .map((g) => g.primary)
    .filter((l) => l.hasSettings)
  const hosts = settingsServers()

  // The service defaults to the first with settings; the server to where it was deployed.
  useEffect(() => {
    const patch: Partial<typeof svs> = {}
    const id = choices.some((c) => c.id === svs.id) ? svs.id : (choices[0]?.id ?? '')
    if (id !== svs.id) patch.id = id
    if (!hosts.some((h) => h.name === svs.server) || patch.id !== undefined) {
      const l = localById(id)
      const deployedTo = [net, ...NETWORKS.filter((n) => n !== net)]
        .map(
          (n) => (l?.manifest?.networks?.[n] as { deploy_host?: string } | undefined)?.deploy_host
        )
        .find((h) => h && hosts.some((x) => x.name === h))
      const server =
        (hosts.some((h) => h.name === svs.server) && patch.id === undefined ? svs.server : '') ||
        deployedTo ||
        hosts.find((h) => h.name === settings?.supplierServer)?.name ||
        hosts[0]?.name ||
        ''
      if (server !== svs.server) patch.server = server
    }
    if (Object.keys(patch).length) set(patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, settings, net])

  // Only the latest read is shown: switching server while one is under way must not let the
  // slower answer, from the server no longer chosen, land on the form.
  const seq = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    setRead(null)
    setReadErr('')
    setDrafts({})
    setReplacing({})
    setCheck(null)
    setCheckErr('')
    if (!svs.id) return
    setLocalDecl(await readSettingsFor(svs.id))
    const s = serverByName(svs.server)
    if (!s) return
    const t = settingsTargetOf(s, svs.id)
    if (!t) return setReadErr(`${s.name} has no provisioned supplier stack.`)
    if (!(await psm().files.fileExists(s.keyPath)))
      return setReadErr(`The SSH key file for ${s.name} was not found on this PC.`)
    setLoading(true)
    try {
      const r = await psm().signer['service-settings-read'](t)
      if (mine !== seq.current) return
      if (r.ok) setRead(r)
      else setReadErr(errText(r))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [svs.id, svs.server])

  useEffect(() => {
    void load()
  }, [load])

  const s = serverByName(svs.server)
  const decl = read?.declared ?? null
  const served = read?.served ?? []
  const nets: Network[] = served.length
    ? NETWORKS.filter((n) => served.some((x) => x.network === n))
    : [...NETWORKS]
  const vars = decl ? variablesFor(decl, nets) : []
  const differs =
    !!decl && !!localDecl?.ok && JSON.stringify(localDecl.decl) !== JSON.stringify(decl)
  const notApplied = !!read?.container && vars.some((v) => read.values[v.name]?.applied === false)

  /** What the field shows: the draft, else the server's value. */
  const shown = (v: SettingVariable): string => {
    const d = drafts[v.name]
    if (d && 'value' in d) return d.value
    return read?.values[v.name]?.value ?? ''
  }
  const isSet = (v: SettingVariable): boolean => {
    const d = drafts[v.name]
    if (d && 'clear' in d) return false
    if (d && 'value' in d) return d.value.trim() !== '' || !!read?.values[v.name]?.set
    return !!read?.values[v.name]?.set
  }
  const problem = (v: SettingVariable): string => {
    const d = drafts[v.name]
    const typed = d && 'value' in d ? d.value : v.setting.secret ? '' : shown(v)
    const p = valueProblem(v.setting, typed)
    if (p) return p
    const willBeSet = v.setting.secret
      ? d && 'clear' in d
        ? false
        : (d && 'value' in d && d.value.trim() !== '') || !!read?.values[v.name]?.set
      : shown(v).trim() !== ''
    if (v.setting.required && v.setting.default === undefined && !willBeSet) return 'Required.'
    return ''
  }
  const edits: SettingEdit[] = vars.flatMap((v): SettingEdit[] => {
    const d = drafts[v.name]
    if (!d) return []
    if ('clear' in d) return [{ name: v.name, value: null }]
    const before = read?.values[v.name]?.value ?? ''
    if (v.setting.secret) return d.value.trim() ? [{ name: v.name, value: d.value }] : []
    if (d.value.trim() === before.trim()) return []
    return [{ name: v.name, value: d.value.trim() === '' ? null : d.value }]
  })
  const problems = vars.filter((v) => problem(v))
  const draft = (name: string, d: Draft | null): void =>
    setDrafts((x) => {
      const out = { ...x }
      if (d) out[name] = d
      else delete out[name]
      return out
    })

  const save = async (): Promise<void> => {
    if (!s || !edits.length || problems.length) return
    const t = settingsTargetOf(s, svs.id)
    if (!t) return
    setWorking('save')
    setBusy(true)
    setStatus(`Saving on ${s.name}`, 'busy')
    try {
      const r = await psm().signer['service-settings-write']({ ...t, edits })
      if (!r.ok) return setStatus(`Not saved: ${errText(r)}`, 'err')
      await load()
      setStatus(
        `Saved on ${s.name}. The new values apply the next time the service restarts.`,
        'ok'
      )
    } finally {
      setWorking('')
      setBusy(false)
    }
  }

  const restart = async (): Promise<void> => {
    if (!s || !read) return
    const t = settingsTargetOf(s, svs.id)
    if (!t) return
    const both =
      served.length > 1
        ? ` It serves ${served.map((x) => netLabel(x.network)).join(' and ')}, so relays on all of them pause for a moment.`
        : ''
    const ok = await confirmDialog(
      `Restart ${svs.id} on ${s.name} so the saved settings apply?${both}`,
      'Restart now',
      'Restart the service'
    )
    if (!ok) return
    setWorking('restart')
    setBusy(true)
    setStatus(`Restarting ${svs.id} on ${s.name}`, 'busy')
    try {
      const hp = readinessPathOf(await readCardFor(svs.id), svs.id)
      const r = await psm().signer['service-restart']({
        ...t,
        health_path: hp,
        ports: [...new Set(served.map((x) => x.port))]
      })
      if (!r.ok) return setStatus(`The restart did not finish: ${errText(r)}`, 'err')
      await load()
      setStatus(`Restarted. ${svs.id} now runs with the saved settings.`, 'ok')
    } finally {
      setWorking('')
      setBusy(false)
    }
  }

  const runCheck = async (): Promise<void> => {
    if (!s || !decl?.check) return
    const t = settingsTargetOf(s, svs.id)
    if (!t) return
    setWorking('check')
    setCheck(null)
    setCheckErr('')
    try {
      const r = await psm().signer['service-settings-check']({
        ...t,
        ...(decl.check.scope === 'network' ? { network: checkNet } : {})
      })
      if (r.ok) setCheck(r)
      else setCheckErr(errText(r))
    } finally {
      setWorking('')
    }
  }

  const l = localById(svs.id)
  const deployHost = netManifest(l).deploy_host

  return (
    <div className="panel">
      <h2>Service settings</h2>
      <p className="hint" style={{ margin: '0 0 6px 0' }}>
        Settings a service asks its operator for, such as where to send alerts. They are saved on
        the server the service runs on and take effect when the service restarts.
      </p>
      <div className="row">
        <div>
          <label>Service</label>
          <select id="svsId" value={svs.id} onChange={(e) => set({ id: e.target.value })}>
            {!choices.length ? <option value="">No services with settings</option> : null}
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
                {c.name ? ` (${c.name})` : ''}
              </option>
            ))}
          </select>
          <div className="hint">
            {!choices.length
              ? 'None of the service folders on this PC declares settings.'
              : deployHost
                ? `Last deployed on ${netLabel(net)} to ${deployHost}.`
                : ''}
          </div>
        </div>
        <div>
          <label>Server</label>
          <select
            id="svsServer"
            value={svs.server}
            onChange={(e) => set({ server: e.target.value })}
          >
            {!hosts.length ? <option value="">No provisioned servers</option> : null}
            {hosts.map((h) => (
              <option key={h.name} value={h.name}>
                {h.name} ({`${h.user}@${h.host}`})
              </option>
            ))}
          </select>
          <div className="hint">
            {!hosts.length ? (
              <a onClick={() => goTo('settings')}>Provision a server under Settings.</a>
            ) : served.length ? (
              `This backend serves ${served.map((x) => netLabel(x.network)).join(' and ')} here.`
            ) : (
              ''
            )}
          </div>
        </div>
      </div>

      {localDecl && !localDecl.ok ? (
        <p className="hint">
          <ErrText>The folder&apos;s settings file cannot be used: {localDecl.error}</ErrText>
        </p>
      ) : null}

      {loading ? (
        <p>
          <Busy>Reading the settings on {svs.server}</Busy>
        </p>
      ) : readErr ? (
        <p className="hint">
          <ErrText>{readErr}</ErrText>
        </p>
      ) : read && !decl ? (
        <p className="hint">
          {read.declared_error ? (
            <ErrText>{read.declared_error}</ErrText>
          ) : (
            <>
              {svs.id} is not deployed with its settings on {svs.server} yet.{' '}
              <a
                onClick={() => {
                  useStore.setState((st) => ({
                    dep: { ...st.dep, id: svs.id, server: svs.server }
                  }))
                  goTo('deploy')
                }}
              >
                Deploy it first.
              </a>
            </>
          )}
        </p>
      ) : null}

      {decl ? (
        <>
          {differs ? (
            <div className="warnbox">
              The folder&apos;s settings file is not the one deployed on {svs.server}. This form
              follows the deployed one; deploy again to use the folder&apos;s.
            </div>
          ) : null}
          {decl.settings.map((st) => (
            <SettingFields
              key={st.env}
              setting={st}
              vars={vars.filter((v) => v.setting === st)}
              read={read!}
              shown={shown}
              isSet={isSet}
              problem={problem}
              replacing={replacing}
              setReplacing={(name, on) => setReplacing((x) => ({ ...x, [name]: on }))}
              draft={draft}
            />
          ))}
          <div className="btnrow">
            <button
              className="btn primary"
              id="svsSave"
              disabled={busy || !edits.length || problems.length > 0}
              onClick={() => void save()}
            >
              {working === 'save' ? 'Saving' : 'Save'}
            </button>
            {edits.length ? (
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setDrafts({})
                  setReplacing({})
                }}
              >
                Undo changes
              </button>
            ) : null}
            <button className="btn" disabled={busy || loading} onClick={() => void load()}>
              Reload
            </button>
          </div>
          <StatusLine status={status} id="svsStatus" />

          {!read!.container ? (
            <p className="hint">
              The service is not running on {svs.server}; saved settings apply when it is deployed.
            </p>
          ) : notApplied ? (
            <div className="warnbox" id="svsRestartBox">
              Some saved settings are not in use yet: they apply when the service restarts.
              {served.length > 1 ? (
                <>
                  {' '}
                  This one backend serves {served.map((x) => netLabel(x.network)).join(' and ')}, so
                  a restart pauses relays on all of them for a moment.
                </>
              ) : null}
              <div className="btnrow">
                <button
                  className="btn primary"
                  id="svsRestart"
                  disabled={busy}
                  onClick={() => void restart()}
                >
                  {working === 'restart' ? 'Restarting' : 'Restart now'}
                </button>
              </div>
            </div>
          ) : null}

          {decl.check && read!.container ? (
            <>
              <h3 style={{ marginTop: 18 }}>Test</h3>
              <p className="hint">
                Runs the service&apos;s own check with the settings it is running with now.
                {notApplied ? ' Restart first to test what you just saved.' : ''}
              </p>
              <div className="btnrow">
                {decl.check.scope === 'network' ? (
                  <select
                    value={checkNet}
                    onChange={(e) => setCheckNet(e.target.value as Network)}
                    style={{ width: 'auto' }}
                  >
                    {nets.map((n) => (
                      <option key={n} value={n}>
                        {netLabel(n)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  className="btn"
                  id="svsCheck"
                  disabled={busy || working === 'check'}
                  onClick={() => void runCheck()}
                >
                  {working === 'check' ? 'Running' : decl.check.label}
                </button>
              </div>
              {checkErr ? (
                <p className="hint">
                  <ErrText>{checkErr}</ErrText>
                </p>
              ) : check ? (
                <div id="svsCheckResult">
                  <p>
                    {check.passed ? (
                      <Badge cls="ok">passed</Badge>
                    ) : (
                      <Badge cls="bad">{check.summary || 'failed'}</Badge>
                    )}
                  </p>
                  {check.output.length ? (
                    <div className="log">
                      {check.output.map((o, i) => (
                        <div key={i}>{o}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function SettingFields({
  setting,
  vars,
  read,
  shown,
  isSet,
  problem,
  replacing,
  setReplacing,
  draft
}: {
  setting: SettingDecl
  vars: SettingVariable[]
  read: ReadBack
  shown: (v: SettingVariable) => string
  isSet: (v: SettingVariable) => boolean
  problem: (v: SettingVariable) => string
  replacing: Record<string, boolean>
  setReplacing: (name: string, on: boolean) => void
  draft: (name: string, d: Draft | null) => void
}): React.JSX.Element {
  const dflt = setting.default
  const dfltLabel =
    dflt === undefined
      ? ''
      : setting.type === 'choice'
        ? (setting.choices?.find((c) => c.value === dflt)?.label ?? dflt)
        : setting.type === 'boolean'
          ? dflt === 'true'
            ? 'On'
            : 'Off'
          : dflt
  return (
    <div style={{ marginTop: 14 }}>
      <label style={{ marginBottom: 2 }}>
        {setting.label}
        {setting.required ? <span className="hint"> (required)</span> : null}
      </label>
      {setting.help ? <div className="hint">{setting.help}</div> : null}
      {vars.map((v) => {
        const st = read.values[v.name]
        const p = problem(v)
        const id = 'svs_' + v.name
        const field = setting.secret ? (
          replacing[v.name] ? (
            <span style={{ display: 'flex', gap: 8 }}>
              <input
                id={id}
                type="password"
                autoComplete="off"
                placeholder="New value"
                value={shown(v)}
                onChange={(e) => draft(v.name, { value: e.target.value })}
              />
              <button
                className="btn small"
                onClick={() => {
                  draft(v.name, null)
                  setReplacing(v.name, false)
                }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {isSet(v) ? <Badge cls="ok">set</Badge> : <Badge cls="muted">not set</Badge>}
              <button className="btn small" onClick={() => setReplacing(v.name, true)}>
                {st?.set ? 'Replace' : 'Set'}
              </button>
              {st?.set && isSet(v) ? (
                <button className="btn small" onClick={() => draft(v.name, { clear: true })}>
                  Clear
                </button>
              ) : null}
              {st?.set && !isSet(v) ? (
                <button className="btn small" onClick={() => draft(v.name, null)}>
                  Keep it
                </button>
              ) : null}
            </span>
          )
        ) : setting.type === 'choice' ? (
          <select
            id={id}
            value={shown(v)}
            onChange={(e) => draft(v.name, { value: e.target.value })}
          >
            <option value="">{dflt !== undefined ? `Default (${dfltLabel})` : 'Not set'}</option>
            {setting.choices?.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        ) : setting.type === 'boolean' ? (
          <select
            id={id}
            value={shown(v)}
            onChange={(e) => draft(v.name, { value: e.target.value })}
          >
            <option value="">{dflt !== undefined ? `Default (${dfltLabel})` : 'Not set'}</option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        ) : (
          <input
            id={id}
            type={setting.type === 'number' ? 'number' : 'text'}
            placeholder={dflt !== undefined ? `Default: ${dfltLabel}` : ''}
            value={shown(v)}
            min={setting.min}
            max={setting.max}
            onChange={(e) => draft(v.name, { value: e.target.value })}
          />
        )
        return (
          <div key={v.name} style={{ marginTop: 6 }} title={v.name}>
            {v.network ? <div className="hint">{netLabel(v.network)}</div> : null}
            {field}
            {p ? (
              <div className="hint">
                <ErrText>{p}</ErrText>
              </div>
            ) : st?.applied === false ? (
              <div className="hint">
                <WarnText>Saved; in use after the next restart.</WarnText>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** For Deploy: required settings with no value on the server, by label. */
export function missingLabels(missing: SettingVariable[]): string {
  return missing
    .map((v) => (v.network ? `${v.setting.label} (${netLabel(v.network)})` : v.setting.label))
    .join(', ')
}
