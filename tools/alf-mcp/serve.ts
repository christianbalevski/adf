/**
 * ALF MCP inbox server — HTTP listener + mDNS announce so ADF Studio agents
 * can discover and message this agent. Endpoint shapes mirror mesh-server.ts:
 *
 *   GET  /health                 GET  /agents/:handle/card
 *   GET  /agents                 GET  /agents/:handle/health
 *   POST /agents/:handle/inbox
 *
 * The legacy layout (/mesh/directory, /:handle/mesh/*) is still answered so
 * contacts saved by older alf-mcp versions keep routing here.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'

import { MdnsService, type DiscoveredRuntime } from '../../src/main/services/mdns-service'
import {
  HANDLE,
  buildCard,
  decryptIfNeeded,
  verifyMessageSignature,
  verifyPayloadSignature,
  type Identity,
  type InboxRecord,
  type Store
} from './core'
import { DIRECTORY_PATH, LEGACY_DIRECTORY_PATH, agentPath, legacyAgentPath, type AgentLeaf } from './routes'
import type { AlfMessage } from '../../src/shared/types/adf-v02.types'

const MAX_BODY_BYTES = 10_000_000
const PORT_SEARCH_SPAN = 20

export interface InboxServer {
  server: Server
  mdns: MdnsService | null
  port: number
  host: string
  discoveredRuntimes: () => DiscoveredRuntime[]
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(data)
}

/** Hostname from a Host header, keeping IPv6 brackets ("[::1]:7396" → "[::1]"). */
export function hostFromHeader(host: string | undefined): string {
  if (!host) return '127.0.0.1'
  try {
    return new URL(`http://${host}`).hostname || '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

const isLoopback = (h: string | undefined): boolean =>
  !h || h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '::ffff:127.0.0.1'

/**
 * Mirror mesh-server's return-path derivation: if the sender's reply_to has a
 * loopback host but the request arrived from a remote peer, substitute the
 * transport-observed address so replies can actually route back.
 */
function deriveReturnPath(replyTo: string | undefined, remoteAddress: string | undefined): string | undefined {
  if (!replyTo) return undefined
  if (isLoopback(remoteAddress)) return replyTo
  try {
    const url = new URL(replyTo)
    if (!isLoopback(url.hostname)) return replyTo
    let peer = remoteAddress!
    if (peer.startsWith('::ffff:')) peer = peer.slice(7)
    url.hostname = peer.includes(':') ? `[${peer}]` : peer
    return url.toString()
  } catch {
    return replyTo
  }
}

function handleInboxPost(body: string, req: IncomingMessage, res: ServerResponse, identity: Identity, store: Store): void {
  let message: AlfMessage
  try {
    message = JSON.parse(body) as AlfMessage
  } catch {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }

  // Structural validation — same checks as mesh-server
  if (!message.from || typeof message.from !== 'string') {
    json(res, 400, { error: 'Missing required field: from' })
    return
  }
  if (!message.payload || typeof message.payload !== 'object') {
    json(res, 400, { error: 'Missing required field: payload' })
    return
  }
  if (!message.payload.content) {
    json(res, 400, { error: 'Missing required field: payload.content' })
    return
  }

  // Ingress crypto in the runtime's order: verify outer → decrypt → verify inner
  const messageVerified = verifyMessageSignature(message)
  if (messageVerified === false) {
    json(res, 403, { error: 'Invalid message signature' })
    return
  }

  const { message: plain, encrypted, error } = decryptIfNeeded(message, identity)
  if (error) {
    json(res, 403, { error })
    return
  }

  const payloadVerified = verifyPayloadSignature(plain)
  if (payloadVerified === false) {
    json(res, 403, { error: 'Invalid payload signature' })
    return
  }

  const record: InboxRecord = {
    id: `inbox-${randomBytes(8).toString('base64url')}`,
    received_at: new Date().toISOString(),
    read: false,
    encrypted,
    verified: { message: messageVerified, payload: payloadVerified },
    return_path: deriveReturnPath(plain.reply_to, req.socket.remoteAddress),
    message: plain
  }
  store.addInbox(record)
  if (plain.from.startsWith('did:')) {
    store.upsertContact({
      did: plain.from,
      alias: plain.payload.sender_alias,
      inbox_url: record.return_path
    })
  }
  console.error(`[alf-mcp] inbox ← ${plain.from} "${plain.payload.subject ?? '(no subject)'}" (${record.id})`)
  json(res, 202, { message_id: record.id })
}

export async function startInboxServer(identity: Identity, store: Store): Promise<InboxServer> {
  const bindHost = process.env.ALF_MCP_BIND ?? '0.0.0.0'
  const basePort = Number(process.env.ALF_MCP_PORT ?? 7396)

  // Current and legacy spellings of the same endpoint.
  const isPath = (path: string, leaf: AgentLeaf): boolean =>
    path === agentPath(HANDLE, leaf) || path === legacyAgentPath(HANDLE, leaf)

  const runtimeId = `alf-mcp-${identity.did.slice(-8)}`

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const cardHost = hostFromHeader(req.headers.host)

    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { status: 'ok', uptime: process.uptime(), agents: 1, port })
      return
    }
    // Runtime identity probe (mesh-server.ts /ping): tailnet and manual-peer
    // discovery only accept peers that answer it with a runtime_id.
    if (req.method === 'GET' && path === '/ping') {
      json(res, 200, { runtime_id: runtimeId, runtime_did: identity.did, proto: 'alf/0.2' })
      return
    }
    if (req.method === 'GET' && (path === DIRECTORY_PATH || path === LEGACY_DIRECTORY_PATH)) {
      json(res, 200, [buildCard(identity, cardHost, port)])
      return
    }
    if (req.method === 'GET' && isPath(path, 'card')) {
      json(res, 200, buildCard(identity, cardHost, port))
      return
    }
    if (req.method === 'GET' && isPath(path, 'health')) {
      json(res, 200, { status: 'ok', state: 'on' })
      return
    }
    if (req.method === 'POST' && isPath(path, 'inbox')) {
      readBody(req)
        .then((body) => handleInboxPost(body, req, res, identity, store))
        .catch(() => json(res, 400, { error: 'Failed to read request body' }))
      return
    }
    json(res, 404, { error: 'Not found' })
  })

  // Port scan like the mesh server: if the base port is taken, walk forward.
  let port = basePort
  await new Promise<void>((resolve, reject) => {
    let attempt = 0
    const tryListen = (): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < PORT_SEARCH_SPAN) {
          attempt++
          port = basePort + attempt
          tryListen()
        } else {
          reject(err)
        }
      })
      server.listen(port, bindHost, () => {
        server.removeAllListeners('error')
        resolve()
      })
    }
    tryListen()
  })
  console.error(`[alf-mcp] inbox listening on http://${bindHost}:${port}${agentPath(HANDLE, 'inbox')}`)

  // mDNS: announce as an ADF runtime + browse for peers (gated like Studio:
  // announce only makes sense when bound beyond loopback).
  let mdns: MdnsService | null = null
  if (process.env.ALF_MCP_MDNS !== '0') {
    try {
      mdns = new MdnsService()
      await mdns.start({
        announce: bindHost === '0.0.0.0',
        browse: true,
        port,
        runtimeId,
        runtimeDid: identity.did
      })
    } catch (err) {
      console.error('[alf-mcp] mdns unavailable:', err)
      mdns = null
    }
  }

  return {
    server,
    mdns,
    port,
    host: bindHost,
    discoveredRuntimes: () => mdns?.getDiscoveredRuntimes() ?? []
  }
}
