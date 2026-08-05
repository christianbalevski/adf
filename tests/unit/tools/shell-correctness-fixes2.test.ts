import { describe, it, expect, vi } from 'vitest'

/** Second-pass residual correctness fixes: sort --output=, grep -c exit codes,
 *  recursive -o zero-width exit, sed named-group offset, jq flag-named file. */

async function getHandler(mod: string, name: string) {
  const h = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = h[Object.keys(h).find(k => k.endsWith('Handlers'))!]
  return list.find((x: any) => x.name === name)!
}

function ctxOf(o: { args?: string[]; flags?: any; stdin?: string; rawArgs?: string[]; vfs?: Record<string, string> }) {
  const vfs = o.vfs ?? {}
  return {
    stdin: o.stdin ?? '', args: o.args ?? [], flags: o.flags ?? {}, rawArgs: o.rawArgs ?? o.args ?? [],
    config: { limits: {} },
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

describe('sort --output= is rejected too', () => {
  it('sort --output=out errors instead of silently discarding', async () => {
    const sort = await getHandler('text', 'sort')
    const r = await sort.execute(ctxOf({ rawArgs: ['--output=out.txt'], flags: { output: 'out.txt' }, stdin: 'b\na\n' }))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('redirect')
  })
  it('wc -o is NOT caught by the output guard (applet handles it)', async () => {
    const wc = await getHandler('text', 'wc')
    const r = await wc.execute(ctxOf({ rawArgs: ['-o'], flags: { o: true }, stdin: 'x\n' }))
    // real wc rejects -o itself; our guard must not produce the "redirect" message
    expect(r.stderr ?? '').not.toContain('redirect')
  })
})

describe('grep -c exit codes', () => {
  it('grep -c with no match exits 1', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['zzz'], flags: { c: true }, stdin: 'a\nb\n' }))
    expect(r.stdout).toBe('0')
    expect(r.exit_code).toBe(1)
  })
  it('grep -c with a match exits 0', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['a'], flags: { c: true }, stdin: 'a\nb\n' }))
    expect(r.stdout).toBe('1')
    expect(r.exit_code).toBe(0)
  })
  it('grep -rc with no match exits 1', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['zzz'], flags: { r: true, c: true }, vfs: { 'f.txt': 'a\n' } }))
    expect(r.exit_code).toBe(1)
  })
})

describe('recursive -o zero-width exits 1', () => {
  it('grep -ro on a zero-width pattern emits nothing and exits 1', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['x*'], flags: { r: true, o: true }, vfs: { 'f.txt': 'abc\n' } }))
    expect(r.stdout).toBe('')
    expect(r.exit_code).toBe(1)
  })
})

describe('sed named groups do not leak the offset', () => {
  it('named group replacement renders the group, not the offset', async () => {
    const sed = await getHandler('text', 'sed')
    const r = await sed.execute(ctxOf({ args: ['s/(?<x>a)/[\\1]/'], stdin: 'zab' }))
    expect(r.stdout).toBe('z[a]b')
  })
})

describe('jq file named like a flag letter', () => {
  it('jq . r (file named r) errors instead of ignoring the file', async () => {
    const jq = await getHandler('structured', 'jq')
    const r = await jq.execute(ctxOf({ args: ['.', 'r'], stdin: '{}' }))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('file arguments not supported')
  })
})
