import { describe, expect, it, beforeEach } from 'vitest'
import {
  useMeshGraphStore,
  applyActivity,
  applyEdgeAnimation,
  type MeshGraphState,
  type NodeActivity
} from '../../../src/renderer/stores/mesh-graph.store'
import { useMeshStore } from '../../../src/renderer/stores/mesh.store'
import type { FleetAgentStatus } from '../../../src/shared/types/ipc.types'

const A = 'C:/agents/agent-1.adf'
const B = 'C:/agents/agent-2.adf'

const tool = (timestamp: number, id = `a${timestamp}`): NodeActivity => ({
  id,
  toolName: 'sys_read',
  timestamp,
  type: 'tool_start'
})

const roster = (...filePaths: string[]): FleetAgentStatus[] =>
  filePaths.map((filePath) => ({ filePath, online: true }) as unknown as FleetAgentStatus)

describe('mesh graph pulse rings', () => {
  beforeEach(() => {
    useMeshGraphStore.getState().reset()
    useMeshStore.getState().reset()
  })

  it('counts tool starts without handing out a new pulse array', () => {
    const store = useMeshGraphStore.getState()
    const ring = store.activityPulse
    store.addActivity(A, tool(1_000))
    store.addActivity(A, tool(2_000))
    const next = useMeshGraphStore.getState()
    // Same ring buffer, mutated in place — nothing subscribes to it.
    expect(next.activityPulse).toBe(ring)
    expect(next.activityPulse).toEqual([1_000, 2_000])
    expect(next.activityInWindow).toBe(2)
  })

  it('leaves the counters alone for a state entry and skips its agent pulse', () => {
    const store = useMeshGraphStore.getState()
    store.addActivity(A, { id: 's1', toolName: '', timestamp: 500, type: 'state', args: 'idle' })
    const next = useMeshGraphStore.getState()
    expect(next.activityInWindow).toBe(0)
    expect(next.agentPulse[A]).toBeUndefined()
    expect(next.lastActivityAt[A]).toBe(500)
  })

  it('records a per-agent pulse for non-state entries', () => {
    const store = useMeshGraphStore.getState()
    store.addActivity(A, tool(1_000))
    store.addActivity(B, tool(1_100))
    store.addActivity(A, tool(1_200))
    const { agentPulse } = useMeshGraphStore.getState()
    expect(agentPulse[A]).toEqual([1_000, 1_200])
    expect(agentPulse[B]).toEqual([1_100])
  })

  it('drops pulse entries that fell out of the window once half are stale', () => {
    const store = useMeshGraphStore.getState()
    const now = Date.now()
    // Two entries well outside the 5-min window, then two inside it.
    for (const t of [now - 20 * 60_000, now - 19 * 60_000, now - 1_000, now]) {
      store.addActivity(A, tool(t, `t${t}`))
    }
    const { activityPulse, activityInWindow } = useMeshGraphStore.getState()
    expect(activityPulse.every((t) => t > now - 5 * 60_000)).toBe(true)
    expect(activityInWindow).toBe(activityPulse.length)
  })

  it('counts routed messages in the window without exposing the message ring', () => {
    const store = useMeshGraphStore.getState()
    const ring = store.messagePulse
    store.triggerEdgeAnimation(A, [B])
    store.triggerEdgeAnimation(B, [A])
    const next = useMeshGraphStore.getState()
    expect(next.messagePulse).toBe(ring)
    expect(next.messageInWindow).toBe(2)
  })

  it('keeps the reducers chainable over a draft state', () => {
    // The fleet map folds a frame's events through the pure reducers before a
    // single set() — each one must read the previous one's output.
    let draft = useMeshGraphStore.getState()
    draft = { ...draft, ...applyActivity(draft, A, tool(1_000)) } as MeshGraphState
    draft = { ...draft, ...applyEdgeAnimation(draft, A, [B]) } as MeshGraphState
    expect(draft.activityInWindow).toBe(1)
    expect(draft.messageInWindow).toBe(1)
    expect(draft.nodeActivities[A]).toHaveLength(1)
    expect(draft.liveRoutes[`${A}|${B}`]).toEqual({ from: A, to: B })
  })
})

describe('mesh graph cleanup eviction', () => {
  beforeEach(() => {
    useMeshGraphStore.getState().reset()
    useMeshStore.getState().reset()
  })

  it('evicts per-agent keys for agents that left the fleet', () => {
    const store = useMeshGraphStore.getState()
    store.addActivity(A, tool(Date.now()))
    store.addActivity(B, tool(Date.now()))
    store.triggerEdgeAnimation(A, [B])
    useMeshStore.getState().setAgents(roster(A))

    useMeshGraphStore.getState().cleanupAnimations()

    const next = useMeshGraphStore.getState()
    expect(Object.keys(next.nodeActivities)).toEqual([A])
    expect(Object.keys(next.lastActivityAt)).toEqual([A])
    expect(Object.keys(next.agentPulse)).toEqual([A])
    expect(next.liveRoutes[`${A}|${B}`]).toBeUndefined()
  })

  it('keeps everything while the roster is empty', () => {
    const store = useMeshGraphStore.getState()
    store.addActivity(A, tool(Date.now()))
    useMeshGraphStore.getState().cleanupAnimations()
    expect(useMeshGraphStore.getState().nodeActivities[A]).toBeDefined()
  })

  it('keeps routes whose far end is a peer station', () => {
    const store = useMeshGraphStore.getState()
    store.triggerEdgeAnimation(A, ['station:peer-1'])
    useMeshStore.getState().setAgents(roster(A))
    useMeshGraphStore.getState().cleanupAnimations()
    expect(useMeshGraphStore.getState().liveRoutes[`${A}|station:peer-1`]).toEqual({
      from: A,
      to: 'station:peer-1'
    })
  })
})
