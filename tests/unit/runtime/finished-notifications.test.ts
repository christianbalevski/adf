/**
 * 'finished' notifications: a main loop turn of an agent no client has open
 * ends with a reply, and the runtime records it in the notifications history.
 * Studio announces it like an approval (bell, in-app notice, OS notification),
 * under the Settings → Notifications switches.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { ApprovalHub, approvalHub } from '../../../src/main/runtime/approval-hub'
import { replyTextOf } from '../../../src/main/runtime/agent-executor'
import { FINISHED_FRESH_MS } from '../../../src/shared/utils/finished-notices'
import { interruptLoopTurn } from '../../../src/main/runtime/interrupt-turn'
import { NativeNotifier, notificationPreferences, type NativeNotifierPlatform, type NotificationPreferences } from '../../../src/main/runtime/native-notifier'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { ContentBlock, LLMResponse } from '../../../src/shared/types/provider.types'
import type { Tool } from '../../../src/main/tools/tool.interface'
import type { NotificationsSnapshot, PendingNotification, ResolvedNotification } from '../../../src/shared/types/ipc.types'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const finishedEntry = (id: string, over: Partial<PendingNotification> = {}): PendingNotification => ({
  id, kind: 'finished', requestId: id, filePath: `/agents/${id}.adf`, agentName: id, loop: 'main', preview: 'Report ready', requestedAt: 1, ...over,
})

beforeEach(() => { clearAllUmbilicalBuses(); approvalHub.clear(); approvalHub.setAttendedCheck(null) })
afterEach(() => { approvalHub.clear(); approvalHub.setAttendedCheck(null) })

describe('ApprovalHub.announce', () => {
  it('records a finished notice straight into history, never as pending', () => {
    const hub = new ApprovalHub()
    expect(hub.announce(finishedEntry('a'))).toBe(true)
    expect(hub.snapshot()).toEqual([])
    expect(hub.historySnapshot()).toMatchObject([{ id: 'a', kind: 'finished', preview: 'Report ready', outcome: 'completed' }])
  })

  it('keeps only the newest finished row per agent', () => {
    const hub = new ApprovalHub()
    hub.announce(finishedEntry('a1', { filePath: '/agents/a.adf', preview: 'first' }))
    hub.announce(finishedEntry('b1', { filePath: '/agents/b.adf' }))
    hub.announce(finishedEntry('a2', { filePath: '/agents/a.adf', preview: 'second' }))
    expect(hub.historySnapshot().map((e) => e.id)).toEqual(['a2', 'b1'])
  })

  it('skips an agent a client has open', () => {
    const hub = new ApprovalHub()
    hub.setAttendedCheck((filePath) => filePath === '/agents/open.adf')
    expect(hub.announce(finishedEntry('open'))).toBe(false)
    expect(hub.announce(finishedEntry('other'))).toBe(true)
    expect(hub.historySnapshot().map((e) => e.id)).toEqual(['other'])
  })
})

describe('replyTextOf', () => {
  it('reads text blocks and say messages, never thinking or other tools', () => {
    expect(replyTextOf([
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', id: 't1', name: 'say', input: { message: 'Also this.' } },
      { type: 'tool_use', id: 't2', name: 'fs_write', input: { content: 'not a reply' } },
    ] as ContentBlock[])).toBe('Done.\nAlso this.')
    expect(replyTextOf([{ type: 'text', text: '  ' }, { type: 'tool_use', id: 't', name: 'fs_read', input: {} }] as ContentBlock[])).toBe('')
  })
})

describe('native notifications for finished turns', () => {
  function fakePlatform(prefs: Partial<NotificationPreferences> = {}) {
    const toasts: Array<{ title: string; body: string; click: () => void; closed: boolean }> = []
    const revealed: string[] = []
    let focused = false
    const clock = 1_000_000
    const platform: NativeNotifierPlatform = {
      isSupported: () => true,
      preferences: () => ({ enabled: true, finished: true, inApp: true, previews: true, ...prefs }),
      isWindowFocused: () => focused,
      now: () => clock,
      show: (request) => {
        const toast = { title: request.title, body: request.body, click: request.onClick, closed: false }
        toasts.push(toast)
        return { close: () => { toast.closed = true } }
      },
      reveal: (entry) => { revealed.push(entry.filePath) },
      openPanel: () => {},
    }
    return { platform, toasts, revealed, clock, setFocused: (v: boolean) => { focused = v } }
  }
  const row = (id: string, resolvedAt: number, over: Partial<ResolvedNotification> = {}): ResolvedNotification =>
    ({ ...finishedEntry(id), outcome: 'completed', resolvedAt, ...over })
  const snap = (...history: ResolvedNotification[]): NotificationsSnapshot => ({ pending: [], history })

  it('announces a new finished row with the reply as its body; a click opens the agent', () => {
    const fake = fakePlatform()
    const notifier = new NativeNotifier(fake.platform)
    notifier.apply(snap(row('scout', fake.clock)))
    expect(fake.toasts).toMatchObject([{ title: 'scout finished', body: 'Report ready' }])
    fake.toasts[0].click()
    expect(fake.revealed).toEqual(['/agents/scout.adf'])
    // The same row again is not new; a later pending-only change does not retract it.
    notifier.apply(snap(row('scout', fake.clock)))
    notifier.apply({ pending: [], history: [row('scout', fake.clock)] })
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0].closed).toBe(false)
  })

  it('stays quiet for seeded history and for rows older than the fresh window', () => {
    const fake = fakePlatform()
    const notifier = new NativeNotifier(fake.platform)
    notifier.seed([], [row('old', fake.clock)])
    notifier.apply(snap(row('stale', fake.clock - FINISHED_FRESH_MS - 1), row('old', fake.clock)))
    expect(fake.toasts).toHaveLength(0)
  })

  it('a focused window gets the in-app notice instead, unless in-app notices are off', () => {
    const inApp = fakePlatform()
    inApp.setFocused(true)
    new NativeNotifier(inApp.platform).apply(snap(row('a', inApp.clock)))
    expect(inApp.toasts).toHaveLength(0)

    const osOnly = fakePlatform({ inApp: false })
    osOnly.setFocused(true)
    new NativeNotifier(osOnly.platform).apply(snap(row('a', osOnly.clock)))
    expect(osOnly.toasts).toHaveLength(1)
  })

  it('Agent finished off: no notification; Message previews off: no reply text', () => {
    const off = fakePlatform({ finished: false })
    new NativeNotifier(off.platform).apply(snap(row('a', off.clock)))
    expect(off.toasts).toHaveLength(0)

    const plain = fakePlatform({ previews: false })
    new NativeNotifier(plain.platform).apply(snap(row('a', plain.clock)))
    expect(plain.toasts).toMatchObject([{ title: 'a finished', body: 'Turn complete' }])
  })

  it('coalesces finished turns arriving in separate pushes within the window, and keeps the summary', () => {
    const fake = fakePlatform()
    const notifier = new NativeNotifier(fake.platform)
    const rows: ResolvedNotification[] = []
    for (const id of ['a', 'b', 'c', 'd']) {
      rows.unshift(row(id, fake.clock))
      notifier.apply(snap(...rows))
    }
    const open = fake.toasts.filter((t) => !t.closed)
    expect(open).toMatchObject([{ title: '4 finished turns' }])
    notifier.apply(snap(...rows))
    expect(fake.toasts.filter((t) => !t.closed)).toHaveLength(1)
  })

  it('reads absent settings as on', () => {
    expect(notificationPreferences({ get: () => undefined })).toEqual({ enabled: true, finished: true, inApp: true, previews: true })
    expect(notificationPreferences({ get: (key) => key === 'notificationPreviewsEnabled' ? false : undefined })).toEqual({ enabled: true, finished: true, inApp: true, previews: false })
  })
})

describe('executor: which turns are announced', () => {
  type Step = { text?: string; calls?: Array<{ id: string; name: string; input?: Record<string, unknown> }>; hang?: boolean }

  class ScriptedProvider implements LLMProvider {
    readonly name = 'scripted'
    readonly modelId = 'scripted-v1'
    steps: Step[] = []
    calls = 0
    async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
      this.calls++
      const step = this.steps.shift() ?? { text: '' }
      if (step.hang) {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
          if (opts.signal?.aborted) return onAbort()
          opts.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      const content: ContentBlock[] = [
        ...(step.text !== undefined ? [{ type: 'text', text: step.text } as ContentBlock] : []),
        ...(step.calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} }) as ContentBlock),
      ]
      return { id: `r${this.calls}`, content, stop_reason: step.calls?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
    }
    async validateConfig() { return { valid: true } }
  }

  const countTool: Tool = {
    name: 'test_count',
    description: 'test tool',
    inputSchema: z.record(z.unknown()),
    category: 'system',
    execute: async () => ({ content: 'counted', isError: false }),
    toProviderFormat: () => ({ name: 'test_count', description: 'test tool', input_schema: { type: 'object', properties: {} } }),
  }

  async function buildAgent(label: string) {
    const dir = mkdtempSync(join(tmpdir(), `adf-finished-${label}-`))
    const filePath = join(dir, 'scout.adf')
    createHeadlessAgent({ filePath, name: 'scout', provider: new MockLLMProvider() }).dispose()
    const workspace = AdfWorkspace.open(filePath)
    const base = workspace.getAgentConfig()
    const config = { ...base, tools: [...base.tools, { name: 'test_count', enabled: true, visible: true }] }
    const provider = new ScriptedProvider()
    const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, config, provider })
    agent.registry.register(countTool)
    return { agent, provider, filePath }
  }

  const chat = (text: string) => createDispatch(createEvent({
    type: 'chat',
    source: 'test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
  }), { scope: 'agent' })

  const finished = () => approvalHub.historySnapshot().filter((e) => e.kind === 'finished')

  it('announces the turn\'s last reply, even when tool calls follow it', async () => {
    const { agent, provider, filePath } = await buildAgent('reply')
    provider.steps = [{ text: 'Report ready: 3 issues.', calls: [{ id: 'c1', name: 'test_count' }] }, { text: '' }]
    await agent.executor.executeTurn(chat('check the repo'))
    expect(finished()).toMatchObject([{ kind: 'finished', filePath, agentName: 'scout', loop: 'main', preview: 'Report ready: 3 issues.' }])
  })

  it('records nothing for a turn without a reply, or while a client has the agent open', async () => {
    const { agent, provider, filePath } = await buildAgent('silent')
    provider.steps = [{ calls: [{ id: 'c1', name: 'test_count' }] }, { text: '' }]
    await agent.executor.executeTurn(chat('count'))
    expect(finished()).toEqual([])

    approvalHub.setAttendedCheck((p) => p === filePath)
    provider.steps = [{ text: 'Hello.' }]
    await agent.executor.executeTurn(chat('hi'))
    expect(finished()).toEqual([])
  })

  it('records nothing for an interrupted turn', async () => {
    const { agent, provider } = await buildAgent('interrupt')
    provider.steps = [{ text: 'Partial.', calls: [{ id: 'c1', name: 'test_count' }] }, { hang: true }]
    const turn = agent.executor.executeTurn(chat('work'))
    while (provider.calls < 2) await sleep(5)
    interruptLoopTurn(agent.executor, agent.loopPool)
    await turn
    expect(finished()).toEqual([])
  })
})
