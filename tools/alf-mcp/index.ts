/**
 * ALF MCP server — gives Claude Code its own ALF identity (DID + Ed25519
 * signing keys), a persistent inbox/outbox, and tools to message ADF Studio
 * agents over the mesh (signed + encrypted, byte-compatible with the runtime).
 *
 * Run: npx tsx tools/alf-mcp/index.ts   (registered via .mcp.json)
 * Data: ~/.alf-mcp (override with ALF_MCP_DATA_DIR)
 */

import './stdout-guard'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  HANDLE,
  DEFAULT_NETWORK,
  buildMessage,
  loadOrCreateIdentity,
  prepareWire,
  Store,
  DATA_DIR,
  type InboxRecord
} from './core'
import { startInboxServer, type InboxServer } from './serve'
import type { AlfAgentCard } from '../../src/shared/types/adf-v02.types'

const identity = loadOrCreateIdentity()
const store = new Store()

/** Assigned in main() before the MCP transport connects; tools run after. */
let inbox: InboxServer

// ===========================================================================
// Discovery
// ===========================================================================

const DEFAULT_RUNTIME_URLS = (process.env.ALF_RUNTIME_URLS ?? 'http://127.0.0.1:7295')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

interface DiscoveredAgent extends AlfAgentCard {
  runtime_url: string
}

async function fetchDirectory(runtimeUrl: string): Promise<DiscoveredAgent[]> {
  try {
    const res = await fetch(`${runtimeUrl.replace(/\/$/, '')}/mesh/directory`, {
      signal: AbortSignal.timeout(2500)
    })
    if (!res.ok) return []
    const cards = (await res.json()) as AlfAgentCard[]
    return (Array.isArray(cards) ? cards : []).map((c) => ({ ...c, runtime_url: runtimeUrl }))
  } catch {
    return []
  }
}

async function discoverAgents(extraRuntimeUrl?: string): Promise<DiscoveredAgent[]> {
  const urls = new Set<string>(DEFAULT_RUNTIME_URLS)
  if (extraRuntimeUrl) urls.add(extraRuntimeUrl)
  for (const peer of inbox.discoveredRuntimes()) urls.add(peer.url)
  const results = await Promise.all([...urls].map(fetchDirectory))
  const agents = results.flat().filter((a) => a.handle !== HANDLE || a.did !== identity.did)
  for (const a of agents) {
    if (a.did && a.endpoints?.inbox) {
      store.upsertContact({ did: a.did, handle: a.handle, inbox_url: a.endpoints.inbox })
    }
  }
  return agents
}

async function resolveRecipient(
  to: string,
  explicitAddress?: string
): Promise<{ did: string; address: string; handle?: string }> {
  const isDid = to.startsWith('did:')
  if (isDid && explicitAddress) return { did: to, address: explicitAddress }

  const contact = isDid ? store.contacts[to] : Object.values(store.contacts).find((c) => c.handle === to)
  if (contact?.inbox_url && (isDid || contact.did)) {
    return { did: isDid ? to : contact.did, address: explicitAddress ?? contact.inbox_url, handle: contact.handle }
  }

  const agents = await discoverAgents()
  const match = agents.find((a) => (isDid ? a.did === to : a.handle === to))
  if (!match?.endpoints?.inbox || !match.did) {
    const known = agents.map((a) => `${a.handle} (${a.did ?? 'no did'})`).join(', ') || 'none'
    throw new Error(
      `Cannot resolve recipient "${to}" to a delivery address. Discovered agents: ${known}. ` +
        `Pass an explicit "address" (inbox URL), or check that ADF Studio's mesh server is running.`
    )
  }
  return { did: match.did, address: explicitAddress ?? match.endpoints.inbox, handle: match.handle }
}

// ===========================================================================
// Formatting helpers
// ===========================================================================

