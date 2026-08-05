import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'

/**
 * Tests for the two discoverability/multimodal additions:
 * 1. `config tools` progressive disclosure (roster vs full schema)
 * 2. Media manifest: `cat` on a media mime emits a marker + media[] which
 *    the executor turns into multimodal blocks via the fs_read machinery.
 */

const TOOL_FIXTURE = {
  tools: [
    { name: 'fs_read', enabled: true, visible: false, restricted: false, locked: false, source: 'builtin', description: 'Read a file from the workspace. Returns JSON row.', schema: { type: 'object', properties: { path: { type: 'string' } } }, restrictions: { restricted: false, locked: false } },
    { name: 'msg_send', enabled: true, visible: true, restricted: true, locked: false, source: 'builtin', description: 'Send a message to another agent.', schema: { type: 'object', properties: { recipient: { type: 'string' } } }, restrictions: { restricted: true, locked: false } },
    { name: 'mcp_files_search', enabled: false, visible: false, restricted: false, locked: false, source: 'mcp:files', description: 'Search files via MCP.', schema: {}, restrictions: { restricted: false, locked: false } },
  ],
}

function makeShell(vfs: Record<string, { content: string; mime_type?: string; size?: number }>) {
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      if (name === 'sys_get_config' && input.section === 'tools') {
        return { content: JSON.stringify(TOOL_FIXTURE), isError: false }
      }
      if (name === 'fs_read') {
        const row = vfs[input.path]
        if (!row) return { content: `not found: ${input.path}`, isError: true }
        return { content: JSON.stringify({ path: input.path, ...row }), isError: false }
      }
      return { content: '{}', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = { insertLog: () => {}, listFiles: () => [] }
  const config: any = {
    name: 'agent-1',
    tools: [
      { name: 'adf_shell', enabled: true },
      { name: 'fs_read', enabled: true },
      { name: 'sys_get_config', enabled: true },
    ],
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  return { shell, fakeWorkspace }
}

async function run(shell: ShellTool, ws: any, command: string) {
  const result = await shell.execute({ command }, ws)
  return JSON.parse(result.content as string)
}

describe('config tools progressive disclosure', () => {
  it('bare listing is a compact roster without schemas', async () => {
    const { shell, fakeWorkspace } = makeShell({})
    const r = await run(shell, fakeWorkspace, 'config tools')
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('fs_read')
    expect(r.stdout).toContain('hidden')
    expect(r.stdout).toContain('restricted')
    expect(r.stdout).toContain('disabled')
    expect(r.stdout).not.toContain('"properties"')
  })

  it('named query returns full schema for matches only', async () => {
    const { shell, fakeWorkspace } = makeShell({})
    const r = await run(shell, fakeWorkspace, 'config tools fs_read')
    expect(r.exit_code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('fs_read')
    expect(parsed[0].schema.properties.path).toBeDefined()
  })

  it('substring pattern matches multiple; unknown name errors', async () => {
    const { shell, fakeWorkspace } = makeShell({})
    const multi = await run(shell, fakeWorkspace, 'config tools s')
    expect(JSON.parse(multi.stdout).length).toBeGreaterThan(1)
    const none = await run(shell, fakeWorkspace, 'config tools zzz')
    expect(none.exit_code).not.toBe(0)
  })
})

describe('shell media manifest', () => {
  const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64')

  it('cat on an image emits marker + media[], no base64 in stdout', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'photo.png': { content: PNG_B64, mime_type: 'image/png', size: 14 },
    })
    const r = await run(shell, fakeWorkspace, 'cat photo.png')
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('image/png')
    expect(r.stdout).toContain('photo.png')
    expect(r.stdout).not.toContain(PNG_B64)
    expect(r.media).toEqual([{ path: 'photo.png', mime_type: 'image/png' }])
  })

  it('media survives pipes and chaining', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'photo.png': { content: PNG_B64, mime_type: 'image/png', size: 14 },
    })
    const r = await run(shell, fakeWorkspace, 'cat photo.png | wc -l && echo done')
    expect(r.exit_code).toBe(0)
    expect(r.media).toEqual([{ path: 'photo.png', mime_type: 'image/png' }])
  })

  it('text files are unaffected (no media field)', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'notes.txt': { content: 'hello', mime_type: 'text/plain', size: 5 },
    })
    const r = await run(shell, fakeWorkspace, 'cat -r notes.txt')
    expect(r.stdout).toBe('hello')
    expect(r.media).toBeUndefined()
  })
})

describe('executor shell media extraction', () => {
  function callExtract(resultContent: string, opts?: { imageEnabled?: boolean; buffer?: Buffer | null }) {
    const fakeThis: any = {
      session: { getWorkspace: () => ({ readFileBuffer: () => opts?.buffer !== undefined ? opts.buffer : Buffer.from('fake-png-bytes') }) },
      config: { limits: {} },
      isMultimodalEnabled: (m: string) => (opts?.imageEnabled ?? true) && m === 'image',
    }
    // Bind the real private extractors onto the fake receiver
    for (const m of ['maybeExtractImageBlock', 'maybeExtractAudioBlock', 'maybeExtractVideoBlock', 'extractShellMediaBlocks']) {
      fakeThis[m] = (AgentExecutor.prototype as any)[m]
    }
    return fakeThis.extractShellMediaBlocks({ content: resultContent, isError: false })
  }

  it('turns a media manifest into an image block via the fs_read machinery', () => {
    const blocks = callExtract(JSON.stringify({
      exit_code: 0, stdout: '[image/png: photo.png]', stderr: '',
      media: [{ path: 'photo.png', mime_type: 'image/png' }],
    }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('image_url')
    expect(blocks[0].image_url.url).toContain('data:image/png;base64,')
  })

  it('returns nothing when modality disabled or file missing', () => {
    const manifest = JSON.stringify({
      exit_code: 0, stdout: '', stderr: '',
      media: [{ path: 'photo.png', mime_type: 'image/png' }],
    })
    expect(callExtract(manifest, { imageEnabled: false })).toHaveLength(0)
    expect(callExtract(manifest, { buffer: null })).toHaveLength(0)
  })

  it('ignores results without a media field', () => {
    expect(callExtract(JSON.stringify({ exit_code: 0, stdout: 'x', stderr: '' }))).toHaveLength(0)
  })
})
