/**
 * The global ApprovalHub — the registry behind the title-bar HIL menu and the
 * fleet map's per-agent pending badge.
 *
 * The contract that matters is lifecycle symmetry: a hub row exists exactly
 * while the executor holds a matching pending request. A row that outlives its
 * executor is a request the user can click forever and never answer, which is
 * the failure this hub is built to prevent — so teardown, chat interrupt,
 * timeout and double-resolve all get their own case here.
 *
 * Both blocking kinds are registered: tool approvals (answerable from the hub)
 * and `ask` questions (surfaced only — an answer is prose).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import {
  approvalHub,
  notificationKey,
  summarizeApprovalArgs,
  summarizeQuestion,
  HISTORY_MAX,
  PREVIEW_MAX,
} from '../../../src/main/runtime/approval-hub'
import {
  NativeNotifier,
  COALESCE_THRESHOLD,
  COALESCE_WINDOW_MS,
  type NativeNotifierPlatform,
} from '../../../src/main/runtime/native-notifier'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { AgentExecutionEvent, PendingNotification } from '../../../src/shared/types/ipc.types'

function makeExecutor(options: { filePath?: string; name?: string; loop?: string } = {}) {
  const tasks = new Map<string, { status: string; result?: string; error?: string }>()
  const workspace = {
    insertTask: (id: string) => { tasks.set(id, { status: 'pending' }) },
    updateTaskStatus: (id: string, status: string, result?: string, error?: string) => {
      tasks.set(id, { status, result, error })
    },
    getTask: (id: string) => (tasks.has(id) ? { id, ...tasks.get(id) } : null),
    getFilePath: () => options.filePath ?? '/agents/agent-1.adf',
    insertLog: () => {},
  }
  const session = { getWorkspace: () => workspace } as never
  const config = {
    name: options.name ?? 'agent-1',
    id: options.name ?? 'agent-1',
    tools: [{ name: 'fs_write', enabled: true, visible: true, restricted: true }],
    triggers: {},
    limits: {},
    ...(options.loop ? { metadata: { loop_name: options.loop } } : {}),
  } as unknown as AgentConfig
  const executor = new AgentExecutor(config, {} as never, { executeTool: vi.fn() } as never, session)
  const events: AgentExecutionEvent[] = []
  executor.on('event', (e: AgentExecutionEvent) => events.push(e))
  return { executor, events, tasks }
}

/** `requestAsk` is private — it is only reachable through the ask tool path. */
function raiseAsk(executor: AgentExecutor, question: string): Promise<string> {
  return (executor as unknown as { requestAsk(q: string): Promise<string> }).requestAsk(question)
}

beforeEach(() => {
  approvalHub.clear()
})

afterEach(() => {
  vi.useRealTimers()
  approvalHub.clear()
})

