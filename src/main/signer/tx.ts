// Local transactions signed with the file keyring (SIGNER-CONTRACT.md section 3.3),
// plus the supplier stake signed on the server (remote-stake-supplier).
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { fail } from '@core/errors'
import { OWNER_KEY_NAME, POCKETD_IMAGE, GAS_ARGS } from '@core/versions'
import {
  RE,
  requireNetwork,
  validateServiceId,
  validateAddress,
  validateLinuxPath,
  toInt64,
  MAX_CUPR,
  MAX_CARD_BYTES,
  RPC_TYPES
} from '@core/validate'
import { appStakeYaml, supplierStakeYaml } from '@core/stack'
import { summarizeErr, cleanErr } from '@core/pocketd-output'
import type { SignerRequests, SignerResults } from '@core/contract'
import type { OpContext } from './context'
import { requireDocker, pocketd } from './docker'
import { requirePassphrase } from './passphrase'
import { resolveSigner, txTail, dryResult, emitTx } from './tx-common'
import { withWorkDir } from './work'
import { readOwnerWallet, findWallet, setWalletService } from '../state/wallets'
import { resolveSsh, runSsh, runScp } from './ssh'
import { exists, fileSize, writeText } from '../state/files'

type Req<K extends keyof SignerRequests> = SignerRequests[K]
type Res<K extends keyof SignerResults> = SignerResults[K]

export async function txAddService(
  req: Req<'tx-add-service'>,
  ctx: OpContext
): Promise<Res<'tx-add-service'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const id = validateServiceId(req.service_id)
  const name = req.name
  const cupr = toInt64(req.compute_units_per_relay)
  if (!RE.serviceName.test(name))
    fail(
      'Service name must be 1 to 169 characters of letters, digits, spaces, hyphens, or underscores.'
    )
  if (!(cupr >= 1 && cupr <= MAX_CUPR))
    fail('Compute units per relay must be between 1 and 1,048,576.')
  if (!(await readOwnerWallet())) fail('No wallet is imported.')
  const cardPath = req.card_path ?? ''
  if (cardPath !== '') {
    if (!exists(cardPath)) fail(`Card file not found: ${cardPath}`)
    if ((await fileSize(cardPath)) > MAX_CARD_BYTES)
      fail('The card is larger than 256 KiB, the chain limit.')
  }
  return withWorkDir(async (work) => {
    const argv = ['tx', 'service', 'add-service', id, name, String(cupr)]
    const mounts: string[] = []
    if (cardPath !== '') {
      await fs.copyFile(cardPath, join(work, 'card.json'))
      mounts.push(`${work}:/work:ro`)
      argv.push('--card-file', '/work/card.json')
    }
    argv.push('--from', OWNER_KEY_NAME, ...txTail(net))
    if (req.dry) return dryResult(argv)
    const pass = await requirePassphrase()
    const r = await pocketd(argv, { pass, mounts, ctx })
    return emitTx(r, net, 'add-service', id, `cupr=${cupr}`)
  })
}

export async function txStakeApp(
  req: Req<'tx-stake-app'>,
  ctx: OpContext
): Promise<Res<'tx-stake-app'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const id = validateServiceId(req.service_id)
  const stake = toInt64(req.stake_upokt)
  if (!(stake > 0)) fail('Stake amount must be a positive number of uPOKT.')
  const from = await resolveSigner(req.from)
  return withWorkDir(async (work) => {
    const yaml = appStakeYaml(stake, id)
    await writeText(join(work, 'app_stake.yaml'), yaml)
    const argv = [
      'tx',
      'application',
      'stake-application',
      '--config',
      '/work/app_stake.yaml',
      '--from',
      from,
      ...txTail(net)
    ]
    if (req.dry) return { ...dryResult(argv), config: yaml, from }
    const pass = await requirePassphrase()
    const r = await pocketd(argv, { pass, mounts: [`${work}:/work:ro`], ctx })
    const res = await emitTx(r, net, 'stake-application', id, `stake_upokt=${stake} from=${from}`)
    // Remember which service this wallet now stakes for. The HTA updated the record
    // before knowing the outcome (contract 6.14); the port updates it only on acceptance.
    if (res.ok && from !== OWNER_KEY_NAME && id) await setWalletService(from, id)
    return res
  })
}

