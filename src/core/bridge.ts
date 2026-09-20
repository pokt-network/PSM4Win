// The local MCP action bridge, pure part (no Node, no Electron): the tool table an
// assistant sees, the JSON-RPC dispatch for MCP over Streamable HTTP, and the rules
// that decide which calls must be confirmed in the app window.
//
// The bridge exposes the app's own named operations (docs/SIGNER-CONTRACT.md) and
// nothing else. Operations that carry a key or a recovery phrase in either direction
// (owner import and revoke, application wallet import, create, recover, export) are
// not on the bridge at all: an assistant never needs a secret, and a secret must not
// land in a model's context. Servers are named by their Settings entry, so SSH key
// paths never cross the bridge either. See docs/ARCHITECTURE.md section 8.
import type { SignerOp } from './contract'

/** Protocol revisions this server speaks; the first is what it answers with. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const
export const BRIDGE_SERVER_NAME = 'pocket-service-manager'

export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/** When a tool call must be approved in the app window before anything runs. */
export type ConfirmRule =
  | 'never'
  /** A spend or a signature: confirm unless `dry` is true. MainNet asks to type a token. */
  | 'spend'
  /** Deletes something on this machine: always confirm, always typed. */
  | 'destructive'
  /** supplier-run: only the `publish` step signs (a self-transfer on the server). */
  | 'publish-step'

export interface BridgeTool {
  name: string
  description: string
  inputSchema: JsonSchema
  /** The signer operation behind the tool, or 'app-status' for the composite read. */
  op: SignerOp | 'app-status'
  confirm: ConfirmRule
  /** The tool takes `server` (a Settings server name) instead of host/port/user/key_path. */
  server?: boolean
}

const network = {
  type: 'string',
  enum: ['beta', 'main'],
  description: 'beta (Beta TestNet, chain pocket-lego-testnet) or main (MainNet, chain pocket)'
}
const dry = {
  type: 'boolean',
  description:
    'true: build and return the exact command (and config) without signing or broadcasting; needs no confirmation'
}
const server = {
  type: 'string',
  description: 'Name of a server entry from the app Settings (psm_status lists them)'
}
const upokt = (what: string): Record<string, unknown> => ({
  type: 'integer',
  minimum: 1,
  description: `${what} in uPOKT (1 POKT = 1,000,000 uPOKT). Fetch minimums live from the network first.`
})
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

