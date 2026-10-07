// Server operations over SSH (SIGNER-CONTRACT.md section 3.4): ssh-test,
// supplier-ship, supplier-run, deploy-ship, server-survey.
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { fail } from '@core/errors'
import { CADDY_DIR } from '@core/networks'
import { measureBlockTime } from '@core/lcd'
import {
  RE,
  requireNetwork,
  validateServiceId,
  validateLinuxPath,
  validateAddress,
  validateHealthPath,
  toInt64
} from '@core/validate'
import { buildSurveyScript, parseSurvey, judgeSurvey } from '@core/survey'
import { supplierStepArgs, normalizeOperatorSecret } from '@core/supplier'
import { probeHexAddress } from './docker'
import { ROUTES_FILE } from '@core/routes'
import { RELAYER_FILE } from '@core/relayer'
import {
  SETTINGS_FILE,
  SETTINGS_ENV_FILE,
  SETTINGS_HELPER_TOO_OLD,
  composeSettingsProblems,
  helperTooOld,
  parseSettingsCheck,
  parseSettingsFile,
  parseSettingsRead,
  restartPorts,
  settingsPatch
} from '@core/service-settings'
import {
  renderStack,
  backendComposeFromTemplate,
  parseStackProbe,
  stackProbeCommand,
  type StackTemplates
} from '@core/stack'
import { cleanErr, operatorFromOutput, lastErrorLine } from '@core/pocketd-output'
import { firstLine, nonEmptyLines, tail, toLf } from '@core/text'
import type { SignerRequests, SignerResults } from '@core/contract'
import { SUPPLIER_STEP_TIMEOUTS_MS } from '@core/contract'
import type { OpContext } from './context'
import { resolveSsh, runSsh, runScp } from './ssh'
import { runNative } from './native'
import { withWorkDir } from './work'
import { serverTemplatesDir, toolPath } from '../paths'
import { ensureDir, exists, writeText, readText, fileSize } from '../state/files'
import { addHistory } from '../state/history'

type Req<K extends keyof SignerRequests> = SignerRequests[K]
type Res<K extends keyof SignerResults> = SignerResults[K]

export async function sshTest(req: Req<'ssh-test'>, ctx: OpContext): Promise<Res<'ssh-test'>> {
  const conn = resolveSsh(req)
  const path = req.path ?? ''
  let probe = 'hostname; docker compose version 2>/dev/null | head -1'
  if (path !== '') {
    validateLinuxPath(path, 'Supplier directory')
    probe += `; test -d '${path}/pocket-home' && echo PSM_KEYRING_OK;` + stackProbeCommand(path)
  }
  probe += '; true'
  const r = await runSsh(conn, probe, ctx)
  // ssh itself exits 255 when it cannot connect or authenticate; the probe always exits 0.
  if (r.code !== 0) fail('Could not connect over SSH.', cleanErr(r.err + '\n' + r.out))
  const lines = nonEmptyLines(r.out)
  let docker = ''
  for (const l of lines) if (/Docker Compose/.test(l)) docker = l.trim()
  return {
    ok: true,
    hostname: lines.length ? lines[0].trim() : '',
    docker,
    keyring: /PSM_KEYRING_OK/.test(r.out),
    stack: path !== '' ? parseStackProbe(r.out) : null
  }
}

/**
 * server-survey: runs resources/server/survey.sh on a server whose supplier was set up by
 * hand, to see what an import would take over. The script is read-only and prints no
 * secret; it goes to a temporary file under /tmp, runs as the SSH user, and is removed
 * however it ends.
 */
export async function serverSurvey(
  req: Req<'server-survey'>,
  ctx: OpContext
): Promise<Res<'server-survey'>> {
  const conn = resolveSsh(req)
  const op = req.operator_address ? validateAddress(req.operator_address, 'Operator address') : ''
  const dir = serverTemplatesDir()
  const sh = await readText(join(dir, 'survey.sh'))
  const py = await readText(join(dir, 'survey_address.py'))
  if (sh === null || py === null) fail('The survey script is missing from the app resources.', dir)
  const script = buildSurveyScript(sh!, py!)
  const remote = `/tmp/psm-survey-${randomBytes(6).toString('hex')}.sh`
  ctx.progress('info', `Surveying ${conn.target} (read-only)`, undefined, 'survey')
  return withWorkDir(async (work) => {
    const local = join(work, 'survey.sh')
    await writeText(local, script)
    const cp = await runScp(conn, [local, `${conn.target}:${remote}`], ctx)
    if (cp.code !== 0) fail('Could not copy the survey to the server.', cleanErr(cp.err))
    const r = await runSsh(conn, `bash ${remote} ${op}; rc=$?; rm -f ${remote}; exit $rc`, ctx)
    if (r.code !== 0 && !/^survey: /m.test(r.out))
      fail('The survey could not run on the server.', cleanErr(r.err + '\n' + r.out))
    const report = parseSurvey(r.out)
    return { ok: true, report, verdict: judgeSurvey(report) }
  })
}