describe('ApprovalHub registration', () => {
  it('registers a blocking HIL approval with agent identity, loop and preview', async () => {
    const { executor } = makeExecutor()
    const promise = executor.requestHilApproval('fs_write', { path: 'notes.md', _reason: 'save the note' })

    const [entry, ...rest] = approvalHub.snapshot()
    expect(rest).toHaveLength(0)
    expect(entry.kind).toBe('approval')
    expect(entry.filePath).toBe('/agents/agent-1.adf')
    expect(entry.agentName).toBe('agent-1')
    expect(entry.loop).toBe('main')
    expect(entry.toolName).toBe('fs_write')
    expect(entry.reason).toBe('restricted')
    expect(entry.preview).toBe('save the note')
    expect(entry.requestedAt).toBeGreaterThan(0)
    // The map's full-context modal needs the raw input and always-approve meta.
    expect(entry.input).toEqual({ path: 'notes.md', _reason: 'save the note' })
    expect(entry.canAlwaysApprove).toBe(true)
    expect(entry.id).toBe(notificationKey('/agents/agent-1.adf', 'main', entry.requestId))

    executor.resolveHilTask(entry.requestId, true)
    await promise
  })

  it('registers an ask, with the question as its preview and no resolve path', async () => {
    const { executor } = makeExecutor()
    const promise = raiseAsk(executor, 'Which branch should I push to?')

    const entry = approvalHub.snapshot()[0]
    expect(entry.kind).toBe('ask')
    expect(entry.question).toBe('Which branch should I push to?')
    expect(entry.preview).toBe('Which branch should I push to?')
    expect(entry.toolName).toBeUndefined()

    // An ask needs prose — the hub refuses to turn it into a yes/no.
    const refused = approvalHub.resolve(entry.filePath, entry.id, true)
    expect(refused.success).toBe(false)
    expect(refused.error).toMatch(/typed answer/i)
    expect(approvalHub.snapshot()).toHaveLength(1)

    executor.resolveAsk(entry.requestId, 'main')
    expect(await promise).toBe('main')
    expect(approvalHub.snapshot()).toHaveLength(0)
  })

  it('keys asks per agent+loop — `ask_1` is not globally unique', async () => {
    const a = makeExecutor({ filePath: '/agents/a.adf', name: 'a' })
    const b = makeExecutor({ filePath: '/agents/b.adf', name: 'b' })
    const loop = makeExecutor({ filePath: '/agents/a.adf', name: 'a', loop: 'reflector' })

    const pa = raiseAsk(a.executor, 'A?')
    const pb = raiseAsk(b.executor, 'B?')
    const pl = raiseAsk(loop.executor, 'L?')

    // All three are `ask_1`; a naive requestId key would have collapsed them.
    expect(approvalHub.snapshot().map((e) => e.requestId)).toEqual(['ask_1', 'ask_1', 'ask_1'])
    expect(approvalHub.snapshot()).toHaveLength(3)
    expect(new Set(approvalHub.snapshot().map((e) => e.id)).size).toBe(3)

    a.executor.abort(); b.executor.abort(); loop.executor.abort()
    await Promise.all([pa, pb, pl])
  })

  it('stamps the inner loop name so the panel can chip it', async () => {
    const { executor } = makeExecutor({ loop: 'reflector' })
    const promise = executor.requestHilApproval('fs_write', { path: 'x' })
    const entry = approvalHub.snapshot()[0]
    expect(entry.loop).toBe('reflector')
    executor.resolveHilTask(entry.requestId, false)
    await promise
  })

  it('aggregates requests from several agents — including ones that are not open', async () => {
    // A backgrounded agent is just an executor no window is showing: it
    // registers through the identical path, which IS the headline win (its
    // request has no in-chat card rendered anywhere).
    const foreground = makeExecutor({ filePath: '/agents/foreground.adf', name: 'foreground' })
    const background = makeExecutor({ filePath: '/agents/background.adf', name: 'background' })

    const fgPromise = foreground.executor.requestHilApproval('fs_write', { path: 'a' })
    const bgPromise = background.executor.requestHilApproval('fs_write', { path: 'b' })

    const snapshot = approvalHub.snapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map((e) => e.filePath).sort()).toEqual([
      '/agents/background.adf',
      '/agents/foreground.adf',
    ])

    // Resolving the background one leaves the foreground one alone.
    const bgEntry = snapshot.find((e) => e.agentName === 'background')!
    expect(approvalHub.resolve(bgEntry.filePath, bgEntry.id, true)).toEqual({ success: true })
    expect(await bgPromise).toMatchObject({ approved: true })
    expect(approvalHub.snapshot()).toHaveLength(1)

    foreground.executor.abort()
    await fgPromise
  })

  it('counts by kind, and pushes a full snapshot to subscribers on every change', async () => {
    const pushes: number[] = []
    const unsubscribe = approvalHub.subscribe((snapshot) => pushes.push(snapshot.pending.length))
    const { executor } = makeExecutor()

    const approval = executor.requestHilApproval('fs_write', { path: 'a' })
    const ask = raiseAsk(executor, 'ready?')
    expect(approvalHub.countOfKind('approval')).toBe(1)
    expect(approvalHub.countOfKind('ask')).toBe(1)

    executor.abort()
    await Promise.all([approval, ask])

    expect(pushes).toEqual([1, 2, 1, 0])
    unsubscribe()
  })
})

