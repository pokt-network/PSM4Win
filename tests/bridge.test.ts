import { describe, it, expect } from 'vitest'
import {
  BRIDGE_TOOLS,
  BRIDGE_EXCLUDED_OPS,
  BRIDGE_APP_ONLY_OPS,
  bridgeTool,
  needsConfirmation,
  handleJsonRpc,
  toolResult,
  MCP_PROTOCOL_VERSIONS,
  RPC,
  type BridgeDispatch
} from '../src/core/bridge'
import { SIGNER_OPS } from '../src/core/contract'

const dispatch: BridgeDispatch = {
  serverVersion: '0.1.0-test',
  call: async (name, args) => toolResult({ ok: true, name, args })
}

describe('bridge tool table', () => {
  it('names every tool psm_* with a unique name and an object schema', () => {
    const names = BRIDGE_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of BRIDGE_TOOLS) {
      expect(t.name).toMatch(/^psm_[a-z_]+$/)
      expect(t.inputSchema.type).toBe('object')
      expect(t.description.length).toBeGreaterThan(20)
    }
  })
  it('maps every tool to a real signer operation (or the composite status)', () => {
    for (const t of BRIDGE_TOOLS)
      expect(t.op === 'app-status' || SIGNER_OPS.includes(t.op)).toBe(true)
  })
  it('never exposes an operation that carries a key or a phrase', () => {
    for (const t of BRIDGE_TOOLS) expect(BRIDGE_EXCLUDED_OPS).not.toContain(t.op)
    // and the exclusion list itself names real operations
    for (const op of BRIDGE_EXCLUDED_OPS) expect(SIGNER_OPS).toContain(op)
  })
  it('withholds the operations the app keeps to itself, for a reason that is not secrecy', () => {
    // Not on the bridge by choice, not because it carries a key: unstaking an application
    // starts an unbonding period nothing can shorten, so it stays in the app window.
    for (const t of BRIDGE_TOOLS) expect(BRIDGE_APP_ONLY_OPS).not.toContain(t.op)
    for (const op of BRIDGE_APP_ONLY_OPS) expect(SIGNER_OPS).toContain(op)
    expect(BRIDGE_APP_ONLY_OPS).toContain('tx-unstake-app')
  })
  it('server-scoped tools take a server name, never SSH fields', () => {
    for (const t of BRIDGE_TOOLS) {
      const props = Object.keys(t.inputSchema.properties)
      expect(props).not.toContain('key_path')
      expect(props).not.toContain('host')
      if (t.server) expect(props).toContain('server')
    }
  })
  it('every transaction confirms unless dry, destructive always, publish only for that step', () => {
    for (const t of BRIDGE_TOOLS) {
      if (t.op.startsWith('tx-') || t.op === 'remote-stake-supplier') {
        expect(t.confirm).toBe('spend')
        expect(needsConfirmation(t, {})).toBe(true)
        expect(needsConfirmation(t, { dry: true })).toBe(false)
      }
    }
    const rm = bridgeTool('psm_wallet_remove')!
    expect(needsConfirmation(rm, { dry: true })).toBe(true)
    const run = bridgeTool('psm_supplier_run')!
    expect(needsConfirmation(run, { step: 'publish' })).toBe(true)
    expect(needsConfirmation(run, { step: 'start' })).toBe(false)
  })
})

describe('bridge JSON-RPC', () => {
  it('initialize negotiates a known protocol version and describes the server', async () => {
    const r = await handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      dispatch
    )
    expect(r?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'pocket-service-manager', version: '0.1.0-test' }
    })
    const r2 = await handleJsonRpc(
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      dispatch
    )
    expect((r2?.result as { protocolVersion: string }).protocolVersion).toBe(
      MCP_PROTOCOL_VERSIONS[0]
    )
  })
  it('notifications get no response', async () => {
    expect(
      await handleJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, dispatch)
    ).toBeNull()
  })
  it('tools/list returns the table', async () => {
    const r = await handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, dispatch)
    const tools = (r?.result as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name)).toContain('psm_status')
    expect(tools.length).toBe(BRIDGE_TOOLS.length)
  })
  it('tools/call dispatches and wraps results; unknown tools are invalid params', async () => {
    const r = await handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'psm_history', arguments: {} }
      },
      dispatch
    )
    const res = r?.result as { content: { type: string; text: string }[]; isError?: boolean }
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, name: 'psm_history' })
    const bad = await handleJsonRpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'psm_export_key' } },
      dispatch
    )
    expect(bad?.error?.code).toBe(RPC.INVALID_PARAMS)
  })
  it('unknown methods and malformed messages are errors', async () => {
    const r = await handleJsonRpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, dispatch)
    expect(r?.error?.code).toBe(RPC.METHOD_NOT_FOUND)
    const m = await handleJsonRpc({ hello: 'world' }, dispatch)
    expect(m?.error?.code).toBe(RPC.INVALID_REQUEST)
  })
  it('a failed signer result is an isError tool result, not a JSON-RPC error', () => {
    const r = toolResult({ ok: false, error: 'nope', detail: '' })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ error: 'nope' })
  })
})
