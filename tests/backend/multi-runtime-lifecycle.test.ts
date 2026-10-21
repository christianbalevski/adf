/**
 * The lifecycle of a runtime that leaves the set (docs/design/multi-runtime.md
 * §3.3, §3.4) and the routing of the calls around it (§4.3, §4.4):
 *
 * - Removed while its connector waits or while its connect requests are in
 *   flight, a runtime sends nothing more (no token), opens no session and
 *   brings back no approvals.
 * - While it retires, no agent window opens on it; forgotten and saved again
 *   meanwhile, it connects again; a second Reconnect does not replace the
 *   fresh connection.
 * - Approvals: an explicit `local` tag from another runtime's agent window
 *   is This computer's; an untagged call stays that window's runtime's.
 * - The main window's open runtime: a tagged FILE_OPEN from the main window
 *   moves adf-file:// to that runtime; an untagged one and an agent window's
 *   do not.
 * - A pin check in flight: nothing at all is sent to the address.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { AGENT_1, AGENT_2, FILE_1, REMOTE_FILE_2, TOKEN, WINDOW, boot, cleanup, fakeHost, pending, tick, until, type FakeHost } from './multi-runtime-harness'

afterEach(cleanup)

/** A promise and its release. */
function hold(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((r) => { release = r })
  return { promise, release }
}

/** The requests to `host` since `from` that carried a token. */
const authed = (host: FakeHost, from: number) => host.daemon.requests.slice(from).filter((r) => r.auth).map((r) => `${r.method} ${r.path}`)

describe('a runtime removed while it connects sends nothing more', () => {
  it('removed during the backoff of an unreachable remote: when the host comes back, no token goes there and no session opens', async () => {
    const host2 = fakeHost('host-2', 47392, 'FP-HOST-2')
    host2.reachable = false
    // Each backoff sleep lasts 50 times its delay: the removal lands inside one.
    const t = await boot({ hosts: [host2], sleepScale: 50 })
    await t.sync()
    const r2 = t.handle.runtimes.get('remote:host-2')!
    await until(() => host2.sleeps.length >= 2)
    host2.daemon.routes.set('GET /approvals', () => ({ pending: [pending('n1', '/srv/agents/agent-2.adf', 'agent-2')], history: [] }))
    t.handle.runtimes.sync({})
    await until(() => t.handle.runtimes.get('remote:host-2') === null)
    const from = host2.daemon.requests.length
    host2.reachable = true
    expect(await r2.ready).toBe(false)
    await tick(1_000)
    expect(authed(host2, from)).toEqual([])
    expect(host2.sessions).toEqual([])
    expect(electronStub.pushes.filter((p) => JSON.stringify(p.args).includes('agent-2.adf'))).toEqual([])
  })

  for (const path of ['/agents', '/approvals']) {
    it(`removed while GET ${path} of its connect is in flight: nothing more is sent, its session never starts and its approvals never show`, async () => {
      const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
      host1.daemon.routes.set('GET /approvals', () => ({ pending: [pending('n1', REMOTE_FILE_2, 'agent-2')], history: [] }))
      const gate = hold()
      host1.gates.set(path, gate.promise)
      const t = await boot({ hosts: [host1] })
      await t.sync()
      const r1 = t.handle.runtimes.get('remote:host-1')!
      await until(() => host1.sessions.length === 1)
      const pushesBefore = electronStub.pushes.length
      const toastsBefore = electronStub.calls.filter((c) => c.api === 'Notification.new').length
      t.handle.runtimes.sync({})
      await until(() => t.handle.runtimes.get('remote:host-1') === null)
      const from = host1.daemon.requests.length
      gate.release()
      await r1.ready
      await tick(100)
      // The request in flight was the last one; nothing after it carries the token.
      expect(authed(host1, from).filter((r) => r !== `GET ${path}`)).toEqual([])
      expect(host1.sessions[0].ended).toBe(true)
      expect(host1.sessions[0].listener).toBeNull()
      expect(electronStub.pushes.slice(pushesBefore).filter((p) => JSON.stringify(p.args).includes(REMOTE_FILE_2))).toEqual([])
      expect(electronStub.calls.filter((c) => c.api === 'Notification.new').length).toBe(toastsBefore)
      expect(t.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local'])
    })
  }
})

describe('a runtime that retires', () => {
  it('Remove: an agent window opened on it meanwhile is refused and opens no session there', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const r1 = t.handle.runtimes.get('remote:host-1')!
    await r1.ready
    // Its main session takes the whole end budget: the runtime retires for a while.
    host1.sessions[0].end = () => new Promise(() => {})
    t.handle.runtimes.sync({})
    expect(() => t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false }, 'remote:host-1')).toThrow('remote:host-1 is not connected.')
    await tick(50)
    expect(host1.sessions).toHaveLength(1)
    expect(r1.windows.ids()).toEqual([])
  })

  it('Reconnect: an agent window opened on the old connection while it retires is refused', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const failed = t.handle.runtimes.get('remote:host-1')!
    await failed.ready
    host1.daemon.routes.set('GET /files/agent', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    await failed.ctx.runningAgentAt(REMOTE_FILE_2).catch(() => null)
    await until(() => failed.connection.state.state === 'failed')
    host1.daemon.routes.delete('GET /files/agent')
    const ending = hold()
    host1.sessions[0].end = async () => { await ending.promise }
    failed.reconnect()
    await tick(20)
    expect(() => t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false }, 'remote:host-1')).toThrow('remote:host-1 is not connected.')
    expect(failed.windows.ids()).toEqual([])
    ending.release()
    await until(() => !!t.handle.runtimes.get('remote:host-1') && t.handle.runtimes.get('remote:host-1') !== failed)
    expect(await t.handle.runtimes.get('remote:host-1')!.ready).toBe(true)
  })

  it('quit while it retires waits for its sessions too, within the session-end budget', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    let ended = false
    host1.sessions[0].end = async () => { await tick(300); ended = true }
    t.handle.runtimes.sync({})
    await t.handle.shutdown()
    expect(ended).toBe(true)
  })

  it('forgotten, then saved again while it retires: it connects again', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const old = t.handle.runtimes.get('remote:host-1')!
    await old.ready
    const ending = hold()
    host1.sessions[0].end = async () => { await ending.promise }
    t.handle.runtimes.sync({})
    await t.sync()
    ending.release()
    await until(() => !!t.handle.runtimes.get('remote:host-1') && t.handle.runtimes.get('remote:host-1') !== old, 2_000)
    const fresh = t.handle.runtimes.get('remote:host-1')!
    expect(await fresh.ready).toBe(true)
    expect(fresh.connection.state.state).toBe('connected')
    expect(t.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local', 'remote:host-1'])
  })

  it('a second Reconnect on the old connection does not replace the fresh one', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const failed = t.handle.runtimes.get('remote:host-1')!
    await failed.ready
    host1.daemon.routes.set('GET /files/agent', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    await failed.ctx.runningAgentAt(REMOTE_FILE_2).catch(() => null)
    await until(() => failed.connection.state.state === 'failed')
    host1.daemon.routes.delete('GET /files/agent')
    failed.reconnect()
    await until(() => !!t.handle.runtimes.get('remote:host-1') && t.handle.runtimes.get('remote:host-1') !== failed)
    const fresh = t.handle.runtimes.get('remote:host-1')!
    expect(await fresh.ready).toBe(true)
    // A stale menu item still names the old connection.
    failed.reconnect()
    await tick(100)
    expect(t.handle.runtimes.get('remote:host-1')).toBe(fresh)
    expect(fresh.connection.state.state).toBe('connected')
    expect(host1.sessions.filter((s) => !s.ended)).toHaveLength(1)
  })
})

