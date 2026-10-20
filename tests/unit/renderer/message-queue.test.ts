import { describe, it, expect, beforeEach, vi } from 'vitest'

// Run hook effects inline so the background subscriber attaches without React.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => { effect() }
}))
import { useAgentStore, selectLoopSlice } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useAppStore } from '../../../src/renderer/stores/app.store'
import { useMessageQueueStore, selectQueue, MAX_AUTOMATIC_SENDS } from '../../../src/renderer/stores/message-queue.store'
import { useBackgroundAgentsStore } from '../../../src/renderer/stores/background-agents.store'
import type { AgentExecutionEvent, RendererBackgroundAgentEvent } from '../../../src/shared/types/ipc.types'
import type { ContentBlock } from '../../../src/shared/types/provider.types'
import { queueOwnerMessage, sendOwnerMessage, sendProblem, sendFleetOrders, DAEMON_EXITED } from '../../../src/renderer/utils/queued-delivery'
import { startForegroundAgent } from '../../../src/renderer/utils/start-agent'
import { sendComposerMessage } from '../../../src/renderer/utils/composer-send'
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

describe('a new message to a stopped agent that still has a queue', () => {
  /** The composer's submit: its own start-before-send. */
  const startForQueue = async () => (await startForegroundAgent({ hasUserMessage: true, announce: false })).success
  const send = (text: string) => {
    const store = useAgentStore.getState()
    return queueOwnerMessage(AGENT_1, 'main', selectLoopSlice(store, 'main').state, store.state, { text }, startForQueue)
  }
  const adfApi = () => (window as unknown as { adfApi: Record<string, unknown> }).adfApi

  beforeEach(async () => {
    main.agents.delete(AGENT_1)
    await main.openFile(AGENT_1)
    expect(useAgentStore.getState().state).toBe('off')
    // Kept from an earlier run (closed while running, or a failed send).
    queue(AGENT_1, 'older')
  })

  it('starts the agent and sends the lot, oldest first', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(send('newer')).toBe(true)
    await vi.waitFor(() => expect(main.invokeAgent).toHaveBeenCalledTimes(1))
    expect(main.invokeAgent).toHaveBeenCalledWith('older\n\nnewer', AGENT_1, [{ type: 'text', text: 'older' }, { type: 'text', text: 'newer' }], 'main')
    expect(queued(AGENT_1)).toEqual([])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('starting it to send its 2 queued messages'))
    info.mockRestore()
  })

  it('sends it once when the start also reports the loop idle', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    adfApi().startAgent = async () => {
      main.pushForeground(idle())
      return { success: true, sessionId: 's-1', agentState: 'idle' }
    }
    send('newer')
    await vi.waitFor(() => expect(main.invokeAgent).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(main.invokeAgent).toHaveBeenCalledWith('older\n\nnewer', AGENT_1, expect.any(Array), 'main')
  })

  it('a start that fails says why in the chat; the messages stay queued, in order', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    adfApi().startAgent = async () => ({ success: false, error: 'No model configured' })
    send('newer')
    await vi.waitFor(() => expect(useAgentStore.getState().log.at(-1)).toMatchObject({ type: 'error', content: 'No model configured' }))
    expect(main.invokeAgent).not.toHaveBeenCalled()
    expect(queued(AGENT_1).map((m) => m.text)).toEqual(['older', 'newer'])
  })

  describe("through the composer's send path (AgentLoop's sendUserMessage)", () => {
    const submit = (text: string) => {
      const store = useAgentStore.getState()
      return sendComposerMessage({ filePath: AGENT_1, loop: 'main', loopState: selectLoopSlice(store, 'main').state, agentState: store.state }, text, [{ type: 'text', text }], [])
    }

    it('starts this agent and sends the lot, oldest first', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {})
      const startAgent = vi.fn(adfApi().startAgent as (...args: unknown[]) => Promise<unknown>)
      adfApi().startAgent = startAgent
      await submit('newer')
      await vi.waitFor(() => expect(main.invokeAgent).toHaveBeenCalledTimes(1))
      expect(startAgent).toHaveBeenCalledWith(AGENT_1, true)
      expect(main.invokeAgent).toHaveBeenCalledWith('older\n\nnewer', AGENT_1, [{ type: 'text', text: 'older' }, { type: 'text', text: 'newer' }], 'main')
      expect(queued(AGENT_1)).toEqual([])
    })

    it('the owner switching agents during the review check still starts and sends to this one', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {})
      const startAgent = vi.fn(async () => ({ success: true, sessionId: 's-1', agentState: 'idle' }))
      adfApi().startAgent = startAgent
      adfApi().checkAgentReview = async () => {
        useDocumentStore.getState().setFilePath(AGENT_2)
        return { needsReview: false }
      }
      await submit('newer')
      await vi.waitFor(() => expect(main.invokeAgent).toHaveBeenCalledTimes(1))
      expect(startAgent).toHaveBeenCalledWith(AGENT_1, true)
      expect(main.invokeAgent).toHaveBeenCalledWith('older\n\nnewer', AGENT_1, expect.any(Array), 'main')
    })

    it('without a queue, a start that does not happen leaves the message "Not sent" with the reason, not a bubble', async () => {
      useMessageQueueStore.setState({ queues: {} })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      adfApi().startAgent = async () => ({ success: false, error: 'No model configured' })
      await submit('hello')
      expect(main.invokeAgent).not.toHaveBeenCalled()
      expect(queued(AGENT_1)).toMatchObject([{ text: 'hello', error: 'No model configured', failures: 1 }])
      expect(useAgentStore.getState().log.some((e) => e.type === 'user' && e.content === 'hello')).toBe(false)
    })

    it('without a queue, a cancelled provider sheet leaves it "Not sent" too', async () => {
      useMessageQueueStore.setState({ queues: {} })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      adfApi().startAgent = async () => ({ success: false, code: 'provider_missing', error: 'No provider is connected' })
      const sent = submit('hello')
      await vi.waitFor(() => expect(useAppStore.getState().providerSetupRequest).not.toBeNull())
      useAppStore.getState().resolveProviderSetup(null)
      await sent
      expect(main.invokeAgent).not.toHaveBeenCalled()
      expect(queued(AGENT_1)).toMatchObject([{ text: 'hello', error: 'No provider is connected' }])
    })

    it('without a queue: starts it, then sends the message directly', async () => {
      useMessageQueueStore.setState({ queues: {} })
      await submit('hello')
      expect(main.invokeAgent).toHaveBeenCalledWith('hello', AGENT_1, [{ type: 'text', text: 'hello' }], 'main')
      expect(useAgentStore.getState().log.at(-1)).toMatchObject({ type: 'user', content: 'hello' })
    })
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

  it('keeps a send the backend accepted but could not see through as sent: never requeued, never sent twice', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'once')
    await main.openFile(AGENT_2)

    // Daemon mode: the chat route took it, then the connection dropped before its turn ended.
    main.invokeAgent.mockResolvedValueOnce({ success: false, accepted: true, error: 'The connection to the ADF daemon was lost' })
    main.pushBatch([stateChanged(AGENT_1, 'idle')])
    await settle()
    expect(queued(AGENT_1)).toEqual([])

    main.pushBatch([stateChanged(AGENT_1, 'active'), stateChanged(AGENT_1, 'idle')])
    await settle()
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
  })

  it("stops retrying on turn ends after repeated failures; the owner's next message still takes the queue along", async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'too big')
    await main.openFile(AGENT_2)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    main.invokeAgent.mockResolvedValue({ success: false, error: 'This message is too large to send' })
    for (let i = 0; i < MAX_AUTOMATIC_SENDS + 2; i++) {
      main.pushBatch([stateChanged(AGENT_1, 'active'), stateChanged(AGENT_1, 'idle')])
      await settle()
    }
    expect(main.invokeAgent).toHaveBeenCalledTimes(MAX_AUTOMATIC_SENDS)
    expect(queued(AGENT_1).map((m) => [m.text, m.error, m.failures])).toEqual([['too big', 'This message is too large to send', MAX_AUTOMATIC_SENDS]])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('waits for the owner'))

    // The owner sends again: the held message goes first, with the new one.
    main.invokeAgent.mockResolvedValue({ success: true })
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    const store = useAgentStore.getState()
    expect(queueOwnerMessage(AGENT_1, 'main', selectLoopSlice(store, 'main').state, store.state, { text: 'smaller' })).toBe(true)
    expect(main.invokeAgent).toHaveBeenLastCalledWith('too big\n\nsmaller', AGENT_1, expect.any(Array), 'main')
    warn.mockRestore()
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

