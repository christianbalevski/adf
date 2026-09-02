import { describe, expect, it, vi } from 'vitest'

import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'
import type { McpLinkedFileReader } from '../../../src/main/services/mcp-linked-files'

const h = vi.hoisted(() => {
  class MockClient {
    static instances: MockClient[] = []
    onclose: (() => void) | undefined
    callToolResult: { content: Array<Record<string, unknown>>; isError?: boolean } = { content: [] }
    constructor() { MockClient.instances.push(this) }
    async connect(_transport: unknown): Promise<void> {}
    async listTools(): Promise<{ tools: Array<Record<string, unknown>> }> {
      return { tools: [{ name: 'browser_take_screenshot', inputSchema: {} }] }
    }
    getServerVersion(): { name: string; version: string } | undefined { return undefined }
    async callTool(): Promise<unknown> { return this.callToolResult }
    async close(): Promise<void> {}
    async ping(): Promise<void> {}
  }
  return { MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client', () => ({ Client: h.MockClient }))

import { McpClientManager } from '../../../src/main/services/mcp-client-manager'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function fakeTransport() {
  return { async start() {}, async send() {}, async close() {} }
}

function containerReader(files: Record<string, Buffer>): McpLinkedFileReader {
  return {
    resolve: (ref) => `/workspace/a1/${ref.replace(/^\.\//, '')}`,
    size: async (p) => files[p]?.length ?? null,
    read: async (p) => files[p],
  }
}

describe('McpClientManager linked-image recovery', () => {
  it('uses the connect-time reader (container) rather than the host scratch dir', async () => {
    const manager = new McpClientManager('C:/definitely/not/a/real/scratch')
    const reader = containerReader({ '/workspace/a1/candidate-peak.png': PNG })
    await manager.connect(
      { name: 'playwright', transport: 'stdio', command: 'noop' } as McpServerConfig,
      { externalTransport: fakeTransport(), linkedFileReader: reader },
    )
    const client = h.MockClient.instances.at(-1)!
    client.callToolResult = {
      content: [{ type: 'text', text: '### Result\n- [Screenshot of player](./candidate-peak.png)' }],
    }

    const result = await manager.callTool('playwright', 'browser_take_screenshot', { filename: 'candidate-peak.png' })
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content)
    expect(parsed.images).toEqual([{ data: PNG.toString('base64'), mimeType: 'image/png' }])
    expect(parsed.text).toContain('candidate-peak.png')
  })

  it('leaves results alone when the server already returned an image block', async () => {
    const manager = new McpClientManager()
    const read = vi.fn(async () => PNG)
    const reader: McpLinkedFileReader = { resolve: (r) => `/w/${r}`, size: async () => 1, read }
    await manager.connect(
      { name: 'playwright', transport: 'stdio', command: 'noop' } as McpServerConfig,
      { externalTransport: fakeTransport(), linkedFileReader: reader },
    )
    const client = h.MockClient.instances.at(-1)!
    client.callToolResult = {
      content: [
        { type: 'text', text: 'saved as page.png' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    }
    const result = await manager.callTool('playwright', 'browser_take_screenshot', {})
    expect(JSON.parse(result.content).images).toEqual([{ data: 'AAAA', mimeType: 'image/png' }])
    expect(read).not.toHaveBeenCalled()
  })
})
