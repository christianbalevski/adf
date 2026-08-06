import { describe, it, expect, vi } from 'vitest'
import { isTextMime } from '../../../src/main/tools/built-in/mime-utils'

/** Spin report: find path/glob semantics + textual MIME classification. */

async function getHandler(name: string) {
  const { filesystemHandlers } = await import('../../../src/main/tools/shell/commands/filesystem')
  return filesystemHandlers.find(h => h.name === name)!
}

function ctxOf(o: { args?: string[]; flags?: any; vfs?: Record<string, { content: string; mime_type?: string }> }) {
  const vfs = o.vfs ?? {}
  return {
    stdin: '', args: o.args ?? [], flags: o.flags ?? {}, rawArgs: o.args ?? [],
    config: { limits: {} },
    workspace: { listFiles: () => Object.keys(vfs).map(p => ({ path: p, mime_type: vfs[p].mime_type })) },
    toolRegistry: {
      executeTool: vi.fn(async (name: string, input: any) => {
        if (name === 'fs_read') {
          const f = vfs[input.path]
          if (!f) return { content: 'nf', isError: true }
          const isText = f.mime_type?.startsWith('text/') || f.mime_type === 'application/x-ndjson'
          const content = isText ? f.content : Buffer.from(f.content).toString('base64')
          return { content: JSON.stringify({ path: input.path, content, mime_type: f.mime_type, size: f.content.length }), isError: false }
        }
        return { content: '{}', isError: false }
      }),
    },
    env: {},
  } as any
}

describe('find path/glob', () => {
  const vfs = {
    'tmp/spin-input.json': { content: '{}' },
    'tmp/spin-input.jsonl': { content: '{}' },
    'tmp/other.txt': { content: 'x' },
    'root.txt': { content: 'y' },
  }
  it('exact path matches only that file, not a longer sibling', async () => {
    const find = await getHandler('find')
    const r = await find.execute(ctxOf({ args: ['tmp/spin-input.json'], vfs }))
    expect(r.stdout).toBe('tmp/spin-input.json') // NOT the .jsonl
  })
  it('directory prefix matches files under it, not outside', async () => {
    const find = await getHandler('find')
    const r = await find.execute(ctxOf({ args: ['tmp'], vfs }))
    const paths = r.stdout.split('\n').sort()
    expect(paths).not.toContain('root.txt')
    expect(paths).toContain('tmp/other.txt')
  })
  it('-name glob filters by basename', async () => {
    const find = await getHandler('find')
    const r = await find.execute(ctxOf({ args: [], flags: { name: '*.jsonl' }, vfs }))
    expect(r.stdout).toBe('tmp/spin-input.jsonl')
  })
  it('-name substring glob matches', async () => {
    const find = await getHandler('find')
    const r = await find.execute(ctxOf({ args: [], flags: { name: '*spin*' }, vfs }))
    expect(r.stdout.split('\n').sort()).toEqual(['tmp/spin-input.json', 'tmp/spin-input.jsonl'])
  })
})

describe('textual MIME classification', () => {
  it('recognizes NDJSON / TSV / CSV / +json suffix as text', () => {
    expect(isTextMime('application/x-ndjson')).toBe(true)
    expect(isTextMime('text/tab-separated-values')).toBe(true)
    expect(isTextMime('text/csv')).toBe(true)
    expect(isTextMime('application/vnd.api+json')).toBe(true)
  })
  it('still treats real binary as binary', () => {
    expect(isTextMime('application/zip')).toBe(false)
    expect(isTextMime('image/png')).toBe(false)
    expect(isTextMime(undefined)).toBe(false)
  })
})

describe('cat --text escape hatch', () => {
  it('decodes a mis-typed binary file back to text', async () => {
    const cat = await getHandler('cat')
    const vfs = { 'data.bin': { content: 'a\tb\tc\n', mime_type: 'application/octet-stream' } }
    const marker = await cat.execute(ctxOf({ args: ['data.bin'], vfs }))
    expect(marker.stdout).toContain('[binary:') // default: marker
    const forced = await cat.execute(ctxOf({ args: ['data.bin'], flags: { text: true }, vfs }))
    expect(forced.stdout).toBe('a\tb\tc\n') // --text: real bytes
  })
})
