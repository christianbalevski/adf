import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHeadlessAgent, MockLLMProvider, type HeadlessAgent } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { AdfEventDispatch, AdfBatchDispatch } from '../../../src/shared/types/adf-event.types'
import type { CreateAgentOptions } from '../../../src/shared/types/adf-v02.types'

/**
 * dispatchStartup's unread inbox sweep: messages that landed in the inbox
 * while no trigger wiring existed (adapter offline catch-up during app
 * startup) must wake the agent on its first startup evaluation — agent scope
 * only, using the real rows so target filters match.
 */
describe('assembleAgent startup unread sweep', () => {
  const agents: HeadlessAgent[] = []

  beforeEach(() => clearAllUmbilicalBuses())
  afterEach(() => {
    for (const agent of agents.splice(0)) agent.dispose()
    clearAllUmbilicalBuses()
  })

  function makeAgent(triggers?: CreateAgentOptions['triggers']) {
    const agent = createHeadlessAgent({
      name: 'sweep-test',
      provider: new MockLLMProvider(),
      profile: 'benchmark',
      createOptions: {
        // idle: no default startup turn, so every dispatch observed below
        // comes from the sweep itself.
        start_in_state: 'idle',
        triggers: triggers ?? {
          on_inbox: {
            enabled: true,
            targets: [{ scope: 'system' }, { scope: 'agent' }],
          },
        },
      },
    })
    agents.push(agent)
    // The sweep's agent-scope fires dispatch real turns; stub them out.
    vi.spyOn(agent.executor, 'executeTurn').mockResolvedValue(undefined)
    const dispatches: (AdfEventDispatch | AdfBatchDispatch)[] = []
    agent.triggerEvaluator.on('trigger', (dispatch) => dispatches.push(dispatch))
    return { agent, dispatches }
  }

  function seedUnread(agent: HeadlessAgent, overrides: Partial<{
    from: string
    content: string
    source: string
    received_at: number
  }> = {}): string {
    return agent.workspace.addToInbox({
      from: 'telegram:12345',
      content: 'missed while offline',
      source: 'telegram',
      received_at: Date.now(),
      status: 'unread',
      ...overrides,
    })
  }

  it('fires agent-scope on_inbox with the real sender/source and skips system scope', async () => {
    const { agent, dispatches } = makeAgent()
    const inboxId = seedUnread(agent)

    await agent.dispatchStartup()

    const inboxDispatches = dispatches.filter(
      (d): d is AdfEventDispatch => 'event' in d && d.event.type === 'inbox',
    )
    expect(inboxDispatches.length).toBe(1)
    expect(inboxDispatches[0].scope).toBe('agent')
    const msg = (inboxDispatches[0].event.data as { message: { id: string; from: string; source?: string } }).message
    expect(msg.id).toBe(inboxId)
    expect(msg.from).toBe('telegram:12345')
    expect(msg.source).toBe('telegram')
  })

  it('coalesces unread rows from one (sender, source) pair into a single fire on the newest row', async () => {
    const { agent, dispatches } = makeAgent()
    seedUnread(agent, { content: 'older', received_at: 1000 })
    const newestId = seedUnread(agent, { content: 'newer', received_at: 2000 })

    await agent.dispatchStartup()

    const inboxDispatches = dispatches.filter(
      (d): d is AdfEventDispatch => 'event' in d && d.event.type === 'inbox',
    )
    expect(inboxDispatches.length).toBe(1)
    const msg = (inboxDispatches[0].event.data as { message: { id: string } }).message
    expect(msg.id).toBe(newestId)
  })

  it('fires once per distinct (sender, source) pair so per-source filters can match', async () => {
    const { agent, dispatches } = makeAgent({
      on_inbox: {
        enabled: true,
        targets: [{ scope: 'agent', filter: { source: 'discord' } }],
      },
    })
    seedUnread(agent, { from: 'telegram:12345', source: 'telegram' })
    seedUnread(agent, { from: 'discord:67890', source: 'discord' })

    await agent.dispatchStartup()

    const inboxDispatches = dispatches.filter(
      (d): d is AdfEventDispatch => 'event' in d && d.event.type === 'inbox',
    )
    expect(inboxDispatches.length).toBe(1)
    const msg = (inboxDispatches[0].event.data as { message: { from: string; source?: string } }).message
    expect(msg.from).toBe('discord:67890')
    expect(msg.source).toBe('discord')
  })

  it('is a no-op with zero unread rows', async () => {
    const { agent, dispatches } = makeAgent()

    await agent.dispatchStartup()

    expect(dispatches.length).toBe(0)
  })

  it('runs only on the first startup evaluation', async () => {
    const { agent, dispatches } = makeAgent()
    seedUnread(agent)

    await agent.dispatchStartup()
    await agent.dispatchStartup()

    const inboxDispatches = dispatches.filter(
      (d): d is AdfEventDispatch => 'event' in d && d.event.type === 'inbox',
    )
    expect(inboxDispatches.length).toBe(1)
  })
})
