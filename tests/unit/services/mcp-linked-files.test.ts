import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  containerLinkedFileReader,
  hostLinkedFileReader,
  loadLinkedImages,
  MAX_LINKED_IMAGE_BYTES,
  type McpLinkedFileReader,
} from '../../../src/main/services/mcp-linked-files'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function fakeReader(files: Record<string, Buffer>, root = '/workspace/a1'): McpLinkedFileReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    resolve: (ref) => {
      const p = ref.startsWith('/') ? ref : `${root}/${ref.replace(/^\.\//, '')}`
      return p.startsWith(root + '/') ? p : null
    },
    size: async (p) => files[p]?.length ?? null,
    read: async (p) => { reads.push(p); return files[p] },
  }
}

describe('loadLinkedImages', () => {
  it('inlines images the result text links to under the server cwd', async () => {
    const reader = fakeReader({ '/workspace/a1/shot.png': PNG })
    const out = await loadLinkedImages('- [Screenshot of player](./shot.png)', reader)
    expect(out.images).toEqual([{ data: PNG.toString('base64'), mimeType: 'image/png' }])
    expect(out.notes).toEqual([])
  })

  it('skips links that do not exist and dedupes repeated links', async () => {
    const reader = fakeReader({ '/workspace/a1/a.jpg': PNG })
    const out = await loadLinkedImages('a.jpg then a.jpg and missing.png', reader)
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/jpeg')
    expect(reader.reads).toEqual(['/workspace/a1/a.jpg'])
  })

  it('notes oversized images instead of attaching them', async () => {
    const reader = fakeReader({})
    reader.size = async () => MAX_LINKED_IMAGE_BYTES + 1
    const out = await loadLinkedImages('big.png', reader)
    expect(out.images).toEqual([])
    expect(out.notes[0]).toMatch(/too large to attach inline/)
    expect(reader.reads).toEqual([])
  })

  it('caps at three images per result', async () => {
    const files = Object.fromEntries([1, 2, 3, 4].map(i => [`/workspace/a1/${i}.png`, PNG]))
    const out = await loadLinkedImages('1.png 2.png 3.png 4.png', fakeReader(files))
    expect(out.images).toHaveLength(3)
  })

  it('swallows reader failures (podman gone, file vanished)', async () => {
    const reader = fakeReader({ '/workspace/a1/x.png': PNG })
    reader.read = async () => { throw new Error('podman cp failed') }
    const out = await loadLinkedImages('x.png', reader)
    expect(out.images).toEqual([])
  })
})

describe('hostLinkedFileReader', () => {
  it('reads files inside the scratch dir and refuses escapes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-linked-'))
    try {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'shot.png'), PNG)
      const reader = hostLinkedFileReader(dir)
      const p = reader.resolve('./sub/shot.png')!
      expect(p).toBeTruthy()
      expect(await reader.size(p)).toBe(PNG.length)
      expect(await reader.read(p)).toEqual(PNG)
      expect(reader.resolve('../outside.png')).toBeNull()
      expect(await reader.size(join(dir, 'sub'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('containerLinkedFileReader', () => {
  const podman = () => ({
    containerFileSize: vi.fn(async () => PNG.length),
    readContainerFile: vi.fn(async () => PNG),
  })

  it('resolves POSIX paths against the container cwd regardless of host platform', async () => {
    const svc = podman()
    const reader = containerLinkedFileReader(svc, 'adf-mcp', '/workspace/a1')
    expect(reader.resolve('./candidate-peak.png')).toBe('/workspace/a1/candidate-peak.png')
    expect(reader.resolve('.playwright-mcp/page.png')).toBe('/workspace/a1/.playwright-mcp/page.png')
    expect(reader.resolve('/workspace/a1/abs.png')).toBe('/workspace/a1/abs.png')
    expect(reader.resolve('sub\\win.png')).toBe('/workspace/a1/sub/win.png')
  })

  it('refuses paths that escape the cwd', () => {
    const reader = containerLinkedFileReader(podman(), 'adf-mcp', '/workspace/a1')
    expect(reader.resolve('../a2/secret.png')).toBeNull()
    expect(reader.resolve('/etc/x.png')).toBeNull()
    expect(reader.resolve('/workspace/a10/x.png')).toBeNull()
  })

  it('reads through the podman service with the container name', async () => {
    const svc = podman()
    const reader = containerLinkedFileReader(svc, 'adf-agent-x', '/workspace')
    const p = reader.resolve('shot.png')!
    expect(p).toBe('/workspace/shot.png')
    expect(await reader.size(p)).toBe(PNG.length)
    expect(svc.containerFileSize).toHaveBeenCalledWith('adf-agent-x', '/workspace/shot.png')
    expect(await reader.read(p)).toEqual(PNG)
    expect(svc.readContainerFile).toHaveBeenCalledWith('adf-agent-x', '/workspace/shot.png')
  })

  it('end to end: a Playwright filename screenshot inside the container is recovered', async () => {
    const svc = podman()
    const reader = containerLinkedFileReader(svc, 'adf-mcp', '/workspace/a1')
    const text = '### Result\n- [Screenshot of player](./candidate-peak.png)\n### Events\n- .playwright-mcp/console-1.log#L18-L20'
    const out = await loadLinkedImages(text, reader)
    expect(out.images).toEqual([{ data: PNG.toString('base64'), mimeType: 'image/png' }])
    expect(svc.readContainerFile).toHaveBeenCalledTimes(1)
  })
})