function inboxSummary(r: InboxRecord): Record<string, unknown> {
  return {
    id: r.id,
    from: r.message.from,
    sender_alias: r.message.payload.sender_alias,
    subject: r.message.payload.subject,
    thread_id: r.message.payload.thread_id,
    sent_at: r.message.payload.sent_at,
    received_at: r.received_at,
    read: r.read,
    encrypted: r.encrypted,
    verified: r.verified,
    preview: String(
      typeof r.message.payload.content === 'string'
        ? r.message.payload.content
        : JSON.stringify(r.message.payload.content)
    ).slice(0, 120)
  }
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

// ===========================================================================
// Sending
// ===========================================================================

interface SendArgs {
  to: string
  content: string
  address?: string
  subject?: string
  thread_id?: string
  parent_id?: string
  content_type?: string
  network?: string
  encrypt?: boolean
}

async function sendAlf(args: SendArgs): Promise<Record<string, unknown>> {
  const { did, address, handle } = await resolveRecipient(args.to, args.address)
  const encrypt = args.encrypt ?? true

  const replyTo = `http://127.0.0.1:${inbox.port}/${HANDLE}/mesh/inbox`
  const cardUrl = `http://127.0.0.1:${inbox.port}/${HANDLE}/mesh/card`
  const message = buildMessage(
    {
      to: did,
      content: args.content,
      replyTo,
      cardUrl,
      network: args.network ?? DEFAULT_NETWORK,
      subject: args.subject,
      threadId: args.thread_id,
      parentId: args.parent_id,
      contentType: args.content_type,
      senderAlias: HANDLE,
      recipientAlias: handle
    },
    identity
  )
  const wire = prepareWire(message, identity, encrypt)

  let statusCode: number | undefined
  let error: string | undefined
  try {
    const res = await fetch(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
      signal: AbortSignal.timeout(10_000)
    })
    statusCode = res.status
    if (res.status !== 202 && res.status !== 200) {
      const body = await res.text().catch(() => '')
      error = `Delivery failed: HTTP ${res.status} ${body.slice(0, 300)}`
    }
  } catch (err) {
    error = `Delivery failed: ${err instanceof Error ? err.message : String(err)}`
  }

  store.addOutbox({
    id: message.id,
    created_at: message.timestamp,
    address,
    status: error ? 'failed' : 'delivered',
    status_code: statusCode,
    error,
    encrypted: encrypt,
    message
  })
  store.upsertContact({ did, handle, inbox_url: address })

  if (error) throw new Error(error)
  return { delivered: true, message_id: message.id, to: did, handle, address, encrypted: encrypt, status_code: statusCode }
}

// ===========================================================================
// MCP server
// ===========================================================================

const mcp = new McpServer({ name: 'alf', version: '0.1.0' })

mcp.registerTool(
  'alf_whoami',
  {
    description:
      'Show this agent\'s ALF identity: DID, handle, inbox endpoint, and agent card URL. Other agents message you at the inbox endpoint.',
    inputSchema: {}
  },
  async () =>
    text({
      handle: HANDLE,
      did: identity.did,
      inbox_endpoint: `http://127.0.0.1:${inbox.port}/${HANDLE}/mesh/inbox`,
      card_endpoint: `http://127.0.0.1:${inbox.port}/${HANDLE}/mesh/card`,
      port: inbox.port,
      network: DEFAULT_NETWORK,
      data_dir: DATA_DIR,
      unread: store.inbox.filter((m) => !m.read).length,
      note: 'Identity is a did:key over Ed25519, recoverable from the mnemonic in identity.json.'
    })
)

mcp.registerTool(
  'alf_discover',
  {
    description:
      'Discover ALF agents: queries ADF runtime directories (local ADF Studio at 127.0.0.1:7295 by default, plus mDNS-discovered LAN runtimes). Returns handle, DID, and inbox endpoint per agent.',
    inputSchema: {
      runtime_url: z.string().optional().describe('Additional runtime base URL to query, e.g. http://192.168.1.20:7295')
    }
  },
  async ({ runtime_url }) => {
    const agents = await discoverAgents(runtime_url)
    return text(
      agents.map((a) => ({
        handle: a.handle,
        did: a.did,
        description: a.description,
        inbox: a.endpoints?.inbox,
        signing: a.policies?.find((p) => p.type === 'signing') ? 'required' : 'open',
        runtime_url: a.runtime_url
      }))
    )
  }
)

