import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import type { AgentLogEntry } from '../../../src/renderer/stores/agent.store'

/**
 * Terminal state for renderer-synthesized (outOfBand) approval entries.
 *
 * LIVE BUG: a protection override raised inside the shell pipeline (e.g.
 * `adf fs_delete` on a read-only file) has no tool_call of its own in the
 * loop, so the renderer synthesizes an out-of-band entry to host the
 * approve/deny prompt. Approving removed the prompt but nothing ever paired a
 * result to the synthesized entry — the gated call runs inside adf_shell and
 * reports in-band — so the entry rendered as "running… / Pending…" forever,
 * then silently vanished on reload (it was never persisted to adf_loop).
 */

const entry = (id: string, metadata: Record<string, unknown>): AgentLogEntry =>
  ({ id, type: 'tool_call', content: 'Calling fs_delete', timestamp: 1, metadata })

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('markApprovalOutcome', () => {
  it('stamps approved on a synthesized outOfBand entry', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(entry('e1', { name: 'fs_delete', outOfBand: true }))
    store.markApprovalOutcome('e1', true)
    expect(useAgentStore.getState().log[0].metadata?.overrideOutcome).toBe('approved')
  })

  it('stamps denied on rejection', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(entry('e1', { name: 'fs_delete', outOfBand: true }))
    store.markApprovalOutcome('e1', false)
    expect(useAgentStore.getState().log[0].metadata?.overrideOutcome).toBe('denied')
  })

  it('leaves real (in-loop) tool calls untouched — their paired result is the terminal state', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(entry('e1', { name: 'fs_delete', tool_id: 'toolu_1' }))
    store.markApprovalOutcome('e1', true)
    expect(useAgentStore.getState().log[0].metadata?.overrideOutcome).toBeUndefined()
  })

  it('is a no-op for unknown entry ids', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(entry('e1', { name: 'fs_delete', outOfBand: true }))
    const version = useAgentStore.getState().logVersion
    store.markApprovalOutcome('missing', true)
    expect(useAgentStore.getState().logVersion).toBe(version)
  })

  it('replaces the entry reference so memoized rows re-render', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(entry('e1', { name: 'fs_delete', outOfBand: true }))
    const before = useAgentStore.getState().log[0]
    store.markApprovalOutcome('e1', true)
    expect(useAgentStore.getState().log[0]).not.toBe(before)
  })
})