/**
 * A remote shell command that creates directories owned by the SSH user. On a server whose
 * parent (for example /opt/pocket) the user cannot write, which is usual on one set up by
 * hand, it creates them with passwordless sudo and hands them to the user.
 */
export function mkdirOwned(dirs: string[]): string {
  const q = dirs.map((d) => `'${d}'`).join(' ')
  return `{ mkdir -p ${q} 2>/dev/null || { sudo -n mkdir -p ${q} && sudo -n chown "$(id -u):$(id -g)" ${q}; }; }`
}

async function loadTemplates(): Promise<StackTemplates> {
  const dir = serverTemplatesDir()
  if (!exists(join(dir, 'supplier.sh')))
    fail('The server templates are missing from the app resources.', dir)
  const rd = async (name: string): Promise<string> => {
    const t = await readText(join(dir, name))
    if (t === null) fail(`Server template missing: ${name}`, dir)
    return t!
  }
  return {
    'miner-config.yaml.tmpl': await rd('miner-config.yaml.tmpl'),
    'relayer-config.yaml.tmpl': await rd('relayer-config.yaml.tmpl'),
    'docker-compose.yaml.tmpl': await rd('docker-compose.yaml.tmpl'),
    'stack.env.tmpl': await rd('stack.env.tmpl'),
    'site.caddy.tmpl': await rd('site.caddy.tmpl'),
    'supplier.sh': await rd('supplier.sh'),
    'survey_address.py': await rd('survey_address.py'),
    'caddy/docker-compose.yaml': await rd(join('caddy', 'docker-compose.yaml')),
    'caddy/Caddyfile': await rd(join('caddy', 'Caddyfile'))
  }
}