describe('ApprovalHub resolution', () => {
  it('routes through the executor, so the in-chat card is dismissed too', async () => {
    const { executor, events } = makeExecutor()
    const promise = executor.requestHilApproval('fs_write', { path: 'a' })
    const entry = approvalHub.snapshot()[0]

    expect(approvalHub.resolve(entry.filePath, entry.id, false, 'nope')).toEqual({ success: true })

    const decision = await promise
    expect(decision.approved).toBe(false)
    expect(decision.feedback).toBe('nope')
    // The same tool_approval_resolved the in-chat card listens for.
    const resolved = events.find((e) => e.type === 'tool_approval_resolved')
    expect(resolved?.payload).toMatchObject({ requestId: entry.requestId, approved: false })
    expect(approvalHub.snapshot()).toHaveLength(0)
  })

  it('double-resolve no-ops with a clear result', async () => {
    const { executor } = makeExecutor()
    const promise = executor.requestHilApproval('fs_write', { path: 'a' })
    const entry = approvalHub.snapshot()[0]

    expect(approvalHub.resolve(entry.filePath, entry.id, true).success).toBe(true)
    const second = approvalHub.resolve(entry.filePath, entry.id, false)
    expect(second.success).toBe(false)
    expect(second.error).toMatch(/no longer pending/i)

    // The first decision stands — a stray second click cannot flip it.
    expect(await promise).toMatchObject({ approved: true })
  })

  it('refuses a resolve aimed at the wrong agent', async () => {
    const { executor } = makeExecutor({ filePath: '/agents/agent-1.adf' })
    const promise = executor.requestHilApproval('fs_write', { path: 'a' })
    const entry = approvalHub.snapshot()[0]

    const result = approvalHub.resolve('/agents/other.adf', entry.id, true)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/different agent/i)
    expect(approvalHub.snapshot()).toHaveLength(1)

    executor.abort()
    await promise
  })

  it('resolve after the auto-deny timeout no-ops (the timeout already answered)', async () => {
    vi.useFakeTimers()
    const { executor } = makeExecutor()
    const protection = { kind: 'file_protection' as const, target: 'mind.md', level: 'no_delete' }
    const promise = executor.requestProtectionApproval('fs_write', { path: 'mind.md' }, protection, { timeoutMs: 1000 })
    const entry = approvalHub.snapshot()[0]
    expect(entry.reason).toBe('protection')
    expect(entry.canAlwaysApprove).toBe(false)

    await vi.advanceTimersByTimeAsync(1100)
    expect(await promise).toMatchObject({ approved: false })
    expect(approvalHub.snapshot()).toHaveLength(0)

    const late = approvalHub.resolve(entry.filePath, entry.id, true)
    expect(late.success).toBe(false)
  })
})

describe('ApprovalHub cleanup', () => {
  it('abort() (agent dispose/teardown) removes every pending row, approvals and asks', async () => {
    const { executor } = makeExecutor()
    const first = executor.requestHilApproval('fs_write', { path: 'a' })
    const second = executor.requestHilApproval('fs_write', { path: 'b' })
    const question = raiseAsk(executor, 'still there?')
    expect(approvalHub.snapshot()).toHaveLength(3)

    executor.abort()

    // Teardown answers all three AND clears the menu — an orphaned row that
    // can never resolve is the bug this asserts against.
    expect(await first).toMatchObject({ approved: false })
    expect(await second).toMatchObject({ approved: false })
    expect(await question).toBe('')
    expect(approvalHub.snapshot()).toHaveLength(0)
  })

  it('unregisterAgent drops only that agent, and is idempotent', async () => {
    const a = makeExecutor({ filePath: '/agents/a.adf', name: 'a' })
    const b = makeExecutor({ filePath: '/agents/b.adf', name: 'b' })
    const pa = a.executor.requestHilApproval('fs_write', { path: 'x' })
    const pb = b.executor.requestHilApproval('fs_write', { path: 'y' })

    expect(approvalHub.unregisterAgent('/agents/a.adf')).toBe(1)
    expect(approvalHub.unregisterAgent('/agents/a.adf')).toBe(0)
    expect(approvalHub.snapshot().map((e) => e.filePath)).toEqual(['/agents/b.adf'])

    a.executor.abort(); b.executor.abort()
    await Promise.all([pa, pb])
  })

  it('a re-register keeps the original requestedAt so the age does not reset', () => {
    const resolve = vi.fn()
    const base = {
      id: 'k', kind: 'approval' as const, requestId: 'task_1', filePath: '/a.adf', agentName: 'a',
      loop: 'main', toolName: 'fs_write', preview: 'x', reason: 'restricted' as const,
    }
    approvalHub.register({ ...base, requestedAt: 1000, resolve })
    approvalHub.register({ ...base, requestedAt: 9000, resolve })
    const snapshot = approvalHub.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].requestedAt).toBe(1000)
  })
})

