/**
 * Contract test: tools/alf-mcp against a real MeshServer, in both directions.
 *
 * alf-mcp reimplements the mesh endpoint layout on both sides (discovery
 * client + its own inbox server). When the runtime moved agents under
 * `/agents`, nothing noticed that alf-mcp still spoke the old routes. This
 * test drives alf-mcp's real discovery and wire code against the runtime's
 * real routes, and the runtime's real directory client against alf-mcp.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-alf-mcp-contract-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-alf-mcp-contract-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { MeshManager } from '../../src/main/runtime/mesh-manager'
import { MeshServer } from '../../src/main/services/mesh-server'
import { CodeSandboxService } from '../../src/main/runtime/code-sandbox'
import { DirectoryFetchCache } from '../../src/main/services/directory-fetch-cache'
import { createDefaultPipeline, type MessagingPipelineContext } from '../../src/main/services/alf-pipeline'
import type { AlfMessage, Visibility } from '../../src/shared/types/adf-v02.types'

const MESH_PORT = 38931
const ALF_PORT = 38935
const HANDLE = 'contract-agent'

// alf-mcp reads its configuration from the environment at import time, so set
// it before the dynamic imports in beforeAll.
process.env.ALF_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'alf-mcp-contract-data-'))
process.env.ALF_MCP_MDNS = '0'
process.env.ALF_MCP_BIND = '127.0.0.1'
process.env.ALF_MCP_PORT = String(ALF_PORT)

type Core = typeof import('../../tools/alf-mcp/core')
type Routes = typeof import('../../tools/alf-mcp/routes')
type Serve = typeof import('../../tools/alf-mcp/serve')

let core: Core
let routes: Routes
let serve: Serve
let agent: ReturnType<typeof createHeadlessAgent>
let agentFilePath: string
let mesh: MeshManager
let server: MeshServer

beforeAll(async () => {
  core = await import('../../tools/alf-mcp/core')
  routes = await import('../../tools/alf-mcp/routes')
  serve = await import('../../tools/alf-mcp/serve')

  const dir = mkdtempSync(join(tmpdir(), 'alf-mcp-contract-agent-'))
  agentFilePath = join(dir, `${HANDLE}.adf`)
  agent = createHeadlessAgent({
    filePath: agentFilePath,
    name: HANDLE,
    provider: new MockLLMProvider(),
    createOptions: {
      handle: HANDLE,
      messaging: { mode: 'respond_only', visibility: 'localhost' as Visibility, receive: true } as never,
    },
  })
  mesh = new MeshManager([dir])
  mesh.enableMesh()
  mesh.registerServableAgent(agentFilePath, agent.workspace.getAgentConfig(), agent.registry, agent.workspace, agent.session, agent.executor)
  server = new MeshServer(new CodeSandboxService(), { get: (k: string) => (k === 'meshPort' ? MESH_PORT : undefined) })
  server.setMeshManager(mesh)
  await server.start()
  if (!server.isRunning()) throw new Error(`mesh server failed to start on ${MESH_PORT}`)
})

afterAll(async () => {
  try { await server?.stop() } catch { /* best-effort */ }
  try { mesh?.unregisterAgent(agentFilePath) } catch { /* best-effort */ }
  agent?.dispose()
})

describe('alf-mcp → runtime', () => {
  it('discovers runtime agents through the /agents directory', async () => {
    const agents = await routes.fetchDirectory(`http://127.0.0.1:${MESH_PORT}`)
    const found = agents.find((a) => a.handle === HANDLE)
    expect(found, `discovered: ${agents.map((a) => a.handle).join(', ') || 'none'}`).toBeDefined()
    expect(found!.did).toBe(agent.workspace.getDid())
    expect(found!.endpoints?.inbox).toBe(`http://127.0.0.1:${MESH_PORT}${routes.agentPath(HANDLE, 'inbox')}`)
  })

  it('discovers through discoverAgents when the live runtime is not first in the list', async () => {
    // Regression: urls.map(fetchDirectory) fed the array index in as the
    // timeout, so every runtime after the first (and the first, at 0 ms)
    // aborted before responding.
    const agents = await routes.discoverAgents({
      runtimeUrls: ['http://127.0.0.1:1', `http://127.0.0.1:${MESH_PORT}`],
      self: { handle: 'claude', did: 'did:key:not-this-agent' },
    })
    expect(agents.map((a) => a.handle)).toContain(HANDLE)
  })

  it('excludes its own card from discovery results', async () => {
    const did = agent.workspace.getDid()!
    const agents = await routes.discoverAgents({ runtimeUrls: [`http://127.0.0.1:${MESH_PORT}`], self: { handle: HANDLE, did } })
    expect(agents.find((a) => a.did === did)).toBeUndefined()
  })

  it('delivers a signed, encrypted message to the discovered inbox', async () => {
    const [target] = (await routes.fetchDirectory(`http://127.0.0.1:${MESH_PORT}`)).filter((a) => a.handle === HANDLE)
    const identity = core.loadOrCreateIdentity()
    const message = core.buildMessage(
      { to: target.did!, content: 'hello from alf-mcp', replyTo: `http://127.0.0.1:${ALF_PORT}${routes.agentPath('claude', 'inbox')}` },
      identity,
    )
    const res = await fetch(target.endpoints!.inbox, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(core.prepareWire(message, identity, true)),
    })
    expect(res.status).toBe(202)
    expect(agent.workspace.getInbox().some((m) => m.content === 'hello from alf-mcp')).toBe(true)
  })
})

