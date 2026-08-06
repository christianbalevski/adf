import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/** Third-pass residual fixes: sort --out abbreviation, pipeline no longer
 *  short-circuits on ordinary nonzero exit, grep -o/-vo exit-0 semantics. */

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

describe('sort --output abbreviations rejected', () => {
  it.each(['--out', '--outp', '--output'])('sort %s res.txt is rejected', async (flag) => {
    const sort = await getHandler('text', 'sort')
    const r = await sort.execute(ctxOf({ rawArgs: [flag, 'res.txt'], flags: {}, stdin: 'b\na\n' }))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('redirect')
  })
})

describe('grep -o exit tracks line selection (GNU)', () => {
  it('grep -o zero-width → exit 0, no output', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['x*'], flags: { o: true }, stdin: 'abc\n' }))
    expect(r.stdout).toBe('')
    expect(r.exit_code).toBe(0)
  })
  it('grep -vo (invert + only-matching) → exit 0 when a line is selected', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['a'], flags: { v: true, o: true }, stdin: 'a\nzz\n' }))
    expect(r.exit_code).toBe(0) // 'zz' is a non-matching line → selected
  })
  it('grep -o with no match at all → exit 1', async () => {
    const grep = await getHandler('text', 'grep')
    const r = await grep.execute(ctxOf({ args: ['zzz'], flags: { o: true }, stdin: 'abc\n' }))
    expect(r.exit_code).toBe(1)
  })
})

describe('pipeline does not short-circuit on ordinary nonzero exit', () => {
  function makeShell() {
    const fakeRegistry: any = {
      executeTool: vi.fn(async () => ({ content: '{}', isError: false })),
      get: () => undefined, getAll: () => [],
    }
    const ws: any = { insertLog: () => {}, insertTask: () => {}, listFiles: () => [] }
    const config: any = { name: 'a', tools: [{ name: 'adf_shell', enabled: true }], limits: { execution_timeout_ms: 5000 } }
    return { shell: new ShellTool(fakeRegistry, ws, config, null), ws }
  }
  it('grep -c with no match still pipes "0" to the next stage', async () => {
    const { shell, ws } = makeShell()
    // grep -c zzz exits 1 (no match) but outputs "0"; sed must still run on it.
    const r = JSON.parse((await shell.execute({ command: `printf 'a\\nb\\n' | grep -c zzz | sed 's/0/NONE/'` }, ws)).content as string)
    expect(r.stdout).toBe('NONE')
    expect(r.exit_code).toBe(0) // last stage (sed) succeeded
  })
  it('a control-plane failure (command not found) still halts the pipeline', async () => {
    const { shell, ws } = makeShell()
    const r = JSON.parse((await shell.execute({ command: `nosuchcmd | sed 's/x/y/'` }, ws)).content as string)
    expect(r.exit_code).not.toBe(0) // 127 is fatal → pipeline stops, surfaces the error
  })
})