/**
 * The menu is a notification centre, not a queue: a row that vanishes the
 * instant it stops blocking leaves the user no way to check what they just
 * answered — or to tell "I said no" from "that agent died before I looked".
 * The distinction the history has to carry is exactly that: a DECISION vs an
 * expiry, per row, for the last HISTORY_MAX rows of this app session.
 */
describe('ApprovalHub history', () => {
  const baseEntry = (id: string, requestedAt = 1000) => ({
    id,
    kind: 'approval' as const,
    requestId: id,
    filePath: '/agents/a.adf',
    agentName: 'a',
    loop: 'main',
    toolName: 'fs_write',
    preview: 'x',
    reason: 'restricted' as const,
    requestedAt,
  })

  it('records a hub resolve as approved / rejected, newest first', async () => {
    const { executor } = makeExecutor()
    const yes = executor.requestHilApproval('fs_write', { path: 'a' })
    const first = approvalHub.snapshot()[0]
    approvalHub.resolve(first.filePath, first.id, true)
    await yes

    const no = executor.requestHilApproval('fs_write', { path: 'b' })
    const second = approvalHub.snapshot()[0]
    approvalHub.resolve(second.filePath, second.id, false, 'nope')
    await no

    const history = approvalHub.historySnapshot()
    expect(history.map((h) => h.outcome)).toEqual(['rejected', 'approved'])
    expect(history[0].requestId).toBe(second.requestId)
    expect(history[0].resolvedAt).toBeGreaterThanOrEqual(history[0].requestedAt)
    // Identity survives so the greyed row still says who and what.
    expect(history[0].agentName).toBe('agent-1')
    expect(history[0].toolName).toBe('fs_write')
    // The pending list is untouched by any of it.
    expect(approvalHub.snapshot()).toHaveLength(0)
  })

  it('records an answered ask, and the in-chat card path too', async () => {
    const { executor } = makeExecutor()
    const question = raiseAsk(executor, 'Which branch?')
    const ask = approvalHub.snapshot()[0]
    executor.resolveAsk(ask.requestId, 'main')
    expect(await question).toBe('main')

    const approval = executor.requestHilApproval('fs_write', { path: 'a' })
    const entry = approvalHub.snapshot()[0]
    // Resolving in the agent's own chat, not from the hub — same history.
    executor.resolveHilTask(entry.requestId, true)
    await approval

    expect(approvalHub.historySnapshot().map((h) => h.outcome)).toEqual(['approved', 'answered'])
  })

  it("marks a drained request 'expired' — nobody decided it", async () => {
    const { executor } = makeExecutor()
    const approval = executor.requestHilApproval('fs_write', { path: 'a' })
    const question = raiseAsk(executor, 'still there?')

    executor.abort()
    await Promise.all([approval, question])

    const history = approvalHub.historySnapshot()
    expect(history).toHaveLength(2)
    expect(new Set(history.map((h) => h.outcome))).toEqual(new Set(['expired']))
  })

  it("marks an auto-denied protection override 'expired', not 'rejected'", async () => {
    vi.useFakeTimers()
    const { executor } = makeExecutor()
    const protection = { kind: 'file_protection' as const, target: 'mind.md', level: 'no_delete' }
    const promise = executor.requestProtectionApproval('fs_write', { path: 'mind.md' }, protection, { timeoutMs: 1000 })

    await vi.advanceTimersByTimeAsync(1100)
    await promise

    expect(approvalHub.historySnapshot().map((h) => h.outcome)).toEqual(['expired'])
  })

  it("marks agent teardown 'expired' via unregisterAgent", () => {
    approvalHub.register({ ...baseEntry('k1'), resolve: vi.fn() })
    expect(approvalHub.unregisterAgent('/agents/a.adf')).toBe(1)
    expect(approvalHub.historySnapshot()).toMatchObject([{ id: 'k1', outcome: 'expired' }])
  })

  it('drops the raw tool input — history is a receipt, not a payload store', () => {
    approvalHub.register({ ...baseEntry('k1'), input: { path: 'a', secret: 'x' }, resolve: vi.fn() })
    approvalHub.unregister('k1', 'approved')
    expect(approvalHub.historySnapshot()[0]).not.toHaveProperty('input')
    expect(approvalHub.historySnapshot()[0]).not.toHaveProperty('resolve')
  })

  it('is bounded — the oldest rows fall off, never the newest', () => {
    for (let i = 0; i < HISTORY_MAX + 10; i++) {
      approvalHub.register({ ...baseEntry(`k${i}`), resolve: vi.fn() })
      approvalHub.unregister(`k${i}`, 'approved')
    }
    const history = approvalHub.historySnapshot()
    expect(history).toHaveLength(HISTORY_MAX)
    expect(history[0].id).toBe(`k${HISTORY_MAX + 9}`)
    expect(history[history.length - 1].id).toBe('k10')
  })

  it('never double-records: a second unregister of the same id is a no-op', () => {
    approvalHub.register({ ...baseEntry('k1'), resolve: vi.fn() })
    expect(approvalHub.unregister('k1', 'approved')).toBe(true)
    expect(approvalHub.unregister('k1', 'rejected')).toBe(false)
    expect(approvalHub.historySnapshot()).toHaveLength(1)
  })

  it('ships pending and history in the one pushed snapshot', () => {
    const pushes: Array<{ pending: number; history: number }> = []
    const unsubscribe = approvalHub.subscribe((s) =>
      pushes.push({ pending: s.pending.length, history: s.history.length })
    )
    approvalHub.register({ ...baseEntry('k1'), resolve: vi.fn() })
    approvalHub.unregister('k1', 'approved')
    unsubscribe()

    expect(pushes).toEqual([{ pending: 1, history: 0 }, { pending: 0, history: 1 }])
    expect(approvalHub.fullSnapshot()).toEqual({
      pending: [],
      history: approvalHub.historySnapshot(),
    })
  })

  it('clear() forgets the history too — a reset is not a session ending', () => {
    approvalHub.register({ ...baseEntry('k1'), resolve: vi.fn() })
    approvalHub.unregister('k1', 'approved')
    approvalHub.clear()
    expect(approvalHub.historySnapshot()).toHaveLength(0)
  })
})