export async function supplierShip(
  req: Req<'supplier-ship'>,
  ctx: OpContext
): Promise<Res<'supplier-ship'>> {
  const conn = resolveSsh(req)
  const net = requireNetwork(req.network)
  const path = validateLinuxPath(req.path, 'Stack directory')
  const hostname = req.hostname
  if (!RE.hostname.test(hostname)) fail('Hostname must be a DNS name pointing at the server.')
  let project = req.project ?? ''
  if (project === '') project = `pocket-supplier-${net}`
  if (!RE.project.test(project))
    fail('Stack project name must be lowercase letters, digits, and hyphens.')
  let caddyDir = req.caddy_dir ?? ''
  if (caddyDir === '') caddyDir = CADDY_DIR
  if (!RE.linuxPath.test(caddyDir)) fail('Caddy directory must be an absolute Linux path.')
  if (caddyDir === path) fail('The Caddy directory must differ from the stack directory.')
  const num = (v: unknown, dflt: number): number => {
    if (v === undefined || v === null || String(v) === '') return dflt
    const n = toInt64(v)
    if (!Number.isFinite(n)) fail('Stack ports must be numbers.')
    return n
  }
  const hp = num(req.health_port, 8081)
  const rmp = num(req.relayer_metrics_port, 9090)
  const mmp = num(req.miner_metrics_port, 9092)
  let bt = Number.isFinite(toInt64(req.block_time)) ? toInt64(req.block_time) : 0
  if (!(bt > 0)) {
    // signer.ps1 fell back to a per-network constant here; live-data discipline (CLAUDE.md rule 1)
    // means measuring it from the LCD instead, over the last 1,000 blocks as the UI does.
    try {
      bt = Math.max(1, Math.round((await measureBlockTime(net)).seconds))
    } catch (e) {
      fail(`Could not measure the block time from the network: ${(e as Error).message}`)
    }
  }

  const rendered = renderStack(await loadTemplates(), {
    network: net,
    blockTime: bt,
    hostname,
    project,
    healthPort: hp,
    relayerMetricsPort: rmp,
    minerMetricsPort: mmp,
    caddyDir
  })

  return withWorkDir(async (work) => {
    await ensureDir(join(work, 'caddy', 'sites'))
    for (const [name, text] of Object.entries(rendered.stack))
      await writeText(join(work, name), text)
    for (const [name, text] of Object.entries(rendered.caddy))
      await writeText(join(work, 'caddy', name), text)
    await writeText(join(work, 'caddy', 'sites', rendered.site.name), rendered.site.text)

    ctx.progress('info', `Creating ${path} on ${conn.target}`, undefined, 'mkdir')
    const mk = await runSsh(
      conn,
      `${mkdirOwned([path, caddyDir, `${caddyDir}/sites`])} && { test -f '${path}/relayer-config.yaml' && echo PSM_HAVE_RELAYER; true; }`,
      ctx
    )
    if (mk.code !== 0)
      fail('Could not create the stack directory over SSH.', cleanErr(mk.err + '\n' + mk.out))
    const keepRelayer = /PSM_HAVE_RELAYER/.test(mk.out)
    const files = [
      'docker-compose.yaml',
      'miner-config.yaml',
      'stack.env',
      'supplier.sh',
      'keyaddr.py'
    ]
    if (!keepRelayer) files.push('relayer-config.yaml')

    ctx.progress('info', 'Copying the stack files', undefined, 'scp')
    const cp = await runScp(
      conn,
      [...files.map((f) => join(work, f)), `${conn.target}:${path}/`],
      ctx
    )
    if (cp.code !== 0) fail('Could not copy the stack files to the server.', cleanErr(cp.err))
    const cp2 = await runScp(
      conn,
      [
        join(work, 'caddy', 'docker-compose.yaml'),
        join(work, 'caddy', 'Caddyfile'),
        `${conn.target}:${caddyDir}/`
      ],
      ctx
    )
    if (cp2.code !== 0) fail('Could not copy the Caddy files to the server.', cleanErr(cp2.err))
    const cp3 = await runScp(
      conn,
      [join(work, 'caddy', 'sites', rendered.site.name), `${conn.target}:${caddyDir}/sites/`],
      ctx
    )
    if (cp3.code !== 0) fail('Could not copy the Caddy site file to the server.', cleanErr(cp3.err))

    ctx.progress('info', 'Running supplier.sh prepare', undefined, 'prepare')
    const r = await runSsh(conn, `bash '${path}/supplier.sh' prepare`, ctx)
    if (r.code !== 0)
      fail('supplier.sh prepare failed on the server.', cleanErr(r.err + '\n' + r.out))
    await addHistory({
      op: 'supplier-ship',
      network: net,
      extra: `host=${conn.target} path=${path} project=${project} hostname=${hostname} caddy=${caddyDir}`
    })
    files.push(
      `${caddyDir}/docker-compose.yaml`,
      `${caddyDir}/Caddyfile`,
      `${caddyDir}/sites/${rendered.site.name}`
    )
    return { ok: true, files, relayer_kept: keepRelayer, out: firstLine(r.out) }
  })
}

export async function supplierRun(
  req: Req<'supplier-run'>,
  ctx: OpContext
): Promise<Res<'supplier-run'>> {
  const conn = resolveSsh(req)
  const path = validateLinuxPath(req.path, 'Stack directory')
  const { step, args } = supplierStepArgs(req)
  const cmd = `bash '${path}/supplier.sh' ${step}` + args.map((a) => ` '${a}'`).join('')
  ctx.progress('info', `Running supplier.sh ${step} on ${conn.target}`, undefined, step)
  const r = await runSsh(conn, cmd, ctx, Math.min(ctx.timeoutMs, SUPPLIER_STEP_TIMEOUTS_MS[step]))
  const out = tail(r.out, 20_000)
  const lines = nonEmptyLines(out)
  const err = lastErrorLine(lines)
  if (step !== 'operator' && step !== 'keys')
    await addHistory({ op: `supplier-${step}`, extra: `host=${conn.target} ${args.join(' ')}` })
  return {
    ok: r.code === 0 && err === '',
    step,
    out,
    err: err ? err : cleanErr(r.err),
    address: operatorFromOutput(out),
    lines
  }
}

/**
 * supplier-import-operator: puts an operator key the user pasted into a stack on the
 * server (import). The one operation that carries an operator key: it travels once, on
 * SSH's standard input, to supplier.sh operator-import, which puts it in the stack's
 * keyring and keeps it only when the keyring then holds exactly this operator. Never on a
 * command line, in the log, or in history. A hex key is checked against the operator here
 * first, so a wrong key does not leave this PC.
 */
