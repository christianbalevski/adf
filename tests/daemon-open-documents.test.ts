/**
 * W2-A: open documents (design daemon-backend.md D4; tracker W2-A). An .adf
 * a client session holds open without running it: every /agents/:id resource
 * route works on it, start assembles on its workspace, stop keeps it open
 * while held, it is invisible to mesh, timers and autostart, and a session's
 * expiry releases it.
 */
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(process.env.ADF_USER_DATA_DIR ?? '.', 'electron')
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-open-documents', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import spec from '../docs/daemon/openapi.json'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService, type RuntimeDocumentEvent, type RuntimeServiceOptions } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { AgentLeaseRegistry, processAgentLeases } from '../src/main/runtime/agent-lease'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'
import type { LLMProvider } from '../src/main/providers/provider.interface'

const runtimes: RuntimeService[] = []
const servers: Array<{ close: () => Promise<unknown> }> = []
const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  await Promise.all(servers.splice(0).map(s => s.close()))
  // Never shutdownAll here: it latches the process-wide RuntimeGate teardown.
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
    for (const doc of runtime.listOpenDocuments()) runtime.closeDocument(doc.filePath, 'released')
  }
  RuntimeGate._resetForTests()
})

function tempDir(): string {
  return realpathSync.native(mkdtempSync(join(process.env.ADF_USER_DATA_DIR!, 'w2a-')))
}

function seedAgent(dir: string, name: string, patch: Partial<AgentConfig> = {}): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions: { handle: name, autostart: false, start_in_state: 'hibernate' },
  })
  const config = created.workspace.getAgentConfig()
  if (Object.keys(patch).length) created.workspace.setAgentConfig({ ...config, ...patch })
  created.dispose()
  return { filePath: realpathSync.native(filePath), agentId: config.id }
}

function memorySettings(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    store: {
      get: (key: string) => data[key],
      set: (key: string, value: unknown) => { data[key] = value },
      getAll: () => ({ ...data }),
      update: (values: Record<string, unknown>) => { Object.assign(data, values) },
    },
  }
}

function setup(opts: { settings?: Record<string, unknown>; runtime?: Partial<RuntimeServiceOptions> } = {}) {
  const settings = memorySettings(opts.settings)
  const runtime = new RuntimeService({
    settings: settings.store,
    enforceReviewGate: false,
    providerFactory: () => new MockLLMProvider(),
    ...opts.runtime,
  })
  runtimes.push(runtime)
  const server = createDaemonHttpApi(runtime, { settingsStore: settings.store })
  servers.push(server)
  return { runtime, server, settings }
}

/** A stand-in for W2-B's client sessions: holds documents, and releases them when it expires. */
class FakeClientSessions {
  constructor(private readonly runtime: RuntimeService) {}
  hold(sessionId: string, filePath: string) { return this.runtime.openDocument(filePath, { holder: sessionId }) }
  release(sessionId: string, agentId: string) { return this.runtime.releaseDocument(agentId, sessionId) }
  /** W2-B's session-expiry hook. */
  expire(sessionId: string) { return this.runtime.releaseDocumentHolder(sessionId) }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

// --- The route table --------------------------------------------------------------

/**
 * `ok`: the route answers this status on an open document that is not
 * running. `notRunning`: a runtime action, refused with 409
 * agent_not_running. `reached`: the route found the document and answered
 * with its own outcome (no owner identity in this daemon, an unknown task
 * id): never "Unknown agent", never a 5xx.
 */
type Expect = { ok: number } | 'notRunning' | 'reached'

interface Ctx {
  id: string
  q: string
  timerId?: number
  taskId: string
}

interface RouteCase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** The OpenAPI path. */
  path: string
  url: (c: Ctx) => string
  body?: unknown | ((c: Ctx) => unknown)
  raw?: Buffer
  expect: Expect
  after?: (res: { statusCode: number; json: () => any; body: string }, c: Ctx) => void
}