export const BRIDGE_TOOLS: readonly BridgeTool[] = [
  {
    name: 'psm_status',
    description:
      'What the Pocket Service Manager app can do right now: selected network, owner wallet (address only), Docker state, services folder, and the configured servers with their supplier stacks. Call this first.',
    inputSchema: obj({}),
    op: 'app-status',
    confirm: 'never'
  },
  {
    name: 'psm_docker_start',
    description: 'Start Docker Desktop on this PC (pocketd runs in a container). No confirmation.',
    inputSchema: obj({}),
    op: 'docker-start',
    confirm: 'never'
  },
  {
    name: 'psm_image_pull',
    description: 'Download the pinned pocketd image (about 100 MB, once). No confirmation.',
    inputSchema: obj({}),
    op: 'image-pull',
    confirm: 'never'
  },
  {
    name: 'psm_pocketap_pull',
    description: 'Download the pinned pocket-ap relay-client image used by relay tests.',
    inputSchema: obj({}),
    op: 'pocketap-pull',
    confirm: 'never'
  },
  {
    name: 'psm_wallet_list',
    description:
      'The application wallets in the keyring: name, address, the service each is for, and whether its key is present. Never returns keys or phrases.',
    inputSchema: obj({}),
    op: 'wallet-list',
    confirm: 'never'
  },
  {
    name: 'psm_wallet_set_service',
    description:
      'Record which service an application wallet is for (metadata only, nothing on chain).',
    inputSchema: obj(
      {
        name: { type: 'string', description: 'Application wallet name' },
        service_id: { type: 'string', description: 'Service ID' }
      },
      ['name', 'service_id']
    ),
    op: 'wallet-set-service',
    confirm: 'never'
  },
  {
    name: 'psm_wallet_remove',
    description:
      'Delete an application wallet key from this machine. Funds and stakes stay on chain and become unreachable without a backup. The user must type the wallet name in the app to approve.',
    inputSchema: obj({ name: { type: 'string', description: 'Application wallet name' } }, [
      'name'
    ]),
    op: 'wallet-remove',
    confirm: 'destructive'
  },
  {
    name: 'psm_history',
    description:
      'The app activity list: every transaction and remote step, newest last, with tx hashes.',
    inputSchema: obj({}),
    op: 'history',
    confirm: 'never'
  },
  {
    name: 'psm_validate_card',
    description:
      'Validate a service card file (pocket-service-card/v1) the way the Register screen does.',
    inputSchema: obj({ card_path: { type: 'string', description: 'Absolute path to card.json' } }, [
      'card_path'
    ]),
    op: 'validate-card',
    confirm: 'never'
  },
  {
    name: 'psm_register_service',
    description:
      'Register (add-service) or update a service on chain, signed by the owner wallet. Spends the registration fee on creation plus gas. The user confirms in the app window; on MainNet they type the service ID.',
    inputSchema: obj(
      {
        network,
        service_id: { type: 'string', description: 'Permanent service ID, up to 42 characters' },
        name: { type: 'string', description: 'Display name' },
        compute_units_per_relay: {
          type: 'integer',
          minimum: 1,
          description: 'Price of one relay in compute units (1 to 1,048,576)'
        },
        card_path: { type: 'string', description: 'Absolute path to the card.json to attach' },
        dry
      },
      ['network', 'service_id', 'name', 'compute_units_per_relay']
    ),
    op: 'tx-add-service',
    confirm: 'spend'
  },
  {
    name: 'psm_stake_application',
    description:
      'Stake an application wallet for one service. The user confirms in the app window; on MainNet they type the service ID.',
    inputSchema: obj(
      {
        network,
        service_id: { type: 'string' },
        stake_upokt: upokt('Stake amount'),
        from: {
          type: 'string',
          description: 'Application wallet name; omitted means the owner wallet stakes itself'
        },
        dry
      },
      ['network', 'service_id', 'stake_upokt']
    ),
    op: 'tx-stake-app',
    confirm: 'spend'
  },
  {
    name: 'psm_delegate_gateway',
    description:
      'Delegate an application to a gateway (fetch the live gateway list first). Confirmed in the app.',
    inputSchema: obj(
      {
        network,
        from: {
          type: 'string',
          description: 'Application wallet name; omitted means the owner wallet'
        },
        gateway_address: { type: 'string', description: 'pokt1... gateway address' },
        dry
      },
      ['network', 'gateway_address']
    ),
    op: 'tx-delegate-gateway',
    confirm: 'spend'
  },
  {
    name: 'psm_undelegate_gateway',
    description: 'Undelegate an application from a gateway. Confirmed in the app.',
    inputSchema: obj(
      {
        network,
        from: {
          type: 'string',
          description: 'Application wallet name; omitted means the owner wallet'
        },
        gateway_address: { type: 'string' },
        dry
      },
      ['network', 'gateway_address']
    ),
    op: 'tx-undelegate-gateway',
    confirm: 'spend'
  },
  {
    name: 'psm_fund_wallet',
    description:
      'Send POKT from the owner wallet to one of its application wallets. Confirmed in the app; on MainNet the user types SEND.',
    inputSchema: obj(
      {
        network,
        name: { type: 'string', description: 'Application wallet name' },
        amount_upokt: upokt('Amount'),
        dry
      },
      ['network', 'name', 'amount_upokt']
    ),
    op: 'tx-fund-wallet',
    confirm: 'spend'
  },
  {
    name: 'psm_fund_operator',
    description:
      'Send POKT from the owner wallet to a supplier operator address for gas. Confirmed in the app; on MainNet the user types SEND.',
    inputSchema: obj(
      {
        network,
        to: { type: 'string', description: 'pokt1... operator address' },
        amount_upokt: upokt('Amount'),
        dry
      },
      ['network', 'to', 'amount_upokt']
    ),
    op: 'tx-fund-operator',
    confirm: 'spend'
  },
  {
    name: 'psm_unstake_supplier',
    description:
      'Begin unstaking a supplier (signed by the owner wallet). The stake returns after the unbonding period. Confirmed in the app; on MainNet the user types UNSTAKE.',
    inputSchema: obj({ network, operator_address: { type: 'string' }, dry }, [
      'network',
      'operator_address'
    ]),
    op: 'tx-unstake-supplier',
    confirm: 'spend'
  },
  {
    name: 'psm_stake_supplier',
    description:
      'Stake the supplier on a provisioned server for a set of services; the operator key on the server signs. The service list replaces the current one. Owner and operator addresses and the stack directory default from the app. Confirmed in the app; on MainNet the user types the server name.',
    inputSchema: obj(
      {
        server,
        network,
        stake_upokt: upokt('Total supplier stake'),
        services: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              service_id: { type: 'string' },
              url: {
                type: 'string',
                description: 'Public https URL of the relayer for this service'
              },
              rpc_type: {
                type: 'string',
                description: 'REST, JSON_RPC, GRPC, WEBSOCKET, or COMET_BFT'
              }
            },
            required: ['service_id', 'url', 'rpc_type']
          }
        },
        path: {
          type: 'string',
          description: 'Stack directory on the server; defaults to the provisioned stack'
        },
        owner_address: { type: 'string', description: 'Defaults to the owner wallet' },
        operator_address: { type: 'string', description: 'Defaults to the stack operator' },
        dry
      },
      ['server', 'network', 'stake_upokt', 'services']
    ),
    op: 'remote-stake-supplier',
    confirm: 'spend',
    server: true
  },
  {
    name: 'psm_ssh_test',
    description:
      'Check the SSH connection to a server: hostname, Docker, and whether the operator keyring exists.',
    inputSchema: obj(
      { server, path: { type: 'string', description: 'Stack directory to check for a keyring' } },
      ['server']
    ),
    op: 'ssh-test',
    confirm: 'never',
    server: true
  },
  {
    name: 'psm_supplier_ship',
    description:
      'Copy the RelayMiner stack templates and supplier.sh to a server for one network (the first Provision step). Existing relayer config is kept.',
    inputSchema: obj(
      {
        server,
        network,
        hostname: { type: 'string', description: 'Public hostname the stack serves' },
        path: {
          type: 'string',
          description: 'Stack directory; defaults to /opt/pocket/supplier-<network>'
        },
        project: { type: 'string' },
        caddy_dir: { type: 'string' },
        health_port: { type: 'integer' },
        relayer_metrics_port: { type: 'integer' },
        miner_metrics_port: { type: 'integer' },
        block_time: { type: 'integer', description: 'Seconds; omitted means measured live' }
      },
      ['server', 'network', 'hostname']
    ),
    op: 'supplier-ship',
    confirm: 'never',
    server: true
  },
  {
    name: 'psm_supplier_run',
    description:
      'Run one supplier.sh step on a server: operator (create the operator key there), keys, publish (signs a 1 uPOKT self-transfer; confirmed in the app), start, status, deploy, add-service, remove-service.',
    inputSchema: obj(
      {
        server,
        step: {
          type: 'string',
          enum: [
            'operator',
            'keys',
            'publish',
            'start',
            'status',
            'deploy',
            'add-service',
            'remove-service'
          ]
        },
        network,
        path: {
          type: 'string',
          description: 'Stack directory; defaults to the provisioned stack for the network'
        },
        service_id: { type: 'string' },
        deploy_root: { type: 'string' },
        health_path: { type: 'string' },
        backend_url: { type: 'string' }
      },
      ['server', 'step', 'network']
    ),
    op: 'supplier-run',
    confirm: 'publish-step',
    server: true
  },
  {
    name: 'psm_deploy_ship',
    description:
      'Copy a local service folder (backend and deploy files) to a server before supplier_run deploy.',
    inputSchema: obj(
      {
        server,
        service_id: { type: 'string' },
        folder: { type: 'string', description: 'Absolute path of the local service folder' },
        deploy_root: { type: 'string', description: 'Defaults to the server deploy root' }
      },
      ['server', 'service_id', 'folder']
    ),
    op: 'deploy-ship',
    confirm: 'never',
    server: true
  },
  {
    name: 'psm_relay_call',
    description:
      'Send one relay through the protocol with pocket-ap, signed by an application wallet staked for the service. Returns status, timing, and the body. Every response must be a JSON object (first byte { or [).',
    inputSchema: obj(
      {
        network,
        service_id: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'] },
        path: { type: 'string', description: 'Request path, for example /v1/version' },
        body: { type: 'string', description: 'Request body for POST or PUT' },
        wallet: {
          type: 'string',
          description: 'Application wallet name; defaults to the one staked for the service'
        }
      },
      ['network', 'service_id', 'method', 'path']
    ),
    op: 'relay-call',
    confirm: 'never'
  }
]

