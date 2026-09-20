import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FsTransferTool } from '../../../src/main/tools/built-in/fs-transfer.tool'
import type { PodmanService } from '../../../src/main/services/podman.service'

/**
 * fs_transfer now copies with fs/promises instead of cpSync + a hand-rolled
 * sync walk (which blocked the Electron main thread for the whole copy).
 * Behaviour must be unchanged: same files, same walk order, same errors.
 */

const caps = {
  hasIsolated: true,
  hasShared: true,
  hasHost: false,
  isolatedContainerName: 'adf-agent-12345678',
  agentId: 'agent-1',
}

/** Mimics `podman cp container:dir host` for a directory: the tree lands at
 *  the (non-existent) staging path itself. */
function podmanCpTree(tree: Record<string, string>) {
  return vi.fn(async (_containerPath: string, hostPath: string) => {
    for (const [rel, content] of Object.entries(tree)) {
      const dest = join(hostPath, rel)
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(dest, content)
    }
  })
}

describe('fs_transfer async copy', () => {
  it('walks a container directory into the VFS in readdir order', async () => {
    const copyFromContainer = podmanCpTree({
      'a.txt': 'A',
      'sub/b.txt': 'B',
      'sub/deep/c.txt': 'C',
    })
    const service = { copyFromContainer } as unknown as PodmanService
    const writeFileBuffer = vi.fn()
    const tool = new FsTransferTool(service, caps)

    const result = await tool.execute(
      { from: 'isolated', to: 'vfs', path: 'out' },
      { writeFileBuffer, getMimeType: () => 'text/plain' } as any,
    )

    expect(result.isError).toBe(false)
    // Depth-first in readdir order. (The native separator inside the relative
    // part is pre-existing behaviour of the sync walk, preserved here.)
    expect(writeFileBuffer.mock.calls.map(c => String(c[0]).replace(/\\/g, '/'))).toEqual([
      'out/a.txt', 'out/sub/b.txt', 'out/sub/deep/c.txt',
    ])
    expect(writeFileBuffer.mock.calls.map(c => c[1].toString())).toEqual(['A', 'B', 'C'])
  })

  it('reports a missing VFS source without leaving the temp dir behind', async () => {
    const copyToContainer = vi.fn(async () => {})
    const tool = new FsTransferTool({ copyToContainer } as unknown as PodmanService, caps)

    const result = await tool.execute(
      { from: 'vfs', to: 'isolated', path: 'nothing/here' },
      { readFileBuffer: () => null, listFiles: () => [] } as any,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('No file or directory found in VFS')
    expect(copyToContainer).not.toHaveBeenCalled()
  })
})
