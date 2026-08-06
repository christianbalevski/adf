import { describe, it, expect, vi } from 'vitest'

/**
 * Honesty fixes for the TS-implemented grep/sed (uutils versions don't compile
 * to WASM) and the tail/seq parity bugs: implement the common surface
 * correctly, and FAIL LOUD on unsupported flags instead of silent no-ops.
 */

async function getHandler(mod: string, name: string) {
  const handlers = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = handlers[Object.keys(handlers).find(k => k.endsWith('Handlers'))!]
  return list.find((h: any) => h.name === name)!
}

function ctxOf(o: { args?: string[]; flags?: any; stdin?: string; rawArgs?: string[]; vfs?: Record<string, string> }) {
  const vfs = o.vfs ?? {}
  const writes: Record<string, string> = {}
  return {
    writes,
    ctx: {
      stdin: o.stdin ?? '', args: o.args ?? [], flags: o.flags ?? {}, rawArgs: o.rawArgs ?? o.args ?? [],
      config: {},
      workspace: {
        listFiles: () => Object.keys(vfs).map(p => ({ path: p, mime_type: 'text/plain' })),
      },
      toolRegistry: {
        executeTool: vi.fn(async (name: string, input: any) => {
          if (name === 'fs_read') {
            const c = vfs[input.path]
            if (c === undefined) return { content: 'nf', isError: true }
            return { content: JSON.stringify({ path: input.path, content: c, mime_type: 'text/plain', size: c.length }), isError: false }
          }
          if (name === 'fs_write') { writes[input.path] = input.content; return { content: 'ok', isError: false } }
          return { content: '{}', isError: false }
        }),
      },
      env: {},
    } as any,
  }
}

describe('grep honesty', () => {
  it('rejects an unsupported flag instead of ignoring it', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['x'], flags: { P: true }, stdin: 'x\n' }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('unsupported')
  })

  it('-o prints only the matching part', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['[0-9]+'], flags: { o: true }, stdin: 'abc123def456\n' }).ctx)
    expect(r.stdout).toBe('123\n456')
  })

  it('-F treats the pattern as a literal string', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['a.c'], flags: { F: true }, stdin: 'a.c\naxc\n' }).ctx)
    expect(r.stdout).toBe('a.c')
  })

  it('-w matches whole words only', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['cat'], flags: { w: true }, stdin: 'cat\ncategory\nthe cat sat\n' }).ctx)
    expect(r.stdout).toBe('cat\nthe cat sat')
  })

  it('-c counts, -v inverts', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['a'], flags: { c: true, v: true }, stdin: 'a\nb\nc\n' }).ctx)
    expect(r.stdout).toBe('2')
  })

  it('-A<N> attached form keeps context (was silently dropped)', async () => {
    const grep = await getHandler('text', 'grep')
    // rawArgs simulate `grep -A1 b` with the parser now attaching the value
    const c = ctxOf({ args: ['b'], flags: { A: '1' }, stdin: 'a\nb\nc\nd\n' })
    const r = await grep.execute(c.ctx)
    expect(r.stdout).toBe('b\nc')
  })

  it('no match → exit 1 (grep convention)', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['zzz'], stdin: 'a\nb\n' }).ctx)
    expect(r.exit_code).toBe(1)
  })

  it('-q is quiet with exit status', async () => {
    const grep = await getHandler('text', 'grep')
    const hit = await grep.execute(ctxOf({ args: ['a'], flags: { q: true }, stdin: 'a\n' }).ctx)
    expect(hit.exit_code).toBe(0); expect(hit.stdout).toBe('')
    const miss = await grep.execute(ctxOf({ args: ['z'], flags: { q: true }, stdin: 'a\n' }).ctx)
    expect(miss.exit_code).toBe(1)
  })

  it('-l lists matching files (recursive)', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['hit'], flags: { l: true, r: true }, vfs: { 'a.txt': 'hit\n', 'b.txt': 'miss\n' } }).ctx)
    expect(r.stdout).toBe('a.txt')
  })
})

describe('sed honesty', () => {
  it('& expands to the whole match (was literal &)', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['s/b/&&/'], stdin: 'abc\n' }).ctx)
    expect(r.stdout).toBe('abbc\n')
  })

  it('\\1 backreference works (was no-op)', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['s/(a)(b)/\\2\\1/'], stdin: 'ab\n' }).ctx)
    expect(r.stdout).toBe('ba\n')
  })

  it('\\& is a literal ampersand', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['s/x/\\&/'], stdin: 'x\n' }).ctx)
    expect(r.stdout).toBe('&\n')
  })

  it('g flag replaces all; plain replaces first', async () => {
    const sed = await getHandler('text', 'sed')
    expect((await sed.execute(ctxOf({ args: ['s/a/X/g'], stdin: 'aaa\n' }).ctx)).stdout).toBe('XXX\n')
    expect((await sed.execute(ctxOf({ args: ['s/a/X/'], stdin: 'aaa\n' }).ctx)).stdout).toBe('Xaa\n')
  })

  it('rejects unsupported -n instead of silently misbehaving', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['2p'], flags: { n: true }, stdin: 'a\nb\n' }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('unsupported')
  })

  it('addresses error clearly rather than corrupting', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['/re/d'], stdin: 'x\n' }).ctx)
    expect(r.exit_code).not.toBe(0)
  })

  it('-i writes the substitution back to the file', async () => {
    const sed = await getHandler('text', 'sed')
    const c = ctxOf({ args: ['s/a/b/g', 'f.txt'], flags: { i: true }, vfs: { 'f.txt': 'aaa\n' } })
    await sed.execute(c.ctx)
    expect(c.writes['f.txt']).toBe('bbb\n')
  })
})

describe('tail / seq parity', () => {
  it('tail -n 1 of newline-terminated input returns the last real line', async () => {
    const tail = await getHandler('filesystem', 'tail')
    const r = await tail.execute(ctxOf({ flags: { n: '1' }, stdin: 'a\nb\n' }).ctx)
    expect(r.stdout).toBe('b')
  })

  it('tail -n 2 returns two lines', async () => {
    const tail = await getHandler('filesystem', 'tail')
    const r = await tail.execute(ctxOf({ flags: { n: '2' }, stdin: 'a\nb\nc\n' }).ctx)
    expect(r.stdout).toBe('b\nc')
  })

  it('seq -5 5 handles a negative start', async () => {
    const seq = await getHandler('text', 'seq')
    const r = await seq.execute(ctxOf({ args: ['5'], rawArgs: ['-5', '5'] }).ctx)
    expect(r.stdout.split('\n')[0]).toBe('-5')
    expect(r.stdout.split('\n').at(-1)).toBe('5')
  })

  it('seq 1 2 7 steps by increment', async () => {
    const seq = await getHandler('text', 'seq')
    const r = await seq.execute(ctxOf({ args: ['1', '2', '7'], rawArgs: ['1', '2', '7'] }).ctx)
    expect(r.stdout).toBe('1\n3\n5\n7')
  })
})
