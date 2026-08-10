import { describe, it, expect, vi } from 'vitest'

/**
 * Awkward-bits regressions for shell built-ins:
 * - crontab -l --all → sys_list_timers { include_expired: true } (schema-valid)
 * - curl -o statically resolves fs_write for the pre-gate (gating hole)
 * - rev/tac read file args (were stdin-only, silently returned empty)
 * - diff bash semantics: exit 0/1/2, unified-ish output, honest errors
 * - chmod numeric/symbolic modes fail fast with the real contract
 * - meta unknown subcommand lists valid ones
 * - mv gates on fs_read+fs_write (rename is not delete); protection check stays
 * - xargs default mode appends whitespace-split stdin items (real-xargs contract)
 * - xargs -n N batches items (was silently ignored; `-n 1` even ate the "1"
 *   as the command); invalid N and -n+-I are rejected plainly
 */

async function getHandler(mod: string, name: string) {
  const h = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = h[Object.keys(h).find(k => k.endsWith('Handlers'))!]
  return list.find((x: any) => x.name === name)!
}

interface VfsFile { content: string; mime_type?: string; protection?: string }

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
      getFileProtection: (path: string) => (path in vfs ? (vfs[path].protection ?? 'none') : null),
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
        if (tool === 'fs_list') {
          // Mirrors the real FsListTool: prefix is a startsWith filter.
          const prefix: string = input.prefix ?? ''
          const rows = Object.keys(vfs)
            .filter(p => p.startsWith(prefix))
            .map(p => ({ path: p, size: vfs[p].content.length, mime_type: vfs[p].mime_type ?? 'text/plain' }))
          return { content: JSON.stringify(rows), isError: false }
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

  it('+p writes the valid read_only level (default), -p (parsed as a flag) is a no-op on an unprotected file', async () => {
    const chmod = await getHandler('filesystem', 'chmod')
    const plus = makeCtx({ args: ['+p', 'f.txt'], vfs: { 'f.txt': { content: 'x' } } })
    expect((await chmod.execute(plus.ctx)).exit_code).toBe(0)
    // Must be a member of FILE_PROTECTION_LEVELS — the old handler wrote the
    // legacy 'protected', which the DB CHECK constraint rejected.
    expect(plus.protections).toEqual([{ path: 'f.txt', level: 'read_only' }])
    // The shell parses `-p` into flags.p, leaving only the path in args.
    // Already 'none' → nothing to change, no write.
    const minus = makeCtx({ args: ['f.txt'], flags: { p: true }, vfs: { 'f.txt': { content: 'x' } } })
    expect((await chmod.execute(minus.ctx)).exit_code).toBe(0)
    expect(minus.protections).toEqual([])
  })

  it('+p=no_delete writes no_delete; bad level and missing file fail plainly', async () => {
    const chmod = await getHandler('filesystem', 'chmod')
    const nd = makeCtx({ args: ['+p=no_delete', 'f.txt'], vfs: { 'f.txt': { content: 'x' } } })
    expect((await chmod.execute(nd.ctx)).exit_code).toBe(0)
    expect(nd.protections).toEqual([{ path: 'f.txt', level: 'no_delete' }])

    const bad = makeCtx({ args: ['+p=protected', 'f.txt'], vfs: { 'f.txt': { content: 'x' } } })
    const badR = await chmod.execute(bad.ctx)
    expect(badR.exit_code).not.toBe(0)
    expect(badR.stderr).toContain('invalid protection level')

    const missing = makeCtx({ args: ['+p', 'nope.txt'] })
    const missR = await chmod.execute(missing.ctx)
    expect(missR.exit_code).not.toBe(0)
    expect(missR.stderr).toContain('No such file')
  })
})

// ── ls multi-arg (glob pre-expansion) ──