const A = '/agents/{id}'
const ROUTES: RouteCase[] = [
  { method: 'GET', path: A, url: c => `/agents/${c.id}`, expect: { ok: 200 }, after: r => expect(r.json().running).toBe(false) },
  { method: 'GET', path: `${A}/status`, url: c => `/agents/${c.id}/status`, expect: { ok: 200 }, after: r => expect(r.json()).toMatchObject({ running: false, runtimeState: 'stopped' }) },
  { method: 'GET', path: `${A}/header`, url: c => `/agents/${c.id}/header`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/batch`, url: c => `/agents/${c.id}/batch`, expect: { ok: 200 }, after: r => expect(r.json().chat.uiLog).toEqual(expect.any(Array)) },
  { method: 'POST', path: `${A}/checkpoint`, url: c => `/agents/${c.id}/checkpoint`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/loop`, url: c => `/agents/${c.id}/loop`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/loops`, url: c => `/agents/${c.id}/loops`, expect: { ok: 200 }, after: r => expect(r.json().loops[0]).toMatchObject({ name: 'main', isMain: true }) },
  { method: 'POST', path: `${A}/loops`, url: c => `/agents/${c.id}/loops`, body: { name: 'critic', goal: 'Review drafts.' }, expect: 'notRunning' },
  { method: 'GET', path: `${A}/loops/{name}`, url: c => `/agents/${c.id}/loops/main`, expect: { ok: 200 } },
  { method: 'PATCH', path: `${A}/loops/{name}`, url: c => `/agents/${c.id}/loops/critic`, body: { enabled: false }, expect: 'notRunning' },
  { method: 'DELETE', path: `${A}/loops/{name}`, url: c => `/agents/${c.id}/loops/critic`, expect: 'notRunning' },
  { method: 'GET', path: `${A}/logs`, url: c => `/agents/${c.id}/logs`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/logs/after`, url: c => `/agents/${c.id}/logs/after?afterId=0`, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/logs`, url: c => `/agents/${c.id}/logs`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/tables`, url: c => `/agents/${c.id}/tables`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/tables/{table}`, url: c => `/agents/${c.id}/tables/adf_audit`, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/tables/{table}`, url: c => `/agents/${c.id}/tables/local_none`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/umbilical/events`, url: c => `/agents/${c.id}/umbilical/events`, expect: { ok: 200 }, after: r => expect(r.json().log_enabled).toBe(false) },
  { method: 'GET', path: `${A}/config`, url: c => `/agents/${c.id}/config`, expect: { ok: 200 } },
  {
    method: 'PUT', path: `${A}/config`, url: c => `/agents/${c.id}/config`, expect: { ok: 200 },
    body: () => ({ ...docConfig, instructions: 'Edited while open.' }),
    after: r => expect(r.json().config.instructions).toBe('Edited while open.'),
  },
  { method: 'GET', path: `${A}/tools`, url: c => `/agents/${c.id}/tools`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/state`, url: c => `/agents/${c.id}/state`, body: { state: 'idle' }, expect: 'notRunning' },
  { method: 'PUT', path: `${A}/document`, url: c => `/agents/${c.id}/document`, body: { content: '# Edited' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/document`, url: c => `/agents/${c.id}/document`, expect: { ok: 200 }, after: r => expect(r.json().content).toBe('# Edited') },
  { method: 'PUT', path: `${A}/mind`, url: c => `/agents/${c.id}/mind`, body: { content: '# Mind' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/mind`, url: c => `/agents/${c.id}/mind`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/chat`, url: c => `/agents/${c.id}/chat`, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/chat`, url: c => `/agents/${c.id}/chat`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/chat`, url: c => `/agents/${c.id}/chat`, body: { text: 'hello' }, expect: 'notRunning' },
  { method: 'GET', path: `${A}/files`, url: c => `/agents/${c.id}/files`, expect: { ok: 200 } },
  { method: 'PUT', path: `${A}/files/content`, url: c => `/agents/${c.id}/files/content?path=notes/a.txt`, body: { content: 'hi' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/files/content`, url: c => `/agents/${c.id}/files/content?path=notes/a.txt`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/files/meta`, url: c => `/agents/${c.id}/files/meta?path=notes/a.txt`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/files/raw`, url: c => `/agents/${c.id}/files/raw?path=notes/a.txt`, expect: { ok: 200 }, after: r => expect(r.body).toBe('hi') },
  { method: 'PUT', path: `${A}/files/raw`, url: c => `/agents/${c.id}/files/raw?path=notes/raw.bin`, raw: Buffer.from([1, 2, 3]), expect: { ok: 200 } },
  { method: 'POST', path: `${A}/files/rename`, url: c => `/agents/${c.id}/files/rename`, body: { oldPath: 'notes/a.txt', newPath: 'notes/b.txt' }, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/files/rename-folder`, url: c => `/agents/${c.id}/files/rename-folder`, body: { oldPrefix: 'notes', newPrefix: 'archive' }, expect: { ok: 200 } },
  { method: 'PATCH', path: `${A}/files/protection`, url: c => `/agents/${c.id}/files/protection`, body: { path: 'archive/b.txt', protection: 'none' }, expect: { ok: 200 } },
  { method: 'PATCH', path: `${A}/files/authorized`, url: c => `/agents/${c.id}/files/authorized`, body: { path: 'archive/b.txt', authorized: false }, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/files/content`, url: c => `/agents/${c.id}/files/content?path=archive/b.txt`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/export`, url: c => `/agents/${c.id}/export`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/inbox`, url: c => `/agents/${c.id}/inbox`, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/inbox`, url: c => `/agents/${c.id}/inbox`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/outbox`, url: c => `/agents/${c.id}/outbox`, expect: { ok: 200 } },
  {
    method: 'POST', path: `${A}/timers`, url: c => `/agents/${c.id}/timers`, body: { mode: 'once_delay', delay_ms: 3_600_000 }, expect: { ok: 200 },
    after: (r, c) => { c.timerId = r.json().id },
  },
  { method: 'GET', path: `${A}/timers`, url: c => `/agents/${c.id}/timers`, expect: { ok: 200 }, after: r => expect(r.json().timers).toHaveLength(1) },
  { method: 'PUT', path: `${A}/timers/{timerId}`, url: c => `/agents/${c.id}/timers/${c.timerId}`, body: { mode: 'once_delay', delay_ms: 7_200_000 }, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/timers/{timerId}`, url: c => `/agents/${c.id}/timers/${c.timerId}`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/meta`, url: c => `/agents/${c.id}/meta`, expect: { ok: 200 } },
  { method: 'PUT', path: `${A}/meta/{key}`, url: c => `/agents/${c.id}/meta/k`, body: { value: '1' }, expect: { ok: 200 } },
  { method: 'PATCH', path: `${A}/meta/{key}/protection`, url: c => `/agents/${c.id}/meta/k/protection`, body: { protection: 'readonly' }, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/meta/{key}`, url: c => `/agents/${c.id}/meta/k`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/usage`, url: c => `/agents/${c.id}/usage`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/tasks`, url: c => `/agents/${c.id}/tasks`, expect: { ok: 200 }, after: r => expect(r.json().tasks[0]).toMatchObject({ status: 'pending_approval', canAlwaysApprove: false }) },
  { method: 'GET', path: `${A}/tasks/{taskId}`, url: c => `/agents/${c.id}/tasks/${c.taskId}`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/tasks/{taskId}/resolve`, url: c => `/agents/${c.id}/tasks/${c.taskId}/resolve`, body: { action: 'approve' }, expect: 'notRunning' },
  { method: 'POST', path: `${A}/tasks/{taskId}/always-approve`, url: c => `/agents/${c.id}/tasks/${c.taskId}/always-approve`, expect: 'notRunning' },
  { method: 'POST', path: `${A}/tasks/approve-all`, url: c => `/agents/${c.id}/tasks/approve-all`, expect: 'notRunning' },
  { method: 'GET', path: `${A}/asks`, url: c => `/agents/${c.id}/asks`, expect: { ok: 200 }, after: r => expect(r.json().asks).toEqual([]) },
  { method: 'POST', path: `${A}/asks/{requestId}/respond`, url: c => `/agents/${c.id}/asks/ask-1/respond`, body: { answer: 'yes' }, expect: 'notRunning' },
  { method: 'POST', path: `${A}/suspend/respond`, url: c => `/agents/${c.id}/suspend/respond`, body: { resume: true }, expect: 'notRunning' },
  { method: 'GET', path: `${A}/context`, url: c => `/agents/${c.id}/context`, expect: { ok: 200 }, after: r => expect(r.json().available).toBe(false) },
  { method: 'GET', path: `${A}/identities`, url: c => `/agents/${c.id}/identities`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/identity`, url: c => `/agents/${c.id}/identity`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/identity/entries`, url: c => `/agents/${c.id}/identity/entries`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/identity/password`, url: c => `/agents/${c.id}/identity/password`, expect: { ok: 200 }, after: r => expect(r.json()).toMatchObject({ needsPassword: false, unlocked: false }) },
  // The password routes on a protected document have their own test below.
  { method: 'POST', path: `${A}/identity/password/unlock`, url: c => `/agents/${c.id}/identity/password/unlock`, body: { password: 'x' }, expect: { ok: 409 }, after: r => expect(r.json().code).toBe('not_password_protected') },
  { method: 'PUT', path: `${A}/identity/password`, url: c => `/agents/${c.id}/identity/password`, body: { password: 'x' }, expect: { ok: 400 } },
  { method: 'DELETE', path: `${A}/identity/password`, url: c => `/agents/${c.id}/identity/password`, expect: { ok: 409 } },
  { method: 'POST', path: `${A}/identity/password/change`, url: c => `/agents/${c.id}/identity/password/change`, body: { newPassword: 'y' }, expect: { ok: 400 } },
  { method: 'GET', path: `${A}/identity/did`, url: c => `/agents/${c.id}/identity/did`, expect: { ok: 200 } },
  { method: 'PUT', path: `${A}/identity/{purpose}`, url: c => `/agents/${c.id}/identity/custom:token`, body: { value: 'secret' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/identity/{purpose}`, url: c => `/agents/${c.id}/identity/custom:token`, expect: { ok: 200 }, after: r => expect(r.json()).toMatchObject({ present: true, length: 6 }) },
  { method: 'PATCH', path: `${A}/identity/{purpose}/code-access`, url: c => `/agents/${c.id}/identity/custom:token/code-access`, body: { codeAccess: true }, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/identity/{purpose}`, url: c => `/agents/${c.id}/identity/custom:token`, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/identity-prefix`, url: c => `/agents/${c.id}/identity-prefix?prefix=custom:`, expect: { ok: 200 } },
  { method: 'PUT', path: `${A}/providers/{providerId}/credential`, url: c => `/agents/${c.id}/providers/custom:ab12/credential`, body: { value: 'k' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/providers/{providerId}/credentials`, url: c => `/agents/${c.id}/providers/custom:ab12/credentials`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/providers`, url: c => `/agents/${c.id}/providers`, body: { provider: { id: 'custom:ab12', type: 'openai-compatible', name: 'Local', baseUrl: 'http://127.0.0.1:1/v1' } }, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/providers/{providerId}`, url: c => `/agents/${c.id}/providers/custom:ab12`, expect: { ok: 200 } },
  { method: 'PUT', path: `${A}/mcp/credentials`, url: c => `/agents/${c.id}/mcp/credentials`, body: { npmPackage: '@acme/server', envKey: 'TOKEN', value: 'v' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/mcp/credentials`, url: c => `/agents/${c.id}/mcp/credentials?npmPackage=@acme/server`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/mcp/servers`, url: c => `/agents/${c.id}/mcp/servers`, body: { server: { name: 'fs', transport: 'stdio', command: 'node' } }, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/mcp/servers/{serverName}/restart`, url: c => `/agents/${c.id}/mcp/servers/fs/restart`, expect: 'notRunning' },
  { method: 'DELETE', path: `${A}/mcp/servers/{serverName}`, url: c => `/agents/${c.id}/mcp/servers/fs`, expect: { ok: 200 } },
  { method: 'PUT', path: `${A}/adapters/credentials`, url: c => `/agents/${c.id}/adapters/credentials`, body: { adapterType: 'telegram', envKey: 'TOKEN', value: 'v' }, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/adapters/credentials`, url: c => `/agents/${c.id}/adapters/credentials?adapterType=telegram`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/adapters`, url: c => `/agents/${c.id}/adapters`, body: { adapterType: 'telegram', config: { enabled: false } }, expect: { ok: 200 } },
  { method: 'DELETE', path: `${A}/adapters/{adapterType}`, url: c => `/agents/${c.id}/adapters/telegram`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/runtime`, url: c => `/agents/${c.id}/runtime`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/runtime/adapters`, url: c => `/agents/${c.id}/runtime/adapters`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/runtime/mcp`, url: c => `/agents/${c.id}/runtime/mcp`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/runtime/triggers`, url: c => `/agents/${c.id}/runtime/triggers`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/runtime/ws`, url: c => `/agents/${c.id}/runtime/ws`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/adapters`, url: c => `/agents/${c.id}/adapters`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/mcp`, url: c => `/agents/${c.id}/mcp`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/triggers`, url: c => `/agents/${c.id}/triggers`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/ws`, url: c => `/agents/${c.id}/ws`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/vitals`, url: c => `/agents/${c.id}/vitals`, expect: { ok: 200 } },
  { method: 'GET', path: `${A}/activity`, url: c => `/agents/${c.id}/activity`, expect: { ok: 200 } },
  // Owner-identity routes: this daemon has no owner identity, so they answer 503 after finding the document.
  { method: 'GET', path: `${A}/attestations`, url: c => `/agents/${c.id}/attestations`, expect: 'reached' },
  { method: 'POST', path: `${A}/attestations/reissue`, url: c => `/agents/${c.id}/attestations/reissue`, expect: 'reached' },
  { method: 'GET', path: `${A}/envelope`, url: c => `/agents/${c.id}/envelope`, expect: 'reached' },
  { method: 'PUT', path: `${A}/envelope/share-password`, url: c => `/agents/${c.id}/envelope/share-password`, body: { password: 'share-pw-1' }, expect: 'reached' },
  { method: 'DELETE', path: `${A}/envelope/share-password`, url: c => `/agents/${c.id}/envelope/share-password`, expect: 'reached' },
  { method: 'POST', path: `${A}/envelope/unlock-password`, url: c => `/agents/${c.id}/envelope/unlock-password`, body: { password: 'share-pw-1' }, expect: 'reached' },
  { method: 'POST', path: `${A}/claim`, url: c => `/agents/${c.id}/claim`, expect: 'reached' },
  { method: 'POST', path: `${A}/identity/generate-keys`, url: c => `/agents/${c.id}/identity/generate-keys`, expect: { ok: 200 } },
  // Runtime actions.
  { method: 'POST', path: `${A}/abort`, url: c => `/agents/${c.id}/abort`, expect: 'notRunning' },
  { method: 'POST', path: `${A}/interrupt`, url: c => `/agents/${c.id}/interrupt`, expect: 'notRunning' },
  { method: 'POST', path: `${A}/compact`, url: c => `/agents/${c.id}/compact`, expect: 'notRunning' },
  { method: 'POST', path: `${A}/trigger`, url: c => `/agents/${c.id}/trigger`, body: { type: 'startup' }, expect: 'notRunning' },
  // Stop and unload of a document that is not running: nothing to stop, it stays open.
  { method: 'POST', path: `${A}/stop`, url: c => `/agents/${c.id}/stop`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/unload`, url: c => `/agents/${c.id}/unload`, expect: { ok: 200 } },
  { method: 'POST', path: `${A}/identity/wipe`, url: c => `/agents/${c.id}/identity/wipe`, expect: { ok: 200 } },
]

/** Covered by the lifecycle tests below (start changes what the rest of the table sees). */
const LIFECYCLE_ROUTES = new Set([`POST ${A}/start`])

let docConfig: AgentConfig

describe('open documents: every /agents/:id route on an open, not-running document', () => {
  it('the table covers every /agents/{id} route of the API contract', () => {
    const documented: string[] = []
    for (const [path, ops] of Object.entries((spec as { paths: Record<string, Record<string, unknown>> }).paths)) {
      if (path !== A && !path.startsWith(`${A}/`)) continue
      for (const method of Object.keys(ops)) documented.push(`${method.toUpperCase()} ${path}`)
    }
    const tabled = new Set([...ROUTES.map(r => `${r.method} ${r.path}`), ...LIFECYCLE_ROUTES])
    expect(documented.filter(r => !tabled.has(r))).toEqual([])
    expect([...tabled].filter(r => !documented.includes(r))).toEqual([])
  })

  it('answers each route as the table says, without starting anything', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const seed = AdfWorkspace.open(filePath)
    seed.insertTask('task-1', 'fs_write', '{}')
    seed.updateTaskStatus('task-1', 'pending_approval')
    seed.close()
    const { runtime, server } = setup({ settings: { trackedDirectories: [dir] } })
    const loaded: string[] = []
    runtime.on('agent-loaded', e => loaded.push(e.agentId))

    const info = await runtime.openDocument(filePath, { holder: 'session-1' })
    expect(info).toMatchObject({ agentId, filePath, running: false, needsPassword: false, holders: 1 })
    docConfig = runtime.getAgentConfig(agentId).config

    const ctx: Ctx = { id: agentId, q: encodeURIComponent(filePath), taskId: 'task-1' }
    const problems: string[] = []
    for (const route of ROUTES) {
      const url = route.url(ctx)
      const body = typeof route.body === 'function' ? (route.body as (c: Ctx) => unknown)(ctx) : route.body
      const res = await server.inject({
        method: route.method,
        url,
        ...(route.raw ? { payload: route.raw, headers: { 'content-type': 'application/octet-stream' } } : body !== undefined ? { payload: body as object } : {}),
      })
      const json = () => JSON.parse(res.body)
      const label = `${route.method} ${url} → ${res.statusCode} ${res.body.slice(0, 160)}`
      if (route.expect === 'notRunning') {
        if (res.statusCode !== 409 || json().code !== 'agent_not_running') problems.push(`expected 409 agent_not_running: ${label}`)
      } else if (route.expect === 'reached') {
        const unknown = res.statusCode === 404 && /Unknown agent/.test(res.body)
        if (unknown || (res.statusCode >= 500 && res.statusCode !== 503)) problems.push(`expected the route to reach the document: ${label}`)
      } else if (res.statusCode !== route.expect.ok) {
        problems.push(`expected ${route.expect.ok}: ${label}`)
      } else if (route.after) {
        try { route.after({ statusCode: res.statusCode, json, body: res.body }, ctx) } catch (err) { problems.push(`${label}: ${(err as Error).message}`) }
      }
    }
    expect(problems).toEqual([])
    // Nothing ran: no agent was loaded, the document is still open and not running.
    expect(loaded).toEqual([])
    expect(runtime.listAgents()).toEqual([])
    expect(runtime.getOpenDocument(agentId)).toMatchObject({ running: false, holders: 1 })
  })

  it('pages chat history by seq (keyset, Studio\'s DOC_GET_CHAT_OLDER)', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const seed = AdfWorkspace.open(filePath)
    for (let i = 0; i < 5; i++) {
      seed.appendToLoop(i % 2 ? 'assistant' : 'user', [{ type: 'text', text: `m${i}` }])
    }
    const total = seed.getLoopCount()
    const seqs = seed.getLoop().map(e => e.seq)
    seed.close()
    const { runtime, server } = setup()
    await runtime.openDocument(filePath, { holder: 'session-1' })
    expect(total).toBe(5)
    const res = await server.inject({ method: 'GET', url: `/agents/${agentId}/chat?before=${seqs[seqs.length - 1]}&limit=2` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ agentId, loop: 'main', earlierCount: Math.max(0, total - 3) })
    expect(res.json().uiLog.length).toBeGreaterThan(0)
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/chat?before=x` })).statusCode).toBe(400)
  })
})

