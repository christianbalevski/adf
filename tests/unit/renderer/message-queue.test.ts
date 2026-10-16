import { describe, it, expect, beforeEach, vi } from 'vitest'

// Run hook effects inline so the background subscriber attaches without React.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => { effect() }
}))
import { useAgentStore, selectLoopSlice } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useMessageQueueStore, selectQueue } from '../../../src/renderer/stores/message-queue.store'
import { useBackgroundAgentsStore } from '../../../src/renderer/stores/background-agents.store'
import type { AgentExecutionEvent, RendererBackgroundAgentEvent } from '../../../src/shared/types/ipc.types'
import type { ContentBlock } from '../../../src/shared/types/provider.types'
import { queueOwnerMessage } from '../../../src/renderer/utils/queued-delivery'
import { createOpenFileHarness, type OpenFileHarness } from './open-file-harness'

/**
 * A message queued while the agent is mid-turn must outlive the owner looking
 * at another agent. The queue used to sit in the agent store, whose reset()
 * runs on every agent switch, so switching away and back dropped it: it was
 * neither shown nor ever sent.
 *
 * Every switch here goes through the real openFile against a fake main that
 * keeps main's ordering (see open-file-harness).
 */

const AGENT_1 = '/w/agent-1.adf'
const AGENT_2 = '/w/agent-2.adf'

const idle = (loop?: string): AgentExecutionEvent =>
  ({ type: 'state_changed', timestamp: 1, payload: { state: 'idle' }, ...(loop ? { loop } : {}) })
const started = (filePath: string, state: string, loopStates?: Record<string, string>): RendererBackgroundAgentEvent =>
  ({ type: 'agent_started', payload: { filePath, state: state as never, handle: 'h', loopStates }, timestamp: 1 })
const loopState = (filePath: string, loop: string, state: string): RendererBackgroundAgentEvent =>
  ({ type: 'agent_loop_state_changed', payload: { filePath, loop, state: state as never }, timestamp: 1 })
const stopped = (filePath: string): RendererBackgroundAgentEvent =>
  ({ type: 'agent_stopped', payload: { filePath }, timestamp: 1 })
const stateChanged = (filePath: string, state: 'idle' | 'active' | 'off' | 'suspended' | 'error'): RendererBackgroundAgentEvent =>
  ({ type: 'agent_state_changed', payload: { filePath, state }, timestamp: 1 })

const queued = (filePath: string, loop = 'main') => selectQueue(useMessageQueueStore.getState(), filePath, loop)
const queue = (filePath: string, text: string, loop = 'main', content?: ContentBlock[]) =>
  useMessageQueueStore.getState().enqueue(filePath, loop, { text, content })

let main: OpenFileHarness

/**
 * Main's side of an agent switch: the outgoing running agent becomes a
 * background agent, the incoming one leaves the background list. Runs inside
 * the FILE_OPEN IPC, before the renderer's filePath moves.
 */
function backgroundOnSwitch(next: string, previous: string | null): void {
  const events: RendererBackgroundAgentEvent[] = []
  if (main.agents.has(next) && useBackgroundAgentsStore.getState().agents.some((a) => a.filePath === next)) events.push(stopped(next))
  if (previous && main.agents.has(previous)) events.push(started(previous, main.agents.get(previous)!.state, main.agents.get(previous)!.loopStates))
  if (events.length > 0) main.pushBatch(events)
}

beforeEach(() => {
  useAgentStore.getState().reset()
  useDocumentStore.getState().reset()
  useMessageQueueStore.setState({ queues: {} })
  useBackgroundAgentsStore.setState({ agents: [] })
  main = createOpenFileHarness()
  main.agents.set(AGENT_1, { state: 'active' })
  main.agents.set(AGENT_2, { state: 'idle' })
  main.duringOpen = (next, previous) => backgroundOnSwitch(next, previous)
})

