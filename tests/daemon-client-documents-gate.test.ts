/**
 * MERGE GATE (W2-A × W2-B): open documents held by client sessions, in the
 * daemon's own wiring (wireRuntimeToClientSessions + wireDocumentsToClientSessions,
 * as daemon/index.ts calls them). A live session's document outlives the
 * holder TTL; a holder that is not a session is swept; the session's expiry
 * releases its documents.
 */
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-client-documents-gate-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-client-documents-gate', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s, 'utf-8'), decryptString: (b: Buffer) => b.toString('utf-8') },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { ClientSessionRegistry, wireDocumentsToClientSessions, wireRuntimeToClientSessions } from '../src/main/daemon/client-sessions'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { DaemonClient } from '../src/shared/daemon-client'

afterAll(() => clearAllUmbilicalBuses())
vi.setConfig({ testTimeout: 30_000 })

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function waitFor(check: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

function agentFile(dir: string, name: string): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  const agentId = created.workspace.getAgentConfig().id
  created.dispose()
  return { filePath, agentId }
}

describe('MERGE GATE: session-held documents in the daemon wiring', () => {
  it('a live session keeps its document past the holder TTL; its expiry releases it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-documents-gate-'))
    const one = agentFile(dir, 'agent-1')
    const two = agentFile(dir, 'agent-2')
    const ttlMs = 300 // shortened from 60 s
    const runtime = new RuntimeService({
      settings: { get: (k: string) => (k === 'reviewedAgents' ? [one.agentId, two.agentId] : undefined) },
      providerFactory: () => new MockLLMProvider(),
      agentRuntimeBuilder: new AgentRuntimeBuilder(),
      documentHoldTtlMs: ttlMs,
    })
    const sessions = new ClientSessionRegistry({ expiryMs: 500, log: () => {} })
    cleanups.push(wireRuntimeToClientSessions(sessions, runtime), wireDocumentsToClientSessions(sessions, runtime))
    const server = createDaemonHttpApi(runtime, { routes: { clientSessions: sessions } })
    await server.listen({ host: '127.0.0.1', port: 0 })
    cleanups.push(() => server.close())
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}` })

    const { sessionId } = await client.createClientSession({ client: 'studio', version: 'test' })
    let open = false
    const stream = client.clientSessionEvents(sessionId, { onEvent: () => {}, onState: s => { if (s.state === 'open') open = true } }).start()
    await waitFor(() => open, 5000, 'stream')
    expect(await client.holdClientSessionDocument(sessionId, { filePath: one.filePath })).toMatchObject({ agentId: one.agentId, running: false })
    // A holder that is not a live session (a client that never opened one).
    await runtime.openDocument(two.filePath, { holder: randomUUID() })
    expect(runtime.getAgentOrDocument(two.agentId)).toBeTruthy()

    // Several holder sweeps (every 1 s at this TTL) pass the TTL many times over.
    await new Promise(r => setTimeout(r, 2_600))
    expect(runtime.getAgentOrDocument(one.agentId)).toBeTruthy()
    expect(runtime.getAgentOrDocument(two.agentId)).toBeUndefined()
    expect((await client.request<{ config: { id: string } }>('GET', `/agents/${one.agentId}/config`)).config.id).toBe(one.agentId)

    // The session goes away: its expiry releases the document (not the sweep's TTL).
    stream.close()
    await waitFor(() => !sessions.has(sessionId), 5000, 'session expiry')
    expect(runtime.getAgentOrDocument(one.agentId)).toBeUndefined()
  })
})
