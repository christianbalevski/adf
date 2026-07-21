import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FsTransferTool } from '../../../src/main/tools/built-in/fs-transfer.tool'
import type { PodmanService } from '../../../src/main/services/podman.service'

describe('fs_transfer containment', () => {
  it('uses /workspace directly for isolated containers', async () => {
    const copyFromContainer = vi.fn(async (_path: string, hostPath: string) => { writeFileSync(join(hostPath, 'result.txt'), 'payload') })
    const service = { copyFromContainer } as unknown as PodmanService
    const writeFileBuffer = vi.fn()
    const tool = new FsTransferTool(service, {
      hasIsolated: true,
      hasShared: true,
      hasHost: false,
      isolatedContainerName: 'adf-agent-12345678',
      agentId: 'agent-1',
    })

    const result = await tool.execute(
      { from: 'isolated', to: 'vfs', path: 'reports/result.txt' },
      { writeFileBuffer, getMimeType: () => 'text/plain' } as any,
    )

    expect(result.isError).toBe(false)
    expect(copyFromContainer).toHaveBeenCalledWith(
      '/workspace/reports/result.txt',
      expect.any(String),
      'adf-agent-12345678',
    )
    expect(writeFileBuffer).toHaveBeenCalled()
  })

  it('rejects traversal before touching any environment', async () => {
    const service = { copyFromContainer: vi.fn() } as unknown as PodmanService
    const tool = new FsTransferTool(service, {
      hasIsolated: true,
      hasShared: true,
      hasHost: true,
      isolatedContainerName: 'adf-agent-12345678',
      agentId: 'agent-1',
    })

    const result = await tool.execute(
      { from: 'isolated', to: 'host', path: '../../outside' },
      {} as any,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('may not escape')
    expect(service.copyFromContainer).not.toHaveBeenCalled()
  })
})
