/**
 * Approval surfaces in the renderer: the card says why a wait ended with no
 * decision, the split buttons' menus are separate keyboard-reachable buttons,
 * the tool call modal is a real dialog, "Review N calls" lists each call with
 * one confirm and no always-approve, and a bell override row names its target.
 *
 * No jsdom here: components render to static markup.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { ApprovalControls } from '../../../src/renderer/components/agent/ApprovalControls'
import { ApprovalReviewDialog } from '../../../src/renderer/components/agent/ApprovalReviewDialog'
import { ToolCallModal } from '../../../src/renderer/components/agent/ToolCallModal'
import { ApprovalRow } from '../../../src/renderer/components/layout/ApprovalsMenu'
import type { AgentExecutionEvent, PendingNotification } from '../../../src/shared/types/ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const TASK = 'task_3f1c2b7a9e11'
const agentEvent = (type: string, payload: Record<string, unknown>): AgentExecutionEvent => ({ type, payload, timestamp: 1 } as AgentExecutionEvent)

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('a drained approval wait', () => {
  it('clears the card and records why it ended, not a denial', () => {
    const store = useAgentStore.getState()
    store.addLogEntry({ id: 'e1', type: 'tool_call', content: 'Calling fs_write', timestamp: 1, metadata: { name: 'fs_write', input: { path: 'a.md' }, outOfBand: true } })
    const handle = createAgentEventHandler()
    handle(agentEvent('tool_approval_request', { requestId: TASK, taskId: TASK, name: 'fs_write', input: { path: 'a.md' }, reason: 'restricted', canAlwaysApprove: true }))
    expect(useAgentStore.getState().pendingApprovals.size).toBe(1)

    handle(agentEvent('tool_approval_resolved', { requestId: TASK, approved: false, endedBy: 'chat' }))

    const state = useAgentStore.getState()
    expect(state.pendingApprovals.size).toBe(0)
    expect(state.log[0].metadata?.approvalEndedBy).toBe('chat')
    expect(state.log[0].metadata?.overrideOutcome).toBeUndefined()
  })
})

describe('ApprovalControls', () => {
  it('each caret is its own menu button with a name, at least 24px tall', () => {
    const html = renderToStaticMarkup(
      <ApprovalControls compact toolName="fs_write" onApprove={() => {}} onAlwaysApprove={() => {}} onReject={() => {}} />
    )
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2)
    expect(html).toContain('aria-label="More approve options for fs_write"')
    expect(html).toContain('aria-label="More reject options for fs_write"')
    expect(html).toContain('h-6')
    expect(html).toContain('w-6')
    expect(html).not.toContain('Always approve')
  })

  it('busy disables every button', () => {
    const html = renderToStaticMarkup(
      <ApprovalControls busy toolName="fs_write" onApprove={() => {}} onAlwaysApprove={() => {}} onReject={() => {}} />
    )
    expect(html.match(/disabled=""/g)).toHaveLength(4)
  })
})

describe('ToolCallModal', () => {
  it('is a modal dialog labelled by its tool name', () => {
    const html = renderToStaticMarkup(<ToolCallModal toolName="fs_write" input={{ path: 'a.md' }} awaitingApproval onClose={() => {}} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(labelledBy).toBeTruthy()
    expect(html).toContain(`id="${labelledBy}"`)
    expect(html).toContain('tabindex="-1"')
  })
})

describe('Review N calls', () => {
  it('lists each call by tool and short target, one confirm, no always-approve', () => {
    const html = renderToStaticMarkup(
      <ApprovalReviewDialog
        open
        calls={[
          { requestId: 'task_1', toolName: 'fs_write', target: 'notes.md' },
          { requestId: 'task_2', toolName: 'sys_fetch', target: 'example.com/a' },
        ]}
        overrideCount={1}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('Review 2 calls')
    expect(html).toContain('notes.md')
    expect(html).toContain('example.com/a')
    expect(html).toContain('Approve 2 calls')
    expect(html).toContain('1 protection override is not included.')
    expect(html).not.toMatch(/always/i)
  })

  it('shows why a confirm did not land', () => {
    const html = renderToStaticMarkup(
      <ApprovalReviewDialog open calls={[{ requestId: 'task_1', toolName: 'fs_write', target: 'notes.md' }]} overrideCount={0} busy={false} error="1 of 2 could not be approved" onConfirm={() => {}} onClose={() => {}} />
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('1 of 2 could not be approved')
  })
})

describe('the bell', () => {
  const pending = (over: Partial<PendingNotification>): PendingNotification => ({
    id: `/agents/agent-1.adf|main|${TASK}`,
    kind: 'approval',
    requestId: TASK,
    filePath: '/agents/agent-1.adf',
    agentName: 'agent-1',
    loop: 'main',
    toolName: 'fs_delete',
    preview: '{"path":"notes.md"}',
    reason: 'restricted',
    requestedAt: Date.now(),
    ...over,
  })

  it('an override row is marked and names its protected target; a routine row is not', () => {
    const row = (approval: PendingNotification) =>
      renderToStaticMarkup(<ApprovalRow approval={approval} now={Date.now()} onJump={() => {}} onInspect={() => {}} />)
    const override = row(pending({ reason: 'protection', protection: { kind: 'file', target: 'notes.md', level: 'read_only', description: 'Delete notes.md — file is protected (read_only)' } }))
    expect(override).toContain('>override<')
    expect(override).toContain('fs_delete · notes.md')
    expect(override).toContain('title="Show the full request"')
    const routine = row(pending({ toolName: 'fs_write' }))
    expect(routine).not.toContain('>override<')
    expect(routine).not.toContain(' · ')
  })
})
