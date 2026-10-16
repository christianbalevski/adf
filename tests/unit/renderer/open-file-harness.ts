import { vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { useAdfFile } from '../../../src/renderer/hooks/useAdfFile'
import { useBackgroundAgentEvents } from '../../../src/renderer/hooks/useBackgroundAgents'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import type { AgentExecutionEvent, RendererBackgroundAgentEvent } from '../../../src/shared/types/ipc.types'

/**
 * Drives the renderer's real agent switch (useAdfFile.openFile) against a
 * fake main process that keeps main's ordering: the FILE_OPEN IPC moves main's
 * workspace (and backgrounds the outgoing agent) BEFORE the renderer's
 * filePath follows, then the renderer reads the incoming file and re-attaches
 * it if it was running.
 *
 * The test file must mock react's useEffect to run inline (vi.mock is
 * hoisted per test file), so the background subscriber attaches here.
 */

interface FakeAgent {
  /** Main's display state, as the re-attach reports it. */
  state: string
  /** Side-loop display states, as the re-attach reports them. */
  loopStates?: Record<string, string>
}

export interface OpenFileHarness {
  openFile: (filePath: string) => Promise<unknown>
  /** The real closeFile; main backgrounds the closed agent if it runs. */
  closeFile: () => Promise<void>
  /** `window.adfApi.platform`, which path keys follow. */
  setPlatform: (platform: string) => void
  /** Running agents by file. Every running agent not open is "background". */
  agents: Map<string, FakeAgent>
  /** Push one BACKGROUND_AGENT_EVENT_BATCH. */
  pushBatch: (events: RendererBackgroundAgentEvent[]) => void
  /** Deliver one foreground AGENT_EVENT (main only sends the open file's). */
  pushForeground: (event: AgentExecutionEvent) => void
  /** Runs inside the FILE_OPEN IPC: main has switched, the renderer has not. */
  duringOpen: ((next: string, previous: string | null) => void) | null
  invokeAgent: ReturnType<typeof vi.fn>
}

export function createOpenFileHarness(): OpenFileHarness {
  let pushBatch: (events: RendererBackgroundAgentEvent[]) => void = () => {}
  let current: string | null = null
  const harness: OpenFileHarness = {
    openFile: async () => undefined,
    closeFile: async () => {},
    setPlatform: () => {},
    agents: new Map(),
    pushBatch: (events) => pushBatch(events),
    pushForeground: () => {},
    duringOpen: null,
    invokeAgent: vi.fn(async () => ({ success: true }))
  }

  const adfApi = {
      platform: 'linux',
      openFile: async (filePath: string) => {
        const previous = current
        current = filePath
        harness.duringOpen?.(filePath, previous)
        return { success: true, filePath, agentWasRunning: harness.agents.has(filePath) }
      },
      getBatch: async () => ({ document: '', agentConfig: null, statusText: '', chat: { uiLog: [] } }),
      readInternalFile: async () => null,
      checkAgentReview: async () => ({ needsReview: false }),
      startAgent: async () => {
        const agent = current ? harness.agents.get(current) : undefined
        return { success: true, sessionId: 's-1', agentState: agent?.state ?? 'idle', loopStates: agent?.loopStates, pendingApprovals: [], pendingAsks: [] }
      },
      invokeAgent: harness.invokeAgent,
      getBackgroundAgentStatus: () => new Promise(() => {}),
      onBackgroundAgentEvents: (cb: typeof pushBatch) => { pushBatch = cb; return () => {} },
      closeFile: async () => { current = null }
  }
  vi.stubGlobal('window', { adfApi })
  harness.setPlatform = (platform) => { adfApi.platform = platform }
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

  let api!: ReturnType<typeof useAdfFile>
  const Probe = (): null => { api = useAdfFile(); return null }
  renderToString(createElement(Probe))
  harness.openFile = (filePath) => api.openFile(filePath)
  harness.closeFile = () => api.closeFile()

  useBackgroundAgentEvents()
  harness.pushForeground = createAgentEventHandler()
  return harness
}