describe('stale queues', () => {
  it('moves a queue with its renamed agent, and delivers it there', async () => {
    const renamed = '/w/agent-1-renamed.adf'
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'follow me')
    await main.openFile(AGENT_2)

    // What App does on FILE_RENAMED.
    useMessageQueueStore.getState().rekey(AGENT_1, renamed)
    expect(queued(AGENT_1)).toEqual([])
    main.pushBatch([stateChanged(renamed, 'idle')])
    expect(main.invokeAgent).toHaveBeenCalledWith('follow me', renamed, expect.any(Array), 'main')
  })

  it('forgets a deleted agent, so a new one at that path starts empty', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'for the old agent')
    await main.openFile(AGENT_2)

    // What the sidebar does once main deleted the file.
    useMessageQueueStore.getState().clearAgent(AGENT_1)
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    expect(queued(AGENT_1)).toEqual([])
    expect(main.invokeAgent).not.toHaveBeenCalled()
  })

  it('keeps the queue of a closed agent: a running one sends it at its turn end, a stopped one when it starts', async () => {
    main.agents.set(AGENT_2, { state: 'active' })
    await main.openFile(AGENT_2)
    queue(AGENT_2, 'still deliverable')
    await main.closeFile()
    expect(queued(AGENT_2)).toHaveLength(1)
    main.pushBatch([stateChanged(AGENT_2, 'idle')])
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)

    main.agents.delete(AGENT_1)
    await main.openFile(AGENT_1)
    expect(useAgentStore.getState().state).toBe('off')
    queue(AGENT_1, 'waits for a start')
    await main.closeFile()
    // Kept, not dropped without a word: it shows again when the agent is opened.
    expect(queued(AGENT_1)).toHaveLength(1)
    await main.openFile(AGENT_1)
    expect(queued(AGENT_1).map((m) => m.text)).toEqual(['waits for a start'])
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
  })

  it('keys one queue per file however its path is spelled', async () => {
    main.setPlatform('win32')
    const spelled = String.raw`C:\W\Agent-1.adf`
    const reported = 'c:/w/agent-1.adf'
    main.agents.set(spelled, { state: 'active' })
    await main.openFile(spelled)
    queue(spelled, 'one file')
    expect(queued(reported).map((m) => m.text)).toEqual(['one file'])
    await main.openFile(AGENT_2)

    main.pushBatch([stateChanged(reported, 'idle')])
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    expect(queued(spelled)).toEqual([])
  })
})