export function bridgeTool(name: string): BridgeTool | undefined {
  return BRIDGE_TOOLS.find((t) => t.name === name)
}

/** Operations that must never appear on the bridge (they carry a key or a phrase). */
/**
 * Operations the bridge never exposes because they carry a key or a phrase in one
 * direction or the other.
 *
 * Kept apart from BRIDGE_APP_ONLY_OPS below, which are withheld for a different reason.
 */
export const BRIDGE_EXCLUDED_OPS: readonly SignerOp[] = [
  'wallet-import',
  'wallet-import-app',
  'wallet-create',
  'wallet-recover',
  'wallet-export',
  'wallet-delete'
]

/**
 * Operations that exist in the app but are deliberately not offered to an assistant.
 *
 * These carry no secret, so nothing forces them off the bridge; they are withheld
 * because the product owner chose to keep them in the app window, where the person
 * doing it is looking at the screen. Unstaking an application starts an unbonding
 * period that cannot be hurried, so it is a decision to take deliberately rather than
 * one to hand to an agent (product owner, 2026-09-20).
 */
export const BRIDGE_APP_ONLY_OPS: readonly SignerOp[] = ['tx-unstake-app']

/** Whether this call needs the user's approval in the app window before it runs. */
export function needsConfirmation(tool: BridgeTool, args: Record<string, unknown>): boolean {
  switch (tool.confirm) {
    case 'never':
      return false
    case 'destructive':
      return true
    case 'spend':
      return args.dry !== true
    case 'publish-step':
      return args.step === 'publish'
  }
}

