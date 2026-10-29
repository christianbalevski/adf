/** The browser transport runs the real Studio handlers against a real daemon. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { ClientSessionRegistry, runtimeDocumentHost, wireRuntimeToClientSessions } from '../src/main/daemon/client-sessions'
import { daemonHostAllowList } from '../src/main/daemon/request-guard'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { IPC } from '../src/shared/constants/ipc-channels'
import { createWebTab } from '../src/main/daemon/web/context'

it('opens, reads and edits an agent through the shared Studio handlers without Electron', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adf-web-runtime-'))
  const filePath = join(directory, 'browser.adf')
  const created = createHeadlessAgent({ filePath, name: 'Browser test', provider: new MockLLMProvider() })
  created.dispose()
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  const sessions = new ClientSessionRegistry({ log: () => {}, documents: runtimeDocumentHost(runtime), resolveAgentId: id => runtime.getAgentOrDocument(id)?.id ?? null })
  const unwire = wireRuntimeToClientSessions(sessions, runtime)
  let port = 0
  const token = 'w'.repeat(43)
  const server = createDaemonHttpApi(runtime, {
    version: '0.0.0-test', routes: { clientSessions: sessions },
    security: { token, localProof: 'proof-for-web-test', allowedHosts: () => daemonHostAllowList('127.0.0.1', port) },
  })
  const writeOrigins: unknown[] = []
  const backgroundOrigins: unknown[] = []
  server.addHook('onRequest', async (request) => {
    if (request.method === 'PUT' && request.url.endsWith('/document')) writeOrigins.push(request.headers['x-adf-client-session'])
    if (request.method === 'GET' && request.url === '/agents') backgroundOrigins.push(request.headers['x-adf-client-session'])
  })
  try {
    await server.listen({ host: '127.0.0.1', port: 0 })
    port = (server.server.address() as { port: number }).port
    const host = `127.0.0.1:${port}`
    const headers = { host, origin: `http://${host}` }
    const launch = await server.inject({ method: 'POST', url: '/web/launch', headers: { host, authorization: `Bearer ${token}`, 'x-adf-local-proof': 'proof-for-web-test' } })
    expect(launch.statusCode).toBe(200)
    const ticket = new URLSearchParams(new URL(launch.json().url).hash.slice(1)).get('ticket')
    const login = await server.inject({ method: 'POST', url: '/web/session', headers, payload: { ticket } })
    expect(login.statusCode).toBe(200)
    const cookie = ([login.headers['set-cookie']].flat() as string[]).find(value => value.startsWith('adf_web_session_'))!.split(';')[0]
    const storageScope = login.json().storageScope
    const invoke = async (channel: string, args: unknown[] = [], clientId = 'browser-runtime-tab-1') => {
      const response = await server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { channel, args, clientId, storageScope } })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().result
    }
    // The first call must wait for registration, before the browser has opened
    // any agent. Otherwise a fast background turn can finish before a stream
    // exists to capture it, and the caller waits forever for its completion.
    await invoke(IPC.BACKGROUND_AGENT_STATUS)
    expect(backgroundOrigins).toEqual([expect.any(String)])
    expect(await invoke(IPC.APP_GET_VERSION)).toBe('0.0.0-test')
    expect(await invoke(IPC.FILE_OPEN, [{ filePath }])).toMatchObject({ success: true, filePath })
    expect(await invoke(IPC.FILE_GET_CURRENT)).toMatchObject({ filePath, agentRunning: false })
    expect(await invoke(IPC.FILE_GET_CURRENT, [], 'browser-runtime-tab-2')).toMatchObject({ filePath: null })
    expect(await invoke(IPC.DOC_SET_DOCUMENT, [{ content: '# Edited in browser' }])).toMatchObject({ success: true })
    // The daemon must recognize the writer so it does not echo saves as
    // external edits to that tab, or confuse two tabs editing the same agent.
    expect(writeOrigins).toEqual([expect.any(String)])
    expect(await invoke(IPC.FILE_OPEN, [{ filePath }], 'browser-runtime-tab-2')).toMatchObject({ success: true })
    expect(await invoke(IPC.DOC_SET_DOCUMENT, [{ content: '# Edited in another tab' }], 'browser-runtime-tab-2')).toMatchObject({ success: true })
    expect(writeOrigins[1]).toEqual(expect.any(String))
    expect(writeOrigins[1]).not.toBe(writeOrigins[0])
    expect(await invoke(IPC.DOC_SET_DOCUMENT, [{ content: '# Edited in browser' }])).toMatchObject({ success: true })
    expect(await invoke(IPC.DOC_GET_DOCUMENT)).toMatchObject({ content: '# Edited in browser' })
    expect(await invoke(IPC.DOC_UPLOAD_FILE, [{ path: 'web.txt', data: [...Buffer.from('browser upload')], mimeType: 'text/plain' }])).toMatchObject({ success: true })
    expect(await invoke(IPC.DOC_READ_INTERNAL_FILE, [{ path: 'web.txt' }])).toMatchObject({ content: 'browser upload' })
    const media = await server.inject({ url: `/web/file?clientId=browser-runtime-tab-1&path=web.txt&storageScope=${storageScope}&filePath=${encodeURIComponent(filePath)}`, headers: { ...headers, cookie } })
    expect(media.statusCode, media.body).toBe(200)
    expect(media.body).toBe('browser upload')
    const staleMedia = await server.inject({ url: `/web/file?clientId=browser-runtime-tab-1&path=web.txt&storageScope=${storageScope}&filePath=${encodeURIComponent(join(directory, 'previous-agent.adf'))}`, headers: { ...headers, cookie } })
    expect(staleMedia.statusCode).toBe(400)
    expect(staleMedia.json().error).toContain('no longer open')
    const snapshot = await server.inject({ url: `/web/snapshot?clientId=browser-runtime-tab-1&mode=share&storageScope=${storageScope}`, headers: { ...headers, cookie } })
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    expect(snapshot.headers['content-disposition']).toContain('attachment')
    expect(snapshot.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3')
    expect(await invoke(IPC.AGENT_START, [{ filePath, hasUserMessage: true }])).toMatchObject({ success: true })
    expect(await invoke(IPC.AGENT_INVOKE, [{ filePath, userMessage: 'Hello from browser Studio' }])).toMatchObject({ success: true })
    const chat = await invoke(IPC.DOC_GET_CHAT, [{}])
    expect(JSON.stringify(chat)).toContain('Hello from browser Studio')
    expect(await invoke(IPC.AGENT_STOP)).toMatchObject({ success: true })
    // Forged raw RPC must not read a browser-supplied path on the daemon host,
    // allocate a native share snapshot, or begin a localhost OAuth listener.
    for (const channel of [IPC.DOC_IMPORT_PATHS, IPC.FILE_SHARE_PREPARE, IPC.CHATGPT_AUTH_START]) {
      const refused = await server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { channel, args: [{ paths: [filePath], filePath }], clientId: 'browser-runtime-tab-1', storageScope } })
      expect(refused.statusCode).toBe(400)
      expect(refused.json().code).toBe('web_desktop_only')
    }
    // The browser cookie never authenticates the daemon REST API directly.
    expect((await server.inject({ url: '/agents', headers: { ...headers, cookie } })).statusCode).toBe(401)
    await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie } })
  } finally {
    await server.close()
    unwire()
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' }).catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

it('reports a failed daemon session instead of claiming the browser is connected', async () => {
  const server = Fastify()
  server.get('/version', () => ({ version: 'incompatible', clientApiVersion: -1 }))
  await server.listen({ host: '127.0.0.1', port: 0 })
  const port = (server.server.address() as { port: number }).port
  const send = vi.fn()
  const tab = await createWebTab({ baseUrl: `http://127.0.0.1:${port}`, version: 'test', token: 'test', settings: {}, send })
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.CONNECTION_CHANGED, expect.objectContaining({ current: expect.objectContaining({ state: 'not-connected' }) })))
    expect(await tab.invoke(IPC.CONNECTION_LIST, [])).toMatchObject({ current: { state: 'not-connected' } })
    expect(await tab.invoke(IPC.BACKEND_SETTINGS_GET, [])).toMatchObject({ daemon: { connection: 'failed', message: expect.stringContaining('client API') } })
    const closing = tab.close()
    expect(tab.close()).toBe(closing)
    await closing
    await expect(tab.invoke(IPC.APP_GET_VERSION, [])).rejects.toThrow('disconnected')
    await expect(tab.snapshot()).rejects.toThrow('disconnected')
    await expect(tab.readFile('image.png')).rejects.toThrow('disconnected')
  } finally {
    await tab.close()
    await server.close()
  }
})