export async function supplierImportOperator(
  req: Req<'supplier-import-operator'>,
  ctx: OpContext
): Promise<Res<'supplier-import-operator'>> {
  const conn = resolveSsh(req)
  const path = validateLinuxPath(req.path, 'Stack directory')
  const op = validateAddress(req.operator_address, 'Operator address')
  const secret = normalizeOperatorSecret(req.secret)
  if (secret.kind === 'hex') {
    const derived = await probeHexAddress(secret.value, ctx)
    if (derived && derived !== op)
      fail(`That key belongs to ${derived}, not to the operator ${op}. Nothing was sent.`)
  }
  ctx.progress(
    'info',
    `Importing the operator key into ${path} on ${conn.target}`,
    undefined,
    'import'
  )
  const r = await runSsh(
    conn,
    `bash '${path}/supplier.sh' operator-import '${op}' '${secret.kind}'`,
    ctx,
    Math.min(ctx.timeoutMs, 180_000),
    `${secret.value}\n`
  )
  const lines = nonEmptyLines(tail(r.out, 20_000))
  const err = lastErrorLine(lines)
  if (r.code !== 0 || err) fail(err || 'The operator key could not be imported.', cleanErr(r.err))
  const got = operatorFromOutput(r.out)
  if (got !== op)
    fail('The server did not confirm the operator after the import.', lines.join('\n'))
  await addHistory({ op: 'supplier-operator-import', extra: `host=${conn.target} operator=${op}` })
  return { ok: true, operator: op, lines }
}

export async function deployShip(
  req: Req<'deploy-ship'>,
  ctx: OpContext
): Promise<Res<'deploy-ship'>> {
  const conn = resolveSsh(req)
  const sid = validateServiceId(req.service_id)
  const root = validateLinuxPath(req.deploy_root, 'Deploy root')
  const folder = req.folder
  if (!exists(join(folder, 'backend', 'Dockerfile')))
    fail('The service folder has no backend\\Dockerfile to build.', folder)
  // A declaration the app cannot use, or a compose that would not read the values, stops
  // the deploy here rather than leave a service whose settings silently do nothing.
  const settingsText = await readText(join(folder, ...SETTINGS_FILE.split('/')))
  const ownCompose = join(folder, 'deploy', 'docker-compose.yaml')
  let settingsWarnings: string[] = []
  if (settingsText !== null) {
    const parsed = parseSettingsFile(settingsText)
    if (!parsed.ok) fail(parsed.error)
    if (exists(ownCompose)) {
      const c = composeSettingsProblems((await readText(ownCompose)) ?? '', parsed.decl)
      if (c.error) fail(c.error)
      settingsWarnings = c.warnings
    }
  }
  return withWorkDir(async (work) => {
    const stage = join(work, 'stage')
    await ensureDir(join(stage, 'deploy'))
    ctx.progress('info', 'Staging the backend folder', undefined, 'stage')
    const rc = await runNative(
      toolPath('robocopy'),
      [
        join(folder, 'backend'),
        join(stage, 'backend'),
        '/E',
        '/XD',
        'node_modules',
        '.git',
        '__pycache__',
        'test',
        '/XF',
        '*.pyc',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP'
      ],
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal }
    )
    if (rc.code >= 8) fail('Could not stage the backend folder.', `${rc.out}${rc.err}`)
    let composeFrom: string
    if (exists(ownCompose)) {
      await writeText(
        join(stage, 'deploy', 'docker-compose.yaml'),
        toLf((await readText(ownCompose)) ?? '')
      )
      composeFrom = 'the service folder'
    } else {
      const t = await readText(join(serverTemplatesDir(), 'backend-compose.yaml.tmpl'))
      if (t === null) fail('The backend compose template is missing from the app resources.')
      await writeText(
        join(stage, 'deploy', 'docker-compose.yaml'),
        backendComposeFromTemplate(t!, sid)
      )
      composeFrom = 'the template'
    }
    // A service's extra public routes and per-network relay ports travel with it, so the
    // server copy mirrors the folder.
    const shipOptional = async (rel: string): Promise<boolean> => {
      const src = join(folder, ...rel.split('/'))
      if (!exists(src)) return false
      await writeText(join(stage, ...rel.split('/')), toLf((await readText(src)) ?? ''))
      return true
    }
    const hasRoutes = await shipOptional(ROUTES_FILE)
    const hasRelayer = await shipOptional(RELAYER_FILE)
    const hasSettings = await shipOptional(SETTINGS_FILE)
    const bundle = join(work, 'bundle.tar')
    const tr = await runNative(toolPath('tar'), ['-cf', bundle, '-C', stage, 'backend', 'deploy'], {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal
    })
    if (tr.code !== 0) fail('Could not build the deployment archive.', firstLine(tr.err))
    const size = await fileSize(bundle)
    const dest = `${root}/${sid}`
    ctx.progress('info', `Copying ${size} bytes to ${conn.target}:${dest}`, undefined, 'ship')
    const mk = await runSsh(conn, mkdirOwned([root, dest]), ctx)
    if (mk.code !== 0)
      fail('Could not create the service directory on the server.', cleanErr(mk.err))
    const cp = await runScp(conn, [bundle, `${conn.target}:${dest}/bundle.tar`], ctx)
    if (cp.code !== 0) fail('Could not copy the archive to the server.', cleanErr(cp.err))
    // The values file is made here as well as by supplier.sh deploy, so the compose's
    // env_file is satisfied even on a server whose helper predates service settings.
    const x = await runSsh(
      conn,
      `cd '${dest}' && rm -f '${ROUTES_FILE}' '${RELAYER_FILE}' '${SETTINGS_FILE}' && tar -xf bundle.tar && rm -f bundle.tar && { test -f '${SETTINGS_ENV_FILE}' || (umask 077 && : > '${SETTINGS_ENV_FILE}'); } && chmod 600 '${SETTINGS_ENV_FILE}' && find backend deploy -type f | wc -l`,
      ctx
    )
    if (x.code !== 0)
      fail('Could not unpack the archive on the server.', cleanErr(x.err + '\n' + x.out))
    await addHistory({
      op: 'deploy-ship',
      service_id: sid,
      extra: `host=${conn.target} dest=${dest} bytes=${size}`
    })
    await fs.rm(stage, { recursive: true, force: true })
    return {
      ok: true,
      dest,
      bytes: size,
      files: firstLine(x.out),
      compose_from: composeFrom,
      routes: hasRoutes,
      relayer: hasRelayer,
      settings: hasSettings,
      settings_warnings: settingsWarnings
    }
  })
}