describe('approvals answered from another runtime\'s agent window (§6.1)', () => {
  async function connected() {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    host1.daemon.routes.set('POST /approvals/resolve', () => ({ success: true }))
    const t = await boot({ hosts: [host1] })
    t.local.routes.set('POST /approvals/resolve', () => ({ success: true }))
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false }, 'remote:host-1')
    t.handle.windows.open({ id: WINDOW + 1, send: () => {}, focused: () => false })
    return { ...t, host1 }
  }
  const answer = { filePath: FILE_1, approvalId: 'n1', approved: false, feedback: 'not this one' }

  it('an explicit local tag from host-1\'s window answers This computer\'s request on This computer; nothing goes to host-1', async () => {
    const t = await connected()
    await t.invoke(IPC.APPROVALS_RESOLVE, WINDOW, { $runtime: 'local' }, answer)
    expect(t.local.requests.filter((r) => r.path === '/approvals/resolve').map((r) => r.body)).toEqual([expect.objectContaining({ filePath: FILE_1, approvalId: 'n1' })])
    expect(t.host1.daemon.requests.filter((r) => r.path === '/approvals/resolve')).toEqual([])
  })

  it('untagged from host-1\'s window stays host-1\'s; This computer\'s window reaches host-1 with its tag', async () => {
    const t = await connected()
    await t.invoke(IPC.APPROVALS_RESOLVE, WINDOW, { ...answer, filePath: REMOTE_FILE_2 })
    expect(t.host1.daemon.requests.filter((r) => r.path === '/approvals/resolve')).toHaveLength(1)
    await t.invoke(IPC.APPROVALS_RESOLVE, WINDOW + 1, { $runtime: 'remote:host-1' }, { ...answer, filePath: REMOTE_FILE_2 })
    expect(t.host1.daemon.requests.filter((r) => r.path === '/approvals/resolve')).toHaveLength(2)
    expect(t.local.requests.filter((r) => r.path === '/approvals/resolve')).toEqual([])
    // Any other runtime-scoped call tagged with another runtime is still refused from a bound window.
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, WINDOW, { $runtime: 'local' })).toThrow('This window shows an agent on host-1.')
  })
})

