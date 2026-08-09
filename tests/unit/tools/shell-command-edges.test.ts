import { describe, it, expect, vi } from 'vitest'

/**
 * Awkward-bits regressions for shell built-ins:
 * - crontab -l --all → sys_list_timers { include_expired: true } (schema-valid)
 * - curl -o statically resolves fs_write for the pre-gate (gating hole)
 * - rev/tac read file args (were stdin-only, silently returned empty)
 * - diff bash semantics: exit 0/1/2, unified-ish output, honest errors
 * - chmod numeric/symbolic modes fail fast with the real contract
 * - meta unknown subcommand lists valid ones
 */

async function getHandler(mod: string, name: string) {
  const h = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = h[Object.keys(h).find(k => k.endsWith('Handlers'))!]
  return list.find((x: any) => x.name === name)!
}

interface VfsFile { content: string; mime_type?: string }

/** Command context backed by a tiny in-memory VFS; captures every tool call. */
function makeCtx(o: {
  args?: string[]
  flags?: any
  stdin?: string
  vfs?: Record<string, VfsFile>
  toolResults?: Record<string, { content: string; isError?: boolean }>
}) {
  const vfs = o.vfs ?? {}
  const calls: Array<{ tool: string; input: any }> = []
  const protections: Array<{ path: string; level: string }> = []
  const ctx = {
    stdin: o.stdin ?? '',
    args: o.args ?? [],
    flags: o.flags ?? {},
    rawArgs: o.args ?? [],
    config: { name: 'agent-1', limits: {} },
    workspace: {
      listFiles: () => Object.keys(vfs).map(p => ({ path: p, mime_type: vfs[p].mime_type ?? 'text/plain', size: vfs[p].content.length })),
      setFileProtection: (path: string, level: string) => { protections.push({ path, level }) },
      fileExists: (path: string) => path in vfs,
    },
    toolRegistry: {
      executeTool: vi.fn(async (tool: string, input: any) => {
        calls.push({ tool, input })
        if (o.toolResults?.[tool]) return { isError: false, ...o.toolResults[tool] }
        if (tool === 'fs_read') {
          const f = vfs[input.path]
          if (!f) return { content: `File not found: "${input.path}"`, isError: true }
          const mime = f.mime_type ?? 'text/plain'
          const isText = mime.startsWith('text/')
          const content = isText ? f.content : Buffer.from(f.content).toString('base64')
          return { content: JSON.stringify({ path: input.path, content, mime_type: mime, size: f.content.length }), isError: false }
        }
        return { content: '', isError: false }
      }),
      get: () => undefined,
      getAll: () => [],
    },
    env: { listAll: () => [], resolve: () => '' },
  } as any
  return { ctx, calls, protections }
}

/** Literal ArgumentNode helper for resolveToolsFromArgs tests. */
const lit = (value: string) => ({ type: 'literal' as const, value })
const quoted = (value: string) => ({ type: 'quoted' as const, quote: 'double' as const, parts: [lit(value)] })

// ── crontab ──

describe('crontab -l --all', () => {
  it('maps --all to sys_list_timers { include_expired: true }', async () => {
    const crontab = await getHandler('timers', 'crontab')
    const { ctx, calls } = makeCtx({ flags: { l: true, all: true }, toolResults: { sys_list_timers: { content: '(timers)' } } })
    await crontab.execute(ctx)
    expect(calls[0].tool).toBe('sys_list_timers')
    expect(calls[0].input).toEqual({ include_expired: true })
  })

  it('--expired and -a are accepted aliases', async () => {
    const crontab = await getHandler('timers', 'crontab')
    for (const flags of [{ l: true, expired: true }, { l: true, a: true }]) {
      const { ctx, calls } = makeCtx({ flags, toolResults: { sys_list_timers: { content: '' } } })
      await crontab.execute(ctx)
      expect(calls[0].input).toEqual({ include_expired: true })
    }
  })

  it('plain -l sends {} and translates the tool-schema hint into shell language', async () => {
    const crontab = await getHandler('timers', 'crontab')
    const { ctx, calls } = makeCtx({
      flags: { l: true },
      toolResults: { sys_list_timers: { content: 'Active timers: ...\n(2 expired timers not shown — pass include_expired: true to list them)' } },
    })
    const r = await crontab.execute(ctx)
    expect(calls[0].input).toEqual({})
    expect(r.stdout).not.toContain('include_expired')
    expect(r.stdout).toContain('crontab -l --all')
  })

  it('{ include_expired: true } passes the real sys_list_timers zod schema', async () => {
    const { GetTimersTool } = await import('../../../src/main/tools/built-in/sys-list-timers.tool')
    const tool = new GetTimersTool()
    expect(tool.inputSchema.safeParse({ include_expired: true }).success).toBe(true)
    expect(tool.inputSchema.safeParse({}).success).toBe(true)
  })
})

