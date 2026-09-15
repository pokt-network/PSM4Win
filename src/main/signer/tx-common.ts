// Shared transaction helpers: signer resolution and the Emit-Tx result envelope.
import type { NativeOutput } from '@core/pocketd-output'
import { parseTxOutput, summarizeErr, cleanErr } from '@core/pocketd-output'
import { fail } from '@core/errors'
import type { Network } from '@core/networks'
import type { TxResult, DryResult } from '@core/contract'
import { OWNER_KEY_NAME, GAS_ARGS } from '@core/versions'
import { renderCommand } from '@core/text'
import { readOwnerWallet, findWallet } from '../state/wallets'
import { addHistory } from '../state/history'

/** The key name a transaction signs with: the owner by default, or a wallets.json name. */
export async function resolveSigner(from: string | undefined): Promise<string> {
  if (!from || from === OWNER_KEY_NAME) {
    if (!(await readOwnerWallet())) fail('No wallet is imported.')
    return OWNER_KEY_NAME
  }
  if (!(await findWallet(from))) fail(`'${from}' is not a wallet this app manages.`)
  return from
}

export function txTail(net: Network): string[] {
  return ['--keyring-backend', 'file', '--network', net, ...GAS_ARGS, '-y', '-o', 'json']
}

export function dryResult(argv: readonly string[]): DryResult {
  return { ok: true, dry: true, command: renderCommand('pocketd', argv) }
}

/** Parses a tx result, records history (even when the node rejected it), and builds the envelope. */
export async function emitTx(
  r: NativeOutput,
  net: Network,
  op: string,
  serviceId: string,
  extra = ''
): Promise<TxResult> {
  const p = parseTxOutput(r)
  const txhash = p.json && typeof p.json.txhash === 'string' ? p.json.txhash : ''
  if (!p.json || !txhash) {
    fail(summarizeErr(r.err), (cleanErr(r.err) + '\n' + (r.out ?? '').trim()).trim())
  }
  const code = Number(p.json!.code ?? 0) | 0
  const rawLog = String(p.json!.raw_log ?? '')
  await addHistory({ network: net, op, service_id: serviceId, txhash, code, extra })
  return {
    ok: code === 0,
    txhash,
    code,
    raw_log: rawLog,
    gas: p.gas,
    error: code !== 0 ? `The node rejected the transaction (code ${code}).` : '',
    detail: code !== 0 ? rawLog : ''
  }
}
