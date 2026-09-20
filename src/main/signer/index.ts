// The SignerService: one method per named operation, a serial queue for every
// operation that opens the keyring or the volume, per-operation timeouts, and
// cancellation. There is no generic "run this command" entry point.
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  SignerOp,
  SignerRequests,
  SignerResult,
  ProgressEvent,
  FailResult
} from '@core/contract'
import {
  DEFAULT_TIMEOUT_MS,
  TIMEOUTS_MS,
  SUPPLIER_STEP_TIMEOUTS_MS,
  SIGNER_OPS
} from '@core/contract'
import { toFailResult, SignerFailure } from '@core/errors'
import { nowIso } from '@core/text'
import { redactDeep } from '@core/redact'
import type { OpContext } from './context'
import { dockerCheck, dockerStart, imagePull, pocketapPull } from './docker'
import * as wallet from './wallet'
import * as tx from './tx'
import * as server from './server'
import * as test from './test'
import { readHistory } from '../state/history'
import { log } from '../state/log'

type Handler<K extends SignerOp> = (
  req: SignerRequests[K],
  ctx: OpContext
) => Promise<SignerResult<K>>

const handlers: { [K in SignerOp]: Handler<K> } = {
  'docker-check': (_r, ctx) => dockerCheck(ctx),
  'docker-start': async () => dockerStart(),
  'image-pull': (_r, ctx) => imagePull(ctx),
  'pocketap-pull': (_r, ctx) => pocketapPull(ctx),
  'wallet-status': wallet.walletStatus,
  'wallet-import': wallet.walletImport,
  'wallet-import-app': wallet.walletImportApp,
  'wallet-create': wallet.walletCreate,
  'wallet-recover': wallet.walletRecover,
  'wallet-list': wallet.walletList,
  'wallet-export': wallet.walletExport,
  'wallet-remove': wallet.walletRemove,
  'wallet-delete': wallet.walletDelete,
  'wallet-set-service': (r) => wallet.walletSetService(r),
  'tx-add-service': tx.txAddService,
  'tx-stake-app': tx.txStakeApp,
  'tx-delegate-gateway': tx.txDelegateGateway,
  'tx-undelegate-gateway': tx.txUndelegateGateway,
  'tx-fund-wallet': tx.txFundWallet,
  'tx-return-to-owner': tx.txReturnToOwner,
  'tx-fund-operator': tx.txFundOperator,
  'tx-unstake-supplier': tx.txUnstakeSupplier,
  'tx-unstake-app': tx.txUnstakeApp,
  'remote-stake-supplier': tx.remoteStakeSupplier,
  'ssh-test': server.sshTest,
  'supplier-ship': server.supplierShip,
  'supplier-run': server.supplierRun,
  'deploy-ship': server.deployShip,
  'relay-call': test.relayCall,
  'validate-card': (r) => test.validateCard(r),
  history: async () => ({ ok: true as const, entries: await readHistory() })
}

/** Operations that open the keyring or touch the volume, and so run one at a time. */
const KEYRING_OPS = new Set<SignerOp>([
  'wallet-status',
  'wallet-import',
  'wallet-import-app',
  'wallet-create',
  'wallet-recover',
  'wallet-list',
  'wallet-export',
  'wallet-remove',
  'wallet-delete',
  'tx-add-service',
  'tx-stake-app',
  'tx-delegate-gateway',
  'tx-undelegate-gateway',
  'tx-fund-wallet',
  'tx-return-to-owner',
  'tx-fund-operator',
  'tx-unstake-supplier',
  'tx-unstake-app',
  'relay-call'
])

export interface RunOptions {
  runId?: string
  timeoutMs?: number
}

export function isSignerOp(op: string): op is SignerOp {
  return (SIGNER_OPS as readonly string[]).includes(op)
}

export class SignerService extends EventEmitter {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly running = new Map<string, AbortController>()

  newRunId(): string {
    return Date.now().toString(36) + randomBytes(3).toString('hex')
  }

  cancel(runId: string): boolean {
    const c = this.running.get(runId)
    if (!c) return false
    c.abort()
    return true
  }

  timeoutFor(op: SignerOp, req: unknown): number {
    if (op === 'supplier-run') {
      const step = (req as { step?: string }).step as keyof typeof SUPPLIER_STEP_TIMEOUTS_MS
      return SUPPLIER_STEP_TIMEOUTS_MS[step] ?? DEFAULT_TIMEOUT_MS
    }
    return TIMEOUTS_MS[op] ?? DEFAULT_TIMEOUT_MS
  }

  /** Runs a named operation. Unknown names never reach here from IPC, but the self-test probes one. */
  async run<K extends SignerOp>(
    op: K | string,
    req: SignerRequests[K],
    opts: RunOptions = {}
  ): Promise<SignerResult<K>> {
    if (!isSignerOp(op))
      return {
        ok: false,
        error: `Unknown operation '${op}'.`,
        detail: ''
      } as FailResult as unknown as SignerResult<K>
    const runId = opts.runId ?? this.newRunId()
    const controller = new AbortController()
    const timeoutMs = opts.timeoutMs ?? this.timeoutFor(op, req)
    const ctx: OpContext = {
      runId,
      op,
      signal: controller.signal,
      timeoutMs,
      progress: (level, text, sub, step) => {
        const ev: ProgressEvent = { runId, op, step, level, text, sub, time: nowIso() }
        this.emit('progress', ev)
      }
    }
    const exec = async (): Promise<SignerResult<K>> => {
      this.running.set(runId, controller)
      const started = Date.now()
      log.info('op start', { runId, op, req: redactDeep(req as Record<string, unknown>) })
      let timer: NodeJS.Timeout | null = null
      try {
        const handler = handlers[op] as unknown as Handler<K>
        const result = await Promise.race<SignerResult<K>>([
          handler(req, ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(
                new SignerFailure(
                  `Timed out waiting for the signer (${Math.round(timeoutMs / 1000)}s).`
                )
              )
            }, timeoutMs + 2000)
          })
        ])
        log.info('op done', {
          runId,
          op,
          ok: (result as { ok?: boolean }).ok,
          ms: Date.now() - started
        })
        return result
      } catch (e) {
        const f = toFailResult(e)
        if (controller.signal.aborted && !/Timed out/.test(f.error)) {
          f.error = 'Cancelled.'
        }
        log.warn('op failed', {
          runId,
          op,
          error: f.error,
          detail: f.detail,
          ms: Date.now() - started
        })
        // Latent issue 6.14: supplier-run callers index `lines` on failure.
        if (op === 'supplier-run')
          return {
            ...f,
            step: (req as { step?: string }).step ?? '',
            out: '',
            err: f.error,
            address: '',
            lines: []
          } as unknown as SignerResult<K>
        return f as SignerResult<K>
      } finally {
        if (timer) clearTimeout(timer)
        this.running.delete(runId)
      }
    }
    if (!KEYRING_OPS.has(op)) return exec()
    const next = this.queue.then(exec, exec)
    this.queue = next.catch(() => undefined)
    return next
  }
}

export const signer = new SignerService()