async function delegation(
  kind: 'delegate' | 'undelegate',
  req: Req<'tx-delegate-gateway'>,
  ctx: OpContext
): Promise<Res<'tx-delegate-gateway'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const gw = req.gateway_address
  if (!RE.address.test(gw)) fail('Gateway address is not a valid pokt1 address.')
  const from = await resolveSigner(req.from)
  const sub = kind === 'delegate' ? 'delegate-to-gateway' : 'undelegate-from-gateway'
  const argv = ['tx', 'application', sub, gw, '--from', from, ...txTail(net)]
  if (req.dry) return { ...dryResult(argv), from }
  const pass = await requirePassphrase()
  const r = await pocketd(argv, { pass, ctx })
  return emitTx(r, net, sub, '', `gateway=${gw} from=${from}`)
}

export const txDelegateGateway = (
  req: Req<'tx-delegate-gateway'>,
  ctx: OpContext
): Promise<Res<'tx-delegate-gateway'>> => delegation('delegate', req, ctx)
export const txUndelegateGateway = (
  req: Req<'tx-undelegate-gateway'>,
  ctx: OpContext
): Promise<Res<'tx-undelegate-gateway'>> => delegation('undelegate', req, ctx)

export async function txFundWallet(
  req: Req<'tx-fund-wallet'>,
  ctx: OpContext
): Promise<Res<'tx-fund-wallet'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const w = await findWallet(req.name)
  if (!w) fail(`'${req.name}' is not a wallet this app manages.`)
  const to = w!.address
  if (!RE.address.test(to)) fail('The wallet record has no valid address.')
  const amt = toInt64(req.amount_upokt)
  if (!(amt > 0)) fail('Amount must be a positive number of uPOKT.')
  if (!(await readOwnerWallet())) fail('No owner wallet is imported.')
  const argv = ['tx', 'bank', 'send', OWNER_KEY_NAME, to, `${amt}upokt`, ...txTail(net)]
  if (req.dry) return dryResult(argv)
  const pass = await requirePassphrase()
  const r = await pocketd(argv, { pass, ctx })
  return emitTx(
    r,
    net,
    'fund-wallet',
    w!.service_id,
    `to=${to} name=${w!.name} amount_upokt=${amt}`
  )
}

/**
 * Sends POKT from an application wallet to the owner wallet.
 *
 * The counterpart of txFundWallet. An application wallet is named after the service it
 * was made for, so it cannot be reused for another, and after an unbonding its stake
 * comes back to it rather than to the owner; without this the POKT would sit there with
 * no way out of the app. The destination is not a field: it is read here from
 * wallet.json, so the only address this can reach is the owner's own.
 */
export async function txReturnToOwner(
  req: Req<'tx-return-to-owner'>,
  ctx: OpContext
): Promise<Res<'tx-return-to-owner'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const w = await findWallet(req.from)
  if (!w) fail(`'${req.from}' is not a wallet this app manages.`)
  const owner = await readOwnerWallet()
  if (!owner) fail('No owner wallet is imported.')
  const to = owner!.address
  if (!RE.address.test(to)) fail('The owner wallet record has no valid address.')
  if (w!.address === to) fail('That is the owner wallet itself.')
  const amt = toInt64(req.amount_upokt)
  if (!(amt > 0)) fail('Amount must be a positive number of uPOKT.')
  const from = await resolveSigner(req.from)
  if (from === OWNER_KEY_NAME) fail('That is the owner wallet itself.')
  const argv = ['tx', 'bank', 'send', from, to, `${amt}upokt`, ...txTail(net)]
  if (req.dry) return dryResult(argv)
  const pass = await requirePassphrase()
  const r = await pocketd(argv, { pass, ctx })
  return emitTx(
    r,
    net,
    'return-to-owner',
    w!.service_id,
    `from=${w!.name} to=${to} amount_upokt=${amt}`
  )
}

export async function txFundOperator(
  req: Req<'tx-fund-operator'>,
  ctx: OpContext
): Promise<Res<'tx-fund-operator'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const to = req.to
  if (!RE.address.test(to)) fail('Recipient is not a valid pokt1 address.')
  const amt = toInt64(req.amount_upokt)
  if (!(amt > 0)) fail('Amount must be a positive number of uPOKT.')
  const w = await readOwnerWallet()
  if (!w) fail('No wallet is imported.')
  if (to === w!.address) fail('The recipient is this wallet itself.')
  const argv = ['tx', 'bank', 'send', OWNER_KEY_NAME, to, `${amt}upokt`, ...txTail(net)]
  if (req.dry) return dryResult(argv)
  const pass = await requirePassphrase()
  const r = await pocketd(argv, { pass, ctx })
  return emitTx(r, net, 'fund-operator', '', `to=${to} amount_upokt=${amt}`)
}

