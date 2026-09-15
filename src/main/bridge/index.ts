// The local MCP action bridge (docs/ARCHITECTURE.md section 8). Off until the user
// enables it in Settings. Listens on loopback with a per-install bearer token, exposes
// the tool table from src/core/bridge.ts, resolves server names to SSH connections
// from Settings, and gates every spend or signature on a confirmation in the app
// window that the main process itself waits for.
import { app, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { join } from 'node:path'
import {
  BRIDGE_TOOLS,
  bridgeTool,
  needsConfirmation,
  toolResult,
  type BridgeDispatch,
  type BridgeTool,
  type ToolCallResult
} from '@core/bridge'
import type { SignerOp, SignerRequests } from '@core/contract'
import { APP_VERSION_PREFIX, BRIDGE_DEFAULT_PORT, CHAIN_IDS } from '@core/versions'
import { fmtPokt } from '@core/format'
import type { Network } from '@core/networks'
import { requestSchemas } from '../ipc/schemas'
import { signer } from '../signer'
import { readSettings, writeSettings, type ServerEntry } from '../state/settings'
import { readText, writeText, exists } from '../state/files'
import { dataDir } from '../paths'
import { log } from '../state/log'
import { createBridgeHttpServer, BRIDGE_HOST, BRIDGE_PATH } from './server'
import { confirmInWindow } from './confirm'

export interface BridgeStatus {
  enabled: boolean
  running: boolean
  port: number
  endpoint: string
  /** The bearer token; shown in Settings so the user can paste it into a client config. */
  token: string
  error: string | null
}

function tokenPath(): string {
  return join(dataDir(), 'bridge.token')
}

class BridgeService {
  private server: Server | null = null
  private token = ''
  private port = BRIDGE_DEFAULT_PORT
  private error: string | null = null
  private getWindow: () => BrowserWindow | null = () => null

  async init(getWindow: () => BrowserWindow | null): Promise<void> {
    this.getWindow = getWindow
    await this.loadToken()
    const s = await readSettings()
    this.port = s.bridgePort ?? BRIDGE_DEFAULT_PORT
    if (s.bridgeEnabled) await this.start()
  }

  private async loadToken(): Promise<void> {
    const p = tokenPath()
    const t = exists(p) ? ((await readText(p)) ?? '').trim() : ''
    if (/^[0-9a-f]{64}$/.test(t)) this.token = t
    else await this.rotateToken()
  }

  async rotateToken(): Promise<BridgeStatus> {
    this.token = randomBytes(32).toString('hex')
    await writeText(tokenPath(), this.token + '\n')
    log.info('bridge token rotated')
    this.notify()
    return this.status()
  }

  status(): BridgeStatus {
    return {
      enabled: this.server !== null || this.error !== null ? this.server !== null : false,
      running: this.server !== null,
      port: this.port,
      endpoint: `http://${BRIDGE_HOST}:${this.port}${BRIDGE_PATH}`,
      token: this.token,
      error: this.error
    }
  }

  async setEnabled(enabled: boolean, port?: number): Promise<BridgeStatus> {
    if (port !== undefined) this.port = port
    await writeSettings({ bridgeEnabled: enabled, bridgePort: this.port })
    if (enabled) await this.start()
    else await this.stop()
    return this.status()
  }

  private async start(): Promise<void> {
    await this.stop()
    this.error = null
    const dispatch: BridgeDispatch = {
      serverVersion: APP_VERSION_PREFIX + app.getVersion(),
      call: (name, args) => this.call(name, args)
    }
    const server = createBridgeHttpServer({ port: this.port, token: () => this.token, dispatch })
    await new Promise<void>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.error =
          e.code === 'EADDRINUSE'
            ? `Port ${this.port} is in use. Choose another port.`
            : `Could not start: ${e.message}`
        log.error('bridge listen failed', { error: e.message, port: this.port })
        resolve()
      })
      server.listen(this.port, BRIDGE_HOST, () => {
        this.server = server
        log.info('bridge listening', { port: this.port })
        resolve()
      })
    })
    this.notify()
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
      s.closeAllConnections?.()
      log.info('bridge stopped')
    }
    this.notify()
  }

  private notify(): void {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('psm:bridge-status', this.status())
  }

  private activity(tool: string, ok: boolean): void {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('psm:bridge-activity', { tool, ok })
  }

  // ---- tool calls ----

  private async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const tool = bridgeTool(name)
    if (!tool) return toolResult({ ok: false, error: `Unknown tool '${name}'.`, detail: '' })
    log.info('bridge call', { tool: name, network: args.network, service_id: args.service_id })
    const result = await this.run(tool, args)
    this.activity(name, (result.structuredContent?.ok as boolean | undefined) !== false)
    return result
  }

  private async run(tool: BridgeTool, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (tool.op === 'app-status') return toolResult(await this.appStatus())
    let req: Record<string, unknown> = { ...args }
    if (tool.server) {
      const r = await this.resolveServer(tool, req)
      if ('error' in r) return toolResult({ ok: false, error: r.error, detail: '' })
      req = r.req
    }
    if (tool.op === 'wallet-remove') req.confirm = String(req.name ?? '')
    const parsed = requestSchemas[tool.op].safeParse(req)
    if (!parsed.success)
      return toolResult({
        ok: false,
        error:
          'Invalid arguments: ' +
          parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
        detail: ''
      })
    const data = parsed.data as Record<string, unknown>
    if (needsConfirmation(tool, data)) {
      const c = this.describe(tool, data)
      const approved = await confirmInWindow(this.getWindow, c)
      if (!approved)
        return toolResult({
          ok: false,
          error: 'Not approved in the app window.',
          detail: 'The user declined, or did not answer within five minutes. Nothing was signed.'
        })
    }
    const res = await signer.run(tool.op, data as SignerRequests[SignerOp])
    return toolResult(res)
  }

  private async resolveServer(
    tool: BridgeTool,
    req: Record<string, unknown>
  ): Promise<{ req: Record<string, unknown> } | { error: string }> {
    const s = await readSettings()
    const name = String(req.server ?? '')
    const entry = s.servers.find((x) => x.name === name)
    if (!entry) return { error: `No server named '${name}' in Settings. psm_status lists them.` }
    const net = (req.network as Network | undefined) ?? s.network
    const stack = entry.suppliers?.[net]
    const out: Record<string, unknown> = { ...req }
    delete out.server
    out.host = entry.host
    out.port = entry.port
    out.user = entry.user
    out.key_path = entry.keyPath
    if (tool.op !== 'ssh-test' && tool.op !== 'deploy-ship' && !out.path)
      out.path = stack?.dir || `/opt/pocket/supplier-${net}`
    if (tool.op === 'deploy-ship' && !out.deploy_root)
      out.deploy_root = entry.deployRoot || '/opt/pocket/services'
    if (tool.op === 'supplier-run' && !out.deploy_root)
      out.deploy_root = entry.deployRoot || '/opt/pocket/services'
    if (tool.op === 'remote-stake-supplier') {
      if (!out.operator_address) out.operator_address = stack?.operator ?? ''
      if (!out.owner_address) {
        const ws = await signer.run('wallet-status', {})
        out.owner_address = ws.ok && 'address' in ws ? (ws.address ?? '') : ''
      }
      if (!out.operator_address)
        return { error: `Server '${name}' has no ${net} operator; provision it first.` }
      if (!out.owner_address) return { error: 'No owner wallet is imported.' }
    }
    return { req: out }
  }

  private describe(
    tool: BridgeTool,
    a: Record<string, unknown>
  ): Parameters<typeof confirmInWindow>[1] {
    const net = (a.network as Network | undefined) ?? null
    const main = net === 'main'
    const netName = net === 'main' ? 'MainNet' : net === 'beta' ? 'Beta TestNet' : ''
    const pokt = (v: unknown): string => fmtPokt(Number(v)) + ' POKT'
    const facts: Array<[string, string]> = []
    let summary = ''
    let token: string | null = null
    switch (tool.op) {
      case 'tx-add-service':
        summary = `An assistant asks to register service '${a.service_id}' on ${netName}, signed by the owner wallet. This pays the registration fee on creation plus gas.`
        facts.push(
          ['Service ID', String(a.service_id)],
          ['Name', String(a.name)],
          ['Compute units per relay', String(a.compute_units_per_relay)]
        )
        if (a.card_path) facts.push(['Card', String(a.card_path)])
        token = main ? String(a.service_id) : null
        break
      case 'tx-stake-app':
        summary = `An assistant asks to stake ${pokt(a.stake_upokt)} from '${a.from ?? 'the owner wallet'}' as an application for '${a.service_id}' on ${netName}. Unstaking takes an unbonding period.`
        facts.push(
          ['Service ID', String(a.service_id)],
          ['Wallet', String(a.from ?? 'owner wallet')],
          ['Stake', pokt(a.stake_upokt)]
        )
        token = main ? String(a.service_id) : null
        break
      case 'tx-delegate-gateway':
      case 'tx-undelegate-gateway': {
        const verb = tool.op === 'tx-delegate-gateway' ? 'delegate' : 'undelegate'
        summary = `An assistant asks to ${verb} '${a.from ?? 'the owner wallet'}' ${verb === 'delegate' ? 'to' : 'from'} gateway ${a.gateway_address} on ${netName} (gas only).`
        facts.push(
          ['Wallet', String(a.from ?? 'owner wallet')],
          ['Gateway', String(a.gateway_address)]
        )
        token = null
        break
      }
      case 'tx-fund-wallet':
        summary = `An assistant asks to send ${pokt(a.amount_upokt)} from the owner wallet to application wallet '${a.name}' on ${netName}. Transfers cannot be reversed.`
        facts.push(['To wallet', String(a.name)], ['Amount', pokt(a.amount_upokt)])
        token = main ? 'SEND' : null
        break
      case 'tx-fund-operator':
        summary = `An assistant asks to send ${pokt(a.amount_upokt)} from the owner wallet to operator ${a.to} on ${netName}. Transfers cannot be reversed.`
        facts.push(['To operator', String(a.to)], ['Amount', pokt(a.amount_upokt)])
        token = main ? 'SEND' : null
        break
      case 'tx-unstake-supplier':
        summary = `An assistant asks to unstake the supplier ${a.operator_address} on ${netName}, signed by the owner wallet. The stake returns after the unbonding period.`
        facts.push(['Operator', String(a.operator_address)])
        token = main ? 'UNSTAKE' : null
        break
      case 'remote-stake-supplier': {
        const ids = (a.services as { service_id: string }[]).map((s) => s.service_id).join(', ')
        summary = `An assistant asks to stake ${pokt(a.stake_upokt)} as the supplier on ${a.host} for ${ids} on ${netName}. The operator key on the server signs; the service list replaces the current one.`
        facts.push(
          ['Server', `${a.user}@${a.host}`],
          ['Operator', String(a.operator_address)],
          ['Stake', pokt(a.stake_upokt)],
          ['Services', ids]
        )
        token = main ? String(this.serverNameFor(String(a.host)) ?? a.host) : null
        break
      }
      case 'supplier-run':
        summary = `An assistant asks to publish the operator's public key on ${netName} with a 1 uPOKT self-transfer signed on ${a.host}.`
        facts.push(['Server', `${a.user}@${a.host}`], ['Stack', String(a.path)])
        token = null
        break
      case 'wallet-remove':
        summary = `An assistant asks to delete application wallet '${a.name}' from this machine. Its funds and stakes stay on chain and are lost without a backup of the key or phrase.`
        facts.push(['Wallet', String(a.name)])
        token = String(a.name)
        break
      default:
        summary = `An assistant asks to run ${tool.name}.`
    }
    return { tool: tool.name, summary, network: net, token, facts }
  }

  private serverNameFor(host: string): string | undefined {
    return this.cachedServers.find((s) => s.host === host)?.name
  }
  private cachedServers: ServerEntry[] = []

  private async appStatus(): Promise<Record<string, unknown>> {
    const s = await readSettings()
    this.cachedServers = s.servers
    const [docker, wallet] = await Promise.all([
      signer.run('docker-check', {}),
      signer.run('wallet-status', {})
    ])
    return {
      ok: true,
      app: APP_VERSION_PREFIX + app.getVersion(),
      network: s.network,
      chain_id: CHAIN_IDS[s.network],
      owner_wallet:
        wallet.ok && 'imported' in wallet
          ? {
              imported: wallet.imported,
              address: wallet.address ?? null,
              verified: wallet.verified
            }
          : { imported: false, address: null, verified: false },
      docker,
      services_root: s.servicesRoot ?? null,
      servers: s.servers.map((e) => ({
        name: e.name,
        host: e.host,
        user: e.user,
        deploy_root: e.deployRoot || '/opt/pocket/services',
        stacks: Object.fromEntries(
          Object.entries(e.suppliers ?? {}).map(([net, st]) => [
            net,
            {
              dir: st?.dir ?? '',
              url: st?.url ?? '',
              operator: st?.operator ?? '',
              provisioned: !!st?.provisioned_at
            }
          ])
        )
      })),
      tools: BRIDGE_TOOLS.map((t) => t.name),
      note: 'Spends and signatures open a confirmation in the app window and wait for the user. Keys and phrases are never available here.'
    }
  }
}

export const bridge = new BridgeService()