describe('previews', () => {
  it('prefers the model-written _reason, like the in-chat card does', () => {
    expect(summarizeApprovalArgs({ path: 'a.md', _reason: 'back up the notes' })).toBe('back up the notes')
  })

  it('falls back to the shell command, then to compact JSON', () => {
    expect(summarizeApprovalArgs({ command: 'rm -rf build' })).toBe('rm -rf build')
    expect(summarizeApprovalArgs({ path: 'a.md' })).toBe('{"path":"a.md"}')
    expect(summarizeApprovalArgs({})).toBe('no arguments')
    expect(summarizeApprovalArgs(undefined)).toBe('no arguments')
  })

  it('redacts secret-shaped keys and drops internal flags', () => {
    const preview = summarizeApprovalArgs({ url: 'https://x', api_key: 'sk-live-123', _async: true })
    expect(preview).not.toContain('sk-live-123')
    expect(preview).toContain('[redacted]')
    expect(preview).not.toContain('_async')
  })

  it('truncates to a single short line', () => {
    const preview = summarizeApprovalArgs({ body: 'x'.repeat(500) })
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX)
    expect(preview.endsWith('…')).toBe(true)
    expect(summarizeApprovalArgs({ _reason: 'line one\n  line two' })).toBe('line one line two')
  })

  it('flattens a question and never shows an empty ask row', () => {
    expect(summarizeQuestion('Which\n  branch?')).toBe('Which branch?')
    expect(summarizeQuestion('q'.repeat(400)).length).toBeLessThanOrEqual(PREVIEW_MAX)
    expect(summarizeQuestion('   ')).toBe('The agent is waiting for your answer')
  })
})