export async function txUnstakeSupplier(
  req: Req<'tx-unstake-supplier'>,
  ctx: OpContext
): Promise<Res<'tx-unstake-supplier'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const op = req.operator_address
  if (!RE.address.test(op)) fail('Operator address is not a valid pokt1 address.')
  const w = await readOwnerWallet()
  if (!w) fail('No wallet is imported.')
  const argv = ['tx', 'supplier', 'unstake-supplier', op, '--from', OWNER_KEY_NAME, ...txTail(net)]
  if (req.dry) return dryResult(argv)
  const pass = await requirePassphrase()
  const r = await pocketd(argv, { pass, ctx })
  return emitTx(r, net, 'unstake-supplier', '', `operator=${op} owner=${w!.address}`)
}

/**
 * Begins the unbonding of an application.
 *
 * The application signs for itself: the message carries no address and the node takes
 * it from the signer, so there is nothing to pass and the wallet named here is the one
 * that stops being staked. The supplier's equivalent is the other shape, where the
 * owner signs and names the operator.
 */
export async function txUnstakeApp(
  req: Req<'tx-unstake-app'>,
  ctx: OpContext
): Promise<Res<'tx-unstake-app'>> {
  await requireDocker(ctx)
  const net = requireNetwork(req.network)
  const from = await resolveSigner(req.from)
  if (from === OWNER_KEY_NAME)
    fail('The owner wallet is not an application. Choose the application wallet instead.')
  const argv = ['tx', 'application', 'unstake-application', '--from', from, ...txTail(net)]
  if (req.dry) return dryResult(argv)
  const pass = await requirePassphrase()
  const r = await pocketd(argv, { pass, ctx })
  return emitTx(r, net, 'unstake-application', '', `from=${from}`)
}

export async function remoteStakeSupplier(
  req: Req<'remote-stake-supplier'>,
  ctx: OpContext
): Promise<Res<'remote-stake-supplier'>> {
  const net = requireNetwork(req.network)
  const conn = resolveSsh(req)
  const path = validateLinuxPath(req.path, 'Supplier directory')
  const keyName =
    req.operator_key_name && req.operator_key_name !== '' ? req.operator_key_name : 'operator'
  if (!RE.keyName.test(keyName)) fail('Operator key name is invalid.')
  const owner = validateAddress(req.owner_address, 'Owner address')
  const operator = validateAddress(req.operator_address, 'Operator address')
  const stake = toInt64(req.stake_upokt)
  if (!(stake > 0)) fail('Stake amount must be a positive number of uPOKT.')
  const svcs = Array.isArray(req.services) ? req.services : []
  if (svcs.length === 0) fail('At least one service is required.')
  const ids: string[] = []
  for (const s of svcs) {
    validateServiceId(s.service_id)
    if (!RE.endpointUrl.test(s.url)) fail(`Endpoint for ${s.service_id} must be an https:// URL.`)
    if (!(RPC_TYPES as readonly string[]).includes(s.rpc_type))
      fail(`Unknown rpc_type '${s.rpc_type}' for ${s.service_id}.`)
    ids.push(s.service_id)
  }
  const yaml = supplierStakeYaml(owner, operator, stake, svcs)
  const remote =
    `cd ${path} && docker run --rm -v ${path}/pocket-home:/home -v ${path}:/work:ro ${POCKETD_IMAGE} tx supplier stake-supplier ` +
    `--config /work/supplier_stake.yaml --from ${keyName} --keyring-backend test --home /home --network ${net} ${GAS_ARGS.join(' ')} -y -o json`
  if (req.dry) {
    return {
      ok: true,
      dry: true,
      command: `ssh ${[...conn.ssh, conn.target].join(' ')} '${remote}'`,
      config: yaml
    }
  }
  await withWorkDir(async (work) => {
    const local = join(work, 'supplier_stake.yaml')
    await writeText(local, yaml)
    const cp = await runScp(conn, [local, `${conn.target}:${path}/supplier_stake.yaml`], ctx)
    if (cp.code !== 0) fail(`Could not copy the stake config to ${conn.target}.`, cleanErr(cp.err))
  })
  const r = await runSsh(conn, remote, ctx)
  if (r.code !== 0 && !/"txhash"/.test(r.out))
    fail(summarizeErr(r.err), cleanErr(r.err + '\n' + r.out))
  return emitTx(r, net, 'stake-supplier', ids.join(','), `operator=${operator} via ${conn.target}`)
}