describe('message queue across agent switches', () => {
  it('still shows a queued message after navigating away and back', async () => {
    await main.openFile(AGENT_1)
    expect(useAgentStore.getState().state).toBe('active')
    queue(AGENT_1, 'after this turn')

    await main.openFile(AGENT_2)
    expect(queued(AGENT_2)).toEqual([])

    await main.openFile(AGENT_1)
    expect(queued(AGENT_1).map((m) => m.text)).toEqual(['after this turn'])
    expect(main.invokeAgent).not.toHaveBeenCalled()

    // Still deliverable: agent-1's own turn end sends it.
    main.pushForeground(idle())
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('after this turn', AGENT_1, [{ type: 'text', text: 'after this turn' }], 'main')
  })

  it('keeps queued attachments with the message', async () => {
    await main.openFile(AGENT_1)
    const content: ContentBlock[] = [{ type: 'text', text: 'see image' }, { type: 'image_url', image_url: { url: 'adf-file://agent-1/a.png' } }]
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'see image', content, imagePreviewUrls: ['adf-file://agent-1/a.png'] })

    await main.openFile(AGENT_2)
    await main.openFile(AGENT_1)
    main.pushForeground(idle())

    expect(main.invokeAgent).toHaveBeenCalledWith('see image', AGENT_1, content, 'main')
    expect(useAgentStore.getState().log.at(-1)?.metadata?.imagePreviewUrls).toEqual(['adf-file://agent-1/a.png'])
  })

  it('cancels a queued message after navigating back', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'keep')
    queue(AGENT_1, 'drop')

    await main.openFile(AGENT_2)
    await main.openFile(AGENT_1)
    const drop = queued(AGENT_1).find((m) => m.text === 'drop')!
    expect(useMessageQueueStore.getState().remove(AGENT_1, 'main', drop.id)?.text).toBe('drop')

    main.pushForeground(idle())
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('keep', AGENT_1, [{ type: 'text', text: 'keep' }], 'main')
  })

  it('delivers once when the open agent goes idle, even on a repeated idle', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'one')
    queue(AGENT_1, 'two')

    main.pushForeground(idle())
    // The send marks the loop busy until its own turn reports back.
    expect(useAgentStore.getState().state).toBe('active')
    main.pushForeground(idle())

    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('one\n\ntwo', AGENT_1, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 'main')
    expect(useAgentStore.getState().log.filter((e) => e.type === 'user').map((e) => e.content)).toEqual(['one\n\ntwo'])
    expect(queued(AGENT_1)).toEqual([])
  })

  it("keeps each loop's queue to that loop", async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'for the reflector', 'reflector')

    main.pushForeground(idle())
    expect(main.invokeAgent).not.toHaveBeenCalled()

    main.pushForeground(idle('reflector'))
    expect(main.invokeAgent).toHaveBeenCalledWith('for the reflector', AGENT_1, [{ type: 'text', text: 'for the reflector' }], 'reflector')
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').log.at(-1)?.content).toBe('for the reflector')
  })

  it("never sends another agent's queue on the open agent's idle", async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'for agent-1')
    await main.openFile(AGENT_2)

    main.pushForeground(idle())
    expect(main.invokeAgent).not.toHaveBeenCalled()
    expect(queued(AGENT_1)).toHaveLength(1)
  })
})

