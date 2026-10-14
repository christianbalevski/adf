/**
 * Design §6.1 row 24 (start window): a path-addressed write to a file whose
 * load is in flight waits for the load and goes through the loaded agent,
 * instead of writing the closed file under the build (whose start-time
 * config would never see it).
 */
import { describe, expect, it, vi } from 'vitest'
import { PathAgentOps, type PathAgentRuntime } from '../src/main/daemon/path-agent-ops'
import type { AgentFileOps } from '../src/main/daemon/file-ops'

const FILE = '/agents/agent-1.adf'
const ID = '0b8c2d4e-6f1a-4b3c-8d5e-7f9a0b1c2d3e'

describe('PathAgentOps during a load', () => {
  it('waits for the load in flight, then writes through the runtime', async () => {
    let loaded = false
    let finishLoad!: () => void
    const loading = new Promise<void>((resolve) => { finishLoad = () => { loaded = true; resolve() } })
    const attachAgentProvider = vi.fn(async (agentId: string) => ({ agentId, providerId: 'p1', success: true as const, alreadyAttached: false, config: {} }))
    const runtime = {
      attachAgentProvider,
      waitForLoad: vi.fn(async () => { await loading }),
    } as unknown as PathAgentRuntime
    const files = {
      adfPath: async () => FILE,
      loadedAt: () => (loaded ? { id: ID } : undefined),
      openDocumentAt: () => undefined,
      assertNotLeasedElsewhere: async () => {},
    } as unknown as AgentFileOps
    const ops = new PathAgentOps(runtime, files)
    const pending = ops.attachProvider(FILE, { provider: { id: 'p1', type: 'openai' } })
    await new Promise((r) => setTimeout(r, 10))
    expect(attachAgentProvider).not.toHaveBeenCalled()
    finishLoad()
    expect(await pending).toMatchObject({ agentId: ID, loaded: true, filePath: FILE })
    expect(attachAgentProvider).toHaveBeenCalledWith(ID, { id: 'p1', type: 'openai' })
  })
})
