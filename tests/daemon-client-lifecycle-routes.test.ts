/**
 * Studio's quit and credential reload against the daemon (design
 * daemon-backend.md §8.3, §11; tracker W4-A):
 *
 * - POST /client/sessions/:id/quit stops the daemon only when Studio started
 *   this run and no other client session is open; a CLI-started daemon is
 *   never stopped; stopping is local-only.
 * - POST /client/reload-credentials re-reads the stores and runs the
 *   RuntimeService reload hook.
 *
 * No daemon process: createDaemonHttpApi with a spy for the bounded shutdown.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-client-lifecycle-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-client-lifecycle-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import Ajv2020 from 'ajv/dist/2020'
import spec from '../docs/daemon/openapi.json'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import type { DaemonStartedBy } from '../src/main/daemon/routes/meta-routes'
import { encryptCredential, resetCredentialKeyCache } from '../src/main/utils/credential-cipher'

const TOKEN = 'q'.repeat(43)
const auth = { authorization: `Bearer ${TOKEN}` }

function validate(schema: string, body: unknown): string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  ajv.addSchema(spec as object, 'spec')
  const check = ajv.compile({ $ref: `spec#/components/schemas/${schema}` })
  return check(body) ? [] : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

const servers: Array<{ close(): Promise<unknown> }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  vi.useRealTimers()
})

function daemon(startedBy: DaemonStartedBy, runtime = new RuntimeService({ enforceReviewGate: false })) {
  const requestShutdown = vi.fn()
  const server = createDaemonHttpApi(runtime, { routes: { startedBy }, requestShutdown, security: { token: TOKEN } })
  servers.push(server)
  const open = async (client: string, exitDaemonWhenClosed = false): Promise<string> => {
    const res = await server.inject({ method: 'POST', url: '/client/sessions', headers: auth, payload: { client, version: '1.0.0', exitDaemonWhenClosed } })
    expect(res.statusCode).toBe(201)
    return res.json().sessionId as string
  }
  const quit = (id: string, stopDaemon: boolean, headers: Record<string, string> = {}) =>
    server.inject({ method: 'POST', url: `/client/sessions/${id}/quit`, headers: { ...auth, ...headers }, payload: { stopDaemon } })
  return { server, requestShutdown, open, quit, runtime }
}

const settle = () => new Promise((r) => setTimeout(r, 120))

describe('POST /client/sessions/:id/quit (§8.3 quit behaviour)', () => {
  it('keepDaemonRunning off: a daemon Studio started stops when no other client session is open', async () => {
    const d = daemon('studio')
    const id = await d.open('studio', true)
    const res = await d.quit(id, true)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sessionId: id, ended: true, stopping: true, otherSessions: 0 })
    expect(res.json().reason).toMatch(/Studio started this daemon run and no other client session is open/)
    expect(validate('ClientQuitResult', res.json())).toEqual([])
    await settle()
    expect(d.requestShutdown).toHaveBeenCalledTimes(1)
  })

  it('another client session (the terminal app) keeps the daemon running until it ends, then the daemon stops', async () => {
    const d = daemon('studio')
    const id = await d.open('studio', true)
    const tui = await d.open('tui')
    const res = await d.quit(id, true)
    expect(res.json()).toMatchObject({ ended: true, stopping: false, otherSessions: 1 })
    expect(res.json().reason).toMatch(/1 other client session.*stops when the last one ends/)
    await settle()
    expect(d.requestShutdown).not.toHaveBeenCalled()
    // The terminal app quits: the held stop happens (no orphaned daemon).
    expect((await d.server.inject({ method: 'DELETE', url: `/client/sessions/${tui}`, headers: auth })).statusCode).toBe(200)
    await settle()
    expect(d.requestShutdown).toHaveBeenCalledTimes(1)
  })

  it('a Studio coming back before the terminal app quits clears the held stop', async () => {
    const d = daemon('studio')
    const id = await d.open('studio', true)
    const tui = await d.open('tui')
    await d.quit(id, true)
    await d.open('studio', true)
    await d.server.inject({ method: 'DELETE', url: `/client/sessions/${tui}`, headers: auth })
    await settle()
    expect(d.requestShutdown).not.toHaveBeenCalled()
  })

  it('once the daemon decided to stop, no new session opens', async () => {
    const d = daemon('studio')
    const id = await d.open('studio', true)
    expect((await d.quit(id, true)).json()).toMatchObject({ stopping: true })
    const late = await d.server.inject({ method: 'POST', url: '/client/sessions', headers: auth, payload: { client: 'tui', version: '1.0.0' } })
    expect(late.statusCode).toBe(503)
  })

  it('GET /client/sessions names the connected clients; PUT exit-when-closed follows keepDaemonRunning', async () => {
    const d = daemon('studio')
    const id = await d.open('studio', true)
    await d.open('tui')
    const list = await d.server.inject({ method: 'GET', url: '/client/sessions', headers: auth })
    expect(list.json()).toEqual({ sessions: [
      { client: 'studio', version: '1.0.0', exitDaemonWhenClosed: true },
      { client: 'tui', version: '1.0.0', exitDaemonWhenClosed: false },
    ] })
    expect(validate('ClientSessionList', list.json())).toEqual([])
    const put = await d.server.inject({ method: 'PUT', url: `/client/sessions/${id}/exit-when-closed`, headers: auth, payload: { exitDaemonWhenClosed: false } })
    expect(put.json()).toEqual({ sessionId: id, exitDaemonWhenClosed: false })
    expect((await d.server.inject({ method: 'GET', url: '/client/sessions', headers: auth })).json().sessions[0].exitDaemonWhenClosed).toBe(false)
    expect((await d.server.inject({ method: 'PUT', url: '/client/sessions/nope/exit-when-closed', headers: auth, payload: { exitDaemonWhenClosed: true } })).statusCode).toBe(404)
  })

  it('a CLI-started daemon is never stopped by Studio', async () => {
    const d = daemon('cli')
    const id = await d.open('studio', true)
    const res = await d.quit(id, true)
    expect(res.json()).toMatchObject({ ended: true, stopping: false })
    expect(res.json().reason).toMatch(/started by cli, not Studio; Studio never stops it/)
    await settle()
    expect(d.requestShutdown).not.toHaveBeenCalled()
  })

  it('keepDaemonRunning on: the session ends and the daemon keeps running', async () => {
    const d = daemon('studio')
    const id = await d.open('studio')
    const res = await d.quit(id, false)
    expect(res.json()).toMatchObject({ ended: true, stopping: false })
    await settle()
    expect(d.requestShutdown).not.toHaveBeenCalled()
    // The session is gone.
    expect((await d.server.inject({ method: 'DELETE', url: `/client/sessions/${id}`, headers: auth })).statusCode).toBe(404)
  })

  it('an already expired session still gets the stop decision', async () => {
    const d = daemon('studio')
    const res = await d.quit('5c0f6a8e-0d0b-4a8f-9a31-6c1d6a0b9e11', true)
    expect(res.json()).toMatchObject({ ended: false, stopping: true })
  })

  it('stopping is local-only: a proxied request is refused and nothing ends', async () => {
    const d = daemon('studio')
    const id = await d.open('studio', true)
    const res = await d.quit(id, true, { 'x-forwarded-for': '203.0.113.9' })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('loopback_only')
    await settle()
    expect(d.requestShutdown).not.toHaveBeenCalled()
    expect((await d.quit(id, false)).json()).toMatchObject({ ended: true })
  })

  it('rejects a non-boolean stopDaemon', async () => {
    const d = daemon('studio')
    const id = await d.open('studio')
    const res = await d.server.inject({ method: 'POST', url: `/client/sessions/${id}/quit`, headers: auth, payload: { stopDaemon: 'yes' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /client/reload-credentials', () => {
  it('runs the RuntimeService reload hook with the subscriptions now in the daemon\'s store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-reload-'))
    const previous = process.env.ADF_USER_DATA_DIR
    process.env.ADF_USER_DATA_DIR = dir
    resetCredentialKeyCache()
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(dir, 'chatgpt-subscription'), { recursive: true })
      writeFileSync(join(dir, 'chatgpt-subscription', 'auth.daemon.json'), encryptCredential(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, account_id: 'acct-1' })))
      const runtime = new RuntimeService({ enforceReviewGate: false })
      const hook = vi.spyOn(runtime, 'reloadCredentials')
      const d = daemon('studio', runtime)
      const res = await d.server.inject({ method: 'POST', url: '/client/reload-credentials', headers: auth })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ runtime: null, unlocked: [], stillLocked: [], sessions: ['chatgpt'], recovered: 0 })
      expect(validate('CredentialReloadResult', res.json())).toEqual([])
      expect(hook).toHaveBeenCalledWith('credentials reloaded by Studio', [{ providerType: 'chatgpt-subscription', label: 'ChatGPT' }])
      const proxied = await d.server.inject({ method: 'POST', url: '/client/reload-credentials', headers: { ...auth, 'x-forwarded-for': '203.0.113.9' } })
      expect(proxied.statusCode).toBe(403)
    } finally {
      process.env.ADF_USER_DATA_DIR = previous
      resetCredentialKeyCache()
    }
  })
})
