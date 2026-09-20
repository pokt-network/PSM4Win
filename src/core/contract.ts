// The signer contract: one request and one result type per named operation.
// Names, fields, and shapes follow docs/SIGNER-CONTRACT.md section 5 exactly so
// the renderer can call the same operation with the same payload as app.js did.
import type { Network } from './networks'
import type { RpcType } from './validate'
import type { FailResult } from './errors'

export type { Network, RpcType, FailResult }

export interface SshConn {
  host: string
  port: number
  user: string
  key_path: string
}

export interface TxResult {
  ok: boolean
  txhash: string
  code: number
  raw_log: string
  gas: string
  error: string
  detail: string
}

export interface DryResult {
  ok: true
  dry: true
  command: string
}

export interface DockerCheckResult {
  ok: boolean
  running: boolean
  docker?: string
  image?: boolean
  pocketap?: boolean
  pocketd?: string
  error?: string
  detail?: string
}

export interface WalletStatusResult {
  ok: true
  imported: boolean
  verified: boolean
  address?: string
  name?: string
  imported_at?: string
  app_wallets: number
  partial?: boolean
  error?: string
}

export type WalletSource = 'create' | 'recover' | 'import'

export interface WalletRecord {
  name: string
  address: string
  service_id: string
  created_at: string
  source: WalletSource
}

export interface WalletListResult {
  ok: true
  verified: boolean
  parent: { name: string; address: string; present: boolean | null } | null
  wallets: Array<WalletRecord & { present: boolean | null }>
}

export interface HistoryEntry {
  time: string
  op: string
  network?: string
  service_id?: string
  txhash?: string
  code?: number
  extra?: string
  address?: string
}

export interface SupplierRunResult {
  ok: boolean
  step: string
  out: string
  err: string
  address: string
  lines: string[]
  /** Present when the operation failed before ssh ran (validation, timeout). */
  error?: string
  detail?: string
}

export interface RelayCallResult {
  ok: boolean
  exit_code: number
  http: number
  ms: number
  body: string
  diagnostics: string
  wallet: string
}

export type ValidateCardResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: boolean
      code: number
      output: string
      /** The card's own service_id when the file parses and carries one (Register warns when it
       *  differs from the form, app.js checkCard). */
      service_id?: string
    }

export interface StakeService {
  service_id: string
  url: string
  rpc_type: RpcType
}

export type SupplierStep =
  'operator' | 'keys' | 'publish' | 'start' | 'status' | 'deploy' | 'add-service' | 'remove-service'

/** Every operation's request type. */
export interface SignerRequests {
  'docker-check': Record<string, never>
  'docker-start': Record<string, never>
  'image-pull': Record<string, never>
  'pocketap-pull': Record<string, never>
  'wallet-status': Record<string, never>
  'wallet-import': { privateKeyHex: string }
  'wallet-import-app': { name: string; service_id?: string; privateKeyHex: string }
  'wallet-create': { name: string; service_id?: string }
  'wallet-recover': { name: string; service_id?: string; mnemonic: string }
  'wallet-list': Record<string, never>
  'wallet-export': { name?: string }
  'wallet-remove': { name: string; confirm: string }
  'wallet-delete': { force?: boolean }
  'wallet-set-service': { name: string; service_id: string }
  'tx-add-service': {
    network: Network
    service_id: string
    name: string
    compute_units_per_relay: number
    card_path?: string
    dry?: boolean
  }
  'tx-stake-app': {
    network: Network
    service_id: string
    stake_upokt: number
    from?: string
    dry?: boolean
  }
  'tx-delegate-gateway': { network: Network; from?: string; gateway_address: string; dry?: boolean }
  'tx-undelegate-gateway': {
    network: Network
    from?: string
    gateway_address: string
    dry?: boolean
  }
  'tx-fund-wallet': { network: Network; name: string; amount_upokt: number; dry?: boolean }
  'tx-fund-operator': { network: Network; to: string; amount_upokt: number; dry?: boolean }
  'tx-unstake-supplier': { network: Network; operator_address: string; dry?: boolean }
  'remote-stake-supplier': SshConn & {
    network: Network
    path: string
    operator_key_name?: string
    owner_address: string
    operator_address: string
    stake_upokt: number
    services: StakeService[]
    dry?: boolean
  }
  'ssh-test': SshConn & { path?: string }
  'supplier-ship': SshConn & {
    path: string
    network: Network
    hostname: string
    project?: string
    caddy_dir?: string
    health_port?: number
    relayer_metrics_port?: number
    miner_metrics_port?: number
    block_time?: number
  }
  'supplier-run': SshConn & {
    path: string
    step: SupplierStep
    network?: Network
    service_id?: string
    deploy_root?: string
    health_path?: string
    backend_url?: string
  }
  'deploy-ship': SshConn & { deploy_root: string; service_id: string; folder: string }
  'relay-call': {
    network: Network
    wallet?: string
    service_id: string
    method: string
    path: string
    body?: string
  }
  'validate-card': { card_path: string; script?: string }
  history: Record<string, never>
}

