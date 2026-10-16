import { describe, expect, it } from 'vitest'
import type { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore } from '../../src/main/tui/state/store'
import { trackedKey } from '../../src/main/tui/state/tracked'
import type { TrackedAgentsList } from '../../src/main/tui/api/types'

const FOLDER = '/agents'
const FILE_1 = `${FOLDER}/agent-1.adf`
const FILE_2 = `${FOLDER}/agent-2.adf`
const AGENT_1 = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function setup(delayed: 'load' | 'refresh' | null) {
  const pending = deferred()
  const entered = deferred()
  const list: TrackedAgentsList = {
    maxDepth: 5,
    folders: [{ path: FOLDER, exists: true, agentCount: 2, loadedCount: 0, agents: [FILE_1, FILE_2].map((filePath, n) => ({ filePath, name: `agent-${n + 1}`, status: 'stopped', autostart: false, reviewed: true })) }],
  }
  const client = {
    baseUrl: 'http://127.0.0.1:47390',
    async load() {
      if (delayed === 'load') { entered.resolve(); await pending.promise }
      return { id: AGENT_1, config: { name: 'agent-1' } }
    },
    async start() { return { startupTriggered: false } },
    async trackedAgents() { return list },
    async config() { return { config: { name: 'agent-1' } } },
    async loopHistory() { return { entries: [], total: 0, offset: 0 } },
  } as unknown as DaemonClient
  const store = createTuiStore({ client, live: false })
  store.dispatch({ type: 'tracked/loaded', list })
  store.actions.selectAgent(trackedKey(FILE_1))
  store.actions.refreshAgents = async () => {
    store.dispatch({ type: 'agents/loaded', agents: [{ id: AGENT_1, filePath: FILE_1, name: 'agent-1', handle: 'agent-1', autostart: false }] })
    if (delayed === 'refresh') { entered.resolve(); await pending.promise }
  }
  return { store, pending, entered }
}

describe('tracked agent start selection', () => {
  it.each(['load', 'refresh'] as const)('preserves a different stopped agent selected while %s is pending', async (delayed) => {
    const { store, pending, entered } = setup(delayed)
    try {
      const starting = store.actions.startTracked(trackedKey(FILE_1))
      await entered.promise
      store.actions.selectAgent(trackedKey(FILE_2))
      pending.resolve()
      expect(await starting).toBe(AGENT_1)
      expect(store.getState().agents[AGENT_1]).toBeDefined()
      expect(store.getState().selectedAgentId).toBe(trackedKey(FILE_2))
    } finally { pending.resolve(); store.stop() }
  })

  it('follows the selected stopped agent to its loaded ID when the selection has not changed', async () => {
    const { store } = setup(null)
    try {
      expect(await store.actions.startTracked(trackedKey(FILE_1))).toBe(AGENT_1)
      expect(store.getState().selectedAgentId).toBe(AGENT_1)
    } finally { store.stop() }
  })
})
