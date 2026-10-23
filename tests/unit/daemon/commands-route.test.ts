import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), `adf-commands-route-${process.pid}`), on: () => {}, getName: () => 'commands-test', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {}, ipcMain: { handle: () => {}, on: () => {} }, BrowserWindow: class {}, dialog: {},
}))
import { createDaemonHttpApi } from '../../../src/main/daemon/http-api'
import { RuntimeService, RuntimeLoopError } from '../../../src/main/runtime/runtime-service'

const token = 'q'.repeat(43)
const deviceToken = 'adfd_' + 'd'.repeat(43)
const headers = { authorization: `Bearer ${token}` }
const servers: ReturnType<typeof createDaemonHttpApi>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); vi.restoreAllMocks() })

function setup() {
  const runtime = new RuntimeService({ agentLeases: null, enforceReviewGate: false })
  const known = vi.spyOn(runtime, 'getAgentOrDocument').mockReturnValue({} as never)
  const running = vi.spyOn(runtime, 'getAgent').mockReturnValue({} as never)
  const result = { id: 'command-1', name: 'echo', loop: 'main', status: 'ok' as const, authorized: false, result: 'hi', durationMs: 1, deferred: false, seq: 4 }
  const run = vi.spyOn(runtime, 'runAgentCommand').mockResolvedValue(result)
  const server = createDaemonHttpApi(runtime, { security: { token }, routes: { remoteAccess: { noteRequest: () => {}, deviceAuthority: () => ({
    enabled: () => true, computerName: () => 'test',
    check: (value) => value === deviceToken ? { kind: 'device', id: 'device-1', label: 'paired' } : { kind: 'unknown' },
  }) } as never } })
  servers.push(server)
  const post = (payload: unknown = {}, auth = headers) => server.inject({ method: 'POST', url: '/agents/agent-1/commands/echo/run', headers: auth, payload: payload as never })
  return { known, running, run, result, post }
}

describe('owner command HTTP route', () => {
  it('requires bearer authentication; paired-device tokens can request elevation', async () => {
    const t = setup()
    expect((await t.post({}, {} as typeof headers)).statusCode).toBe(401)
    expect(t.run).not.toHaveBeenCalled()
    const res = await t.post({ authorize: true }, { authorization: `Bearer ${deviceToken}` })
    expect(res.statusCode).toBe(200)
    expect(t.run).toHaveBeenCalledWith('agent-1', 'echo', { authorize: true })
  })
  it('distinguishes unknown and off agents without starting them', async () => {
    const t = setup()
    t.known.mockReturnValue(undefined as never)
    expect((await t.post()).statusCode).toBe(404)
    t.known.mockReturnValue({} as never)
    t.running.mockReturnValue(undefined)
    const off = await t.post()
    expect(off.statusCode).toBe(409)
    expect(off.json().code).toBe('agent_not_running')
    expect(t.run).not.toHaveBeenCalled()
  })
  it.each([{ args: 1 }, { authorize: 'true' }, { loop: [] }, { requestId: 10 }, []])('rejects malformed request %j', async (body) => {
    const t = setup()
    const res = await t.post(body)
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_request')
    expect(t.run).not.toHaveBeenCalled()
  })
  it.each(['ok', 'error', 'denied'] as const)('returns HTTP 200 for a recorded %s outcome', async status => {
    const t = setup()
    t.run.mockResolvedValue({ ...t.result, status })
    const res = await t.post({ args: 'hi', loop: 'research', requestId: 'test-1', authorize: false })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ...t.result, status })
    expect(t.run).toHaveBeenCalledWith('agent-1', 'echo', { args: 'hi', loop: 'research', requestId: 'test-1', authorize: false })
  })
  it('preserves runtime refusal status and code', async () => {
    const t = setup()
    t.run.mockRejectedValue(new RuntimeLoopError('Invalid args', 400, 'invalid_request'))
    const res = await t.post({ args: '\n' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'Invalid args', code: 'invalid_request' })
  })
})
