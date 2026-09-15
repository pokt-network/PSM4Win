// The bridge's HTTP layer: MCP Streamable HTTP on loopback, one endpoint, bearer
// token, JSON responses (no SSE stream is needed: every tool call resolves to one
// result). Binds 127.0.0.1 only; refuses any Origin that is not this machine.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  handleJsonRpc,
  rpcError,
  MCP_PROTOCOL_VERSIONS,
  RPC,
  type BridgeDispatch,
  type JsonRpcResponse
} from '@core/bridge'
import { log } from '../state/log'

export const BRIDGE_HOST = '127.0.0.1'
export const BRIDGE_PATH = '/mcp'
const MAX_BODY = 2_000_000

export interface BridgeHttpOptions {
  port: number
  token: () => string
  dispatch: BridgeDispatch
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !expected) return false
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!m) return false
  const a = createHash('sha256').update(m[1]).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  } catch {
    return false
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSIONS[0],
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Body too large.'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createBridgeHttpServer(opts: BridgeHttpOptions): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${BRIDGE_HOST}`)
      if (url.pathname !== BRIDGE_PATH) return send(res, 404, { error: 'Not found.' })
      if (!originAllowed(req.headers.origin)) return send(res, 403, { error: 'Origin refused.' })
      if (!tokenMatches(req.headers.authorization, opts.token()))
        return send(res, 401, { error: 'Missing or wrong bridge token.' })
      if (req.method === 'GET' || req.method === 'DELETE')
        return send(res, 405, { error: 'This server answers POST only; it keeps no sessions.' })
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' })

      let parsed: unknown
      try {
        parsed = JSON.parse(await readBody(req))
      } catch (e) {
        return send(res, 400, rpcError(null, RPC.PARSE, `Invalid JSON: ${(e as Error).message}`))
      }
      // A 2025-03-26 client may still batch; answer each and return the array.
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const answers: JsonRpcResponse[] = []
      for (const m of messages) {
        const r = await handleJsonRpc(m, opts.dispatch)
        if (r) answers.push(r)
      }
      if (!answers.length) return send(res, 202, undefined)
      return send(res, 200, Array.isArray(parsed) ? answers : answers[0])
    } catch (e) {
      log.error('bridge request failed', { error: (e as Error).message })
      if (!res.headersSent) send(res, 500, rpcError(null, RPC.INTERNAL, 'Bridge error.'))
    }
  })
  // Tool calls can run for minutes (a deploy builds a container); never cut a request short.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 5_000
  server.timeout = 0
  return server
}
