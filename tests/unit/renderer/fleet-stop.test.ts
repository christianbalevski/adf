import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopMapAgent } from '../../../src/renderer/components/mesh/runtime-fleet'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { agentKey } from '../../../src/shared/types/agent-ref'

const PATH = '/agents/one.adf'
const OTHER = '/agents/two.adf'
const REMOTE = 'remote:host-1'
const key = (runtimeId: string, filePath = PATH) => agentKey({ runtimeId, filePath })
const surface = () => ({
  stopAgent: vi.fn(async () => ({ success: true })),
  stopBackgroundAgent: vi.fn(async (_filePath: string) => ({ success: true }))
})

describe('turning agents off from the fleet map', () => {
  let local: ReturnType<typeof surface>
  let remote: ReturnType<typeof surface>

  beforeEach(() => {
    local = surface()
    remote = surface()
    vi.stubGlobal('window', { adfApi: { ...local, runtime: vi.fn(() => remote) } })
    useDocumentStore.getState().setFilePath(PATH, 'local')
    useAgentStore.getState().setState('idle')
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['local', REMOTE])('stops the open agent on %s and updates its state', async (runtimeId) => {
    useDocumentStore.getState().setFilePath(PATH, runtimeId)
    await stopMapAgent(key(runtimeId))
    const target = runtimeId === 'local' ? local : remote
    const other = runtimeId === 'local' ? remote : local
    expect(target.stopAgent).toHaveBeenCalledOnce()
    expect(target.stopBackgroundAgent).not.toHaveBeenCalled()
    expect(other.stopAgent).not.toHaveBeenCalled()
    expect(other.stopBackgroundAgent).not.toHaveBeenCalled()
    expect(useAgentStore.getState().state).toBe('off')
  })

  it('stops a background agent without changing the open agent', async () => {
    await stopMapAgent(OTHER)
    expect(local.stopBackgroundAgent).toHaveBeenCalledWith(OTHER)
    expect(local.stopAgent).not.toHaveBeenCalled()
    expect(useAgentStore.getState().state).toBe('idle')
  })

  it.each(['local', REMOTE])('does not confuse the same path on another runtime when %s is open', async (runtimeId) => {
    useDocumentStore.getState().setFilePath(PATH, runtimeId)
    const otherRuntime = runtimeId === 'local' ? REMOTE : 'local'
    await stopMapAgent(key(otherRuntime))
    const target = otherRuntime === 'local' ? local : remote
    expect(target.stopBackgroundAgent).toHaveBeenCalledWith(PATH)
    expect(local.stopAgent).not.toHaveBeenCalled()
    expect(remote.stopAgent).not.toHaveBeenCalled()
    expect(useAgentStore.getState().state).toBe('idle')
  })

  it('leaves the open agent running when shutdown throws', async () => {
    local.stopAgent.mockRejectedValueOnce(new Error('Disconnected'))
    await expect(stopMapAgent(PATH)).rejects.toThrow('Disconnected')
    expect(useAgentStore.getState().state).toBe('idle')
  })

  it.each([PATH, OTHER])('reports an unsuccessful shutdown of %s', async (filePath) => {
    local.stopAgent.mockResolvedValueOnce({ success: false })
    local.stopBackgroundAgent.mockResolvedValueOnce({ success: false })
    await expect(stopMapAgent(filePath)).rejects.toThrow('Agent did not stop')
    expect(useAgentStore.getState().state).toBe('idle')
  })

  it.each([PATH, OTHER])('does not overwrite the view opened during shutdown (%s)', async (filePath) => {
    let finish!: (result: { success: boolean }) => void
    local.stopAgent.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const stopping = stopMapAgent(PATH)
    useDocumentStore.getState().setFilePath(filePath, 'local')
    useAgentStore.getState().setState('active')
    finish({ success: true })
    await stopping
    expect(useAgentStore.getState().state).toBe('active')
  })
})
