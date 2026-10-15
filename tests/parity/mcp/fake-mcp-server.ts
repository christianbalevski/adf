import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A remote MCP server on loopback for the W3-C parity scenarios: Streamable
 * HTTP with JSON answers (no SSE), one tool. Two endpoints:
 *
 * - `/mcp`: no auth;
 * - `/oauth-mcp`: OAuth (RFC 9728 protected resource, RFC 8414 metadata,
 *   dynamic client registration, PKCE code flow) with this server as the
 *   authorization server. Its authorization endpoint is an https URL nobody
 *   fetches (Studio only opens https authorization pages): the scenario's
 *   "browser" (mcp.test.ts) reads the page's redirect_uri and state and
 *   delivers the code to the loopback callback, as the real page would.
 *
 * It never reaches the network. Both backends reach it on the same port,
 * which the scenario's backend wrapper allows before boot (the daemon child
 * reads its fence ports at spawn).
 */

export interface FakeMcpServer {
  url: string
  /** The OAuth-protected endpoint. */
  oauthUrl: string
  port: number
  /** JSON-RPC methods and OAuth endpoints received, in order. */
  methods: string[]
  /**
   * Requests the server holds until the gate resolves (null: none). A
   * scenario sets them to pin where a backend's asynchronous pushes land
   * against the flow (agent-oauth.test.ts): `register` holds dynamic client
   * registration, `connect` an authorized MCP `initialize`.
   */
  gates: { register?: () => Promise<void>; connect?: () => Promise<void> } | null
  close(): Promise<void>
}

export const FAKE_MCP_TOOL = { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
export const FAKE_ACCESS_TOKEN = 'parity-access-token'
export const FAKE_AUTH_CODE = 'parity-auth-code'

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeMcpServer(): Promise<FakeMcpServer> {
  const methods: string[] = []
  let gates: FakeMcpServer['gates'] = null
  let base = ''
  const server: Server = createServer((req, res) => {
    // One request per connection: no keep-alive socket outlives a scenario (the harness counts open handles).
    res.setHeader('Connection', 'close')
    void (async () => {
      const path = new URL(req.url ?? '/', base).pathname
      // --- OAuth authorization server and protected resource metadata ---
      if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
        methods.push('GET protected-resource')
        return json(res, 200, { resource: `${base}/oauth-mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] })
      }
      if (req.method === 'GET' && path.startsWith('/.well-known/oauth-authorization-server')) {
        methods.push('GET authorization-server')
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `https://127.0.0.1:${(server.address() as AddressInfo).port}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      }
      if (req.method === 'GET' && path.startsWith('/.well-known/')) {
        methods.push(`GET ${path}`)
        res.writeHead(404).end()
        return
      }
      if (req.method === 'POST' && path === '/register') {
        await gates?.register?.()
        methods.push('POST register')
        const metadata = JSON.parse(await readBody(req)) as Record<string, unknown>
        return json(res, 201, { ...metadata, client_id: 'parity-client', client_id_issued_at: 1 })
      }
      if (req.method === 'POST' && path === '/token') {
        const form = new URLSearchParams(await readBody(req))
        methods.push(`POST token ${form.get('grant_type')}`)
        if (form.get('grant_type') === 'authorization_code' && form.get('code') !== FAKE_AUTH_CODE) return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, { access_token: FAKE_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'parity-refresh-token' })
      }
      // --- MCP ---
      if (path === '/oauth-mcp' && req.headers.authorization !== `Bearer ${FAKE_ACCESS_TOKEN}`) {
        methods.push(`${req.method} /oauth-mcp unauthorized`)
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth-mcp"`, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_token' }))
        return
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        methods.push(req.method)
        // No standalone SSE stream; no session to end.
        res.writeHead(405).end()
        return
      }
      const message = JSON.parse(await readBody(req)) as { id?: number | string; method?: string; params?: { protocolVersion?: string } }
      if (path === '/oauth-mcp' && message.method === 'initialize') await gates?.connect?.()
      methods.push(message.method ?? '?')
      if (message.id === undefined) { res.writeHead(202).end(); return }
      switch (message.method) {
        case 'initialize':
          return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'parity-fake', version: '1.2.3' } } })
        case 'tools/list':
          return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [FAKE_MCP_TOOL] } })
        case 'ping':
          return json(res, 200, { jsonrpc: '2.0', id: message.id, result: {} })
        default:
          return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
      }
    })().catch(() => { try { res.writeHead(500).end() } catch { /* closed */ } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  return {
    url: `${base}/mcp`,
    oauthUrl: `${base}/oauth-mcp`,
    port,
    methods,
    get gates() { return gates },
    set gates(value) { gates = value },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

/**
 * The browser on the fake's authorization page: the owner signs in and the
 * page redirects to the loopback callback with the code. `allowPort` lets the
 * calling process reach the callback (fence). Answers false for any other URL.
 */
export async function completeFakeAuthorization(authorizeUrl: string, port: number, allowPort: (port: number) => void, callbackHost?: string): Promise<boolean> {
  let page: URL
  try { page = new URL(authorizeUrl) } catch { return false }
  if (page.protocol !== 'https:' || page.hostname !== '127.0.0.1' || page.port !== String(port) || page.pathname !== '/authorize') return false
  const redirect = new URL(page.searchParams.get('redirect_uri') ?? '')
  redirect.searchParams.set('code', FAKE_AUTH_CODE)
  redirect.searchParams.set('state', page.searchParams.get('state') ?? '')
  // Remote mode: the browser runs on "another computer", where Studio's relay listens (127.0.0.2).
  if (callbackHost) redirect.hostname = callbackHost
  allowPort(Number(redirect.port))
  // No keep-alive agent: no socket of this "browser" outlives the scenario.
  return new Promise<boolean>((resolve) => {
    httpGet(redirect, { agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve((res.statusCode ?? 500) < 400))
    }).on('error', () => resolve(false))
  })
}
