import { describe, it, expect, beforeEach, vi } from 'vitest'

// Run hook effects inline so the background subscriber is testable without React.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => { effect() }
}))
import { useAgentStore, selectLoopSlice } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useMessageQueueStore, selectQueue } from '../../../src/renderer/stores/message-queue.store'
import { useBackgroundAgentsStore } from '../../../src/renderer/stores/background-agents.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { useBackgroundAgentEvents } from '../../../src/renderer/hooks/useBackgroundAgents'
import { deliverQueuedMessages } from '../../../src/renderer/utils/queued-delivery'
import type { AgentExecutionEvent, RendererBackgroundAgentEvent } from '../../../src/shared/types/ipc.types'
import type { ContentBlock } from '../../../src/shared/types/provider.types'

/**
 * A message queued while the agent is mid-turn must outlive the owner looking
 * at another agent. The queue used to sit in the agent store, whose reset()
 * runs on every agent switch, so switching away and back dropped it: it was
 * neither shown nor ever sent.
 */

const AGENT_1 = '/w/agent-1.adf'
const AGENT_2 = '/w/agent-2.adf'

const invokeAgent = vi.fn()

const idle = (loop?: string): AgentExecutionEvent =>
  ({ type: 'state_changed', timestamp: 1, payload: { state: 'idle' }, ...(loop ? { loop } : {}) })

/** What openFile does to the renderer stores when the owner switches agents. */
function switchTo(filePath: string): void {
  useAgentStore.getState().reset()
  useDocumentStore.getState().setFilePath(filePath)
}

beforeEach(() => {
  useAgentStore.getState().reset()
  useDocumentStore.getState().reset()
  useMessageQueueStore.setState({ queues: {} })
  invokeAgent.mockReset()
  vi.stubGlobal('window', { adfApi: { invokeAgent } })
})

describe('message queue across agent switches', () => {
  it('still shows a queued message after navigating away and back', () => {
    switchTo(AGENT_1)
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'after this turn' })

    switchTo(AGENT_2)
    expect(selectQueue(useMessageQueueStore.getState(), AGENT_2, 'main')).toEqual([])

    switchTo(AGENT_1)
    const queue = selectQueue(useMessageQueueStore.getState(), AGENT_1, 'main')
    expect(queue.map((m) => m.text)).toEqual(['after this turn'])
    expect(invokeAgent).not.toHaveBeenCalled()
  })

  it('keeps queued attachments with the message', () => {
    switchTo(AGENT_1)
    const content: ContentBlock[] = [{ type: 'text', text: 'see image' }, { type: 'image_url', image_url: { url: 'adf-file://agent-1/a.png' } }]
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'see image', content, imagePreviewUrls: ['adf-file://agent-1/a.png'] })

    switchTo(AGENT_2)
    switchTo(AGENT_1)
    const handle = createAgentEventHandler()
    handle(idle())

    expect(invokeAgent).toHaveBeenCalledWith('see image', AGENT_1, content, 'main')
    const bubble = useAgentStore.getState().log.at(-1)
    expect(bubble?.metadata?.imagePreviewUrls).toEqual(['adf-file://agent-1/a.png'])
  })

  it('cancels a queued message after navigating back', () => {
    switchTo(AGENT_1)
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'keep' })
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'drop' })

    switchTo(AGENT_2)
    switchTo(AGENT_1)
    const drop = selectQueue(useMessageQueueStore.getState(), AGENT_1, 'main').find((m) => m.text === 'drop')!
    expect(useMessageQueueStore.getState().remove(AGENT_1, 'main', drop.id)?.text).toBe('drop')

    createAgentEventHandler()(idle())
    expect(invokeAgent).toHaveBeenCalledTimes(1)
    expect(invokeAgent).toHaveBeenCalledWith('keep', AGENT_1, [{ type: 'text', text: 'keep' }], 'main')
  })

  it('delivers once when the open agent goes idle, even on a repeated idle', () => {
    switchTo(AGENT_1)
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'one' })
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'two' })
    const handle = createAgentEventHandler()

    handle(idle())
    // The send marks the loop busy until its own turn reports back.
    expect(useAgentStore.getState().state).toBe('active')
    handle(idle())

    expect(invokeAgent).toHaveBeenCalledTimes(1)
    expect(invokeAgent).toHaveBeenCalledWith('one\n\ntwo', AGENT_1, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 'main')
    expect(useAgentStore.getState().log.filter((e) => e.type === 'user').map((e) => e.content)).toEqual(['one\n\ntwo'])
    expect(selectQueue(useMessageQueueStore.getState(), AGENT_1, 'main')).toEqual([])
  })

  it("keeps each loop's queue to that loop", () => {
    switchTo(AGENT_1)
    useMessageQueueStore.getState().enqueue(AGENT_1, 'reflector', { text: 'for the reflector' })
    const handle = createAgentEventHandler()

    handle(idle())
    expect(invokeAgent).not.toHaveBeenCalled()

    handle(idle('reflector'))
    expect(invokeAgent).toHaveBeenCalledWith('for the reflector', AGENT_1, [{ type: 'text', text: 'for the reflector' }], 'reflector')
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').log.at(-1)?.content).toBe('for the reflector')
  })

  it("never sends another agent's queue on the open agent's idle", () => {
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'for agent-1' })
    switchTo(AGENT_2)

    createAgentEventHandler()(idle())
    expect(invokeAgent).not.toHaveBeenCalled()
    expect(selectQueue(useMessageQueueStore.getState(), AGENT_1, 'main')).toHaveLength(1)
  })
})

