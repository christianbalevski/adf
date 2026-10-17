import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { startForegroundAgent } from '../../../src/renderer/utils/start-agent'

/**
 * startForegroundAgent starts the agent the user acted on. The open file can
 * change while the review check is in flight (the user switched agents); the
 * start must still go to the agent captured when the user acted, never to
 * the one open by then.
 */

const AGENT_1 = '/w/agent-1.adf'
const AGENT_2 = '/w/agent-2.adf'

let startAgent: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAgentStore.getState().reset()
  useDocumentStore.getState().reset()
  useDocumentStore.getState().setFilePath(AGENT_1)
  startAgent = vi.fn(async () => ({ success: true, sessionId: 's-1', agentState: 'idle' }))
  vi.stubGlobal('window', {
    adfApi: {
      // The user switches to agent-2 while the review check is answered.
      checkAgentReview: async () => {
        useDocumentStore.getState().setFilePath(AGENT_2)
        return { needsReview: false }
      },
      startAgent
    }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('startForegroundAgent', () => {
  it('starts the agent open when it was called, not the one open after the review check', async () => {
    expect(await startForegroundAgent()).toEqual({ success: true })
    expect(startAgent).toHaveBeenCalledWith(AGENT_1, undefined)
    // agent-2's view is not told agent-1 started.
    expect(useAgentStore.getState().state).not.toBe('idle')
  })

  it('starts exactly the agent the caller names', async () => {
    await startForegroundAgent({ filePath: AGENT_1, hasUserMessage: true })
    expect(startAgent).toHaveBeenCalledWith(AGENT_1, true)
    expect(startAgent).not.toHaveBeenCalledWith(AGENT_2, expect.anything())
  })
})