describe('open documents: lifecycle', () => {
  it('start assembles on the open workspace; stop keeps it open while held; the last release closes it', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime, server } = setup()
    const events: RuntimeDocumentEvent[] = []
    runtime.on('document-closed', e => events.push(e))
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const workspace = runtime.getAgentWorkspace(agentId)!.workspace

    const started = await server.inject({ method: 'POST', url: `/agents/${agentId}/start` })
    expect(started.statusCode).toBe(200)
    expect(started.json()).toMatchObject({ success: true, loaded: true })
    // One handle on the file: the runtime runs on the document's workspace.
    expect(runtime.getLoadedAgent(agentId)!.workspace).toBe(workspace)
    expect(runtime.getOpenDocument(agentId)).toMatchObject({ running: true })
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}` })).json().running).toBe(true)

    expect((await server.inject({ method: 'POST', url: `/agents/${agentId}/stop` })).statusCode).toBe(200)
    expect(runtime.listAgents()).toEqual([])
    expect(runtime.getOpenDocument(agentId)).toMatchObject({ running: false, holders: 1 })
    // Same workspace, still open and usable.
    expect(runtime.getAgentWorkspace(agentId)!.workspace).toBe(workspace)
    const doc = await server.inject({ method: 'PUT', url: `/agents/${agentId}/document`, payload: { content: 'after stop' } })
    expect(doc.statusCode).toBe(200)
    expect(workspace.readDocument()).toBe('after stop')

    // Start again on the same document, then release while it runs: the runtime keeps the workspace.
    await runtime.startOrLoadAgent(agentId)
    expect(runtime.getLoadedAgent(agentId)!.workspace).toBe(workspace)
    const released = await runtime.releaseDocument(agentId, 'session-1')
    expect(released).toMatchObject({ released: true, closed: false })
    expect(runtime.getOpenDocument(agentId)).toBeUndefined()
    expect(runtime.getAgent(agentId)).toBeDefined()
    await runtime.stopAgent(agentId)
    // The runtime owned the workspace once released: the stop closed it.
    expect(() => workspace.readDocument()).toThrow()
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/document` })).statusCode).toBe(404)
    expect(events.map(e => e.reason)).toEqual(['released'])
  })

  it('a document whose agent is running joins the runtime\'s workspace; release hands it back', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime } = setup()
    await runtime.loadAgent(filePath)
    const workspace = runtime.getLoadedAgent(agentId)!.workspace
    const info = await runtime.openDocument(filePath, { holder: 'session-1' })
    expect(info).toMatchObject({ running: true, holders: 1 })
    expect(runtime.getAgentWorkspace(agentId)!.workspace).toBe(workspace)
    await runtime.stopAgent(agentId)
    expect(workspace.readDocument()).toEqual(expect.any(String)) // kept open for the holder
    expect((await runtime.releaseDocument(agentId, 'session-1')).closed).toBe(true)
    expect(() => workspace.readDocument()).toThrow()
  })

  it('a session\'s expiry releases every document it holds (W2-B hook); other sessions keep theirs', async () => {
    const dir = tempDir()
    const one = seedAgent(dir, 'agent-1')
    const two = seedAgent(dir, 'agent-2')
    const { runtime, server } = setup()
    const sessions = new FakeClientSessions(runtime)
    await sessions.hold('session-1', one.filePath)
    await sessions.hold('session-1', two.filePath)
    await sessions.hold('session-2', two.filePath)
    expect(runtime.documentHolders(two.agentId).sort()).toEqual(['session-1', 'session-2'])

    expect((await sessions.expire('session-1')).sort()).toEqual([one.agentId, two.agentId].sort())
    expect(runtime.getOpenDocument(one.agentId)).toBeUndefined()
    expect(runtime.getOpenDocument(two.agentId)).toMatchObject({ holders: 1 })
    expect((await server.inject({ method: 'GET', url: `/agents/${one.agentId}/config` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: `/agents/${two.agentId}/config` })).statusCode).toBe(200)

    await sessions.expire('session-2')
    expect(runtime.listOpenDocuments()).toEqual([])
    // Expiring an unknown session is a no-op.
    expect(await sessions.expire('session-3')).toEqual([])
  })

  it('refuses a second file with an open document\'s config id (409 duplicate_agent_id, both paths)', async () => {
    const dir = tempDir()
    const one = seedAgent(dir, 'agent-1')
    const copy = join(tempDir(), 'agent-1.adf')
    const ws = AdfWorkspace.open(one.filePath)
    ws.checkpoint()
    ws.close()
    const { copyFileSync } = await import('node:fs')
    copyFileSync(one.filePath, copy)
    const { runtime } = setup()
    await runtime.openDocument(one.filePath, { holder: 'session-1' })
    await expect(runtime.openDocument(copy, { holder: 'session-1' })).rejects.toMatchObject({ statusCode: 409, code: 'duplicate_agent_id', details: { filePath: realpathSync.native(copy), loadedFilePath: one.filePath } })
    await expect(runtime.loadAgent(copy)).rejects.toMatchObject({ code: 'duplicate_agent_id' })
  })
})

