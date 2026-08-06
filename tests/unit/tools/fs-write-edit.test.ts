import { describe, it, expect } from 'vitest'
import { FsWriteTool } from '../../../src/main/tools/built-in/fs-write.tool'

/** #1 replace_all, #2 atomic batch edits, #3 per-file concurrency lock. */

function makeWorkspace(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial }
  const ws: any = {
    getFileProtection: () => 'none',
    getAgentConfig: () => ({ limits: {} }),
    readFile: (p: string) => (p in files ? files[p] : null),
    writeFile: (p: string, c: string) => { files[p] = c },
    writeFileBuffer: (p: string, b: Buffer) => { files[p] = b.toString('base64') },
    readDocument: () => files['README.md'] ?? '',
    writeDocument: (c: string) => { files['README.md'] = c },
    readMind: () => files['mind.md'] ?? '',
    writeMind: (c: string) => { files['mind.md'] = c },
  }
  return { ws, files }
}

const tool = new FsWriteTool()

describe('#1 replace_all', () => {
  it('single unique edit works (default)', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'the cat sat' })
    const r = await tool.execute({ mode: 'edit', path: 'f.txt', old_text: 'cat', new_text: 'dog' }, ws)
    expect(r.isError).toBe(false)
    expect(files['f.txt']).toBe('the dog sat')
  })

  it('ambiguous edit without replace_all errors and writes nothing', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'a a a' })
    const r = await tool.execute({ mode: 'edit', path: 'f.txt', old_text: 'a', new_text: 'b' }, ws)
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('multiple times')
    expect(files['f.txt']).toBe('a a a') // unchanged
  })

  it('replace_all replaces every occurrence and reports the count', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'a a a' })
    const r = await tool.execute({ mode: 'edit', path: 'f.txt', old_text: 'a', new_text: 'b', replace_all: true }, ws)
    expect(r.isError).toBe(false)
    expect(files['f.txt']).toBe('b b b')
    expect(String(r.content)).toContain('3 replacement')
  })

  it('not-found errors clearly', async () => {
    const { ws } = makeWorkspace({ 'f.txt': 'x' })
    const r = await tool.execute({ mode: 'edit', path: 'f.txt', old_text: 'zzz', new_text: 'y' }, ws)
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('not found')
  })
})

describe('#2 atomic batch edits', () => {
  it('applies edits in order', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'one two three' })
    const r = await tool.execute({
      mode: 'edit', path: 'f.txt',
      edits: [
        { old_text: 'one', new_text: '1' },
        { old_text: 'two', new_text: '2' },
        { old_text: 'three', new_text: '3' },
      ],
    }, ws)
    expect(r.isError).toBe(false)
    expect(files['f.txt']).toBe('1 2 3')
    expect(String(r.content)).toContain('3 edits')
  })

  it('sequential dependency: a later edit can target text a prior edit produced', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'A' })
    const r = await tool.execute({
      mode: 'edit', path: 'f.txt',
      edits: [{ old_text: 'A', new_text: 'B' }, { old_text: 'B', new_text: 'C' }],
    }, ws)
    expect(r.isError).toBe(false)
    expect(files['f.txt']).toBe('C')
  })

  it('is atomic: one failing edit aborts the whole batch, file unchanged', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'keep this' })
    const r = await tool.execute({
      mode: 'edit', path: 'f.txt',
      edits: [{ old_text: 'keep', new_text: 'KEEP' }, { old_text: 'MISSING', new_text: 'x' }],
    }, ws)
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('aborted')
    expect(files['f.txt']).toBe('keep this') // first edit NOT applied
  })

  it('replace_all inside a batch', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'x x | y' })
    const r = await tool.execute({
      mode: 'edit', path: 'f.txt',
      edits: [{ old_text: 'x', new_text: 'z', replace_all: true }, { old_text: 'y', new_text: 'w' }],
    }, ws)
    expect(r.isError).toBe(false)
    expect(files['f.txt']).toBe('z z | w')
  })
})

describe('append mode', () => {
  it('appends to an existing file', async () => {
    const { ws, files } = makeWorkspace({ 'log.txt': 'line1\n' })
    const r = await tool.execute({ mode: 'append', path: 'log.txt', content: 'line2\n' }, ws)
    expect(r.isError).toBe(false)
    expect(files['log.txt']).toBe('line1\nline2\n')
  })
  it('creates the file if absent', async () => {
    const { ws, files } = makeWorkspace()
    await tool.execute({ mode: 'append', path: 'new.txt', content: 'hi' }, ws)
    expect(files['new.txt']).toBe('hi')
  })
})

describe('#3 concurrency lock', () => {
  it('serializes concurrent edits on the same file (no clobber)', async () => {
    const { ws, files } = makeWorkspace({ 'f.txt': 'a=0 b=0' })
    // Two edits fired without awaiting between them — must both land.
    const [r1, r2] = await Promise.all([
      tool.execute({ mode: 'edit', path: 'f.txt', old_text: 'a=0', new_text: 'a=1' }, ws),
      tool.execute({ mode: 'edit', path: 'f.txt', old_text: 'b=0', new_text: 'b=1' }, ws),
    ])
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)
    expect(files['f.txt']).toBe('a=1 b=1') // both applied; neither clobbered the other
  })

  it('serializes many concurrent appends (all land)', async () => {
    const { ws, files } = makeWorkspace({ 'log.txt': '' })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => tool.execute({ mode: 'append', path: 'log.txt', content: `${i}\n` }, ws))
    )
    const lines = files['log.txt'].trim().split('\n').map(Number).sort((a, b) => a - b)
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => i)) // none lost
  })
})