describe('ls multi-arg', () => {
  const vfs = {
    'a.md': { content: 'A' },
    'b.md': { content: 'BB' },
    'notes/x.md': { content: 'X' },
    'c.txt': { content: 'C' },
  }

  it('merges multiple args into ONE JSON array, deduped by path', async () => {
    const ls = await getHandler('filesystem', 'ls')
    // Shell-expanded `ls *.md` arrives as several args; a.md repeated to prove dedupe.
    const r = await ls.execute(makeCtx({ args: ['a.md', 'b.md', 'a.md'], vfs }).ctx)
    expect(r.exit_code).toBe(0)
    const rows = JSON.parse(r.stdout)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.map((x: any) => x.path)).toEqual(['a.md', 'b.md'])
    // jq idiom shape preserved: every row still has .path
    for (const row of rows) expect(typeof row.path).toBe('string')
  })

  it('0-arg and 1-arg output is byte-identical to fs_list content (jq contract)', async () => {
    const ls = await getHandler('filesystem', 'ls')
    const zero = makeCtx({ vfs })
    const r0 = await ls.execute(zero.ctx)
    const direct0 = await zero.ctx.toolRegistry.executeTool('fs_list', { prefix: '' }, zero.ctx.workspace)
    expect(r0.stdout).toBe(direct0.content)
    const one = makeCtx({ args: ['notes/x.md'], vfs })
    const r1 = await ls.execute(one.ctx)
    const direct1 = await one.ctx.toolRegistry.executeTool('fs_list', { prefix: 'notes/x.md' }, one.ctx.workspace)
    expect(r1.stdout).toBe(direct1.content)
  })

  it('a named path that matches nothing errors on stderr; exit 2 when NOTHING matched', async () => {
    const ls = await getHandler('filesystem', 'ls')
    const r = await ls.execute(makeCtx({ args: ['nope.md'], vfs }).ctx)
    expect(r.exit_code).toBe(2)
    expect(r.stderr).toBe('ls: nope.md: No such file or directory')
    expect(r.stdout).toBe('[]') // stdout stays one JSON array even on failure
  })

  it('partial match lists what exists (exit 0) and still reports the missing arg', async () => {
    const ls = await getHandler('filesystem', 'ls')
    const r = await ls.execute(makeCtx({ args: ['a.md', 'nope.md'], vfs }).ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stderr).toContain('ls: nope.md: No such file or directory')
    expect(JSON.parse(r.stdout).map((x: any) => x.path)).toEqual(['a.md'])
  })

  it('no args on an empty workspace is [] with exit 0 (not an error)', async () => {
    const ls = await getHandler('filesystem', 'ls')
    const r = await ls.execute(makeCtx({ vfs: {} }).ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('[]')
    expect(r.stderr).toBe('')
  })
})

// ── head/tail -c byte mode ──

