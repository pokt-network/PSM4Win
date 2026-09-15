// Server operations over SSH (SIGNER-CONTRACT.md section 3.4): ssh-test,
// supplier-ship, supplier-run, deploy-ship.
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { fail } from '@core/errors'
import { CADDY_DIR } from '@core/networks'
import { measureBlockTime } from '@core/lcd'
import {
  RE,
  requireNetwork,
  validateServiceId,
  validateLinuxPath,
  validateHealthPath,
  toInt64
} from '@core/validate'
import { renderStack, backendComposeFromTemplate, type StackTemplates } from '@core/stack'
import { cleanErr, operatorFromOutput, lastErrorLine } from '@core/pocketd-output'
import { firstLine, nonEmptyLines, tail, toLf } from '@core/text'
import type { SignerRequests, SignerResults, SupplierStep } from '@core/contract'
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
    probe += `; test -d '${path}/pocket-home' && echo PSM_KEYRING_OK`
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
    keyring: /PSM_KEYRING_OK/.test(r.out)
  }
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
      `mkdir -p '${path}' '${caddyDir}/sites' && test -f '${path}/relayer-config.yaml' && echo PSM_HAVE_RELAYER || true`,
      ctx
    )
    if (mk.code !== 0)
      fail('Could not create the stack directory over SSH.', cleanErr(mk.err + '\n' + mk.out))
    const keepRelayer = /PSM_HAVE_RELAYER/.test(mk.out)
    const files = ['docker-compose.yaml', 'miner-config.yaml', 'stack.env', 'supplier.sh']
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

const STEPS: readonly SupplierStep[] = [
  'operator',
  'keys',
  'start',
  'status',
  'publish',
  'deploy',
  'add-service',
  'remove-service'
]

export async function supplierRun(
  req: Req<'supplier-run'>,
  ctx: OpContext
): Promise<Res<'supplier-run'>> {
  const conn = resolveSsh(req)
  const path = validateLinuxPath(req.path, 'Stack directory')
  const step = String(req.step) as SupplierStep
  const args: string[] = []
  switch (step) {
    case 'operator':
    case 'keys':
    case 'start':
    case 'status':
      break
    case 'publish':
      args.push(requireNetwork(req.network))
      break
    case 'deploy': {
      const sid = validateServiceId(String(req.service_id ?? ''))
      const root = validateLinuxPath(String(req.deploy_root ?? ''), 'Deploy root')
      args.push(sid, root, validateHealthPath(req.health_path))
      break
    }
    case 'add-service': {
      const sid = validateServiceId(String(req.service_id ?? ''))
      const url = String(req.backend_url ?? '')
      if (!RE.backendUrl.test(url)) fail('Backend URL must be http://<container>:<port>.')
      args.push(sid, url, validateHealthPath(req.health_path))
      break
    }
    case 'remove-service':
      args.push(validateServiceId(String(req.service_id ?? '')))
      break
    default:
      fail(`Unknown supplier step '${step}'.`)
  }
  if (!STEPS.includes(step)) fail(`Unknown supplier step '${step}'.`)
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
    const own = join(folder, 'deploy', 'docker-compose.yaml')
    let composeFrom: string
    if (exists(own)) {
      await writeText(
        join(stage, 'deploy', 'docker-compose.yaml'),
        toLf((await readText(own)) ?? '')
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
    const bundle = join(work, 'bundle.tar')
    const tr = await runNative(toolPath('tar'), ['-cf', bundle, '-C', stage, 'backend', 'deploy'], {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal
    })
    if (tr.code !== 0) fail('Could not build the deployment archive.', firstLine(tr.err))
    const size = await fileSize(bundle)
    const dest = `${root}/${sid}`
    ctx.progress('info', `Copying ${size} bytes to ${conn.target}:${dest}`, undefined, 'ship')
    const mk = await runSsh(conn, `mkdir -p '${dest}'`, ctx)
    if (mk.code !== 0)
      fail('Could not create the service directory on the server.', cleanErr(mk.err))
    const cp = await runScp(conn, [bundle, `${conn.target}:${dest}/bundle.tar`], ctx)
    if (cp.code !== 0) fail('Could not copy the archive to the server.', cleanErr(cp.err))
    const x = await runSsh(
      conn,
      `cd '${dest}' && tar -xf bundle.tar && rm -f bundle.tar && find backend deploy -type f | wc -l`,
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
    return { ok: true, dest, bytes: size, files: firstLine(x.out), compose_from: composeFrom }
  })
}