describe('open documents: invisible to mesh, timers and autostart', () => {
  it('opening registers nothing and runs nothing: no agent-loaded (the mesh registers on it), no timer turn', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime, server } = setup()
    const loaded: string[] = []
    const agentEvents: string[] = []
    runtime.on('agent-loaded', e => loaded.push(e.agentId))
    runtime.on('agent-event', e => agentEvents.push(e.event.type))
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const before = runtime.getAgentWorkspace(agentId)!.workspace.getLoopCount()
    const timer = await server.inject({ method: 'POST', url: `/agents/${agentId}/timers`, payload: { mode: 'once_delay', delay_ms: 30 } })
    expect(timer.statusCode).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    expect(loaded).toEqual([])
    expect(agentEvents).toEqual([])
    expect(runtime.listAgents()).toEqual([])
    expect(runtime.listLiveAgents()).toEqual([])
    expect((await server.inject({ method: 'GET', url: '/agents' })).json()).toEqual([])
    const ws = runtime.getAgentWorkspace(agentId)!.workspace
    expect(ws.getLoopCount()).toBe(before)
    expect(ws.getTimers()).toHaveLength(1) // not consumed: no scheduler runs
  })

  it('autostart does not count an open document as loaded: it starts the agent on the document\'s workspace', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const ws = AdfWorkspace.open(filePath)
    ws.setAgentConfig({ ...ws.getAgentConfig(), autostart: true })
    ws.close()
    const { runtime } = setup({ settings: { reviewedAgents: { [agentId]: 'accepted' } } })
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const workspace = runtime.getAgentWorkspace(agentId)!.workspace
    const report = await runtime.autostartFromDirectories([dir])
    expect(report.skipped).toEqual([])
    expect(report.started.map(s => s.agentId)).toEqual([agentId])
    expect(runtime.getLoadedAgent(agentId)!.workspace).toBe(workspace)
  })
})