describe('message queue of an agent in the background', () => {
  it('delivers exactly once when the turn ends while the owner views another agent', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'when you are done')
    await main.openFile(AGENT_2)

    main.pushBatch([stateChanged(AGENT_1, 'idle')])
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('when you are done', AGENT_1, [{ type: 'text', text: 'when you are done' }], 'main')
    // Not drawn into the agent on screen.
    expect(useAgentStore.getState().log).toEqual([])

    // Every later settle signal finds the queue empty: a repeated idle, the
    // owner coming back (the re-attach reads idle), agent-1's own idle event.
    main.pushBatch([stateChanged(AGENT_1, 'idle')])
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    main.pushForeground(idle())
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(queued(AGENT_1)).toEqual([])
  })

  it('delivers when the outgoing agent finishes inside the switch itself', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'mid-switch')

    // main has moved to agent-2 and backgrounded agent-1; the renderer still
    // shows agent-1 when agent-1's turn ends.
    main.duringOpen = (next, previous) => {
      backgroundOnSwitch(next, previous)
      expect(useDocumentStore.getState().filePath).toBe(AGENT_1)
      main.pushBatch([stateChanged(AGENT_1, 'idle')])
    }
    await main.openFile(AGENT_2)

    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('mid-switch', AGENT_1, [{ type: 'text', text: 'mid-switch' }], 'main')
    expect(queued(AGENT_1)).toEqual([])
  })

  it('holds the queue while the background agent is still busy', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'later')
    await main.openFile(AGENT_2)

    main.pushBatch([stateChanged(AGENT_1, 'active')])
    expect(main.invokeAgent).not.toHaveBeenCalled()
    expect(queued(AGENT_1)).toHaveLength(1)
  })

  it('leaves the agent being opened to its re-attach', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'on return')
    await main.openFile(AGENT_2)

    // agent-1 finishes while the owner is opening it again: the background
    // event is skipped, the re-attach finds it idle and sends once.
    main.agents.set(AGENT_1, { state: 'idle' })
    main.duringOpen = (next, previous) => {
      backgroundOnSwitch(next, previous)
      main.pushBatch([stateChanged(AGENT_1, 'idle')])
    }
    await main.openFile(AGENT_1)
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().log.at(-1)?.content).toBe('on return')
  })
})

describe('only a real idle sends the queue', () => {
  it.each(['suspended', 'error', 'off'] as const)('keeps a background queue on %s', async (state) => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'wait for idle')
    await main.openFile(AGENT_2)

    main.pushBatch([stateChanged(AGENT_1, state)])
    expect(main.invokeAgent).not.toHaveBeenCalled()
    expect(queued(AGENT_1)).toHaveLength(1)
  })

  it.each(['suspended', 'error'] as const)('keeps an inner loop queue on %s', async (state) => {
    main.agents.set(AGENT_1, { state: 'idle', loopStates: { reflector: 'active' } })
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'for the reflector', 'reflector')
    await main.openFile(AGENT_2)

    main.pushBatch([loopState(AGENT_1, 'reflector', state)])
    expect(main.invokeAgent).not.toHaveBeenCalled()
  })

  it('keeps the open agent queue while it waits on an approval', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'after the approval')
    main.pushForeground({ type: 'state_changed', timestamp: 1, payload: { state: 'awaiting_approval' } })
    expect(main.invokeAgent).not.toHaveBeenCalled()
  })
})

describe('inner-loop queues', () => {
  it("sends on that loop's own turn end in the background, not on a count", async () => {
    main.agents.set(AGENT_1, { state: 'idle', loopStates: { reflector: 'active', auditor: 'idle' } })
    await main.openFile(AGENT_1)
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').state).toBe('active')
    queue(AGENT_1, 'for the reflector', 'reflector')

    // Adopted busy: the seed says so, nothing goes.
    await main.openFile(AGENT_2)
    expect(main.invokeAgent).not.toHaveBeenCalled()

    // Another loop's activity does not send it.
    main.pushBatch([loopState(AGENT_1, 'auditor', 'active'), loopState(AGENT_1, 'auditor', 'idle')])
    expect(main.invokeAgent).not.toHaveBeenCalled()

    main.pushBatch([loopState(AGENT_1, 'reflector', 'idle')])
    main.pushBatch([loopState(AGENT_1, 'reflector', 'idle')])
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('for the reflector', AGENT_1, [{ type: 'text', text: 'for the reflector' }], 'reflector')
  })

  it('keeps an inner loop queue while the agent is off', async () => {
    main.agents.set(AGENT_1, { state: 'idle', loopStates: { reflector: 'active' } })
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'for the reflector', 'reflector')
    await main.openFile(AGENT_2)

    main.pushBatch([stateChanged(AGENT_1, 'off'), loopState(AGENT_1, 'reflector', 'idle')])
    expect(main.invokeAgent).not.toHaveBeenCalled()
  })

  it('sends a settled inner loop queue on the re-attach, leaving a busy main alone', async () => {
    main.agents.set(AGENT_1, { state: 'active', loopStates: { reflector: 'active' } })
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'for main')
    queue(AGENT_1, 'for the reflector', 'reflector')
    await main.openFile(AGENT_2)

    // The reflector finished during the switch back; main is still working.
    main.agents.set(AGENT_1, { state: 'active', loopStates: { reflector: 'idle' } })
    await main.openFile(AGENT_1)
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('for the reflector', AGENT_1, [{ type: 'text', text: 'for the reflector' }], 'reflector')
    expect(queued(AGENT_1).map((m) => m.text)).toEqual(['for main'])
  })
})

