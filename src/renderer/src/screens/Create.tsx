// Create service (docs/SCREENS.md 3.3): the card form, preview, and folder creation.
import { useEffect, useState } from 'react'
import { useStore, S } from '../store'
import {
  type CreateForm,
  validateCreate,
  buildCard,
  deriveFromId,
  createIdHint,
  formFromCard,
  hasFail,
  type CheckItem
} from '@core/card-form'
import { fmtInt } from '@core/format'
import {
  Checks,
  PlanBlock,
  StatusLine,
  useStatus,
  ErrText,
  WarnText,
  type CheckNode
} from '../components/ui'
import { confirmDialog } from '../lib/modal'
import { loadServiceFolders, psm } from '../lib/actions'
import { selectRegisterFolder } from './Services'

type K = keyof CreateForm

export function CreateScreen(): React.JSX.Element {
  const { cr, crFolder, local, servicesRoot } = useStore()
  const [status, setStatus] = useStatus()
  const [checks, setChecks] = useState<CheckNode[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const loadNote = useStore((s) => (s as unknown as { crLoadNote?: string }).crLoadNote)
  const loadErr = useStore((s) => (s as unknown as { crLoadErr?: boolean }).crLoadErr)

  useEffect(() => {
    if (loadNote) {
      setStatus(loadNote, loadErr ? 'err' : '')
      useStore.setState({ crLoadNote: '', crLoadErr: false } as never)
    }
  }, [loadNote, loadErr, setStatus])

  const set = (k: K, v: string): void => {
    useStore.setState((s) => {
      let form = { ...s.cr, [k]: v }
      let auto = s.crAuto
      if (k === 'apis') auto = { ...auto, apis: false }
      if (k === 'hint') auto = { ...auto, hint: false }
      if (k === 'impl') auto = { ...auto, impl: false }
      if (k === 'idMatch') auto = { ...auto, idMatch: false }
      if (k === 'id' || k === 'rpc') form = deriveFromId(form, auto)
      return { cr: form, crAuto: auto }
    })
  }

  const loadFromFolder = async (folder: string): Promise<void> => {
    useStore.setState({ crFolder: folder })
    if (!folder) return
    const [cardText, manText] = await Promise.all([
      psm().files.readServiceFile(folder, 'card.json'),
      psm().files.readServiceFile(folder, 'service.json')
    ])
    let card: unknown = null
    let man: unknown = null
    try {
      card = cardText ? JSON.parse(cardText) : null
    } catch (e) {
      setStatus(`card.json in ${folder} is not valid JSON: ${(e as Error).message}`, 'err')
    }
    try {
      man = manText ? JSON.parse(manText) : null
    } catch {
      man = null
    }
    useStore.setState({
      cr: formFromCard(folder, card, man),
      crAuto: { apis: false, hint: false, impl: false, idMatch: false }
    })
    setStatus(`Loaded ${folder}. Edit and press Create to rewrite its card.`)
  }

  const toNodes = (items: CheckItem[]): CheckNode[] =>
    items.map((i) => ({ level: i.level, text: i.text, sub: i.sub }))

  const doPreview = (): void => {
    const items: CheckItem[] = []
    const ok = validateCreate(cr, items)
    setChecks(toNodes(items))
    if (!ok) {
      setPreview(null)
      setStatus('Fix the red items first.', 'err')
      return
    }
    const json = JSON.stringify(buildCard(cr), null, 2)
    setPreview(json)
    setStatus(
      `Card is ${fmtInt(json.length)} bytes${json.length > 4096 ? ' (over the 4 KiB target; trim the text fields)' : ' (under the 4 KiB target)'}.`,
      json.length > 4096 ? 'err' : 'ok'
    )
  }

  const doCreate = async (): Promise<void> => {
    const items: CheckItem[] = []
    const ok = validateCreate(cr, items)
    setChecks(toNodes(items))
    if (!ok) return setStatus('Fix the red items first.', 'err')
    if (!S().servicesRoot) return setStatus('Choose a services folder in Settings first.', 'err')
    const id = cr.id.trim()
    const existing = await psm().files.readServiceFile(id, 'card.json')
    if (
      existing !== null &&
      !(await confirmDialog(
        `services\\${id}\\card.json already exists. Overwrite it with this form?`,
        'Overwrite',
        'Overwrite card',
        'danger solid'
      ))
    ) {
      return setStatus('Left the existing card alone.')
    }
    const card = buildCard(cr)
    const json = JSON.stringify(card, null, 2)
    const wrote = await psm().files.writeServiceFile(id, 'card.json', json + '\n')
    if (!wrote)
      return setStatus('Could not write the card. Is the services folder set and writable?', 'err')
    let m: Record<string, unknown> = {}
    const manText = await psm().files.readServiceFile(id, 'service.json')
    if (manText) {
      try {
        m = JSON.parse(manText)
      } catch {
        m = {}
      }
    }
    m.service_id = id
    m.name = cr.name.trim()
    m.compute_units_per_relay = parseInt(cr.cupr, 10)
    m.card = 'card.json'
    m.networks = m.networks || {}
    await psm().files.writeServiceFile(id, 'service.json', JSON.stringify(m, null, 2) + '\n')
    const cardPath = `${S().servicesRoot}\\${id}\\card.json`
    const nodes = toNodes(items)
    nodes.push({
      level: 'ok',
      text: `Wrote ${cardPath} (${fmtInt(json.length)} bytes) and service.json.`
    })
    setChecks([...nodes])
    setPreview(json)
    setStatus('Validating the card', 'busy')
    const r = await psm().signer['validate-card']({ card_path: cardPath })
    if ('skipped' in r && r.skipped)
      nodes.push({ level: 'info', text: 'Schema validation skipped.', sub: r.reason })
    else if ('output' in r)
      nodes.push({
        level: r.ok ? 'ok' : 'fail',
        text: r.ok
          ? 'Card validation passed.'
          : 'Card validation reported problems; edit and create again.',
        sub: <pre>{r.output}</pre>
      })
    else
      nodes.push({
        level: 'fail',
        text: 'Card validation failed.',
        sub: (r as { error?: string }).error
      })
    setChecks([...nodes])
    await loadServiceFolders()
    await selectRegisterFolder(id)
    const passed = r.ok || ('skipped' in r && !!r.skipped)
    setStatus(
      passed
        ? 'Service folder created. The Register tab is ready with it selected.'
        : 'Folder created, but fix the card before registering.',
      passed ? 'ok' : 'err'
    )
  }

  const idHint = createIdHint(cr.id)
  const text = (k: K, props: Record<string, unknown> = {}): React.JSX.Element => (
    <input type="text" value={cr[k]} onChange={(e) => set(k, e.target.value)} {...props} />
  )

  return (
    <>
      <div className="panel">
        <h2>Service definition</h2>
        <p className="hint" style={{ margin: '0 0 6px 0' }}>
          Fill this in once. It creates <span className="mono">services/&lt;service id&gt;/</span>{' '}
          with a <span className="mono">card.json</span> (the on-chain description consumers and
          suppliers read) and a <span className="mono">service.json</span> (what the Register screen
          needs). Fields marked optional can be left blank and added later; an update re-publishes
          the card.
        </p>
        <div className="row" style={{ marginTop: 6 }}>
          <div>
            <label>Load an existing folder (optional)</label>
            <select id="crFolder" value={crFolder} onChange={(e) => loadFromFolder(e.target.value)}>
              <option value="">Start from scratch</option>
              {local.map((l) => (
                <option key={l.folder} value={l.folder}>
                  {l.folder}
                </option>
              ))}
            </select>
            <div className="hint">
              Fills the form from that folder's card.json so you can edit and re-create it.
            </div>
          </div>
          <div />
        </div>
        <div className="row">
          <div>
            <label>Service ID</label>
            {text('id', { id: 'crId', placeholder: 'pretty-charts', maxLength: 42 })}
            <div className="hint" id="crIdHint">
              {idHint.kind === 'default' ? (
                'Permanent once registered. Also becomes the folder name. Lowercase letters, digits, hyphen, underscore.'
              ) : idHint.kind === 'err' ? (
                <ErrText>{idHint.text}</ErrText>
              ) : idHint.kind === 'warn' ? (
                <WarnText>{idHint.text}</WarnText>
              ) : (
                idHint.text
              )}
            </div>
          </div>
          <div>
            <label>Display name</label>
            {text('name', { placeholder: 'Pretty Charts', maxLength: 169 })}
            <div className="hint">
              Shown in the catalog. Letters, digits, spaces, hyphen, underscore.
            </div>
          </div>
          <div>
            <label>Compute units per relay</label>
            <input
              type="number"
              min={1}
              max={1048576}
              value={cr.cupr}
              onChange={(e) => set('cupr', e.target.value)}
            />
            <div className="hint">Price of one relay. Changeable later.</div>
          </div>
        </div>
        <label>Description</label>
        <textarea
          rows={4}
          maxLength={2048}
          value={cr.desc}
          onChange={(e) => set('desc', e.target.value)}
          placeholder="What the service does, the request shape (for example POST JSON to /v1/chart), and the response shape. State whether every supplier returns identical output."
        />
        <div className="hint">
          Up to 2,048 characters. Every response on Pocket must be a JSON object; HTML or other
          non-JSON output rides inside a string field. Say so here if it applies.
        </div>
      </div>

      <div className="panel">
        <h2>Interface</h2>
        <div className="row">
          <div>
            <label>Protocol</label>
            <select value={cr.rpc} onChange={(e) => set('rpc', e.target.value)}>
              <option value="REST">REST (HTTP with JSON bodies)</option>
              <option value="JSON_RPC">JSON-RPC</option>
              <option value="WEBSOCKET">WebSocket</option>
              <option value="GRPC">gRPC</option>
              <option value="COMET_BFT">CometBFT</option>
            </select>
            <div className="hint">REST is right for almost every non-blockchain service.</div>
          </div>
          <div>
            <label>Backend hint</label>
            {text('hint', { maxLength: 256 })}
            <div className="hint">
              For supplier operators: what process listens behind their RelayMiner, on which port,
              and at which path prefix. "mount at /" means paths pass through unchanged. Example:
              "pretty-charts container on :8080; mount at /". Up to 256 characters.
            </div>
          </div>
        </div>
        <label>Endpoints a caller can rely on</label>
        {text('endpoints', {
          maxLength: 512,
          placeholder:
            'Only POST /v1/chart, GET /v1/version and GET /healthz are expected. Every response is a JSON object.'
        })}
        <div className="hint">
          Up to 512 characters. Consumers must not depend on anything not listed here.
        </div>
        <div className="row">
          <div>
            <label>API contract names</label>
            {text('apis', { placeholder: 'pretty-charts-api' })}
            <div className="hint">
              Comma-separated, lowercase kebab-case,{' '}
              <span className="mono">&lt;service&gt;-&lt;family&gt;</span>. Other cards claiming the
              same name promise the same contract.
            </div>
          </div>
          <div>
            <label>Access</label>
            <select value={cr.access} onChange={(e) => set('access', e.target.value)}>
              <option value="public">public (anyone with an app stake)</option>
              <option value="gated">gated (needs a credential the service defines)</option>
            </select>
          </div>
          <div>
            <label>Results</label>
            <select value={cr.results} onChange={(e) => set('results', e.target.value)}>
              <option value="deterministic">
                deterministic (identical bytes from every supplier)
              </option>
              <option value="variable">
                variable (timestamps, randomness, per-supplier rendering)
              </option>
            </select>
          </div>
        </div>
        <div className="row">
          <div>
            <label>API spec URL (optional)</label>
            {text('specUrl', { placeholder: 'https://example.com/openapi/v1/openapi.json' })}
            <div className="hint">
              Point at the spec; never inline it. Use a version-addressed URL that will not change
              in place.
            </div>
          </div>
          <div>
            <label>Spec kind</label>
            <select value={cr.specKind} onChange={(e) => set('specKind', e.target.value)}>
              <option value="openapi">openapi</option>
              <option value="openrpc">openrpc</option>
              <option value="markdown">markdown</option>
              <option value="docs">docs</option>
            </select>
          </div>
          <div>
            <label>Public docs URL (optional)</label>
            {text('docs', { placeholder: 'https://example.com/docs' })}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Serving (what a supplier runs)</h2>
        <label>Backend description</label>
        <textarea
          rows={3}
          maxLength={1024}
          value={cr.backend}
          onChange={(e) => set('backend', e.target.value)}
          placeholder="What a supplier deploys, e.g. the pretty-charts container behind a RelayMiner with the rest backend pointed at it. No auth toward the backend; callers cannot send headers."
        />
        <div className="row">
          <div>
            <label>Implementations</label>
            {text('impl', { placeholder: 'pretty-charts >= 1.0' })}
            <div className="hint">
              Comma-separated software and version constraints a supplier may run.
            </div>
          </div>
          <div>
            <label>Minimum disk (GB)</label>
            <input
              type="number"
              min={0}
              value={cr.disk}
              onChange={(e) => set('disk', e.target.value)}
            />
          </div>
          <div>
            <label>Minimum RAM (GB)</label>
            <input
              type="number"
              min={0}
              value={cr.ram}
              onChange={(e) => set('ram', e.target.value)}
            />
          </div>
        </div>
        <div className="row">
          <div>
            <label>Operator docs URL (optional)</label>
            {text('opDocs', { placeholder: 'https://example.com/docs/operators' })}
          </div>
          <div>
            <label>Operator notes (optional)</label>
            {text('servingNotes', {
              maxLength: 2048,
              placeholder:
                "Rate limits to disable for the RelayMiner's address, request size limits, timeouts."
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Health checks (gateways run these every cycle)</h2>
        <p className="hint" style={{ margin: '0 0 6px 0' }}>
          Three probes are the convention. The identity probe pins a backend to this service so a
          wrong backend cannot be staked under this ID. Paths are relative to the backend root;
          expectations are a JSONPath into the response and a regular expression it must match.
        </p>
        <div className="row">
          <div>
            <label>Identity probe path</label>
            {text('idPath')}
          </div>
          <div>
            <label>JSON path</label>
            {text('idJson')}
          </div>
          <div>
            <label>Must match</label>
            {text('idMatch', { placeholder: '^pretty-charts$' })}
          </div>
        </div>
        <div className="row">
          <div>
            <label>Readiness probe path</label>
            {text('rdPath')}
          </div>
          <div>
            <label>JSON path</label>
            {text('rdJson')}
          </div>
          <div>
            <label>Must match</label>
            {text('rdMatch')}
          </div>
        </div>
        <div className="row">
          <div>
            <label>Functional probe path (optional)</label>
            {text('fnPath', { placeholder: '/v1/chart' })}
          </div>
          <div>
            <label>Method</label>
            <select value={cr.fnMethod} onChange={(e) => set('fnMethod', e.target.value)}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
          </div>
          <div>
            <label>JSON path</label>
            {text('fnJson', { placeholder: '$.marks' })}
          </div>
          <div>
            <label>Must match</label>
            {text('fnMatch', { placeholder: '^1$' })}
          </div>
        </div>
        <label>Functional probe request body (JSON, for POST)</label>
        <textarea
          rows={3}
          className="mono"
          value={cr.fnBody}
          onChange={(e) => set('fnBody', e.target.value)}
          placeholder='{"data": {"values": [{"a": "A", "b": 1}]}, "chart": {"type": "bar", "x": "a", "y": "b"}}'
        />
        <div className="hint">A minimal valid request with a known answer. Keep it cheap.</div>
      </div>

      <div className="panel">
        <div className="btnrow">
          <button className="btn" onClick={doPreview}>
            Preview card
          </button>
          <button className="btn primary" onClick={doCreate}>
            Create folder and card
          </button>
        </div>
        {!servicesRoot ? (
          <div className="hint">
            No services folder is set. Choose one in Settings before creating.
          </div>
        ) : null}
        <StatusLine status={status} id="crStatus" />
        <Checks items={checks} id="crChecks" />
        <PlanBlock label="card.json" text={preview} />
        {hasFail([]) ? null : null}
      </div>
    </>
  )
}
