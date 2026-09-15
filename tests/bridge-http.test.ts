// The bridge's HTTP layer end to end on a loopback port: token, origin, method, and
// the MCP handshake, with a stub dispatch in place of the signer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createBridgeHttpServer, BRIDGE_PATH } from '../src/main/bridge/server'
import { toolResult, type BridgeDispatch } from '../src/core/bridge'

const TOKEN = 'a'.repeat(64)
const calls: Array<{ name: string; args: Record<string, unknown> }> = []
const dispatch: BridgeDispatch = {
  serverVersion: 'electron-test',
  call: async (name, args) => {
    calls.push({ name, args })
    return toolResult({ ok: true, echoed: args })
  }
}

let server: Server
let base = ''

beforeAll(async () => {
  server = createBridgeHttpServer({ port: 0, token: () => TOKEN, dispatch })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function rpc(
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<Response> {
  return fetch(base + BRIDGE_PATH, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...headers
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  })
}

describe('bridge HTTP', () => {
  it('refuses a missing or wrong token', async () => {
    const r1 = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: '' })
    expect(r1.status).toBe(401)
    const r2 = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { Authorization: 'Bearer nope' }
    )
    expect(r2.status).toBe(401)
  })
  it('refuses a foreign Origin and unknown paths', async () => {
    const r = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { Origin: 'https://evil.example' }
    )
    expect(r.status).toBe(403)
    const ok = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { Origin: 'http://localhost:1234' }
    )
    expect(ok.status).toBe(200)
    const nf = await fetch(base + '/other', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(nf.status).toBe(404)
  })
  it('answers POST only (no session stream)', async () => {
    const g = await rpc(null, {}, 'GET')
    expect(g.status).toBe(405)
  })
  it('completes the MCP handshake and lists tools', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' }
      }
    })
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-protocol-version')).toBe('2025-06-18')
    const body = (await init.json()) as {
      result: { protocolVersion: string; serverInfo: { version: string } }
    }
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.serverInfo.version).toBe('electron-test')
    const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools
    expect(tools.some((t) => t.name === 'psm_register_service')).toBe(true)
  })
  it('routes tools/call to the dispatch and returns a tool result', async () => {
    const r = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'psm_status', arguments: {} }
    })
    const body = (await r.json()) as {
      result: { isError: boolean; structuredContent: { ok: boolean } }
    }
    expect(body.result.isError).toBe(false)
    expect(body.result.structuredContent.ok).toBe(true)
    expect(calls.at(-1)).toEqual({ name: 'psm_status', args: {} })
  })
  it('rejects bad JSON with a parse error', async () => {
    const r = await fetch(base + BRIDGE_PATH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{not json'
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700)
  })
})
