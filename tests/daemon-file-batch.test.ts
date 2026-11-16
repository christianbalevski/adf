/**
 * POST /agents/:id/files/batch on a real daemon (RuntimeService + HTTP API):
 * the atomic multi-file write behind skill installs, its refusals, its body
 * bound, and Studio's daemon-mode DOC_WRITE_INTERNAL_FILES handler, whose
 * request names the agent it resolved before any await.
 */
import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-file-batch-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-file-batch', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { FILE_BATCH_BODY_LIMIT } from '../src/main/runtime/file-batch'
import { FILE_BATCH_MAX_BYTES, FILE_BATCH_MAX_FILES, isMissingBatchRoute } from '../src/shared/utils/file-batch'
import { VFS_PATH_MAX_LENGTH } from '../src/shared/utils/vfs-path'
import { DaemonClient, DaemonError } from '../src/shared/daemon-client'
import { IPC } from '../src/shared/constants/ipc-channels'
import { createStudioDaemonClient } from '../src/main/backend/daemon-mode/credentials'
import { findRunningAgent, type DaemonModeContext } from '../src/main/backend/daemon-mode/context'
import { DaemonModeSession } from '../src/main/backend/daemon-mode/session'
import { DOC_HANDLERS } from '../src/main/backend/daemon-mode/documents/doc-handlers'
import { createFakeClientSession } from './backend/daemon-mode-fakes'

afterAll(() => clearAllUmbilicalBuses())
vi.setConfig({ testTimeout: 30_000 })

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

function agentFile(dir: string, name: string): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  const agentId = created.workspace.getAgentConfig().id
  created.dispose()
  return { filePath, agentId }
}

async function daemon() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-file-batch-'))
  const one = agentFile(dir, 'agent-1')
  const two = agentFile(dir, 'agent-2')
  const runtime = new RuntimeService({
    settings: { get: (k: string) => (k === 'reviewedAgents' ? [one.agentId, two.agentId] : undefined) },
    providerFactory: () => new MockLLMProvider(),
    agentRuntimeBuilder: new AgentRuntimeBuilder(),
  })
  cleanups.push(async () => { for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' }).catch(() => {}) })
  const server = createDaemonHttpApi(runtime, {})
  await server.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => server.close())
  const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
  await runtime.loadAgent(one.filePath)
  await runtime.loadAgent(two.filePath)
  return { runtime, baseUrl, client: new DaemonClient({ baseUrl }), one, two }
}

async function refused(write: Promise<unknown>): Promise<{ status: number | null; body: Record<string, unknown> }> {
  try {
    await write
  } catch (err) {
    if (err instanceof DaemonError) return { status: err.status, body: err.body as Record<string, unknown> }
    throw err
  }
  throw new Error('not refused')
}