describe('open documents: leases', () => {
  it('an open document takes no lease; a start on it does; stop releases it and the document stays open', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime } = setup()
    const leases = processAgentLeases()
    await runtime.openDocument(filePath, { holder: 'session-1' })
    expect(await leases.isHeld(filePath)).toBe(false)
    await runtime.startOrLoadAgent(agentId)
    expect(await leases.isHeld(filePath)).toBe(true)
    await runtime.stopAgent(agentId)
    expect(await leases.isHeld(filePath)).toBe(false)
    expect(runtime.getOpenDocument(agentId)).toBeDefined()
  })

  it('refuses writes through an open document while another runtime runs the file (409 agent_leased); reads work', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const other = new AgentLeaseRegistry({ dir: processAgentLeases().dir, kind: 'studio-embedded', settingsPath: join(dir, 'other-settings.json') })
    expect((await other.acquire(filePath, { agentId })).ok).toBe(true)
    cleanups.push(() => other.close())
    const { runtime, server } = setup()
    // Opening is not running: it is not refused (embedded Studio opens such a file too).
    await runtime.openDocument(filePath, { holder: 'session-1' })
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/document` })).statusCode).toBe(200)
    const put = await server.inject({ method: 'PUT', url: `/agents/${agentId}/document`, payload: { content: 'x' } })
    expect(put.statusCode).toBe(409)
    expect(put.json().code).toBe('agent_leased')
    const config = await server.inject({ method: 'PUT', url: `/agents/${agentId}/config`, payload: runtime.getAgentConfig(agentId).config as object })
    expect(config.json().code).toBe('agent_leased')
    // Starting it here is the lease's own refusal.
    const start = await server.inject({ method: 'POST', url: `/agents/${agentId}/start` })
    expect(start.statusCode).toBe(409)
    expect(start.json().code).toBe('agent_leased')
    expect(runtime.getOpenDocument(agentId)).toMatchObject({ running: false })
  })
})

describe('open documents: config written while the agent starts (pickFresherConfig race)', () => {
  it('a config write through the document during the start window reaches the running agent', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let calls = 0
    const { runtime, server } = setup({
      runtime: {
        providerFactory: async (): Promise<LLMProvider> => {
          calls++
          if (calls === 1) await gate // the start's provider: hold the build open
          return new MockLLMProvider()
        },
      },
    })
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const starting = server.inject({ method: 'POST', url: `/agents/${agentId}/start` })
    await waitFor(() => calls >= 1)
    // The start is building: the route reaches the document, and the write lands in the file.
    const config = runtime.getAgentConfig(agentId).config
    const put = await server.inject({ method: 'PUT', url: `/agents/${agentId}/config`, payload: { ...config, instructions: 'Written while starting.' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().renameDeferred).toBeUndefined()
    release()
    expect((await starting).statusCode).toBe(200)
    expect(runtime.getAgentConfig(agentId).config.instructions).toBe('Written while starting.')
    expect(runtime.getLoadedAgent(agentId)!.agent.executor.getConfig().instructions).toBe('Written while starting.')
  })
})

describe('open documents: password-protected files (D3 derived-key cache)', () => {
  function protectedAgent(dir: string, name: string) {
    const seeded = seedAgent(dir, name)
    const ws = AdfWorkspace.open(seeded.filePath)
    ws.setIdentity('custom:secret', 'hunter2')
    ws.setPassword('pw-1')
    ws.close()
    return seeded
  }

  it('opens locked, unlocks once, and keeps the key across stop and start; the same session reopens without a prompt', async () => {
    const dir = tempDir()
    const { filePath, agentId } = protectedAgent(dir, 'agent-1')
    const { runtime, server } = setup()
    expect(await runtime.openDocument(filePath, { holder: 'session-1' })).toMatchObject({ needsPassword: true })
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/identity/password` })).json()).toMatchObject({ needsPassword: true, unlocked: false })
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/identity/custom:secret` })).json()).toMatchObject({ storage: 'password', locked: true })
    const wrong = await server.inject({ method: 'POST', url: `/agents/${agentId}/identity/password/unlock`, payload: { password: 'nope' } })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().code).toBe('wrong_password')

    const unlock = await server.inject({ method: 'POST', url: `/agents/${agentId}/identity/password/unlock`, payload: { password: 'pw-1' } })
    expect(unlock.statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/identity/custom:secret` })).json()).toMatchObject({ locked: false, length: 7 })

    // Start: the runtime gets the key the document holds (Studio's captured key).
    await runtime.startOrLoadAgent(agentId)
    expect(runtime.getLoadedAgent(agentId)!.derivedKey).not.toBeNull()
    await runtime.stopAgent(agentId)
    // Stop keeps it: no prompt for the next start.
    expect(runtime.getOpenDocument(agentId)).toMatchObject({ needsPassword: false })

    // Close and reopen in the same session: the remembered key opens it.
    await runtime.releaseDocument(agentId, 'session-1')
    expect(runtime.getOpenDocument(agentId)).toBeUndefined()
    expect(await runtime.openDocument(filePath, { holder: 'session-1' })).toMatchObject({ needsPassword: false })
    // Another session never unlocked it... but the document is open and unlocked: it shares it.
    expect(await runtime.openDocument(filePath, { holder: 'session-2' })).toMatchObject({ needsPassword: false })
    await runtime.releaseDocumentHolder('session-1')
    await runtime.releaseDocumentHolder('session-2')
    // Session 2 held it when it was unlocked: it remembers the key; a new session 3 is prompted.
    expect(await runtime.openDocument(filePath, { holder: 'session-3' })).toMatchObject({ needsPassword: true })
  })

  it('session expiry forgets the keys it unlocked', async () => {
    const dir = tempDir()
    const { filePath, agentId } = protectedAgent(dir, 'agent-1')
    const { runtime } = setup()
    await runtime.openDocument(filePath, { holder: 'session-1' })
    runtime.unlockAgentIdentityPassword(agentId, 'pw-1')
    await runtime.releaseDocumentHolder('session-1')
    expect(await runtime.openDocument(filePath, { holder: 'session-1' })).toMatchObject({ needsPassword: true })
  })
})