describe('head -c / tail -c', () => {
  const vfs = { 'f.txt': { content: 'hello world' } }

  it('-c is a valueFlag on both (the count must not be parsed as a path)', async () => {
    const head = await getHandler('filesystem', 'head')
    const tail = await getHandler('filesystem', 'tail')
    expect(head.valueFlags.has('c')).toBe(true)
    expect(tail.valueFlags.has('c')).toBe(true)
  })

  it('head -c N returns the first N bytes of a file', async () => {
    const head = await getHandler('filesystem', 'head')
    const r = await head.execute(makeCtx({ args: ['f.txt'], flags: { c: '5' }, vfs }).ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('hello')
  })

  it('head -c slices BYTES, not codepoints (multi-byte aware)', async () => {
    const head = await getHandler('filesystem', 'head')
    // 'h' (1 byte) + 'é' (2 bytes) → -c 3 keeps both, -c 5 spans into 'llo'
    const r = await head.execute(makeCtx({ stdin: 'héllo', flags: { c: '3' } }).ctx)
    expect(r.stdout).toBe('hé')
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(3)
  })

  it('head -c works on stdin', async () => {
    const head = await getHandler('filesystem', 'head')
    const r = await head.execute(makeCtx({ stdin: 'abcdef', flags: { c: '3' } }).ctx)
    expect(r.stdout).toBe('abc')
  })

  it('head -c rejects size suffixes plainly instead of guessing', async () => {
    const head = await getHandler('filesystem', 'head')
    const r = await head.execute(makeCtx({ args: ['f.txt'], flags: { c: '1K' }, vfs }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('head: -c')
    expect(r.stderr).toContain('suffixes')
  })

  it('head -c on a missing file surfaces the fs_read error', async () => {
    const head = await getHandler('filesystem', 'head')
    const r = await head.execute(makeCtx({ args: ['nope.txt'], flags: { c: '5' }, vfs }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('nope.txt')
  })

  it('tail -c N returns the last N bytes; -c +N starts at byte N', async () => {
    const tail = await getHandler('filesystem', 'tail')
    const last = await tail.execute(makeCtx({ stdin: 'abcdef', flags: { c: '3' } }).ctx)
    expect(last.stdout).toBe('def')
    const from = await tail.execute(makeCtx({ stdin: 'abcdef', flags: { c: '+3' } }).ctx)
    expect(from.stdout).toBe('cdef')
  })

  it('tail -c rejects suffixes plainly', async () => {
    const tail = await getHandler('filesystem', 'tail')
    const r = await tail.execute(makeCtx({ stdin: 'abc', flags: { c: '1M' } }).ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('tail: -c')
  })
})

// ── curl envelope honesty (-o body-only, -w, -v) ──

describe('curl envelope honesty', () => {
  const envelope = JSON.stringify({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/plain' },
    body: 'BODY',
  })

  it('default stdout is the raw envelope, unchanged', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx } = makeCtx({ args: ['https://example.com'], toolResults: { sys_fetch: { content: envelope } } })
    const r = await curl.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe(envelope)
  })

  it('-o writes the response BODY only, not the JSON envelope', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx, calls } = makeCtx({
      args: ['https://example.com'],
      flags: { o: 'out.txt' },
      toolResults: { sys_fetch: { content: envelope }, fs_write: { content: 'ok' } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).toBe(0)
    const write = calls.find(c => c.tool === 'fs_write')!
    expect(write.input).toEqual({ mode: 'write', path: 'out.txt', content: 'BODY' })
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('saved response body to out.txt')
  })

  it('-o normalizes the target path like shell redirects (no leading-slash VFS keys)', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx, calls } = makeCtx({
      args: ['https://example.com'],
      flags: { o: '/tmp/out.txt', s: true },
      toolResults: { sys_fetch: { content: envelope }, fs_write: { content: 'ok' } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).toBe(0)
    const write = calls.find(c => c.tool === 'fs_write')!
    expect(write.input).toEqual({ mode: 'write', path: 'tmp/out.txt', content: 'BODY' })
  })

  it('-o /dev/null discards: no fs_write, no file, exit 0', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx, calls } = makeCtx({
      args: ['https://example.com'],
      flags: { o: '/dev/null', s: true },
      toolResults: { sys_fetch: { content: envelope }, fs_write: { content: 'ok' } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('')
    expect(calls.filter(c => c.tool === 'fs_write').length).toBe(0)
  })

  it('-o /dev/stdout is rejected plainly', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx, calls } = makeCtx({
      args: ['https://example.com'],
      flags: { o: '/dev/stdout' },
      toolResults: { sys_fetch: { content: envelope }, fs_write: { content: 'ok' } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('not supported')
    expect(calls.filter(c => c.tool === 'fs_write').length).toBe(0)
  })

  it('-s -o saves silently (no note)', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx } = makeCtx({
      args: ['https://example.com'],
      flags: { o: 'out.txt', s: true },
      toolResults: { sys_fetch: { content: envelope }, fs_write: { content: 'ok' } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it('-w %{http_code} appends after the output; \\n escape honored', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx } = makeCtx({
      args: ['https://example.com'],
      flags: { w: 'code=%{http_code}\\n' },
      toolResults: { sys_fetch: { content: envelope } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe(envelope + 'code=200\n')
  })

  it('-w with -o writes only the write-out to stdout', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx } = makeCtx({
      args: ['https://example.com'],
      flags: { o: 'out.txt', s: true, w: '%{http_code}' },
      toolResults: { sys_fetch: { content: envelope }, fs_write: { content: 'ok' } },
    })
    const r = await curl.execute(ctx)
    expect(r.stdout).toBe('200')
  })

  it('-w with any other %{var} errors plainly, no partial output', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx } = makeCtx({
      args: ['https://example.com'],
      flags: { w: '%{content_type}' },
      toolResults: { sys_fetch: { content: envelope } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('%{content_type}')
    expect(r.stderr).toContain('%{http_code}')
  })

  it('-v is a clear error, refused BEFORE the request fires', async () => {
    const curl = await getHandler('networking', 'curl')
    const { ctx, calls } = makeCtx({
      args: ['https://example.com'],
      flags: { v: true },
      toolResults: { sys_fetch: { content: envelope } },
    })
    const r = await curl.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('curl: -v is not supported in adf_shell')
    expect(calls.length).toBe(0) // no fetch side effect on a refused flag
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

// ── mv capability gate ──

describe('mv gating: rename is not delete', () => {
  it('resolves fs_read + fs_write, NOT fs_delete', async () => {
    const mv = await getHandler('filesystem', 'mv')
    expect([...mv.resolvedTools].sort()).toEqual(['fs_read', 'fs_write'])
    expect(mv.resolvedTools).not.toContain('fs_delete')
  })

  it('renames an unprotected file directly (no tool dispatch)', async () => {
    const mv = await getHandler('filesystem', 'mv')
    const renames: Array<[string, string]> = []
    const { ctx, calls } = makeCtx({ args: ['a.txt', 'b.txt'] })
    ctx.workspace.getFileProtection = () => 'none'
    ctx.workspace.renameInternalFile = (s: string, d: string) => { renames.push([s, d]); return true }
    const r = await mv.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(renames).toEqual([['a.txt', 'b.txt']])
    expect(calls).toEqual([])
  })

  it('protected source still fails closed without a gate handler', async () => {
    const mv = await getHandler('filesystem', 'mv')
    const { ctx } = makeCtx({ args: ['locked.txt', 'new.txt'] })
    ctx.workspace.getFileProtection = () => 'no_delete'
    ctx.workspace.renameInternalFile = () => { throw new Error('must not rename') }
    const r = await mv.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('protected')
  })
})

// ── xargs default mode: append stdin items (real-xargs contract) ──

/** xargs re-enters parse+executeNode, which calls env.setLastExitCode. */
function makeXargsCtx(o: { args: string[]; flags?: any; stdin: string }) {
  const made = makeCtx(o)
  made.ctx.env = { listAll: () => [], resolve: () => '', setLastExitCode: () => {} }
  return made
}

describe('xargs default mode appends stdin items', () => {
  it('ls | jq | xargs rm shape: newline-separated items become rm arguments', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm'], stdin: 'a.txt\nb.txt\n' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls.map(c => [c.tool, c.input.path])).toEqual([['fs_delete', 'a.txt'], ['fs_delete', 'b.txt']])
  })

  it('splits on any whitespace and appends after template args (single invocation)', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx } = makeXargsCtx({ args: ['echo', 'PREFIX'], stdin: 'a b\tc\nd' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('PREFIX a b c d\n')
  })

  it('items are data: operators, substitutions, globs, and quotes stay literal', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm'], stdin: `a|b ;c $(boom) *.md it's.txt` })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls.map(c => c.input.path)).toEqual(['a|b', ';c', '$(boom)', '*.md', `it's.txt`])
    expect(calls.every(c => c.tool === 'fs_delete')).toBe(true)
  })

  it('{} is NOT special without -I (appended alongside items, like real xargs)', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx } = makeXargsCtx({ args: ['echo', '{}'], stdin: 'x' })
    const r = await xargs.execute(ctx)
    expect(r.stdout).toBe('{} x\n')
  })

  it('-I substitution mode is unchanged: one invocation per LINE', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm', '{}'], flags: { I: '{}' }, stdin: 'a b\nc' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls.map(c => c.input.path)).toEqual(['a b', 'c']) // per line, not per word
  })

  it('empty stdin runs nothing; missing command errors plainly', async () => {
    const xargs = await getHandler('text', 'xargs')
    const empty = await xargs.execute(makeXargsCtx({ args: ['rm'], stdin: '' }).ctx)
    expect(empty).toEqual({ exit_code: 0, stdout: '', stderr: '' })
    const noCmd = await xargs.execute(makeXargsCtx({ args: [], stdin: 'a' }).ctx)
    expect(noCmd.exit_code).not.toBe(0)
    expect(noCmd.stderr).toContain('missing command')
  })
})

// ── xargs -n N: batch mode (was silently ignored; -n 1 ate the "1" as cmd) ──

describe('xargs -n batching', () => {
  it('6 items with -n 2 → 3 invocations with correct arg groups, order preserved', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx } = makeXargsCtx({ args: ['echo'], flags: { n: '2' }, stdin: 'a b c d e f' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    // Each echo invocation prints its own batch — three lines prove three
    // invocations with the right groups in the right order.
    expect(r.stdout).toBe('a b\nc d\ne f\n')
  })

  it('-n 1 runs once per item; a partial final batch is fine', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm'], flags: { n: '1' }, stdin: 'a.txt b.txt c.txt' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls.map(c => [c.tool, c.input.path])).toEqual([
      ['fs_delete', 'a.txt'], ['fs_delete', 'b.txt'], ['fs_delete', 'c.txt'],
    ])
    const partial = makeXargsCtx({ args: ['echo'], flags: { n: '4' }, stdin: 'a b c d e' })
    const pr = await xargs.execute(partial.ctx)
    expect(pr.stdout).toBe('a b c d\ne\n')
  })

  it('space form `xargs -n 1 echo` parses: "1" is the count, not the command', async () => {
    // Regression: without 'n' in valueFlags the parser consumed "1" as the
    // command and the shell answered "1: command not found".
    const { parse } = await import('../../../src/main/tools/shell/parser/parser')
    const { executeNode } = await import('../../../src/main/tools/shell/executor/pipeline-executor')
    const { ctx } = makeXargsCtx({ args: [], stdin: '' })
    const r = await executeNode(parse('xargs -n 1 echo'), 'a b', ctx as any)
    expect(r.stderr).not.toContain('command not found')
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('a\nb\n')
  })

  it('attached form -n2 works too', async () => {
    const { parse } = await import('../../../src/main/tools/shell/parser/parser')
    const { executeNode } = await import('../../../src/main/tools/shell/executor/pipeline-executor')
    const { ctx } = makeXargsCtx({ args: [], stdin: '' })
    const r = await executeNode(parse('xargs -n2 echo'), 'a b c', ctx as any)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('a b\nc\n')
  })

  it('invalid N is rejected plainly (non-numeric, zero, negative, missing)', async () => {
    const xargs = await getHandler('text', 'xargs')
    for (const bad of ['woof', '0', '-3', '2.5']) {
      const { ctx } = makeXargsCtx({ args: ['echo'], flags: { n: bad }, stdin: 'a' })
      const r = await xargs.execute(ctx)
      expect(r.exit_code).not.toBe(0)
      expect(r.stderr).toBe(`xargs: -n: invalid number '${bad}'`)
    }
    const missing = makeXargsCtx({ args: ['echo'], flags: { n: true }, stdin: 'a' })
    const mr = await xargs.execute(missing.ctx)
    expect(mr.exit_code).not.toBe(0)
    expect(mr.stderr).toContain('-n requires a count')
  })

  it('-n combined with -I is refused loudly (real xargs silently ignores -n)', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm', '{}'], flags: { n: '2', I: '{}' }, stdin: 'a\nb' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('-n cannot be combined with -I')
    expect(r.stderr).toContain('silently ignores')
    expect(calls).toEqual([]) // refused before running anything
  })

  it('bad N fails even on empty stdin (never silently "works")', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx } = makeXargsCtx({ args: ['echo'], flags: { n: 'x' }, stdin: '' })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('invalid number')
  })

  it('a failing batch does not stop later batches; exit is the highest batch exit', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm'], flags: { n: '1' }, stdin: 'a.txt bad.txt c.txt' })
    const inner = ctx.toolRegistry.executeTool
    ctx.toolRegistry.executeTool = async (tool: string, input: any, ws: any) => {
      if (tool === 'fs_delete' && input.path === 'bad.txt') {
        calls.push({ tool, input })
        return { content: 'boom', isError: true }
      }
      return inner(tool, input, ws)
    }
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(1) // highest batch exit (not real xargs's blanket 123)
    expect(r.stderr).toContain('boom')
    // All three batches ran — the middle failure didn't abort the run.
    expect(calls.map(c => c.input.path)).toEqual(['a.txt', 'bad.txt', 'c.txt'])
  })

  it('quoting stays intact per batch: items remain data, never operators/globs', async () => {
    const xargs = await getHandler('text', 'xargs')
    const { ctx, calls } = makeXargsCtx({ args: ['rm'], flags: { n: '2' }, stdin: `a|b ;c $(boom) *.md it's.txt` })
    const r = await xargs.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls.map(c => c.input.path)).toEqual(['a|b', ';c', '$(boom)', '*.md', `it's.txt`])
    expect(calls.every(c => c.tool === 'fs_delete')).toBe(true)
  })
})