// ---- a service's settings on the server (supplier.sh settings-*, backend-restart) ----

function settingsTarget(req: Req<'service-settings-read'>): {
  path: string
  sid: string
  root: string
} {
  return {
    path: validateLinuxPath(req.path, 'Stack directory'),
    sid: validateServiceId(req.service_id),
    root: validateLinuxPath(req.deploy_root, 'Deploy root')
  }
}

/** The remote command for a settings step; every argument has passed a strict pattern. */
function settingsCmd(
  t: ReturnType<typeof settingsTarget>,
  step: string,
  extra: string[] = []
): string {
  return (
    `bash '${t.path}/supplier.sh' ${step} '${t.sid}' '${t.root}'` +
    extra.map((a) => ` '${a}'`).join('')
  )
}

/** Fails with the helper's own error line, or the old-helper note, or the fallback. */
function settingsFail(r: { code: number; out: string; err: string }, fallback: string): void {
  if (helperTooOld(r.out)) fail(SETTINGS_HELPER_TOO_OLD)
  const lines = nonEmptyLines(tail(r.out, 20_000))
  const err = lastErrorLine(lines)
  if (err) fail(err, lines.length > 1 ? lines.join('\n') : '')
  if (r.code !== 0) fail(fallback, cleanErr(r.err + '\n' + r.out))
}

async function readSettingsOn(
  conn: ReturnType<typeof resolveSsh>,
  t: ReturnType<typeof settingsTarget>,
  ctx: OpContext
): Promise<Omit<Res<'service-settings-read'>, 'ok'>> {
  const r = await runSsh(conn, settingsCmd(t, 'settings-read'), ctx, 60_000)
  // Not deployed here yet is a state the screen shows, not a failure.
  if (/^error: \S+ is not deployed on this server$/m.test(r.out))
    return { declared: null, declared_error: '', values: {}, container: false, served: [] }
  settingsFail(r, 'Could not read the settings on the server.')
  const p = parseSettingsRead(r.out)
  if (typeof p === 'string') fail(p)
  return p as Omit<Res<'service-settings-read'>, 'ok'>
}

