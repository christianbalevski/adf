import { describe, it, expect, vi } from 'vitest'

/**
 * Golden tests for text commands backed by real coreutils (uutils
 * wasm32-wasip1, in-memory WASI). Assertions follow GNU semantics —
 * including behavior the previous hand-written TypeScript implementations
 * got wrong or lacked (tr character ranges/classes, sort -t, uniq -f,
 * cut -c, locale-independent sort order).
 */

async function getHandler(name: string) {
  const { textHandlers } = await import(
    '../../../src/main/tools/shell/commands/text'
  )
  return textHandlers.find(h => h.name === name)!
}

function makeCtx(opts: {
  rawArgs?: string[]
  args?: string[]
  flags?: Record<string, string | boolean | string[]>
  stdin?: string
  vfs?: Record<string, string>
}) {
  const vfs = opts.vfs ?? {}
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      if (name === 'fs_read') {
        const content = vfs[input.path]
        if (content === undefined) return { content: `not found: ${input.path}`, isError: true }
        // Mirror fs_read's contract: text mime → raw text content.
        return { content: JSON.stringify({ path: input.path, content, mime_type: 'text/plain', size: content.length }), isError: false }
      }
      return { content: '{}', isError: false }
    }),
  }
  return {
    stdin: opts.stdin ?? '',
    args: opts.args ?? [],
    flags: opts.flags ?? {},
    rawArgs: opts.rawArgs ?? opts.args ?? [],
    workspace: {},
    toolRegistry: fakeRegistry,
    config: {},
    env: {},
  } as any
}

describe('sort (coreutils WASM)', () => {
  it('sorts stdin lines', async () => {
    const h = await getHandler('sort')
    const r = await h.execute(makeCtx({ stdin: 'banana\napple\ncherry\n' }))
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('apple\nbanana\ncherry')
  })

  it('-r reverses, -n numeric, -u unique', async () => {
    const h = await getHandler('sort')
    const rev = await h.execute(makeCtx({ stdin: 'a\nb\n', rawArgs: ['-r'], flags: { r: true } }))
    expect(rev.stdout).toBe('b\na')
    const num = await h.execute(makeCtx({ stdin: '10\n9\n2\n', rawArgs: ['-n'], flags: { n: true } }))
    expect(num.stdout).toBe('2\n9\n10')
    const uniq = await h.execute(makeCtx({ stdin: 'b\na\nb\n', rawArgs: ['-u'], flags: { u: true } }))
    expect(uniq.stdout).toBe('a\nb')
  })

  it('-t and -k sort by delimited field (new capability)', async () => {
    const h = await getHandler('sort')
    const r = await h.execute(makeCtx({
      stdin: 'x:3\ny:1\nz:2\n',
      rawArgs: ['-t', ':', '-k', '2', '-n'],
      flags: { t: ':', k: '2', n: true },
    }))
    expect(r.stdout).toBe('y:1\nz:2\nx:3')
  })

  it('sorts a VFS file argument', async () => {
    const h = await getHandler('sort')
    const r = await h.execute(makeCtx({
      args: ['data/list.txt'],
      rawArgs: ['data/list.txt'],
      vfs: { 'data/list.txt': 'b\na\n' },
    }))
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('a\nb')
  })

  it('missing file → error', async () => {
    const h = await getHandler('sort')
    const r = await h.execute(makeCtx({ args: ['nope.txt'], rawArgs: ['nope.txt'] }))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('nope.txt')
  })
})

describe('uniq (coreutils WASM)', () => {
  it('dedupes adjacent lines', async () => {
    const h = await getHandler('uniq')
    const r = await h.execute(makeCtx({ stdin: 'a\na\nb\na\n' }))
    expect(r.stdout).toBe('a\nb\na')
  })

  it('-c prefixes GNU-style counts', async () => {
    const h = await getHandler('uniq')
    const r = await h.execute(makeCtx({ stdin: 'a\na\nb\n', rawArgs: ['-c'], flags: { c: true } }))
    expect(r.stdout.split('\n').map(l => l.trim())).toEqual(['2 a', '1 b'])
  })

  it('-f skips fields (new capability)', async () => {
    const h = await getHandler('uniq')
    const r = await h.execute(makeCtx({
      stdin: '1 x\n2 x\n3 y\n',
      rawArgs: ['-f', '1'],
      flags: { f: '1' },
    }))
    expect(r.stdout).toBe('1 x\n3 y')
  })
})