describe('message queue of an agent in the background', () => {
  /** The background-batch subscriber, run outside React (its effect runs inline). */
  let pushBatch: (events: RendererBackgroundAgentEvent[]) => void

  const stateChanged = (filePath: string, state: 'idle' | 'active' | 'off'): RendererBackgroundAgentEvent =>
    ({ type: 'agent_state_changed', payload: { filePath, state }, timestamp: 1 })
  const loopsChanged = (filePath: string, activeLoops: number): RendererBackgroundAgentEvent =>
    ({ type: 'agent_loops_changed', payload: { filePath, activeLoops }, timestamp: 1 })

  beforeEach(() => {
    useBackgroundAgentsStore.setState({ agents: [{ filePath: AGENT_1, handle: 'agent-1', state: 'active', activeLoops: 1 }] })
    vi.stubGlobal('window', {
      adfApi: {
        invokeAgent,
        getBackgroundAgentStatus: () => new Promise(() => {}),
        onBackgroundAgentEvents: (cb: typeof pushBatch) => { pushBatch = cb; return () => {} }
      }
    })
    useBackgroundAgentEvents()
  })

  it('delivers exactly once when the turn ends while the owner views another agent', () => {
    switchTo(AGENT_1)
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'when you are done' })
    switchTo(AGENT_2)

    pushBatch([stateChanged(AGENT_1, 'idle')])
    expect(invokeAgent).toHaveBeenCalledTimes(1)
    expect(invokeAgent).toHaveBeenCalledWith('when you are done', AGENT_1, [{ type: 'text', text: 'when you are done' }], 'main')
    // Not drawn into the agent on screen.
    expect(useAgentStore.getState().log).toEqual([])

    // Every later settle signal finds the queue empty: a repeated idle, the
    // owner coming back (re-attach reads idle), agent-1's own idle event.
    pushBatch([stateChanged(AGENT_1, 'idle')])
    switchTo(AGENT_1)
    expect(deliverQueuedMessages(AGENT_1, 'main')).toBe(false)
    createAgentEventHandler()(idle())
    expect(invokeAgent).toHaveBeenCalledTimes(1)
    expect(selectQueue(useMessageQueueStore.getState(), AGENT_1, 'main')).toEqual([])
  })

  it('holds the queue while the background agent is still busy', () => {
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'later' })
    switchTo(AGENT_2)

    pushBatch([loopsChanged(AGENT_1, 0)])
    expect(invokeAgent).not.toHaveBeenCalled()
    expect(selectQueue(useMessageQueueStore.getState(), AGENT_1, 'main')).toHaveLength(1)
  })

  it("sends an inner loop's queue once no inner loop is mid-turn", () => {
    useMessageQueueStore.getState().enqueue(AGENT_1, 'reflector', { text: 'for the reflector' })
    switchTo(AGENT_2)

    pushBatch([loopsChanged(AGENT_1, 0)])
    expect(invokeAgent).toHaveBeenCalledTimes(1)
    expect(invokeAgent).toHaveBeenCalledWith('for the reflector', AGENT_1, [{ type: 'text', text: 'for the reflector' }], 'reflector')
  })

  it('keeps the queue when the background agent stops instead of finishing', () => {
    useMessageQueueStore.getState().enqueue(AGENT_1, 'reflector', { text: 'for the reflector' })
    switchTo(AGENT_2)

    // Main going off empties the inner-loop count too; a send now is refused.
    pushBatch([stateChanged(AGENT_1, 'off'), loopsChanged(AGENT_1, 0)])
    expect(invokeAgent).not.toHaveBeenCalled()
    expect(selectQueue(useMessageQueueStore.getState(), AGENT_1, 'reflector')).toHaveLength(1)
  })

  it('leaves the open agent to its own events', () => {
    switchTo(AGENT_1)
    useMessageQueueStore.getState().enqueue(AGENT_1, 'main', { text: 'mine' })

    // A background idle from before the switch must not send under the view.
    pushBatch([stateChanged(AGENT_1, 'idle')])
    expect(invokeAgent).not.toHaveBeenCalled()

    createAgentEventHandler()(idle())
    expect(invokeAgent).toHaveBeenCalledTimes(1)
  })
})