describe('open documents: file operations keep one handle', () => {
  it('a name change through the document renames its file now (Studio\'s DOC_SET_AGENT_CONFIG), and the document follows', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime, server } = setup({ settings: { trackedDirectories: [dir] } })
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const config = runtime.getAgentConfig(agentId).config
    const res = await server.inject({ method: 'PUT', url: `/agents/${agentId}/config`, payload: { ...config, name: 'agent-2' } })
    expect(res.statusCode).toBe(200)
    const moved = join(dir, 'agent-2.adf')
    expect(res.json().filePath).toBe(moved)
    expect(existsSync(filePath)).toBe(false)
    expect(runtime.getOpenDocument(agentId)).toMatchObject({ filePath: moved, name: 'agent-2' })
    expect((await server.inject({ method: 'GET', url: `/agents/${agentId}/document` })).statusCode).toBe(200)
  })

  it('DELETE /files closes the open document first', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime, server } = setup({ settings: { trackedDirectories: [dir] } })
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const res = await server.inject({ method: 'DELETE', url: `/files?path=${encodeURIComponent(filePath)}` })
    expect(res.statusCode).toBe(200)
    expect(existsSync(filePath)).toBe(false)
    expect(runtime.getOpenDocument(agentId)).toBeUndefined()
  })

  it('path-addressed credential writes reach the open document\'s workspace and its unlocked key', async () => {
    const dir = tempDir()
    const { filePath, agentId } = seedAgent(dir, 'agent-1')
    const { runtime, server } = setup({ settings: { trackedDirectories: [dir] } })
    await runtime.openDocument(filePath, { holder: 'session-1' })
    const res = await server.inject({
      method: 'PUT',
      url: `/files/agent/providers/custom:ab12/credential?path=${encodeURIComponent(filePath)}`,
      payload: { value: 'secret-key' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ agentId, loaded: true })
    expect(runtime.readAgentProviderApiKey(agentId, 'custom:ab12')).toBe('secret-key')
  })
})