/**
 * OS-level notifications.
 *
 * The rule that carries the whole feature: notify only when Studio is NOT the
 * focused app. A focused window already renders the in-app toast and the bell
 * badge, and a second, OS-level notice for the same event is the kind of noise
 * that trains people to switch notifications off. Everything else here guards
 * the OS notification centre itself — a burst collapses instead of stacking,
 * and a request answered elsewhere has its toast retracted rather than left
 * sitting there as a clickable lie.
 *
 * Electron lives behind NativeNotifierPlatform, so the policy is exercised as
 * pure state: these tests drive apply() with hub snapshots exactly as the real
 * wiring drives it from approvalHub.subscribe.
 */
describe('native notifications', () => {
  interface FakeToast {
    title: string
    body: string
    click: () => void
    closed: boolean
  }

  function makeFakePlatform(overrides: { enabled?: boolean; supported?: boolean } = {}) {
    const toasts: FakeToast[] = []
    const revealed: string[] = []
    let panelOpens = 0
    let focused = false
    let clock = 10_000

    const platform: NativeNotifierPlatform = {
      isSupported: () => overrides.supported ?? true,
      isEnabled: () => overrides.enabled ?? true,
      isWindowFocused: () => focused,
      now: () => clock,
      show: (request) => {
        const toast: FakeToast = {
          title: request.title,
          body: request.body,
          click: request.onClick,
          closed: false,
        }
        toasts.push(toast)
        return { close: () => { toast.closed = true } }
      },
      reveal: (pending) => { revealed.push(pending.filePath) },
      openPanel: () => { panelOpens++ },
    }

    return {
      platform,
      toasts,
      revealed,
      open: () => toasts.filter((t) => !t.closed),
      get panelOpens() { return panelOpens },
      setFocused: (value: boolean) => { focused = value },
      advance: (ms: number) => { clock += ms },
    }
  }

  const pendingEntry = (id: string, over: Partial<PendingNotification> = {}): PendingNotification => ({
    id,
    kind: 'approval',
    requestId: id,
    filePath: `/agents/${id}.adf`,
    agentName: id,
    loop: 'main',
    toolName: 'fs_write',
    preview: 'write notes.md',
    requestedAt: 1000,
    ...over,
  })

  const snapshotOf = (...pending: PendingNotification[]) => ({ pending, history: [] })

  it('notifies for a new pending request when no window is focused', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    notifier.apply(snapshotOf(pendingEntry('loop2')))

    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0].title).toBe('loop2 needs approval')
    expect(fake.toasts[0].body).toContain('fs_write')
  })

  it('says "asked a question" for an ask, and names the inner loop', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    notifier.apply(snapshotOf(
      pendingEntry('a1', { kind: 'ask', agentName: 'scout', loop: 'watch', toolName: undefined, preview: 'Which branch?' })
    ))

    expect(fake.toasts[0].title).toBe('scout · watch asked a question')
    expect(fake.toasts[0].body).toBe('Which branch?')
  })

  it('stays silent while a window is focused — the in-app toast owns that case', () => {
    const fake = makeFakePlatform()
    fake.setFocused(true)
    const notifier = new NativeNotifier(fake.platform)

    notifier.apply(snapshotOf(pendingEntry('loop2')))

    expect(fake.toasts).toHaveLength(0)
  })

  it('does not re-announce a request the user was focused for once they leave', () => {
    const fake = makeFakePlatform()
    fake.setFocused(true)
    const notifier = new NativeNotifier(fake.platform)
    notifier.apply(snapshotOf(pendingEntry('loop2')))

    // Alt-tab away: that request is old news, not an arrival.
    fake.setFocused(false)
    notifier.apply(snapshotOf(pendingEntry('loop2')))

    expect(fake.toasts).toHaveLength(0)
  })

  it('honours the off switch and an unsupported platform', () => {
    const off = makeFakePlatform({ enabled: false })
    new NativeNotifier(off.platform).apply(snapshotOf(pendingEntry('a')))
    expect(off.toasts).toHaveLength(0)

    const unsupported = makeFakePlatform({ supported: false })
    new NativeNotifier(unsupported.platform).apply(snapshotOf(pendingEntry('a')))
    expect(unsupported.toasts).toHaveLength(0)
  })

  it('never announces what was already pending when it attached', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)
    const existing = pendingEntry('old')

    notifier.seed([existing])
    notifier.apply(snapshotOf(existing, pendingEntry('new')))

    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0].title).toBe('new needs approval')
  })

  it('closes the toast when the request resolves somewhere else', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)
    notifier.apply(snapshotOf(pendingEntry('loop2')))

    // Answered from the in-chat card, the bell, or an auto-deny timeout.
    notifier.apply(snapshotOf())

    expect(fake.toasts[0].closed).toBe(true)
  })

  it('treats a re-registered id as new again once it has left the list', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)
    notifier.apply(snapshotOf(pendingEntry('loop2')))
    notifier.apply(snapshotOf())
    notifier.apply(snapshotOf(pendingEntry('loop2')))

    expect(fake.toasts).toHaveLength(2)
  })

  it('collapses a burst into one summary instead of stacking toasts', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    const burst = ['a', 'b', 'c', 'd', 'e'].map((id) => pendingEntry(id))
    for (let i = 0; i < burst.length; i++) {
      fake.advance(100)
      notifier.apply(snapshotOf(...burst.slice(0, i + 1)))
    }

    const open = fake.open()
    expect(open).toHaveLength(1)
    expect(open[0].title).toBe('5 approvals waiting')
    // The per-request toasts the burst already produced are retracted.
    expect(fake.toasts.filter((t) => t.title.endsWith('needs approval')).every((t) => t.closed)).toBe(true)
  })

  it('counts a mixed burst honestly and keeps separate events separate', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    const burst = [
      pendingEntry('a'),
      pendingEntry('b', { kind: 'ask', preview: 'q', toolName: undefined }),
      pendingEntry('c'),
      pendingEntry('d'),
    ]
    notifier.apply(snapshotOf(...burst))
    expect(fake.open()[0].title).toBe('4 notifications waiting')

    // Well past the coalescing window: a new arrival is its own event again.
    fake.advance(COALESCE_WINDOW_MS + 1_000)
    notifier.apply(snapshotOf(...burst, pendingEntry('e')))
    const open = fake.open()
    expect(open).toHaveLength(1)
    expect(open[0].title).toBe('e needs approval')
  })

  it('shows up to the threshold individually before summarizing', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    const three = ['a', 'b', 'c'].map((id) => pendingEntry(id))
    notifier.apply(snapshotOf(...three))

    expect(fake.open()).toHaveLength(COALESCE_THRESHOLD)
    expect(fake.open().every((t) => t.title.endsWith('needs approval'))).toBe(true)
  })

  it('clicking a per-request toast reveals that agent; a summary opens the panel', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    notifier.apply(snapshotOf(pendingEntry('loop2')))
    fake.toasts[0].click()
    expect(fake.revealed).toEqual(['/agents/loop2.adf'])

    fake.advance(COALESCE_WINDOW_MS + 1_000)
    const burst = ['a', 'b', 'c', 'd'].map((id) => pendingEntry(id))
    notifier.apply(snapshotOf(pendingEntry('loop2'), ...burst))
    const summary = fake.open().find((t) => t.title.endsWith('waiting'))
    summary?.click()
    expect(fake.panelOpens).toBe(1)
  })

  it('retracts the summary once nothing is pending', () => {
    const fake = makeFakePlatform()
    const notifier = new NativeNotifier(fake.platform)

    const burst = ['a', 'b', 'c', 'd'].map((id) => pendingEntry(id))
    notifier.apply(snapshotOf(...burst))
    expect(fake.open()).toHaveLength(1)

    notifier.apply(snapshotOf())
    expect(fake.open()).toHaveLength(0)
  })
})