describe('runtime → alf-mcp', () => {
  // One inbox server for the block: restarting on the same port lets fetch
  // reuse a pooled keep-alive socket to the closed server (ECONNRESET).
  let identity: ReturnType<Core['loadOrCreateIdentity']>
  let store: InstanceType<Core['Store']>
  let inbox: Awaited<ReturnType<Serve['startInboxServer']>>

  beforeAll(async () => {
    identity = core.loadOrCreateIdentity()
    store = new core.Store()
    inbox = await serve.startInboxServer(identity, store)
  })

  afterAll(async () => {
    if (!inbox) return
    inbox.server.closeAllConnections()
    await new Promise<void>((resolve) => inbox.server.close(() => resolve()))
  })

  it("is discoverable by the runtime's directory client and accepts the runtime's egress", async () => {
    const cards = await new DirectoryFetchCache().fetch(`http://127.0.0.1:${inbox.port}`)
    const card = cards?.find((c) => c.did === identity.did)
    expect(card, 'runtime could not list the alf-mcp agent').toBeDefined()
    expect(card!.endpoints?.inbox).toBe(`http://127.0.0.1:${inbox.port}${routes.agentPath(core.HANDLE, 'inbox')}`)

    const agentDid = agent.workspace.getDid()!
    const outbound: AlfMessage = {
      version: '1.0', network: 'devnet', id: 'msg_contract_runtime_to_alf', timestamp: new Date().toISOString(),
      from: agentDid, to: identity.did, reply_to: `http://127.0.0.1:${MESH_PORT}${routes.agentPath(HANDLE, 'inbox')}`,
      payload: { content: 'hello from the runtime', content_type: 'text/plain', sent_at: new Date().toISOString() },
    }
    const ctx: MessagingPipelineContext = {
      direction: 'egress', workspace: agent.workspace, localDid: agentDid, remoteDid: identity.did,
      isLocal: false, security: { allow_unsigned: false, level: 2 }, derivedKey: null,
    }
    const egress = await createDefaultPipeline().processEgress(outbound, ctx)
    if (egress.rejected) throw new Error(`egress rejected: ${egress.rejected.reason}`)

    const res = await fetch(card!.endpoints!.inbox, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(egress.data),
    })
    expect(res.status).toBe(202)
    const stored = store.inbox.find((r) => r.message.id === 'msg_contract_runtime_to_alf')
    expect(stored?.message.payload.content).toBe('hello from the runtime')
    expect(stored?.verified).toEqual({ message: true, payload: true })
  })

  it('still answers the legacy route layout for saved contacts', async () => {
    const base = `http://127.0.0.1:${inbox.port}`
    expect((await fetch(`${base}${routes.LEGACY_DIRECTORY_PATH}`)).status).toBe(200)
    expect((await fetch(`${base}${routes.legacyAgentPath(core.HANDLE, 'card')}`)).status).toBe(200)

    // Saved contacts POST to the legacy inbox path.
    const sender = core.loadOrCreateIdentity()
    const message = core.buildMessage({ to: identity.did, content: 'via legacy inbox', replyTo: `${base}/legacy-reply` }, sender)
    const res = await fetch(`${base}${routes.legacyAgentPath(core.HANDLE, 'inbox')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(core.prepareWire(message, sender, true)),
    })
    expect(res.status).toBe(202)
    expect(store.inbox.some((r) => r.message.payload.content === 'via legacy inbox')).toBe(true)
  })

  it('answers health and the /ping identity probe', async () => {
    const base = `http://127.0.0.1:${inbox.port}`
    expect(await (await fetch(`${base}${routes.agentPath(core.HANDLE, 'health')}`)).json()).toEqual({ status: 'ok', state: 'on' })
    const ping = (await (await fetch(`${base}/ping`)).json()) as { runtime_id?: string; runtime_did?: string }
    expect(ping.runtime_id).toMatch(/^alf-mcp-/)
    expect(ping.runtime_did).toBe(identity.did)
  })
})

describe('fetchDirectory fallback', () => {
  const servers: Server[] = []
  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<{ url: string; hits: string[] }> => {
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url ?? '')
      handler!(req, res)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
  }

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('falls back to the legacy directory when /agents is missing', async () => {
    const legacy = await listen((req, res) => {
      if (req.url === routes.LEGACY_DIRECTORY_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ handle: 'old-runtime-agent' }]))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const agents = await routes.fetchDirectory(legacy.url)
    expect(agents.map((a) => a.handle)).toEqual(['old-runtime-agent'])
    expect(legacy.hits).toEqual([routes.DIRECTORY_PATH, routes.LEGACY_DIRECTORY_PATH])
  })

  it('does not retry the legacy path when the runtime does not answer', async () => {
    const silent = await listen(() => { /* never responds */ })
    expect(await routes.fetchDirectory(silent.url, 200)).toEqual([])
    expect(silent.hits).toEqual([routes.DIRECTORY_PATH])
  })
})
