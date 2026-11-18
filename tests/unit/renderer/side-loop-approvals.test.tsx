/**
 * An inner loop's approvals in the renderer: they restore into that loop's
 * tab on re-attach, survive the tab's history loading on first open, show as a
 * count on the loop's tab, and toast unless that loop is the one in view.
 *
 * No jsdom here: components render to static markup.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore, selectLoopSlice, type AgentLogEntry } from '../../../src/renderer/stores/agent.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { rebindPendingRequests, restorePendingApproval, restorePendingAsk } from '../../../src/renderer/hooks/approval-target'
import { arrivalsToAnnounce } from '../../../src/renderer/hooks/useApprovals'
import { LoopPendingBadge } from '../../../src/renderer/components/agent/AgentLoop'
import type { AgentExecutionEvent, NotificationsSnapshot, PendingNotification } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const FILE = '/agents/a.adf'

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('re-attach restore', () => {
  it('puts a side loop\'s approval in that loop\'s slice, not main\'s', () => {
    restorePendingApproval({ requestId: 'task_1', name: 'fs_write', input: { path: 'a.md' }, loop: 'critic' }, { reason: 'restricted' })
    restorePendingApproval({ requestId: 'task_2', name: 'fs_read', input: { path: 'b.md' } }, { reason: 'restricted' })

    const state = useAgentStore.getState()
    const critic = selectLoopSlice(state, 'critic')
    expect([...critic.pendingApprovals.values()].map((info) => info.requestId)).toEqual(['task_1'])
    expect(critic.log).toHaveLength(1)
    expect([...state.pendingApprovals.values()].map((info) => info.requestId)).toEqual(['task_2'])
  })

  it('binds two approvals for one tool to two calls, not one', () => {
    const store = useAgentStore.getState()
    store.addLogEntry({ id: 'c1', type: 'tool_call', content: '', timestamp: 1, metadata: { name: 'fs_write' } }, 'critic')
    store.addLogEntry({ id: 'c2', type: 'tool_call', content: '', timestamp: 2, metadata: { name: 'fs_write' } }, 'critic')
    restorePendingApproval({ requestId: 'task_1', name: 'fs_write', input: {}, loop: 'critic' }, {})
    restorePendingApproval({ requestId: 'task_2', name: 'fs_write', input: {}, loop: 'critic' }, {})
    expect([...selectLoopSlice(useAgentStore.getState(), 'critic').pendingApprovals.keys()].sort()).toEqual(['c1', 'c2'])
  })
})

describe('asks in their loop', () => {
  it('re-attach restores a side loop\'s ask into that loop\'s slice', () => {
    restorePendingAsk({ requestId: 'ask_1', questions: [{ question: 'Which?' }], loop: 'critic' })
    restorePendingAsk({ requestId: 'ask_1', questions: [{ question: 'Why?' }] })
    const state = useAgentStore.getState()
    expect([...selectLoopSlice(state, 'critic').pendingAsks.values()].map((a) => a.questions[0].question)).toEqual(['Which?'])
    expect([...state.pendingAsks.values()].map((a) => a.questions[0].question)).toEqual(['Why?'])
  })

  it('a live ask_request lands in the asking loop\'s slice and survives its history loading', () => {
    createAgentEventHandler()({ type: 'ask_request', payload: { requestId: 'ask_1', questions: [{ question: 'Which?' }] }, timestamp: 1, loop: 'critic' } as AgentExecutionEvent)
    const before = selectLoopSlice(useAgentStore.getState(), 'critic')
    expect(before.pendingAsks.size).toBe(1)
    expect(useAgentStore.getState().pendingAsks.size).toBe(0)

    useAgentStore.getState().setLog([
      { id: 'h1', type: 'tool_call', content: 'Calling ask', timestamp: 1, metadata: { name: 'ask', input: {} } },
    ], 0, 'critic')
    rebindPendingRequests(before, 'critic')
    const after = selectLoopSlice(useAgentStore.getState(), 'critic')
    expect([...after.pendingAsks.entries()].map(([id, a]) => [id, a.requestId])).toEqual([['h1', 'ask_1']])
  })
})

describe('a side loop\'s history loading on first open', () => {
  it('keeps an approval that arrived before the history', () => {
    const handle = createAgentEventHandler()
    handle({
      type: 'tool_approval_request',
      payload: { requestId: 'task_1', taskId: 'task_1', name: 'fs_write', input: { path: 'a.md' }, reason: 'restricted' },
      timestamp: 1,
      loop: 'critic',
    } as AgentExecutionEvent)
    const before = selectLoopSlice(useAgentStore.getState(), 'critic')
    expect(before.pendingApprovals.size).toBe(1)

    // The tab opens: its stored history replaces the slice's log.
    const history: AgentLogEntry[] = [
      { id: 'h1', type: 'user', content: 'go', timestamp: 0 },
      { id: 'h2', type: 'tool_call', content: 'Calling fs_write', timestamp: 1, metadata: { name: 'fs_write', input: { path: 'a.md' } } },
    ]
    useAgentStore.getState().setLog(history, 0, 'critic')
    rebindPendingRequests(before, 'critic')

    const after = selectLoopSlice(useAgentStore.getState(), 'critic')
    const ids = new Set(after.log.map((entry) => entry.id))
    const bound = [...after.pendingApprovals.entries()]
    expect(bound.map(([, info]) => info.requestId)).toEqual(['task_1'])
    expect(ids.has(bound[0][0])).toBe(true)
    // Main never got a copy.
    expect(useAgentStore.getState().pendingApprovals.size).toBe(0)
  })
})

describe('loop tab badge', () => {
  it('counts the loop slice\'s pending approvals, with a plain label', () => {
    const store = useAgentStore.getState()
    store.addPendingApproval('e1', 'task_1', { reason: 'restricted' }, 'critic')
    store.addPendingApproval('e2', 'task_2', { reason: 'restricted' }, 'critic')
    // What LoopTab reads for an inner loop.
    const count = selectLoopSlice(useAgentStore.getState(), 'critic').pendingApprovals.size
    expect(count).toBe(2)
    const html = renderToStaticMarkup(<LoopPendingBadge approvals={count} asks={0} />)
    expect(html).toContain('aria-label="2 pending approvals"')
    expect(html).toMatch(/>2<\/span>/)
    expect(renderToStaticMarkup(<LoopPendingBadge approvals={1} asks={0} />)).toContain('aria-label="1 pending approval"')
    expect(renderToStaticMarkup(<LoopPendingBadge approvals={0} asks={0} />)).toBe('')
  })

  it('counts questions too, as the sidebar\'s waiting ring does', () => {
    useAgentStore.getState().addPendingAsk('a1', 'ask_1', [{ question: 'Which?' }], 'critic')
    expect(selectLoopSlice(useAgentStore.getState(), 'critic').pendingAsks.size).toBe(1)
    const html = renderToStaticMarkup(<LoopPendingBadge approvals={2} asks={1} />)
    expect(html).toContain('aria-label="2 pending approvals, 1 pending question"')
    expect(html).toMatch(/>3<\/span>/)
    expect(renderToStaticMarkup(<LoopPendingBadge approvals={0} asks={2} />)).toContain('aria-label="2 pending questions"')
  })
})

describe('toasts for the open agent', () => {
  const n = (id: string, loop: string): PendingNotification => ({
    id, kind: 'approval', requestId: id, filePath: FILE, agentName: 'a', loop, toolName: 'fs_write', preview: 'a.md', requestedAt: 1,
  } as PendingNotification)
  const snapshot = (...pending: PendingNotification[]): NotificationsSnapshot => ({ pending, history: [] })

  it('stay quiet only for the loop in view', () => {
    const s = snapshot(n('m1', 'main'), n('c1', 'critic'))
    // Viewing main: main's card is on screen, the critic's is not.
    expect(arrivalsToAnnounce(s, new Set(), FILE, 'main').map((x) => x.id)).toEqual(['c1'])
    // Viewing the critic's tab: the reverse.
    expect(arrivalsToAnnounce(s, new Set(), FILE, 'critic').map((x) => x.id)).toEqual(['m1'])
  })
})
