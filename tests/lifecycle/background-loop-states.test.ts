import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackgroundAgentManager } from '../../src/main/runtime/background-agent-manager'
import type { AgentHostBindings, AssembledAgent, HostAttachment } from '../../src/main/runtime/assemble-agent'
import type { SettingsService } from '../../src/main/services/settings.service'
import type { AgentConfig } from '../../src/shared/types/adf-v02.types'
import type { BackgroundAgentEvent } from '../../src/shared/types/ipc.types'

/**
 * An agent backgrounded mid-turn can have inner loops mid-turn too. The
 * manager used to start every adopted agent at "no inner loop busy" and only
 * broadcast the busy COUNT, so a busy loop looked settled and a loop's turn
 * end that left the count unchanged (0 → 0, or one up and one down) was
 * invisible to anything waiting on that loop (the chat panel's queue).
 */

const managers: BackgroundAgentManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  vi.restoreAllMocks()
})

function makeHandle(sideLoopStates: Record<string, string>) {
  let hooks: AgentHostBindings | null = null
  const attachHost = vi.fn((next: AgentHostBindings): HostAttachment => {
    hooks = next
    return { detach: () => { hooks = null } }
  })
  const handle = {
    executor: { isMessageTriggered: false, getState: () => 'thinking', getPendingApprovals: () => [] },
    session: { flushToLoop: vi.fn(), getMessages: () => [] },
    workspace: { getLoop: () => [] },
    triggerEvaluator: { getDisplayState: () => 'active' },
    loopPool: { sideLoopStates: () => sideLoopStates },
    attachHost,
    disposeAsync: vi.fn(async () => {}),
    setWorkspaceOwnership: vi.fn(),
  } as unknown as AssembledAgent<'studioForeground'>
  return { handle, emit: (event: Parameters<NonNullable<AgentHostBindings['onEvent']>>[0]) => hooks?.onEvent?.(event) }
}

const config = { id: 'agent-1', name: 'agent-1', tools: [] } as unknown as AgentConfig
const filePath = '/tmp/agent-1.adf'

async function adopt(sideLoopStates: Record<string, string>) {
  const manager = new BackgroundAgentManager({} as SettingsService, '', {})
  managers.push(manager)
  const events: BackgroundAgentEvent[] = []
  manager.on('background_agent_event', (event: BackgroundAgentEvent) => events.push(event))
  const stable = makeHandle(sideLoopStates)
  await manager.transitionToBackground(filePath, config, stable.handle)
  return { manager, events, emit: stable.emit }
}

describe('inner-loop states of an adopted background agent', () => {
  it('seeds the real loop states and announces them', async () => {
    const { manager, events } = await adopt({ reflector: 'active', auditor: 'idle' })

    const started = events.find((e) => e.type === 'agent_started')
    expect(started?.payload.loopStates).toEqual({ reflector: 'active', auditor: 'idle' })
    expect(manager.getStatuses()[0].activeLoops).toBe(1)
    expect(events.some((e) => e.type === 'agent_loops_changed' && e.payload.activeLoops === 1)).toBe(true)
  })

  it("reports each loop's own transition, also when the count does not move", async () => {
    const { events, emit } = await adopt({ reflector: 'active', auditor: 'idle' })
    events.length = 0

    // One loop finishes as another starts: the count stays 1.
    emit({ type: 'state_changed', loop: 'auditor', payload: { state: 'thinking' }, timestamp: 1 })
    emit({ type: 'state_changed', loop: 'reflector', payload: { state: 'idle' }, timestamp: 2 })
    // A loop never seen busy goes straight to idle: 0 → 0 for it.
    emit({ type: 'state_changed', loop: 'scribe', payload: { state: 'idle' }, timestamp: 3 })
    // A repeat is not a transition.
    emit({ type: 'state_changed', loop: 'reflector', payload: { state: 'idle' }, timestamp: 4 })

    const perLoop = events.filter((e) => e.type === 'agent_loop_state_changed').map((e) => [e.payload.loop, e.payload.state])
    expect(perLoop).toEqual([['auditor', 'active'], ['reflector', 'idle'], ['scribe', 'idle']])
  })
})