describe('wc (coreutils WASM)', () => {
  it('counts stdin', async () => {
    const h = await getHandler('wc')
    const r = await h.execute(makeCtx({ stdin: 'one two\nthree\n' }))
    const nums = r.stdout.trim().split(/\s+/).map(Number)
    expect(nums).toEqual([2, 3, 14])
  })

  it('-l counts lines only', async () => {
    const h = await getHandler('wc')
    const r = await h.execute(makeCtx({ stdin: 'a\nb\nc\n', rawArgs: ['-l'], flags: { l: true } }))
    expect(r.stdout.trim()).toBe('3')
  })

  it('multiple files include per-file rows and total with original names', async () => {
    const h = await getHandler('wc')
    const r = await h.execute(makeCtx({
      args: ['a.txt', 'b.txt'],
      rawArgs: ['-l', 'a.txt', 'b.txt'],
      flags: { l: true },
      vfs: { 'a.txt': 'x\n', 'b.txt': 'y\nz\n' },
    }))
    expect(r.exit_code).toBe(0)
    const lines = r.stdout.split('\n').map(l => l.trim())
    expect(lines).toEqual(['1 a.txt', '2 b.txt', '3 total'])
  })
})

describe('cut (coreutils WASM)', () => {
  it('-d/-f extracts fields', async () => {
    const h = await getHandler('cut')
    const r = await h.execute(makeCtx({
      stdin: 'a:b:c\nd:e:f\n',
      rawArgs: ['-d', ':', '-f', '2'],
      flags: { d: ':', f: '2' },
    }))
    expect(r.stdout).toBe('b\ne')
  })

  it('field ranges and open ranges', async () => {
    const h = await getHandler('cut')
    const r = await h.execute(makeCtx({
      stdin: 'a:b:c:d\n',
      rawArgs: ['-d', ':', '-f', '2-'],
      flags: { d: ':', f: '2-' },
    }))
    expect(r.stdout).toBe('b:c:d')
  })

  it('-c selects characters (new capability)', async () => {
    const h = await getHandler('cut')
    const r = await h.execute(makeCtx({
      stdin: 'abcdef\n',
      rawArgs: ['-c', '2-4'],
      flags: { c: '2-4' },
    }))
    expect(r.stdout).toBe('bcd')
  })
})

describe('tr (coreutils WASM)', () => {
  it('translates literal characters', async () => {
    const h = await getHandler('tr')
    const r = await h.execute(makeCtx({ stdin: 'abc', args: ['b', 'x'], rawArgs: ['b', 'x'] }))
    expect(r.stdout).toBe('axc')
  })

  it('supports ranges a-z (new capability)', async () => {
    const h = await getHandler('tr')
    const r = await h.execute(makeCtx({ stdin: 'hello', args: ['a-z', 'A-Z'], rawArgs: ['a-z', 'A-Z'] }))
    expect(r.stdout).toBe('HELLO')
  })

  it('-d deletes characters (new capability)', async () => {
    const h = await getHandler('tr')
    const r = await h.execute(makeCtx({
      stdin: 'a1b2c3', args: ['0-9'], rawArgs: ['-d', '0-9'], flags: { d: true },
    }))
    expect(r.stdout).toBe('abc')
  })

  it('-s squeezes repeats (new capability)', async () => {
    const h = await getHandler('tr')
    const r = await h.execute(makeCtx({
      stdin: 'aaabbb', args: ['a-z'], rawArgs: ['-s', 'a-z'], flags: { s: true },
    }))
    expect(r.stdout).toBe('ab')
  })
})
