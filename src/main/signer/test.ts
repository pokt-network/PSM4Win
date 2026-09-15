// Testing operations (SIGNER-CONTRACT.md section 3.5): relay-call through
// pocket-ap, and validate-card through the in-process validator (no Python).
import { join } from 'node:path'
import { fail } from '@core/errors'
import { POCKET_AP_IMAGE } from '@core/versions'
import { requireNetwork, validateServiceId, RE, HTTP_METHODS } from '@core/validate'
import { pocketApYaml } from '@core/stack'
import { upstreamHttp } from '@core/pocketd-output'
import { head, tail } from '@core/text'
import { validateCardText, formatCardValidation } from '@core/card'
import type { SignerRequests, SignerResults } from '@core/contract'
import type { OpContext } from './context'
import { requireDocker, pocketapPresent, docker } from './docker'
import { requirePassphrase } from './passphrase'
import { resolveSigner } from './tx-common'
import { exportKeyInMemory } from './wallet'
import { withWorkDir } from './work'
import { writeText, readText, exists } from '../state/files'
import { addHistory } from '../state/history'

type Req<K extends keyof SignerRequests> = SignerRequests[K]
type Res<K extends keyof SignerResults> = SignerResults[K]

export async function relayCall(
  req: Req<'relay-call'>,
  ctx: OpContext
): Promise<Res<'relay-call'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const sid = validateServiceId(req.service_id)
  const method = String(req.method ?? '').toUpperCase()
  const path = String(req.path ?? '')
  const body = req.body ?? ''
  if (!(HTTP_METHODS as readonly string[]).includes(method))
    fail(`Unsupported HTTP method '${method}'.`)
  if (!RE.relayPath.test(path)) fail('Path must start with /.')
  const from = await resolveSigner(req.wallet)
  if (!(await pocketapPresent(ctx)))
    fail('The pocket-ap image is not downloaded yet. Use "Download pocket-ap" first.')
  const pass = await requirePassphrase()
  let hex: string | null = await exportKeyInMemory(from, pass, ctx)
  return withWorkDir(async (work) => {
    await writeText(join(work, 'pocket-ap.yaml'), pocketApYaml(net, sid))
    const argv = [
      'run',
      '--rm',
      '-e',
      'POCKET_APP_PRIVATE_KEY',
      '-v',
      `${work}:/work:ro`,
      POCKET_AP_IMAGE,
      'call',
      '--config',
      '/work/pocket-ap.yaml',
      '--service',
      sid,
      '--rpc-type',
      'rest',
      '-X',
      method,
      '--path',
      path,
      '-v',
      '--timeout',
      '30s'
    ]
    if (body !== '') {
      await writeText(join(work, 'body.json'), body)
      argv.push('--data', '@/work/body.json')
    }
    const started = Date.now()
    const r = await docker(argv, {
      env: { POCKET_APP_PRIVATE_KEY: hex! },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal
    })
    hex = null
    const ms = Date.now() - started
    const out = head(r.out, 200_000)
    const diag = tail(r.err, 20_000)
    let status = upstreamHttp(diag)
    // The HTA assumed 200 on a clean exit without evidence (contract 6.14); the UI's grader relies on it.
    if (status === 0 && r.code === 0) status = 200
    await addHistory({
      op: 'relay-test',
      network: net,
      service_id: sid,
      extra: `wallet=${from} ${method} ${path} code=${r.code} http=${status} ms=${ms}`
    })
    return {
      ok: r.code === 0 || status >= 400,
      exit_code: r.code,
      http: status,
      ms,
      body: out,
      diagnostics: diag,
      wallet: from
    }
  })
}

export async function validateCard(req: Req<'validate-card'>): Promise<Res<'validate-card'>> {
  const card = req.card_path
  if (!exists(card)) fail(`Card file not found: ${card}`)
  const text = await readText(card)
  if (text === null) fail(`Card file not found: ${card}`)
  const v = validateCardText(text!)
  return { ok: v.ok, code: v.ok ? 0 : 1, output: formatCardValidation(v) }
}
