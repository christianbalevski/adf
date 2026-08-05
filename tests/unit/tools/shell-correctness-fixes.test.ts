import { describe, it, expect, vi } from 'vitest'

/**
 * Regression tests for the adversarial-audit correctness findings:
 * stdout-on-nonzero-exit, sort -o rejection, grep -rc / -o / line-numbers,
 * tail -n 0 / +N, sed \0 / \10, cat oversized-media marker.
 */

async function getHandler(mod: string, name: string) {
  const h = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = h[Object.keys(h).find(k => k.endsWith('Handlers'))!]
  return list.find((x: any) => x.name === name)!
}

function ctxOf(o: { args?: string[]; flags?: any; stdin?: string; rawArgs?: string[]; vfs?: Record<string, string>; limits?: any }) {
  const vfs = o.vfs ?? {}
  return {
    stdin: o.stdin ?? '', args: o.args ?? [], flags: o.flags ?? {}, rawArgs: o.rawArgs ?? o.args ?? [],
    config: { limits: o.limits ?? {} },
    workspace: { listFiles: () => Object.keys(vfs).map(p => ({ path: p, mime_type: 'text/plain' })) },
    toolRegistry: {
      executeTool: vi.fn(async (name: string, input: any) => {
        if (name === 'fs_read') {
          const c = vfs[input.path]
          if (c === undefined) return { content: 'nf', isError: true }
          return { content: JSON.stringify({ path: input.path, content: c, mime_type: 'text/plain', size: c.length }), isError: false }
        }
        return { content: '{}', isError: false }
      }),
    },
    env: {},
  } as any
}

describe('stdout preserved on nonzero exit', () => {
  it('jq -e still returns its output alongside exit 1', async () => {
    const jq = await getHandler('structured', 'jq')
    const r = await jq.execute(ctxOf({ args: ['.missing'], flags: { e: true }, stdin: '{}' }))
    expect(r.exit_code).not.toBe(0)          // -e: null/false → nonzero
    expect(r.stdout).toBe('null')            // output NOT discarded
  })
})

describe('coreutils output-writing flags rejected, not silently dropped', () => {
  it('sort -o errors with a redirect hint', async () => {
    const sort = await getHandler('text', 'sort')
    const r = await sort.execute(ctxOf({ args: [], rawArgs: ['-o', 'out.txt'], flags: { o: 'out.txt' }, stdin: 'b\na\n' }))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('redirect')
  })
})

describe('grep correctness', () => {
  it('-rc reports per-file counts, not 0', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['x'], flags: { r: true, c: true }, vfs: { 'a.txt': 'x\nx\n', 'b.txt': 'y\n' } }))
    const lines = r.stdout.split('\n').sort()
    expect(lines).toContain('a.txt:2')
    expect(lines).toContain('b.txt:0')
  })

  it('-o on a zero-width pattern emits nothing (no phantom empties)', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['x*'], flags: { o: true }, stdin: 'abc\n' }))
    expect(r.stdout).toBe('')
    expect(r.exit_code).toBe(1)
  })

  it('-r output has no line numbers without -n', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['hit'], flags: { r: true }, vfs: { 'f.txt': 'hit\n' } }))
    expect(r.stdout).toBe('f.txt:hit')          // path:content, not path:1:content
  })

  it('-rn output includes line numbers', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['hit'], flags: { r: true, n: true }, vfs: { 'f.txt': 'a\nhit\n' } }))
    expect(r.stdout).toBe('f.txt:2:hit')
  })

  it('-h suppresses the filename prefix', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['hit'], flags: { r: true, h: true }, vfs: { 'f.txt': 'hit\n' } }))
    expect(r.stdout).toBe('hit')
  })
})

describe('tail -n edge cases', () => {
  it('-n 0 prints nothing', async () => {
    const tail = await getHandler('filesystem', 'tail')
    const r = await tail.execute(ctxOf({ flags: { n: '0' }, stdin: 'a\nb\nc\n' }))
    expect(r.stdout).toBe('')
  })

  it('-n +2 skips the first line', async () => {
    const tail = await getHandler('filesystem', 'tail')
    const r = await tail.execute(ctxOf({ flags: { n: '+2' }, stdin: 'a\nb\nc\n' }))
    expect(r.stdout).toBe('b\nc')
  })
})

describe('sed backref edge cases', () => {
  it('\\0 is the whole match (not literal $0)', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['s/abc/[\\0]/'], stdin: 'abc' }))
    expect(r.stdout).toBe('[abc]')
  })

  it('\\1 followed by a literal digit does not become group 10', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['s/(a)/\\10/'], stdin: 'a' }))
    expect(r.stdout).toBe('a0')       // group 1 = "a", then literal "0"
  })
})

describe('cat oversized media', () => {
  it('marks an over-limit image as too large and does not attach it', async () => {
    const cat = await getHandler('filesystem', 'cat')
    const ctx: any = ctxOf({ args: ['big.png'], limits: { max_image_size_bytes: 100 } })
    ctx.toolRegistry.executeTool = vi.fn(async () => ({
      content: JSON.stringify({ path: 'big.png', content: 'AAAA', mime_type: 'image/png', size: 999999 }), isError: false,
    }))
    const result = await cat.execute(ctx)
    expect(result.stdout).toContain('too large')
    expect(result.media).toBeUndefined()
  })

  it('attaches an under-limit image', async () => {
    const cat = await getHandler('filesystem', 'cat')
    const ctx: any = ctxOf({ args: ['ok.png'], limits: { max_image_size_bytes: 5_000_000 } })
    ctx.toolRegistry.executeTool = vi.fn(async () => ({
      content: JSON.stringify({ path: 'ok.png', content: 'AAAA', mime_type: 'image/png', size: 1000 }), isError: false,
    }))
    const result = await cat.execute(ctx)
    expect(result.stdout).toContain('attached for viewing')
    expect(result.media).toEqual([{ path: 'ok.png', mime_type: 'image/png' }])
  })
})