describe('a message sent straight to an idle loop', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a refused send ends in the chat: an error row, the optimistic state back to idle, no retry', async () => {
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useAgentStore.getState().setState('active')
    main.invokeAgent.mockResolvedValueOnce({ success: false, error: 'Agent not running' })
    sendOwnerMessage(AGENT_1, 'main', 'hello', [{ type: 'text', text: 'hello' }])
    await settle()
    expect(useAgentStore.getState().log.at(-1)).toMatchObject({ type: 'error', content: 'Not sent: Agent not running' })
    expect(useAgentStore.getState().state).toBe('idle')
    expect(main.invokeAgent).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('an accepted send whose end was not seen shows nothing extra', async () => {
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    useAgentStore.getState().setState('active')
    const before = useAgentStore.getState().log.length
    main.invokeAgent.mockResolvedValueOnce({ success: false, accepted: true, error: 'The connection to the ADF daemon was lost' })
    sendOwnerMessage(AGENT_1, 'main', 'hello', [{ type: 'text', text: 'hello' }])
    await settle()
    expect(useAgentStore.getState().log).toHaveLength(before)
    expect(useAgentStore.getState().state).toBe('active')
  })
})

describe('W5-L review: holds, refusals after a switch, a daemon that exited', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a new message queued while the loop is busy releases the hold: the old "Not sent" messages go first, then the new one', async () => {
    await main.openFile(AGENT_1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    queue(AGENT_1, 'old')
    main.invokeAgent.mockResolvedValue({ success: false, error: 'Agent not running' })
    for (let i = 0; i < MAX_AUTOMATIC_SENDS; i++) {
      main.pushForeground(idle())
      await settle()
    }
    expect(queued(AGENT_1)[0]).toMatchObject({ text: 'old', failures: MAX_AUTOMATIC_SENDS })
    // Held: a turn end alone sends nothing.
    main.invokeAgent.mockClear()
    main.pushForeground(idle())
    expect(main.invokeAgent).not.toHaveBeenCalled()

    // The loop is busy again and the owner queues a new message.
    useAgentStore.getState().setState('active')
    const store = useAgentStore.getState()
    expect(queueOwnerMessage(AGENT_1, 'main', selectLoopSlice(store, 'main').state, store.state, { text: 'new' })).toBe(true)
    expect(main.invokeAgent).not.toHaveBeenCalled()
    expect(queued(AGENT_1).map((m) => [m.text, m.error, m.failures ?? 0])).toEqual([['old', 'Agent not running', 0], ['new', undefined, 0]])

    // Its turn ends: both go, oldest first.
    main.invokeAgent.mockResolvedValue({ success: true })
    main.pushForeground(idle())
    expect(main.invokeAgent).toHaveBeenCalledWith('old\n\nnew', AGENT_1, expect.any(Array), 'main')
    warn.mockRestore()
  })

  it('a direct send refused after the owner switched away goes into its own agent\'s queue, marked "Not sent"', async () => {
    main.agents.set(AGENT_1, { state: 'idle' })
    await main.openFile(AGENT_1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let answer: (value: unknown) => void = () => {}
    main.invokeAgent.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    sendOwnerMessage(AGENT_1, 'critic', 'hello', [{ type: 'text', text: 'hello' }], ['adf-file://a.png'])
    await main.openFile(AGENT_2)
    answer({ success: false, error: 'Agent not running' })
    await settle()
    expect(queued(AGENT_1, 'critic')).toEqual([expect.objectContaining({ text: 'hello', error: 'Agent not running', failures: 1, imagePreviewUrls: ['adf-file://a.png'] })])
    expect(useAgentStore.getState().log.some((e) => e.type === 'error')).toBe(false)
    warn.mockRestore()
  })

  it('a background queue whose daemon exited before the turn ended goes back as "Not sent"; on the open agent the chat shows the error instead', async () => {
    await main.openFile(AGENT_1)
    queue(AGENT_1, 'to the critic', 'critic')
    await main.openFile(AGENT_2)
    main.invokeAgent.mockResolvedValueOnce({ success: false, accepted: true, code: 'daemon_exited', error: 'The ADF daemon exited while the message waited for its turn' })
    main.pushBatch([loopState(AGENT_1, 'critic', 'idle')])
    await settle()
    expect(queued(AGENT_1, 'critic').map((m) => [m.text, m.error])).toEqual([['to the critic', DAEMON_EXITED]])

    // The open agent: its chat shows the daemon's error row; the message is not requeued.
    queue(AGENT_2, 'here')
    main.invokeAgent.mockResolvedValueOnce({ success: false, accepted: true, code: 'daemon_exited', error: 'exited' })
    main.pushForeground(idle())
    await settle()
    expect(queued(AGENT_2)).toEqual([])
  })
})