describe('a new message never jumps ahead of older queued ones', () => {
  /** What the composer does on submit, with the open loop's current states. */
  const send = (text: string, loop = 'main') => {
    const store = useAgentStore.getState()
    return queueOwnerMessage(useDocumentStore.getState().filePath, loop, selectLoopSlice(store, loop).state, store.state, { text })
  }

  it('sends directly when nothing waits and the loop is idle', async () => {
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    expect(send('hello')).toBe(false)
    expect(queued(AGENT_1)).toEqual([])
  })

  it('queues behind a waiting message and sends both in order on idle', async () => {
    main.agents.set(AGENT_1, { state: 'suspended' })
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'older')
    await main.openFile(AGENT_2)
    await main.openFile(AGENT_1)

    // Held on an approval: a direct send would overtake "older".
    expect(send('newer')).toBe(true)
    expect(main.invokeAgent).not.toHaveBeenCalled()
    expect(queued(AGENT_1).map((m) => m.text)).toEqual(['older', 'newer'])

    main.pushForeground(idle())
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('older\n\nnewer', AGENT_1, [{ type: 'text', text: 'older' }, { type: 'text', text: 'newer' }], 'main')
  })

  it('on an idle loop with a waiting queue, sends the lot now, oldest first', async () => {
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'older')

    expect(send('newer')).toBe(true)
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('older\n\nnewer', AGENT_1, [{ type: 'text', text: 'older' }, { type: 'text', text: 'newer' }], 'main')
  })
})

describe('a send main does not take', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('puts a background queue back at its head, in order, marked not sent', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'first')
    queue(AGENT_1, 'second')
    await main.openFile(AGENT_2)

    main.invokeAgent.mockResolvedValueOnce({ success: false, error: 'Agent not running' })
    main.pushBatch([stateChanged(AGENT_1, 'idle')])
    // Queued while the failed send was in flight: stays behind the older two.
    queue(AGENT_1, 'third')
    await settle()

    expect(queued(AGENT_1).map((m) => [m.text, m.error])).toEqual([
      ['first', 'Agent not running'],
      ['second', 'Agent not running'],
      ['third', undefined]
    ])

    // Shown as queued (and not sent) when the owner comes back.
    main.agents.set(AGENT_1, { state: 'active' })
    await main.openFile(AGENT_1)
    expect(queued(AGENT_1)).toHaveLength(3)

    // The next turn end retries them, oldest first.
    main.pushForeground(idle())
    expect(main.invokeAgent).toHaveBeenLastCalledWith('first\n\nsecond\n\nthird', AGENT_1, expect.any(Array), 'main')
  })

  it('takes back the bubble and the optimistic state of the open agent on a rejected send', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'try me')

    main.invokeAgent.mockRejectedValueOnce(new Error('IPC closed'))
    main.pushForeground(idle())
    expect(useAgentStore.getState().log.at(-1)?.content).toBe('try me')
    await settle()

    expect(useAgentStore.getState().log.some((e) => e.type === 'user')).toBe(false)
    expect(useAgentStore.getState().state).toBe('idle')
    expect(queued(AGENT_1).map((m) => [m.text, m.error])).toEqual([['try me', 'IPC closed']])
  })
})