/** Every operation's success result type (a FailResult may come back instead). */
export interface SignerResults {
  'docker-check': DockerCheckResult
  'docker-start': { ok: true }
  'image-pull': { ok: true; pocketd: string }
  'pocketap-pull': { ok: true; version: string }
  'wallet-status': WalletStatusResult
  'wallet-import': { ok: true; address: string; name: string }
  'wallet-import-app': { ok: true; name: string; address: string; service_id: string }
  'wallet-create': { ok: true; name: string; address: string; service_id: string; mnemonic: string }
  'wallet-recover': { ok: true; name: string; address: string; service_id: string }
  'wallet-list': WalletListResult
  'wallet-export': { ok: true; hex: string; name: string }
  'wallet-remove': { ok: true }
  'wallet-delete': { ok: true }
  'wallet-set-service': { ok: true }
  'tx-add-service': TxResult | DryResult
  'tx-stake-app': TxResult | (DryResult & { config: string; from: string })
  'tx-delegate-gateway': TxResult | (DryResult & { from: string })
  'tx-undelegate-gateway': TxResult | (DryResult & { from: string })
  'tx-fund-wallet': TxResult | DryResult
  'tx-fund-operator': TxResult | DryResult
  'tx-unstake-supplier': TxResult | DryResult
  'remote-stake-supplier': TxResult | (DryResult & { config: string })
  'ssh-test': { ok: true; hostname: string; docker: string; keyring: boolean }
  'supplier-ship': { ok: true; files: string[]; relayer_kept: boolean; out: string }
  'supplier-run': SupplierRunResult
  'deploy-ship': { ok: true; dest: string; bytes: number; files: string; compose_from: string }
  'relay-call': RelayCallResult
  'validate-card': ValidateCardResult
  history: { ok: true; entries: HistoryEntry[] }
}

export type SignerOp = keyof SignerRequests

export const SIGNER_OPS: readonly SignerOp[] = [
  'docker-check',
  'docker-start',
  'image-pull',
  'pocketap-pull',
  'wallet-status',
  'wallet-import',
  'wallet-import-app',
  'wallet-create',
  'wallet-recover',
  'wallet-list',
  'wallet-export',
  'wallet-remove',
  'wallet-delete',
  'wallet-set-service',
  'tx-add-service',
  'tx-stake-app',
  'tx-delegate-gateway',
  'tx-undelegate-gateway',
  'tx-fund-wallet',
  'tx-fund-operator',
  'tx-unstake-supplier',
  'remote-stake-supplier',
  'ssh-test',
  'supplier-ship',
  'supplier-run',
  'deploy-ship',
  'relay-call',
  'validate-card',
  'history'
]

/** Per-operation timeouts in milliseconds (SIGNER-CONTRACT.md section 6.9). */
export const DEFAULT_TIMEOUT_MS = 240_000
export const TIMEOUTS_MS: Partial<Record<SignerOp, number>> = {
  'image-pull': 900_000,
  'pocketap-pull': 900_000,
  'ssh-test': 60_000,
  'supplier-ship': 180_000,
  'deploy-ship': 600_000,
  'relay-call': 120_000
}
export const SUPPLIER_STEP_TIMEOUTS_MS: Record<SupplierStep, number> = {
  operator: 120_000,
  keys: 120_000,
  publish: 420_000,
  start: 300_000,
  status: 120_000,
  deploy: 600_000,
  'add-service': 240_000,
  'remove-service': 240_000
}

/**
 * What a screen reports to the structured log when the read it does after a
 * transaction does not confirm it.
 *
 * Chain reads happen in the renderer, so nothing about them reaches app.log. A
 * verification that fails because the node did not answer therefore left no trace
 * anywhere, and the only record of it was a red line on a screen that is gone at the
 * next reload. This is the one thing the renderer may write to the log, and it carries
 * fixed fields and no free text: nothing here can be used to put a chosen string,
 * secret or otherwise, into the file.
 */
export interface VerifyReport {
  what: 'supplier' | 'application'
  network: 'beta' | 'main'
  txhash: string
  height: number
  /** unreadable: the record did not come back. stake-short: less on chain than was
   *  submitted. not-listed: a submitted service is neither active nor scheduled. */
  outcome: 'unreadable' | 'stake-short' | 'not-listed'
  /** The HTTP status of the read, 0 when the node did not answer at all. */
  status: number
  services: string[]
}

/** A progress line emitted while a long operation runs. */
export interface ProgressEvent {
  runId: string
  op: SignerOp
  step?: string
  level: 'info' | 'ok' | 'warn' | 'fail'
  text: string
  sub?: string
  time: string
}

export type SignerResult<K extends SignerOp> = K extends 'supplier-run'
  ? SupplierRunResult
  : SignerResults[K] | FailResult