/**
 * service-settings-read: what is in force on the server. Non-secret values come back;
 * secrets only as set or not set. The server is the source of truth, so a second PC sees
 * the same.
 */
export async function serviceSettingsRead(
  req: Req<'service-settings-read'>,
  ctx: OpContext
): Promise<Res<'service-settings-read'>> {
  const conn = resolveSsh(req)
  const t = settingsTarget(req)
  ctx.progress('info', `Reading ${t.sid}'s settings on ${conn.target}`, undefined, 'read')
  return { ok: true, ...(await readSettingsOn(conn, t, ctx)) }
}

/**
 * service-settings-write: checks the edits against the server's own copy of
 * deploy/settings.json, then sends them once on SSH's standard input. Values never reach a
 * command line, the log, history, or an error message; history keeps the names only.
 */
export async function serviceSettingsWrite(
  req: Req<'service-settings-write'>,
  ctx: OpContext
): Promise<Res<'service-settings-write'>> {
  const conn = resolveSsh(req)
  const t = settingsTarget(req)
  const state = await readSettingsOn(conn, t, ctx)
  if (!state.declared)
    fail(
      state.declared_error ||
        `${t.sid} has no deploy/settings.json on ${conn.target}. Deploy it again first.`
    )
  const patch = settingsPatch(state.declared!, req.edits)
  ctx.progress('info', `Saving ${t.sid}'s settings on ${conn.target}`, undefined, 'write')
  const r = await runSsh(
    conn,
    settingsCmd(t, 'settings-write'),
    ctx,
    60_000,
    JSON.stringify(patch) + '\n'
  )
  settingsFail(r, 'Could not save the settings on the server.')
  const lines = nonEmptyLines(r.out)
  const set = lines.filter((l) => l.startsWith('saved: set ')).map((l) => l.slice(11))
  const cleared = lines.filter((l) => l.startsWith('saved: cleared ')).map((l) => l.slice(15))
  await addHistory({
    op: 'service-settings-write',
    service_id: t.sid,
    extra: `host=${conn.target} set=${set.join(',')} cleared=${cleared.join(',')}`
  })
  return { ok: true, set, cleared }
}

/** service-settings-check: runs the deployed declaration's check inside the backend. */
export async function serviceSettingsCheck(
  req: Req<'service-settings-check'>,
  ctx: OpContext
): Promise<Res<'service-settings-check'>> {
  const conn = resolveSsh(req)
  const t = settingsTarget(req)
  const extra = req.network ? [requireNetwork(req.network)] : []
  ctx.progress('info', `Running ${t.sid}'s check on ${conn.target}`, undefined, 'check')
  const r = await runSsh(conn, settingsCmd(t, 'settings-check', extra), ctx, 110_000)
  const res = parseSettingsCheck(r.out)
  // A check that ran and failed is a result, not a failure of the operation.
  if (!res.summary) settingsFail(r, 'The check could not run on the server.')
  if (!res.summary) fail('The server did not report how the check went.', cleanErr(r.out))
  await addHistory({
    op: 'service-settings-check',
    service_id: t.sid,
    network: req.network,
    extra: `host=${conn.target} ${res.summary}`
  })
  return { ok: true, ...res }
}

/** service-restart: recreates only the service's backend, so saved settings apply. */
export async function serviceRestart(
  req: Req<'service-restart'>,
  ctx: OpContext
): Promise<Res<'service-restart'>> {
  const conn = resolveSsh(req)
  const t = settingsTarget(req)
  const hp = validateHealthPath(req.health_path)
  const ports = restartPorts(req.ports)
  ctx.progress('info', `Restarting ${t.sid}-backend on ${conn.target}`, undefined, 'restart')
  const r = await runSsh(
    conn,
    settingsCmd(t, 'backend-restart', [hp, ...ports.map(String)]),
    ctx,
    290_000
  )
  settingsFail(r, 'The backend did not restart.')
  const lines = nonEmptyLines(tail(r.out, 20_000))
  if (!lines.some((l) => l.startsWith('restarted: ')))
    fail('The server did not confirm the restart.', lines.join('\n'))
  await addHistory({
    op: 'service-restart',
    service_id: t.sid,
    extra: `host=${conn.target} ports=${ports.join(',')}`
  })
  return { ok: true, lines }
}