mcp.registerTool(
  'alf_send',
  {
    description:
      'Send an ALF message to another agent (e.g. an ADF Studio agent). Signs the payload and message with this agent\'s Ed25519 key and encrypts to the recipient DID by default. Recipient can be a handle (resolved via discovery) or a DID.',
    inputSchema: {
      to: z.string().describe('Recipient handle (e.g. "agent-1") or DID (did:key:z6Mk...)'),
      content: z.string().describe('Message body (plain text, markdown, or JSON string)'),
      subject: z.string().optional(),
      address: z.string().optional().describe('Explicit inbox URL, overrides discovery'),
      thread_id: z.string().optional().describe('Thread to continue'),
      parent_id: z.string().optional().describe('Message id this replies to'),
      content_type: z.string().optional().describe('MIME type, default text/plain'),
      network: z.string().optional().describe(`ALF network, default ${DEFAULT_NETWORK}`),
      encrypt: z.boolean().optional().describe('Encrypt payload to recipient DID (default true)')
    }
  },
  async (args) => text(await sendAlf(args))
)

mcp.registerTool(
  'alf_reply',
  {
    description: 'Reply to a message in the inbox by its inbox id. Routes to the sender\'s return path and preserves threading.',
    inputSchema: {
      id: z.string().describe('Inbox record id (from alf_inbox)'),
      content: z.string(),
      subject: z.string().optional()
    }
  },
  async ({ id, content, subject }) => {
    const record = store.inbox.find((r) => r.id === id)
    if (!record) throw new Error(`No inbox message with id ${id}`)
    const original = record.message
    return text(
      await sendAlf({
        to: original.from,
        address: record.return_path ?? original.reply_to,
        content,
        subject: subject ?? (original.payload.subject ? `Re: ${original.payload.subject.replace(/^Re: /, '')}` : undefined),
        thread_id: original.payload.thread_id ?? undefined,
        parent_id: original.id
      })
    )
  }
)

mcp.registerTool(
  'alf_inbox',
  {
    description: 'List received ALF messages (newest first) with verification status. Use alf_read to fetch a full message.',
    inputSchema: {
      unread_only: z.boolean().optional().describe('Only unread messages (default false)'),
      limit: z.number().optional().describe('Max results (default 20)')
    }
  },
  async ({ unread_only, limit }) => {
    const items = store.inbox
      .filter((r) => !unread_only || !r.read)
      .slice(-(limit ?? 20))
      .reverse()
      .map(inboxSummary)
    return text({ total: store.inbox.length, unread: store.inbox.filter((r) => !r.read).length, messages: items })
  }
)

mcp.registerTool(
  'alf_read',
  {
    description: 'Read a full inbox message by id and mark it read.',
    inputSchema: { id: z.string().describe('Inbox record id (from alf_inbox)') }
  },
  async ({ id }) => {
    const record = store.inbox.find((r) => r.id === id)
    if (!record) throw new Error(`No inbox message with id ${id}`)
    if (!record.read) {
      record.read = true
      store.saveInbox()
    }
    return text(record)
  }
)

mcp.registerTool(
  'alf_outbox',
  {
    description: 'List sent ALF messages (newest first) with delivery status.',
    inputSchema: { limit: z.number().optional().describe('Max results (default 20)') }
  },
  async ({ limit }) =>
    text(
      store.outbox
        .slice(-(limit ?? 20))
        .reverse()
        .map((r) => ({
          message_id: r.id,
          to: r.message.to,
          subject: r.message.payload.subject,
          address: r.address,
          status: r.status,
          status_code: r.status_code,
          error: r.error,
          encrypted: r.encrypted,
          created_at: r.created_at
        }))
    )
)

// ===========================================================================
// Startup
// ===========================================================================

async function shutdown(): Promise<void> {
  await inbox?.mdns?.stop().catch(() => {})
  inbox?.server.close()
  process.exit(0)
}

async function main(): Promise<void> {
  inbox = await startInboxServer(identity, store)
  console.error(`[alf-mcp] identity ${identity.did} (handle: ${HANDLE})`)

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await mcp.connect(new StdioServerTransport())
  console.error('[alf-mcp] MCP server connected on stdio')
}

main().catch((err) => {
  console.error('[alf-mcp] fatal:', err)
  process.exit(1)
})