// ---- JSON-RPC over MCP ----

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603
} as const

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface BridgeDispatch {
  serverVersion: string
  /** Runs a tool; throws only for programming errors, otherwise returns a result with isError. */
  call: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>
}

export function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  }
}

export function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as JsonRpcRequest).jsonrpc === '2.0' &&
    typeof (v as JsonRpcRequest).method === 'string'
  )
}

/** Wraps a signer result as an MCP tool result: text for the model, structured for clients. */
export function toolResult(value: unknown): ToolCallResult {
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : { value }
  const isError = obj.ok === false
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
    isError
  }
}

/**
 * Handles one MCP JSON-RPC message. Returns null for notifications (nothing to send).
 * Methods: initialize, ping, tools/list, tools/call. Everything else is method-not-found.
 */
export async function handleJsonRpc(
  msg: unknown,
  dispatch: BridgeDispatch
): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(msg))
    return rpcError(null, RPC.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.')
  const id = msg.id ?? null
  const isNotification = msg.id === undefined
  if (isNotification) return null
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '')
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : MCP_PROTOCOL_VERSIONS[0]
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: dispatch.serverVersion },
          instructions:
            'These tools drive the Pocket Service Manager desktop app on this PC. Read-only tools run at once. Every spend or signature opens a confirmation in the app window and waits for the user; on MainNet they must type a token. Keys and recovery phrases are never available here. Pass dry: true to preview the exact command without confirmation. Fetch every chain value live before quoting it.'
        }
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: BRIDGE_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        }
      }
    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments
      if (typeof name !== 'string' || !bridgeTool(name))
        return rpcError(id, RPC.INVALID_PARAMS, `Unknown tool '${String(name)}'.`)
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args)))
        return rpcError(id, RPC.INVALID_PARAMS, 'arguments must be an object.')
      try {
        const result = await dispatch.call(name, (args ?? {}) as Record<string, unknown>)
        return { jsonrpc: '2.0', id, result }
      } catch (e) {
        return rpcError(id, RPC.INTERNAL, (e as Error).message)
      }
    }
    default:
      return rpcError(id, RPC.METHOD_NOT_FOUND, `Method '${msg.method}' is not supported.`)
  }
}
