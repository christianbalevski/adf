import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FsTransferTool } from '../../../src/main/tools/built-in/fs-transfer.tool'
import type { PodmanService } from '../../../src/main/services/podman.service'

const caps = {
  hasIsolated: true,
  hasShared: true,
  hasHost: false,
  isolatedContainerName: 'adf-agent-12345678',
  agentId: 'agent-1',
}

/**
 * Mimics `podman cp container:src host` semantics: a file lands exactly at
 * `hostPath` when that path does not exist, but *inside* it when it is an
 * existing directory (the behaviour that produced foo.png/foo.png).
 */
function podmanCpFile(name: string, bytes = 'payload') {
  return vi.fn(async (_containerPath: string, hostPath: string) => {
    const target = existsSync(hostPath) && statSync(hostPath).isDirectory() ? join(hostPath, name) : hostPath
    writeFileSync(target, bytes)
  })
}

describe('fs_transfer containment', () => {
  it('uses /workspace directly for isolated containers', async () => {
    const copyFromContainer = podmanCpFile('result.txt')
    const service = { copyFromContainer } as unknown as PodmanService
    const writeFileBuffer = vi.fn()
    const tool = new FsTransferTool(service, caps)

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
    expect(writeFileBuffer).toHaveBeenCalledTimes(1)
    expect(writeFileBuffer.mock.calls[0][0]).toBe('reports/result.txt')
  })

  it('does not double the file name on container → vfs (staging must not pre-exist)', async () => {
    // Regression: screenshots/foo.png arrived as screenshots/foo.png/foo.png.
    const copyFromContainer = podmanCpFile('foo.png')
    const service = { copyFromContainer } as unknown as PodmanService
    const writeFileBuffer = vi.fn()
    const tool = new FsTransferTool(service, caps)

    const result = await tool.execute(
      { from: 'shared', to: 'vfs', path: 'screenshots/foo.png' },
      { writeFileBuffer, getMimeType: () => 'image/png' } as any,
    )

    expect(result.isError).toBe(false)
    const staging = copyFromContainer.mock.calls[0][1]
    expect(existsSync(staging)).toBe(false) // cleaned up, and never pre-created as a dir
    expect(writeFileBuffer).toHaveBeenCalledTimes(1)
    expect(writeFileBuffer.mock.calls[0][0]).toBe('screenshots/foo.png')
  })

  it('copies directory contents (payload/.) when pushing a tree into a container', async () => {
    const copyToContainer = vi.fn(async () => {})
    const service = { copyToContainer } as unknown as PodmanService
    const tool = new FsTransferTool(service, caps)
    const workspace = {
      readFileBuffer: (p: string) => (p === 'shots/a.png' || p === 'shots/sub/b.png' ? Buffer.from('x') : null),
      listFiles: () => [{ path: 'shots/a.png' }, { path: 'shots/sub/b.png' }, { path: 'other.txt' }],
    }

    const result = await tool.execute({ from: 'vfs', to: 'isolated', path: 'shots' }, workspace as any)

    expect(result.isError).toBe(false)
    const [source, dest, name] = copyToContainer.mock.calls[0]
    expect(source.endsWith(`${sep}payload${sep}.`)).toBe(true)
    expect(dest).toBe('/workspace/shots')
    expect(name).toBe('adf-agent-12345678')
  })

  it('pushes a single vfs file into a container without the /. suffix', async () => {
    const copyToContainer = vi.fn(async () => {})
    const service = { copyToContainer } as unknown as PodmanService
    const tool = new FsTransferTool(service, caps)
    const workspace = {
      readFileBuffer: (p: string) => (p === 'a.txt' ? Buffer.from('x') : null),
      listFiles: () => [{ path: 'a.txt' }],
    }

    const result = await tool.execute({ from: 'vfs', to: 'shared', path: 'a.txt', save_as: 'out/a.txt' }, workspace as any)

    expect(result.isError).toBe(false)
    const [source, dest] = copyToContainer.mock.calls[0]
    expect(source.endsWith(`${sep}payload`)).toBe(true)
    expect(dest).toBe('/workspace/agent-1/out/a.txt')
  })

  it('rejects traversal before touching any environment', async () => {
    const service = { copyFromContainer: vi.fn() } as unknown as PodmanService
    const tool = new FsTransferTool(service, { ...caps, hasHost: true })

    const result = await tool.execute(
      { from: 'isolated', to: 'host', path: '../../outside' },
      {} as any,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('may not escape')
    expect(service.copyFromContainer).not.toHaveBeenCalled()
  })
})