// ── curl -o gating ──

describe('curl -o gating', () => {
  it('resolveToolsFromArgs adds fs_write when -o/-O present', async () => {
    const curl = await getHandler('networking', 'curl')
    expect(curl.resolveToolsFromArgs([lit('-o'), lit('out.txt'), lit('https://example.com')])).toEqual(['fs_write'])
    expect(curl.resolveToolsFromArgs([lit('-O'), lit('out.txt'), lit('https://example.com')])).toEqual(['fs_write'])
    expect(curl.resolveToolsFromArgs([lit('-oout.txt'), lit('https://example.com')])).toEqual(['fs_write']) // attached form
    expect(curl.resolveToolsFromArgs([quoted('-o'), lit('out.txt'), lit('https://example.com')])).toEqual(['fs_write'])
  })

  it('resolveToolsFromArgs stays empty without an output flag', async () => {
    const curl = await getHandler('networking', 'curl')
    expect(curl.resolveToolsFromArgs([lit('https://example.com')])).toEqual([])
    expect(curl.resolveToolsFromArgs([lit('-X'), lit('POST'), lit('https://example.com')])).toEqual([])
  })

  it('surfaces fs_write failure instead of swallowing it', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx } = makeCtx({
      args: ['https://example.com'],
      flags: { o: 'out.txt' },
      toolResults: { sys_fetch: { content: 'BODY' }, fs_write: { content: 'disk full', isError: true } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('out.txt')
    expect(r.stderr).toContain('disk full')
  })
})

// ── rev / tac file args ──

describe('rev/tac file args', () => {
  const vfs = { 'f.txt': { content: 'abc\ndef\n' } }

  it('rev reads a file arg', async () => {
    const rev = await getHandler('text', 'rev')
    const r = await rev.execute(makeCtx({ args: ['f.txt'], vfs }).ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('cba\nfed\n')
  })

  it('rev still reads stdin when no args', async () => {
    const rev = await getHandler('text', 'rev')
    const r = await rev.execute(makeCtx({ stdin: 'abc\ndef' }).ctx)
    expect(r.stdout).toBe('cba\nfed')
  })

  it('tac reads a file arg and reverses lines without a leading blank', async () => {
    const tac = await getHandler('text', 'tac')
    const r = await tac.execute(makeCtx({ args: ['f.txt'], vfs }).ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('def\nabc')
  })

  it('tac still reads stdin when no args', async () => {
    const tac = await getHandler('text', 'tac')
    const r = await tac.execute(makeCtx({ stdin: 'a\nb\nc' }).ctx)
    expect(r.stdout).toBe('c\nb\na')
  })

  it('missing file errors instead of silently returning empty', async () => {
    for (const name of ['rev', 'tac']) {
      const h = await getHandler('text', name)
      const r = await h.execute(makeCtx({ args: ['nope.txt'], vfs }).ctx)
      expect(r.exit_code).not.toBe(0)
      expect(r.stderr).toContain('nope.txt')
    }
  })

  it('resolveToolsFromArgs gates fs_read only when file args are present', async () => {
    for (const name of ['rev', 'tac']) {
      const h = await getHandler('text', name)
      expect(h.resolveToolsFromArgs([lit('f.txt')])).toEqual(['fs_read'])
      expect(h.resolveToolsFromArgs([])).toEqual([])
    }
  })
})

// ── diff semantics ──

describe('diff semantics', () => {
  const vfs = {
    'a.txt': { content: 'one\ntwo\nthree\nfour\n' },
    'b.txt': { content: 'one\ntwo-changed\nthree\nfour\nfive\n' },
    'same1.txt': { content: 'x\ny\n' },
    'same2.txt': { content: 'x\ny\n' },
    'bin1.dat': { content: '\x00\x01\x02', mime_type: 'application/octet-stream' },
    'bin2.dat': { content: '\x00\x01\x03', mime_type: 'application/octet-stream' },
  }

  it('identical files → no output, exit 0', async () => {
    const diff = await getHandler('text', 'diff')
    const r = await diff.execute(makeCtx({ args: ['same1.txt', 'same2.txt'], vfs }).ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it('differing multi-line files → unified-ish output, exit 1', async () => {
    const diff = await getHandler('text', 'diff')
    const r = await diff.execute(makeCtx({ args: ['a.txt', 'b.txt'], vfs }).ctx)
    expect(r.exit_code).toBe(1)
    expect(r.stdout).toContain('--- a.txt')
    expect(r.stdout).toContain('+++ b.txt')
    expect(r.stdout).toContain('-two')
    expect(r.stdout).toContain('+two-changed')
    expect(r.stdout).toContain('+five')
    expect(r.stdout).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
    // LCS keeps unchanged lines as context, not -/+ noise
    expect(r.stdout).toContain(' three')
    expect(r.stdout).not.toContain('-three')
  })

  it('missing file → clear error, exit 2', async () => {
    const diff = await getHandler('text', 'diff')
    const r = await diff.execute(makeCtx({ args: ['a.txt', 'nope.txt'], vfs }).ctx)
    expect(r.exit_code).toBe(2)
    expect(r.stderr).toContain('nope.txt')
  })

  it('missing operand → usage error, exit 2', async () => {
    const diff = await getHandler('text', 'diff')
    const r = await diff.execute(makeCtx({ args: ['a.txt'], vfs }).ctx)
    expect(r.exit_code).toBe(2)
    expect(r.stderr).toContain('usage')
  })

  it('binary files are compared, not line-diffed as base64', async () => {
    const diff = await getHandler('text', 'diff')
    const r = await diff.execute(makeCtx({ args: ['bin1.dat', 'bin2.dat'], vfs }).ctx)
    expect(r.exit_code).toBe(1)
    expect(r.stdout).toBe('Binary files bin1.dat and bin2.dat differ')
    const same = await diff.execute(makeCtx({ args: ['bin1.dat', 'bin1.dat'], vfs }).ctx)
    expect(same.exit_code).toBe(0)
  })

  it('-q reports without a dump; unknown flags are rejected', async () => {
    const diff = await getHandler('text', 'diff')
    const q = await diff.execute(makeCtx({ args: ['a.txt', 'b.txt'], flags: { q: true }, vfs }).ctx)
    expect(q.exit_code).toBe(1)
    expect(q.stdout).toBe('Files a.txt and b.txt differ')
    const bad = await diff.execute(makeCtx({ args: ['a.txt', 'b.txt'], flags: { r: true }, vfs }).ctx)
    expect(bad.exit_code).toBe(2)
    expect(bad.stderr).toContain('unsupported option')
  })

  it('trailing-newline-only difference is reported, not shown as an empty diff', async () => {
    const diff = await getHandler('text', 'diff')
    const nlVfs = { 'x1.txt': { content: 'a\nb\n' }, 'x2.txt': { content: 'a\nb' } }
    const r = await diff.execute(makeCtx({ args: ['x1.txt', 'x2.txt'], vfs: nlVfs }).ctx)
    expect(r.exit_code).toBe(1)
    expect(r.stdout).toContain('trailing newline')
  })
})

// ── chmod modes ──

describe('chmod modes', () => {
  it('numeric mode fails fast with the real contract', async () => {
    const chmod = await getHandler('filesystem', 'chmod')
    const r = await chmod.execute(makeCtx({ args: ['644', 'f.txt'] }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toBe('chmod: only +p (protect) and -p (unprotect) are supported — adf files have no unix modes')
  })

  it('symbolic unix mode gets the same message', async () => {
    const chmod = await getHandler('filesystem', 'chmod')
    for (const mode of ['u+x', 'a=r', 'go-w']) {
      const r = await chmod.execute(makeCtx({ args: [mode, 'f.txt'] }).ctx)
      expect(r.stderr).toContain('adf files have no unix modes')
    }
  })

  it('+p protects, -p (parsed as a flag) unprotects', async () => {
    const chmod = await getHandler('filesystem', 'chmod')
    const plus = makeCtx({ args: ['+p', 'f.txt'] })
    expect((await chmod.execute(plus.ctx)).exit_code).toBe(0)
    expect(plus.protections).toEqual([{ path: 'f.txt', level: 'protected' }])
    // The shell parses `-p` into flags.p, leaving only the path in args.
    const minus = makeCtx({ args: ['f.txt'], flags: { p: true } })
    expect((await chmod.execute(minus.ctx)).exit_code).toBe(0)
    expect(minus.protections).toEqual([{ path: 'f.txt', level: 'normal' }])
  })
})

// ── meta errors ──

describe('meta unknown subcommand', () => {
  it('lists valid subcommands with usage', async () => {
    const meta = await getHandler('meta', 'meta')
    const r = await meta.execute(makeCtx({ args: ['status'] }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('unknown subcommand "status"')
    for (const line of ['meta list', 'meta get <key>', 'meta set <key> <value>', 'meta delete <key>']) {
      expect(r.stderr).toContain(line)
    }
  })

  it('help text names the exact subcommand set', async () => {
    const meta = await getHandler('meta', 'meta')
    expect(meta.helpText).toContain('get, set, list, delete')
    expect(meta.helpText).toContain('meta list')
    expect(meta.helpText).toContain('meta set <key> <value> [protection]')
  })
})
