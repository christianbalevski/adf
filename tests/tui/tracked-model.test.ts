// Pure model of tracked agents that are not loaded: the slice built from GET
// /tracked-dirs/agents/all, selection across load / unload, the sidebar tree.

import { describe, expect, it } from 'vitest'
import { initialState, tuiReducer } from '../../src/main/tui/state/reducer'
import { buildTracked, relativeTo, stoppedLabel, trackedKey } from '../../src/main/tui/state/tracked'
import { buildTree } from '../../src/main/tui/views/fleet/Sidebar'
import { findStopped } from '../../src/main/tui/views/fleet/model'
import type { FolderAgent, TrackedAgentsList } from '../../src/main/tui/api/types'
import type { AgentEntry } from '../../src/main/tui/state/types'

const ID_1 = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
const ID_3 = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'

const fa = (filePath: string, name: string, patch: Partial<FolderAgent> = {}): FolderAgent => ({ filePath, name, status: 'stopped', autostart: true, reviewed: true, ...patch })

function list(): TrackedAgentsList {
  return {
    maxDepth: 5,
    folders: [
      { path: '/work/agents', exists: true, agentCount: 3, loadedCount: 1, agents: [
        fa('/work/agents/agent-1.adf', 'agent-1', { status: 'loaded', agentId: ID_1 }),
        fa('/work/agents/team/agent-4.adf', 'agent-4', { status: 'needs_review', reviewed: false }),
        fa('/work/agents/agent-3.adf', 'agent-3', { agentId: ID_3 }),
      ] },
      { path: '/work/lab', exists: true, agentCount: 1, loadedCount: 0, agents: [
        fa('/work/lab/agent-5.adf', 'agent-5', { status: 'unreadable', error: 'Not a readable .adf' }),
      ] },
    ],
  }
}

const summary = (id: string, handle: string, filePath: string) => ({ id, filePath, name: handle, handle, autostart: true })
const entry = (id: string, handle: string, filePath: string): AgentEntry => ({ summary: summary(id, handle, filePath), pendingTasks: [], pendingAsks: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unreadInbox: 0, loops: [] })

describe('tracked agents model', () => {
  it('keeps the not-loaded agents, by folder then relative path, with labels', () => {
    const t = buildTracked(list(), [summary(ID_1, 'agent-1', '/work/agents/agent-1.adf')], null)
    expect(t.stopped.map(s => s.relPath)).toEqual(['agent-3.adf', 'team/agent-4.adf', 'agent-5.adf'])
    expect(t.stopped.map(s => stoppedLabel(s))).toEqual(['stopped', 'needs review', 'unreadable'])
    expect(stoppedLabel(t.stopped[0], { '/work/agents/agent-3.adf': 'boom' })).toBe('load error')
    expect(relativeTo('C:\\work\\agents', 'C:\\work\\agents\\team\\a.adf')).toBe('team/a.adf')
    // A file loaded under another spelling (the daemon's summary path) is not listed as stopped.
    const again = buildTracked(list(), [summary(ID_3, 'agent-3', '/work/agents/agent-3.adf')], t)
    expect(again.stopped.map(s => s.agent.name)).toEqual(['agent-4', 'agent-5'])
  })

  it('selection follows an agent across load and unload', () => {
    let s = tuiReducer(initialState('http://x'), { type: 'agents/loaded', agents: [summary(ID_1, 'agent-1', '/work/agents/agent-1.adf')] })
    s = tuiReducer(s, { type: 'tracked/loaded', list: list() })
    const key = trackedKey('/work/agents/agent-3.adf')
    s = tuiReducer(s, { type: 'select/agent', agentId: key })
    // Loaded (anywhere): the selection moves to the loaded agent.
    s = tuiReducer(s, { type: 'agents/loaded', agents: [summary(ID_1, 'agent-1', '/work/agents/agent-1.adf'), summary(ID_3, 'agent-3', '/work/agents/agent-3.adf')] })
    expect(s.selectedAgentId).toBe(ID_3)
    expect(s.tracked?.stopped.map(t => t.agent.name)).toEqual(['agent-4', 'agent-5'])
    // Unloaded: back to its stopped entry (kept until the next tracked read confirms it).
    s = tuiReducer(s, { type: 'agents/loaded', agents: [summary(ID_1, 'agent-1', '/work/agents/agent-1.adf')] })
    expect(s.selectedAgentId).toBe(key)
    s = tuiReducer(s, { type: 'tracked/loaded', list: list() })
    expect(s.selectedAgentId).toBe(key)
    // Gone from the folders: the first agent.
    s = tuiReducer(s, { type: 'tracked/loaded', list: { maxDepth: 5, folders: [] } })
    expect(s.selectedAgentId).toBe(ID_1)
  })

  it('load errors stay until the file loads; busy marks work in progress', () => {
    let s = tuiReducer(initialState('http://x'), { type: 'tracked/loaded', list: list() })
    s = tuiReducer(s, { type: 'tracked/file-error', filePath: '/work/agents/agent-3.adf', error: 'boom' })
    s = tuiReducer(s, { type: 'tracked/busy', filePath: '/work/agents/agent-4.adf', busy: 'loading' })
    s = tuiReducer(s, { type: 'tracked/loaded', list: list() })
    expect(s.tracked?.errors).toEqual({ '/work/agents/agent-3.adf': 'boom' })
    expect(s.tracked?.busy).toEqual({ '/work/agents/agent-4.adf': 'loading' })
    s = tuiReducer(s, { type: 'agents/loaded', agents: [summary(ID_3, 'agent-3', '/work/agents/agent-3.adf')] })
    expect(s.tracked?.errors).toEqual({})
  })

  it('the sidebar tree: loaded agents, then a header per folder with its stopped agents; filter matches both', () => {
    const tracked = buildTracked(list(), [summary(ID_1, 'agent-1', '/work/agents/agent-1.adf')], null)
    const agents = [entry(ID_1, 'agent-1', '/work/agents/agent-1.adf')]
    expect(buildTree(agents, {}, '', tracked).map(r => r.key)).toEqual([
      `a:${ID_1}`, 'd:/work/agents', trackedKey('/work/agents/agent-3.adf'), trackedKey('/work/agents/team/agent-4.adf'), 'd:/work/lab', trackedKey('/work/lab/agent-5.adf'),
    ])
    expect(buildTree(agents, {}, 'agent-4', tracked).map(r => r.key)).toEqual(['d:/work/agents', trackedKey('/work/agents/team/agent-4.adf')])
    expect(buildTree(agents, {}, '', null).map(r => r.key)).toEqual([`a:${ID_1}`])
    expect(findStopped({ tracked }, 'agent-4')).toBe(trackedKey('/work/agents/team/agent-4.adf'))
  })
})
