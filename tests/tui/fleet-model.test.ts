import { describe, expect, it } from 'vitest'
import {
  completePath,
  describeAgent,
  describeLoop,
  expandPath,
  findAgent,
  formatIn,
  nextRunByLoop,
  parseAgentLoopRef,
  timerLoop,
} from '../../src/main/tui/views/fleet/model'
import { buildTree } from '../../src/main/tui/views/fleet/Sidebar'
import type { AgentEntry, LoopState } from '../../src/main/tui/state/types'
import type { Timer } from '../../src/main/tui/api/types'

const ID_1 = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
const ID_2 = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'

function loop(name: string, patch: Partial<LoopState['info']> = {}, executorState?: LoopState['executorState']): LoopState {
  return { info: { name, goal: `${name} goal`, status: 'idle', enabled: true, isMain: name === 'main', config: null, entryCount: 0, effectiveTools: null, ...patch }, executorState }
}

function agent(id: string, handle: string, patch: Partial<AgentEntry> = {}): AgentEntry {
  return {
    summary: { id, filePath: `/agents/${handle}.adf`, name: handle, handle, autostart: false },
    pendingTasks: [],
    pendingAsks: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    unreadInbox: 0,
    executorState: 'idle',
    loops: [loop('main'), loop('consolidator'), loop('researcher')],
    ...patch,
  }
}

function timer(id: number, next: number, patch: Partial<Timer> = {}): Timer {
  return { id, schedule: { mode: 'interval', every_ms: 3_600_000 } as Timer['schedule'], next_wake_at: next, scope: ['agent'], run_count: 0, created_at: 0, ...patch }
}

describe('fleet model', () => {
  it('derives agent state from main and inner loops', () => {
    expect(describeAgent(agent(ID_1, 'agent-1'))).toMatchObject({ kind: 'idle', busy: false, runningLoops: [] })
    const inner = agent(ID_1, 'agent-1', { loops: [loop('main'), loop('consolidator', { status: 'running' }, 'thinking')] })
    expect(describeAgent(inner)).toMatchObject({ kind: 'busy', busy: true, runningLoops: ['consolidator'] })
    expect(describeAgent(agent(ID_1, 'agent-1', { executorState: 'tool_use' })).runningLoops).toEqual(['main'])
    expect(describeAgent(agent(ID_1, 'agent-1', { error: 'boom' })).kind).toBe('error')
    expect(describeAgent(agent(ID_1, 'agent-1', { executorState: 'hibernate' })).kind).toBe('hibernate')
    const disabled = agent(ID_1, 'agent-1', { loops: [loop('main'), loop('critic', { enabled: false, status: 'running' })] })
    expect(describeAgent(disabled).busy).toBe(false)
    expect(describeLoop(disabled, disabled.loops![1])).toEqual({ kind: 'disabled', label: 'off' })
  })

  it('maps timers to the loops they wake', () => {
    const now = 1_000_000
    const timers = [
      timer(1, now + 3_600_000, { loop: 'consolidator' }),
      timer(2, now + 60_000, { loop: 'consolidator' }),
      timer(3, now + 5_000),
      timer(4, now + 1_000, { scope: ['system'] as Timer['scope'] }),
      timer(5, now + 10, { loop: 'researcher', expired: true }),
    ]
    expect(timerLoop(timers[2])).toBe('main')
    expect(timerLoop(timers[3])).toBeNull()
    expect(nextRunByLoop(timers)).toEqual({ consolidator: now + 60_000, main: now + 5_000 })
    expect(formatIn(now + 42 * 60_000, now)).toBe('in 42m')
    expect(formatIn(now - 1, now)).toBe('due')
  })

  it('finds agents fuzzily and parses agent/loop refs', () => {
    const state = { agentOrder: [ID_1, ID_2], agents: { [ID_1]: agent(ID_1, 'agent-1'), [ID_2]: agent(ID_2, 'agent-2') } }
    expect(findAgent(state, 'agent-2')).toBe(ID_2)
    expect(findAgent(state, ID_1)).toBe(ID_1)
    expect(findAgent(state, 'ag2')).toBe(ID_2)
    expect(findAgent(state, 'zzz')).toBeNull()
    expect(parseAgentLoopRef('agent-1/consolidator')).toEqual({ agent: 'agent-1', loop: 'consolidator' })
    expect(parseAgentLoopRef('agent-1:researcher')).toEqual({ agent: 'agent-1', loop: 'researcher' })
    expect(parseAgentLoopRef('agent-1')).toEqual({ agent: 'agent-1' })
  })

  it('builds the tree with collapse and type-to-filter', () => {
    const agents = [agent(ID_1, 'agent-1'), agent(ID_2, 'agent-2', { loops: [loop('main')] })]
    expect(buildTree(agents, {}, '').map(r => r.key)).toEqual([
      `a:${ID_1}`, `l:${ID_1}:main`, `l:${ID_1}:consolidator`, `l:${ID_1}:researcher`, `a:${ID_2}`, `l:${ID_2}:main`,
    ])
    expect(buildTree(agents, { [ID_1]: true }, '').map(r => r.key)).toEqual([`a:${ID_1}`, `a:${ID_2}`, `l:${ID_2}:main`])
    // A loop match shows its agent (expanded even if collapsed) and only the matching loops.
    expect(buildTree(agents, { [ID_1]: true }, 'cons').map(r => r.key)).toEqual([`a:${ID_1}`, `l:${ID_1}:consolidator`])
    expect(buildTree(agents, {}, 'agent-2').map(r => r.key)).toEqual([`a:${ID_2}`, `l:${ID_2}:main`])
  })

  it('completes directories and .adf files like a shell', () => {
    const tree: Record<string, Array<{ name: string; dir: boolean }>> = {
      '/work': [{ name: 'agents', dir: true }, { name: 'notes.txt', dir: false }, { name: 'agent-1.adf', dir: false }, { name: '.hidden', dir: true }],
      '/work/agents': [{ name: 'agent-2.adf', dir: false }, { name: 'agent-3.adf', dir: false }],
    }
    const list = (dir: string) => tree[dir.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')] ?? []
    const opts = { cwd: '/work', home: '/home/me', list, ignoreCase: false, separator: '/' }
    expect(completePath('agents', opts)).toEqual({ value: 'agents/', candidates: ['agents/'] })
    expect(completePath('age', opts).candidates).toEqual(['agents/', 'agent-1.adf'])
    expect(completePath('age', opts).value).toBe('agent')
    expect(completePath('agents/a', opts)).toEqual({ value: 'agents/agent-', candidates: ['agent-2.adf', 'agent-3.adf'] })
    expect(completePath('agents/agent-3', opts).value).toBe('agents/agent-3.adf')
    expect(completePath('n', opts)).toEqual({ value: 'n', candidates: [] })
    expect(expandPath('~/x.adf', { home: '/home/me', cwd: '/work' }).replace(/\\/g, '/')).toMatch(/\/home\/me\/x\.adf$/)
  })
})