describe('the main window\'s open runtime (§4.3, §4.4)', () => {
  async function connected() {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    host1.daemon.routes.set('GET /files/agent', (req) => ({ agentId: req.query.path === REMOTE_FILE_2 ? AGENT_2 : null, loaded: req.query.path === REMOTE_FILE_2 }))
    host1.daemon.routes.set(`GET /agents/${AGENT_2}/files/raw`, () => ({ raw: 'remote-image', headers: { 'Content-Type': 'image/png' } }))
    const t = await boot({ hosts: [host1] })
    t.local.routes.set('GET /files/agent', (req) => ({ agentId: req.query.path === FILE_1 ? AGENT_1 : null, loaded: req.query.path === FILE_1 }))
    t.local.routes.set(`GET /agents/${AGENT_1}/files/raw`, () => ({ raw: 'local-image', headers: { 'Content-Type': 'image/png' } }))
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    return { ...t, host1 }
  }
  const image = (window?: number) => t0Request(window)
  function t0Request(window?: number): Request {
    return new Request('adf-file://img1.png', window === undefined ? {} : { headers: { 'x-adf-window': String(window) } })
  }

  it('a tagged FILE_OPEN from the main window: adf-file:// goes to host-1 with host-1\'s token', async () => {
    const t = await connected()
    await t.invoke(IPC.FILE_OPEN, 1, { $runtime: 'remote:host-1' }, { filePath: REMOTE_FILE_2 })
    await until(() => t.handle.runtimes.mainOpenRuntime().id === 'remote:host-1')
    const res = await t.handle.adfFile(image())
    expect(await res.text()).toBe('remote-image')
    expect(t.host1.daemon.requests.filter((r) => r.path.endsWith('/files/raw')).map((r) => r.auth)).toEqual([`Bearer ${TOKEN}-host-1`])
    expect(t.local.requests.filter((r) => r.path.endsWith('/files/raw'))).toEqual([])
  })

  it('an untagged FILE_OPEN from the main window: adf-file:// stays on This computer', async () => {
    const t = await connected()
    await t.invoke(IPC.FILE_OPEN, 1, { $runtime: 'remote:host-1' }, { filePath: REMOTE_FILE_2 })
    await until(() => t.handle.runtimes.mainOpenRuntime().id === 'remote:host-1')
    await t.invoke(IPC.FILE_OPEN, 1, { filePath: FILE_1 })
    await until(() => t.handle.runtimes.mainOpenRuntime().id === 'local')
    expect(await (await t.handle.adfFile(image())).text()).toBe('local-image')
    expect(t.local.requests.filter((r) => r.path.endsWith('/files/raw')).map((r) => r.auth)).toEqual([`Bearer ${TOKEN}`])
  })

  it('an agent window\'s FILE_OPEN does not move the main window\'s open runtime', async () => {
    const t = await connected()
    t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false }, 'remote:host-1')
    await t.invoke(IPC.FILE_OPEN, WINDOW, { filePath: REMOTE_FILE_2 })
    await tick(20)
    expect(t.handle.runtimes.mainOpenRuntime().id).toBe('local')
    // The agent window's own request is served by its runtime; the main window's by This computer.
    expect(t.host1.daemon.requests.filter((r) => r.path.endsWith('/files/raw'))).toEqual([])
    expect((await t.handle.adfFile(image())).status).toBe(404)
  })
})

describe('a pin check in flight (§3.5)', () => {
  it('nothing is sent while it runs: a tagged call and a stream retry carry no token; another computer then fails the runtime', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const r1 = t.handle.runtimes.get('remote:host-1')!
    await r1.ready
    host1.shows = 'FP-EVIL-1'
    const check = hold()
    host1.gates.set('/remote/hello', check.promise)
    const from = host1.daemon.requests.length
    host1.sessions[0].listener!.onConnection({ state: 'reconnecting', error: 'the stream dropped' })
    // A call on host-1 and the stream's own retry, while the fingerprint is being checked.
    const call = t.invoke(IPC.BACKGROUND_AGENT_STATUS, null, { $runtime: 'remote:host-1' }) as Promise<unknown>
    void call.catch(() => null)
    const direct = r1.connection.current!.request('GET', '/agents').catch((err: unknown) => err)
    host1.sessions[0].listener!.onConnection({ state: 'reconnecting', error: 'the retry failed' })
    await tick(100)
    expect(await direct).toBeInstanceOf(Error)
    expect(host1.daemon.requests.slice(from)).toEqual([])
    check.release()
    await until(() => r1.connection.state.state === 'failed')
    await call.catch(() => null)
    expect(authed(host1, from)).toEqual([])
  })
})
