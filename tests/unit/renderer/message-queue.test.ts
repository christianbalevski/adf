import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore, selectLoopSlice } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useMessageQueueStore, selectQueue } from '../../../src/renderer/stores/message-queue.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'
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