describe('sendProblem: what a steward order or a send says when it went wrong', () => {
  it('names refusals and exits as not sent, an unseen end as sent, and nothing for a success', () => {
    expect(sendProblem({ success: true })).toBeNull()
    expect(sendProblem(undefined)).toBeNull()
    expect(sendProblem({ success: false, error: 'Agent not running' })).toEqual({ reason: 'Agent not running', notSent: true })
    expect(sendProblem({ success: false, accepted: true, error: 'connection lost' })).toEqual({ reason: 'connection lost', notSent: false })
    expect(sendProblem({ success: false, accepted: true, code: 'daemon_exited', error: 'x' })).toEqual({ reason: DAEMON_EXITED, notSent: true })
  })
})

describe('fleet map orders (a steward appointment)', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a refused order is said, an unseen end is said, a delivered one is not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notices: string[] = []
    main.invokeAgent.mockResolvedValueOnce({ success: false, error: 'Agent not running' })
    sendFleetOrders(AGENT_1, 'agent-1', 'You are the steward.', (n) => notices.push(n))
    main.invokeAgent.mockResolvedValueOnce({ success: false, accepted: true, error: 'The connection to the ADF daemon was lost' })
    sendFleetOrders(AGENT_1, 'agent-1', 'You are the steward.', (n) => notices.push(n))
    main.invokeAgent.mockResolvedValueOnce({ success: true })
    sendFleetOrders(AGENT_1, 'agent-1', 'You are the steward.', (n) => notices.push(n))
    main.invokeAgent.mockRejectedValueOnce(new Error('IPC closed'))
    sendFleetOrders(AGENT_1, 'agent-1', 'You are the steward.', (n) => notices.push(n))
    await settle()
    expect(notices).toEqual([
      'Orders not sent to agent-1: Agent not running',
      'Orders sent to agent-1, but The connection to the ADF daemon was lost',
      'Orders not sent to agent-1: IPC closed',
    ])
    expect(main.invokeAgent).toHaveBeenCalledWith('You are the steward.', AGENT_1)
    warn.mockRestore()
  })
})