describe('POST /agents/:id/files/batch', () => {
  it('writes all files of a running agent; refusals name the path and write nothing', async () => {
    const { client, one } = await daemon()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255])
    const ok = await client.writeFiles(one.agentId, [
      { path: 'skills/a/ref.md', content: 'r1', mustNotExist: true },
      { path: 'skills/a/logo.png', contentBase64: png.toString('base64'), mustNotExist: true },
      { path: 'skills/a/SKILL.md', content: '---\nname: a\ndescription: d\n---\n', mustNotExist: true },
    ])
    expect(Object.keys(ok.revisions)).toEqual(['skills/a/ref.md', 'skills/a/logo.png', 'skills/a/SKILL.md'])
    const logo = await client.file(one.agentId, 'skills/a/logo.png')
    expect(Buffer.from(logo.content_base64!, 'base64').equals(png)).toBe(true)

    // An existing path under mustNotExist: 409, nothing else written.
    const exists = await refused(client.writeFiles(one.agentId, [{ path: 'skills/a/new.md', content: 'n', mustNotExist: true }, { path: 'skills/a/SKILL.md', content: 'x', mustNotExist: true }]))
    expect(exists).toMatchObject({ status: 409, body: { code: 'stale_revision', path: 'skills/a/SKILL.md' } })
    expect((await client.files(one.agentId)).files.some((f) => f.path === 'skills/a/new.md')).toBe(false)

    // A stale base: 409. The current one: written.
    const stale = await refused(client.writeFiles(one.agentId, [{ path: 'skills/a/ref.md', content: 'r2', baseRevision: 1 }]))
    expect(stale).toMatchObject({ status: 409, body: { code: 'stale_revision', path: 'skills/a/ref.md', revision: ok.revisions['skills/a/ref.md'] } })
    await client.writeFiles(one.agentId, [{ path: 'skills/a/ref.md', content: 'r2', baseRevision: ok.revisions['skills/a/ref.md'] }])
    expect((await client.file(one.agentId, 'skills/a/ref.md')).content).toBe('r2')

    // Read-only: 403 file_protected.
    await client.request('PATCH', `/agents/${one.agentId}/files/protection`, { body: { path: 'skills/a/ref.md', protection: 'read_only' } })
    const rev = (await client.file(one.agentId, 'skills/a/ref.md')).revision
    expect(await refused(client.writeFiles(one.agentId, [{ path: 'skills/a/ref.md', content: 'r3', baseRevision: rev }]))).toMatchObject({ status: 403, body: { code: 'file_protected', path: 'skills/a/ref.md' } })

    // Malformed: 400.
    expect(await refused(client.writeFiles(one.agentId, [{ path: '../escape.md', content: 'x', mustNotExist: true }]))).toMatchObject({ status: 400, body: { code: 'bad_request' } })
    expect(await refused(client.writeFiles(one.agentId, [{ path: 'skills/a/x.md', content: 'x' }]))).toMatchObject({ status: 400, body: { code: 'bad_request' } })
    expect(await refused(client.request('POST', `/agents/${one.agentId}/files/batch`, { body: {} }))).toMatchObject({ status: 400 })
    expect(await refused(client.writeFiles('nobody', [{ path: 'x.md', content: 'x', mustNotExist: true }]))).toMatchObject({ status: 404 })
  })

  it('accepts maximum escaped text and Unicode paths together, and still refuses excess decoded bytes', async () => {
    const { client, one } = await daemon()
    const content = '\u0001'.repeat(FILE_BATCH_MAX_BYTES)
    const files = Array.from({ length: FILE_BATCH_MAX_FILES }, (_, i) => ({
      path: '漢'.repeat(VFS_PATH_MAX_LENGTH - 3) + String(i).padStart(3, '0'),
      content: i === 0 ? content : '',
      mustNotExist: true,
    }))
    const result = await client.writeFiles(one.agentId, files)
    expect(Object.keys(result.revisions)).toHaveLength(FILE_BATCH_MAX_FILES)
    const meta = await client.fileMeta(one.agentId, files[0].path, true)
    expect(meta).toMatchObject({ size: FILE_BATCH_MAX_BYTES, revision: result.revisions[files[0].path] })
    expect(meta).not.toHaveProperty('content')
    expect(meta).not.toHaveProperty('content_base64')
    const over = await refused(client.writeFiles(one.agentId, [{ path: 'over.bin', content: 'x'.repeat(FILE_BATCH_MAX_BYTES + 1), mustNotExist: true }]))
    expect(over).toMatchObject({ status: 400, body: { code: 'payload_too_large' } })
    expect((await client.files(one.agentId)).files.some((f) => f.path === 'over.bin')).toBe(false)
  })

  it('the body bound covers 8 MiB of content as base64; past it the request is refused unread', async () => {
    const { baseUrl, one, client } = await daemon()
    // 8 MiB of content, as one base64 file: accepted.
    const exact = Buffer.alloc(8 * 1024 * 1024, 7)
    await client.writeFiles(one.agentId, [{ path: 'big/exact.bin', contentBase64: exact.toString('base64'), mustNotExist: true }])
    expect((await client.files(one.agentId)).files.find((f) => f.path === 'big/exact.bin')?.size).toBe(exact.length)
    // A body declared over the route's limit: 413 from the HTTP layer before
    // any of it is read. The request sends headers only — the server answers
    // and closes without reading, so streaming a real body here races its close
    // (EPIPE on macOS CI). A route waiting for the body fails the timeout.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${baseUrl}/agents/${one.agentId}/files/batch`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(FILE_BATCH_BODY_LIMIT + 1) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy() })
      req.on('error', reject)
      req.setTimeout(5000, () => req.destroy(new Error('no answer within 5s: the route is waiting for a body past its limit')))
      req.flushHeaders()
    })
    expect(status).toBe(413)
  })
})

