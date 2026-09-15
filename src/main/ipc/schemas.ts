// zod schemas for every IPC payload. Unknown channels do not exist; unknown
// fields are stripped; wrong types are rejected before a handler runs. Handlers
// never take a command string or an argument array from the renderer.
import { z } from 'zod'
import type { SignerOp } from '@core/contract'

const network = z.enum(['beta', 'main'])
const empty = z
  .object({})
  .passthrough()
  .transform(() => ({}))
const ssh = z.object({
  host: z.string().max(253),
  port: z.coerce.number().int().default(22),
  user: z.string().max(64),
  key_path: z.string().max(1024)
})
const name = z.string().max(64)
const sid = z.string().max(64)
const addr = z.string().max(64)
const amount = z.coerce.number()
const dry = z.boolean().optional()

export const requestSchemas: Record<SignerOp, z.ZodTypeAny> = {
  'docker-check': empty,
  'docker-start': empty,
  'image-pull': empty,
  'pocketap-pull': empty,
  'wallet-status': empty,
  'wallet-import': z.object({ privateKeyHex: z.string().max(80) }),
  'wallet-import-app': z.object({
    name,
    service_id: sid.optional(),
    privateKeyHex: z.string().max(80)
  }),
  'wallet-create': z.object({ name, service_id: sid.optional() }),
  'wallet-recover': z.object({ name, service_id: sid.optional(), mnemonic: z.string().max(2048) }),
  'wallet-list': empty,
  'wallet-export': z.object({ name: name.optional() }),
  'wallet-remove': z.object({ name, confirm: z.string().max(64) }),
  'wallet-delete': z.object({ force: z.boolean().optional() }),
  'wallet-set-service': z.object({ name, service_id: sid }),
  'tx-add-service': z.object({
    network,
    service_id: sid,
    name: z.string().max(200),
    compute_units_per_relay: amount,
    card_path: z.string().max(1024).optional(),
    dry
  }),
  'tx-stake-app': z.object({
    network,
    service_id: sid,
    stake_upokt: amount,
    from: name.optional(),
    dry
  }),
  'tx-delegate-gateway': z.object({ network, from: name.optional(), gateway_address: addr, dry }),
  'tx-undelegate-gateway': z.object({ network, from: name.optional(), gateway_address: addr, dry }),
  'tx-fund-wallet': z.object({ network, name, amount_upokt: amount, dry }),
  'tx-fund-operator': z.object({ network, to: addr, amount_upokt: amount, dry }),
  'tx-unstake-supplier': z.object({ network, operator_address: addr, dry }),
  'remote-stake-supplier': ssh.extend({
    network,
    path: z.string().max(512),
    operator_key_name: z.string().max(64).optional(),
    owner_address: addr,
    operator_address: addr,
    stake_upokt: amount,
    services: z
      .array(z.object({ service_id: sid, url: z.string().max(2048), rpc_type: z.string().max(16) }))
      .max(200),
    dry
  }),
  'ssh-test': ssh.extend({ path: z.string().max(512).optional() }),
  'supplier-ship': ssh.extend({
    path: z.string().max(512),
    network,
    hostname: z.string().max(253),
    project: z.string().max(64).optional(),
    caddy_dir: z.string().max(512).optional(),
    health_port: z.coerce.number().optional(),
    relayer_metrics_port: z.coerce.number().optional(),
    miner_metrics_port: z.coerce.number().optional(),
    block_time: z.coerce.number().optional()
  }),
  'supplier-run': ssh.extend({
    path: z.string().max(512),
    step: z.string().max(32),
    network: network.optional(),
    service_id: sid.optional(),
    deploy_root: z.string().max(512).optional(),
    health_path: z.string().max(256).optional(),
    backend_url: z.string().max(256).optional()
  }),
  'deploy-ship': ssh.extend({
    deploy_root: z.string().max(512),
    service_id: sid,
    folder: z.string().max(1024)
  }),
  'relay-call': z.object({
    network,
    wallet: name.optional(),
    service_id: sid,
    method: z.string().max(8),
    path: z.string().max(2048),
    body: z.string().max(1_000_000).optional()
  }),
  'validate-card': z.object({
    card_path: z.string().max(1024),
    script: z.string().max(1024).optional()
  }),
  history: empty
}

export const windowBoundsSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number(),
  height: z.number(),
  maximized: z.boolean().optional()
})

export const settingsPatchSchema = z
  .object({
    network: network.optional(),
    theme: z.enum(['light', 'dark']).optional(),
    lastTab: z.string().max(64).optional(),
    lastService: z.string().max(64).optional(),
    servicesRoot: z.string().max(1024).optional(),
    supplierServer: z.string().max(64).optional(),
    welcomeSeen: z.boolean().optional(),
    servers: z
      .array(
        z.object({
          name: z.string().max(64),
          host: z.string().max(253),
          port: z.coerce.number().int(),
          user: z.string().max(64),
          keyPath: z.string().max(1024),
          deployRoot: z.string().max(512),
          suppliers: z
            .record(
              z.object({
                dir: z.string(),
                project: z.string(),
                url: z.string(),
                operator: z.string(),
                provisioned_at: z.string().optional()
              })
            )
            .default({})
        })
      )
      .optional(),
    lcdOverrides: z.record(z.string().max(512)).optional()
  })
  .strict()

export const serviceFileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,42}$/),
  name: z.enum(['service.json', 'card.json', 'deploy/docker-compose.yaml', 'deploy/answers.json'])
})
/** Reads may name any relative file inside the service folder (a custom card path from
 *  service.json); the handler still refuses paths that resolve outside the folder. */
export const serviceReadFileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,42}$/),
  name: z.string().regex(/^(?![A-Za-z]:|[\\/])[A-Za-z0-9_.\\/ -]{1,200}$/)
})

export const importSchema = z.object({ servicesRoot: z.string().max(1024).optional() })