describe("Studio daemon mode: DOC_WRITE_INTERNAL_FILES", () => {
  async function studio() {
    const d = await daemon()
    const { sessionId } = await d.client.createClientSession({ client: 'studio', version: '1' })
    const studioClient = createStudioDaemonClient({ baseUrl: d.baseUrl, source: { token: () => undefined } }).withClientSession(sessionId)
    const fake = createFakeClientSession((filePath) => (filePath === d.one.filePath ? d.one.agentId : filePath === d.two.filePath ? d.two.agentId : null))
    fake.holdsAvailable = true
    const session = new DaemonModeSession(fake, { log: () => {}, warn: () => {}, error: () => {} })
    let beforeReady: (() => Promise<void>) | null = null
    const ctx = {
      mode: 'local',
      session,
      ready: async () => { const hook = beforeReady; beforeReady = null; if (hook) await hook(); return studioClient },
      runningAgentAt: (filePath: string) => findRunningAgent(studioClient, filePath),
      raw: async (path: string, query?: Record<string, string | number | undefined>) => fetch(studioClient.url(path, query), { headers: studioClient.headers({ Accept: '*/*' }) }),
      log: { log: () => {}, warn: () => {}, error: () => {} },
    } as unknown as DaemonModeContext
    await session.openFile(d.one.filePath, async () => null)
    const ipc = (channel: string, ...args: unknown[]) => Promise.resolve(DOC_HANDLERS[channel as keyof typeof DOC_HANDLERS]!(ctx, {} as never, ...args)) as Promise<any>
    return { ...d, session, ipc, onReady: (fn: () => Promise<void>) => { beforeReady = fn } }
  }

  it('writes to the open agent; a batch naming another file writes nothing', async () => {
    const { ipc, one, client } = await studio()
    const ok = await ipc(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: one.filePath, files: [{ path: 'skills/a/SKILL.md', content: 'm', mustNotExist: true }] })
    expect(ok).toMatchObject({ success: true, revisions: { 'skills/a/SKILL.md': expect.any(Number) } })
    const wrong = await ipc(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: '/elsewhere/agent.adf', files: [{ path: 'skills/b/SKILL.md', content: 'm', mustNotExist: true }] })
    expect(wrong).toEqual({ success: false, code: 'agent_changed', error: 'The open agent changed — nothing was written.' })
    expect((await client.files(one.agentId)).files.some((f) => f.path === 'skills/b/SKILL.md')).toBe(false)
    const stale = await ipc(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: one.filePath, files: [{ path: 'skills/a/SKILL.md', content: 'x', mustNotExist: true }] })
    expect(stale).toMatchObject({ success: false, code: 'stale_revision', path: 'skills/a/SKILL.md' })
  })

  it('an older daemon (no batch route) is named as version skew; an unknown agent is not mistaken for it', async () => {
    const { ipc, one, client } = await studio()
    // The real answers of a real daemon: its framework's 404 for a route it does not have,
    // and its own 404 for an agent it does not know.
    const missing = await client.request('POST', `/agents/${one.agentId}/files/batch-from-a-newer-client`, { body: { files: [] } }).catch((err: unknown) => err)
    const unknown = await client.request('POST', '/agents/nobody/files/batch', { body: { files: [] } }).catch((err: unknown) => err)
    expect(isMissingBatchRoute(missing)).toBe(true)
    expect(isMissingBatchRoute(unknown)).toBe(false)
    const real = DaemonClient.prototype.request
    DaemonClient.prototype.request = async function (this: DaemonClient, ...args: Parameters<typeof real>) {
      if (args[0] === 'POST' && String(args[1]).endsWith('/files/batch')) throw missing
      return real.apply(this, args)
    } as typeof real
    try {
      expect(await ipc(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: one.filePath, files: [{ path: 'skills/a/SKILL.md', content: 'm', mustNotExist: true }] }))
        .toEqual({ success: false, code: 'runtime_outdated', error: 'This ADF runtime predates atomic skill installs; update it.' })
    } finally {
      DaemonClient.prototype.request = real
    }
    expect((await client.files(one.agentId)).files.some((f) => f.path === 'skills/a/SKILL.md')).toBe(false)
  })

  it('a switch while the request is in flight cannot retarget it: the agent resolved first gets the write, the new one nothing', async () => {
    const { ipc, one, two, session, onReady, client } = await studio()
    onReady(async () => { await session.openFile(two.filePath, async () => null) })
    const ok = await ipc(IPC.DOC_WRITE_INTERNAL_FILES, { expectFilePath: one.filePath, files: [{ path: 'skills/race/SKILL.md', content: 'm', mustNotExist: true }] })
    expect(ok).toMatchObject({ success: true })
    expect(session.filePath).toBe(two.filePath)
    expect((await client.files(one.agentId)).files.some((f) => f.path === 'skills/race/SKILL.md')).toBe(true)
    expect((await client.files(two.agentId)).files.some((f) => f.path === 'skills/race/SKILL.md')).toBe(false)
  })
})
