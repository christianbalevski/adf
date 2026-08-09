import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parse } from '../../../src/main/tools/shell/parser/parser'
import type { CommandContext, CommandResult, CommandHandler } from '../../../src/main/tools/shell/commands/types'
import { ok, err } from '../../../src/main/tools/shell/commands/types'

/**
 * Pipeline executor tests.
 *
 * Mocking strategy: vi.mock the commands/index module so getCommand returns
 * controlled handlers. The real buildCommandContext still runs inside
 * executeCommand, so flag parsing is exercised through the real code path.
 * Mock handlers capture the CommandContext they receive for assertions.
 */

// Handler registry for tests — getCommand looks up from here
const testHandlers = new Map<string, CommandHandler>()

vi.mock('../../../src/main/tools/shell/commands/index', () => ({
  getCommand: (name: string) => testHandlers.get(name),
}))

// Must import AFTER vi.mock so the mock is in place
const { executeNode } = await import('../../../src/main/tools/shell/executor/pipeline-executor')
const { EnvironmentResolver } = await import('../../../src/main/tools/shell/executor/environment')

/** Real env resolver over a stub workspace — for $?, assignments, defaults */
function makeRealEnv(workspace?: any) {
  return new EnvironmentResolver(
    { name: 'agent-1' } as any,
    (workspace ?? { getIdentity: () => null, getDid: () => null }) as any,
  )
}

/** Create a minimal mock handler */
function mockHandler(
  name: string,
  executeFn: (ctx: CommandContext) => CommandResult | Promise<CommandResult>,
  opts?: { valueFlags?: Set<string>; resolvedTools?: string[] }
): CommandHandler {
  return {
    name,
    summary: `test ${name}`,
    helpText: `help for ${name}`,
    category: 'general',
    resolvedTools: opts?.resolvedTools ?? [],
    valueFlags: opts?.valueFlags,
    execute: async (ctx) => {
      const result = executeFn(ctx)
      return result instanceof Promise ? result : result
    },
  }
}

/** Build a minimal ExecutorContext */
function makeCtx(overrides?: Partial<any>) {
  return {
    workspace: {},
    toolRegistry: {
      executeTool: vi.fn(async (name: string, input: any) => {
        if (name === 'fs_read') {
          return { content: JSON.stringify({ content: 'file-content' }), isError: false }
        }
        return { content: 'ok', isError: false }
      }),
    },
    config: {},
    env: {
      resolve: vi.fn((name: string) => `resolved_${name}`),
      has: vi.fn(() => true),
      setLastExitCode: vi.fn(),
      export: vi.fn(),
      withOverlay: vi.fn(function (this: any, vars: Record<string, string>) {
        return { ...this, resolve: (n: string) => vars[n] ?? this.resolve(n) }
      }),
    },
    ...overrides,
  } as any
}

beforeEach(() => {
  testHandlers.clear()
})

// ── Chain operators ──

describe('executor — chain operators', () => {
  it('&& executes right on success', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return ok('A') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a && cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a', 'b'])
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toContain('A')
    expect(result.stdout).toContain('B')
  })

  it('&& skips right on failure', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return err('fail') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a && cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a'])
    expect(result.exit_code).toBe(1)
  })

  it('|| executes right on failure', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return err('fail') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a || cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a', 'b'])
    expect(result.exit_code).toBe(0)
  })

  it('|| skips right on success', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return ok('A') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a || cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a'])
    expect(result.exit_code).toBe(0)
  })

  it('; always executes both sides', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return err('fail') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a; cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a', 'b'])
    expect(result.exit_code).toBe(0) // right side exit code wins
  })
})

// ── Pipeline ──

describe('executor — pipeline', () => {
  it('pipes stdout of stage 1 as stdin of stage 2', async () => {
    let receivedStdin = ''
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => ok('from_a')))
    testHandlers.set('cmd_b', mockHandler('cmd_b', (ctx) => {
      receivedStdin = ctx.stdin
      return ok('from_b')
    }))

    const ast = parse('cmd_a | cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(receivedStdin).toBe('from_a')
    expect(result.stdout).toBe('from_b')
  })

  it('chains three stages', async () => {
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => ok('A')))
    testHandlers.set('cmd_b', mockHandler('cmd_b', (ctx) => ok(ctx.stdin + '+B')))
    testHandlers.set('cmd_c', mockHandler('cmd_c', (ctx) => ok(ctx.stdin + '+C')))

    const ast = parse('cmd_a | cmd_b | cmd_c')
    const result = await executeNode(ast, '', makeCtx())

    expect(result.stdout).toBe('A+B+C')
  })

  it('continues the pipeline past an ordinary non-zero exit (bash semantics)', async () => {
    // Bash pipelines run every stage regardless of a middle stage's exit; the
    // pipeline status is the LAST stage's. (Only control-plane codes —
    // 124/126/127/130 — halt the pipeline; see the next test.)
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return err('fail') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a | cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a', 'b'])   // b runs despite a's failure
    expect(result.exit_code).toBe(0)    // status is b's (the last stage)
  })

  it('halts the pipeline on a control-plane exit (command not found = 127)', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('nosuchcmd | cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual([])           // b never runs
    expect(result.exit_code).toBe(127)
  })
})

// ── Flag parsing (real buildCommandContext) ──

describe('executor — flag parsing via buildCommandContext', () => {
  it('parses --name value as flag', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd --name value')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.name).toBe('value')
    expect(captured!.args).toEqual([])
  })

  it('parses --key=value format', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd --include=*.md')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.include).toBe('*.md')
  })

  it('parses boolean long flag (no following arg)', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd --verbose')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.verbose).toBe(true)
  })

  it('parses short boolean flag', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd -v')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.v).toBe(true)
  })

  it('parses short value flag with valueFlags set', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }, {
      valueFlags: new Set(['n']),
    }))

    const ast = parse('testcmd -n 5')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.n).toBe('5')
  })

  it('parses combined short flags as booleans', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd -la')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.l).toBe(true)
    expect(captured!.flags.a).toBe(true)
  })

  it('-- stops flag parsing', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd -- --not-a-flag')
    await executeNode(ast, '', makeCtx())

    expect(captured!.args).toContain('--not-a-flag')
    expect(captured!.flags).not.toHaveProperty('not-a-flag')
  })

  it('accumulates repeated short value flags as array', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }, {
      valueFlags: new Set(['H']),
    }))

    const ast = parse('testcmd -H a -H b')
    await executeNode(ast, '', makeCtx())

    expect(captured!.flags.H).toEqual(['a', 'b'])
  })
})

// ── Argument resolution ──

describe('executor — argument resolution', () => {
  it('resolves $VAR through environment', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => { captured = ctx; return ok('') }))

    const ast = parse('testcmd $MY_VAR')
    const ctx = makeCtx()
    await executeNode(ast, '', ctx)

    expect(ctx.env.resolve).toHaveBeenCalledWith('MY_VAR')
    // The resolved value becomes a positional arg
    expect(captured!.args).toContain('resolved_MY_VAR')
  })
})

// ── Redirects ──

describe('executor — redirects', () => {
  it('output redirect calls fs_write and clears stdout', async () => {
    // echo is a builtin, so it doesn't need a handler
    const ctx = makeCtx()
    const ast = parse('echo hello > out.txt')
    const result = await executeNode(ast, '', ctx)

    expect(ctx.toolRegistry.executeTool).toHaveBeenCalledWith(
      'fs_write',
      expect.objectContaining({ path: 'out.txt', content: expect.stringContaining('hello') }),
      expect.anything(),
    )
    // stdout should be cleared after redirect
    expect(result.stdout).toBe('')
  })

  it('append redirect uses fs_write append mode (atomic read-modify-write)', async () => {
    const ctx = makeCtx()
    const ast = parse('echo hello >> out.txt')
    const result = await executeNode(ast, '', ctx)

    // `>>` now delegates to fs_write mode:'append' — the tool does the
    // read-modify-write under its per-file lock, so the redirect no longer
    // reads separately.
    const calls = ctx.toolRegistry.executeTool.mock.calls
    const writeCall = calls.find((c: any) => c[0] === 'fs_write')
    expect(writeCall).toBeDefined()
    expect(writeCall![1].mode).toBe('append')
    expect(writeCall![1].path).toBe('out.txt')
    expect(writeCall![1].content).toContain('hello')
    expect(result.stdout).toBe('')
  })

  it('input redirect reads file as stdin', async () => {
    let receivedStdin = ''
    testHandlers.set('testcmd', mockHandler('testcmd', (ctx) => {
      receivedStdin = ctx.stdin
      return ok('done')
    }))

    const ctx = makeCtx()
    const ast = parse('testcmd < input.txt')
    await executeNode(ast, '', ctx)

    // shellReadFile should have been called to read the file
    expect(ctx.toolRegistry.executeTool).toHaveBeenCalledWith(
      'fs_read',
      expect.objectContaining({ path: 'input.txt' }),
      expect.anything(),
    )
    expect(receivedStdin).toBe('file-content')
  })
})

// ── Abort signal ──

describe('executor — abort signal', () => {
  it('returns exit 130 when signal is aborted', async () => {
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => ok('A')))

    const controller = new AbortController()
    controller.abort()
    const ctx = makeCtx({ signal: controller.signal })

    const ast = parse('cmd_a')
    const result = await executeNode(ast, '', ctx)

    expect(result.exit_code).toBe(130)
    expect(result.stderr).toContain('aborted')
  })
})

// ── Echo builtin ──

describe('executor — echo builtin', () => {
  it('joins args with spaces and adds trailing newline', async () => {
    const ast = parse('echo hello world')
    const result = await executeNode(ast, '', makeCtx())
    expect(result.stdout).toBe('hello world\n')
    expect(result.exit_code).toBe(0)
  })

  it('-e interprets escape sequences', async () => {
    const ast = parse("echo -e 'a\\nb'")
    const result = await executeNode(ast, '', makeCtx())
    expect(result.stdout).toBe('a\nb\n')
  })

  it('-n suppresses trailing newline', async () => {
    const ast = parse('echo -n hello')
    const result = await executeNode(ast, '', makeCtx())
    expect(result.stdout).toBe('hello')
  })

  it('-en combines both flags', async () => {
    const ast = parse("echo -en 'a\\tb'")
    const result = await executeNode(ast, '', makeCtx())
    expect(result.stdout).toBe('a\tb')
    expect(result.stdout.endsWith('\n')).toBe(false)
  })
})

// ── fd duplication (2>&1, >&2) ──

describe('executor — fd duplication', () => {
  beforeEach(() => {
    testHandlers.set('noisy', mockHandler('noisy', () =>
      ({ exit_code: 0, stdout: 'out', stderr: 'err' })))
  })

  it('2>&1 merges stderr into stdout', async () => {
    const result = await executeNode(parse('noisy 2>&1'), '', makeCtx())
    expect(result.stdout).toBe('out\nerr')
    expect(result.stderr).toBe('')
  })

  it('2>&1 feeds merged output into the next pipe stage', async () => {
    let receivedStdin = ''
    testHandlers.set('sink', mockHandler('sink', (ctx) => {
      receivedStdin = ctx.stdin
      return ok('done')
    }))
    const result = await executeNode(parse('noisy 2>&1 | sink'), '', makeCtx())
    expect(receivedStdin).toBe('out\nerr')
    expect(result.exit_code).toBe(0)
  })

  it('>&2 sends stdout to stderr', async () => {
    const result = await executeNode(parse('noisy >&2'), '', makeCtx())
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('err\nout')
  })

  it('> f 2>&1 writes both streams to the file', async () => {
    const ctx = makeCtx()
    const result = await executeNode(parse('noisy > f.txt 2>&1'), '', ctx)
    expect(ctx.toolRegistry.executeTool).toHaveBeenCalledWith(
      'fs_write',
      expect.objectContaining({ path: 'f.txt', content: 'out\nerr' }),
      expect.anything(),
    )
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('2>/dev/null discards stderr without writing a VFS file', async () => {
    const ctx = makeCtx()
    const result = await executeNode(parse('noisy 2>/dev/null'), '', ctx)
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('')
    expect(ctx.toolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('>/dev/null discards stdout without writing a VFS file', async () => {
    const ctx = makeCtx()
    const result = await executeNode(parse('noisy >/dev/null'), '', ctx)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('err')
    expect(ctx.toolRegistry.executeTool).not.toHaveBeenCalled()
  })
})

// ── Redirect target resolution (special devices + path normalization) ──

describe('executor — redirect targets', () => {
  beforeEach(() => {
    testHandlers.set('noisy', mockHandler('noisy', () =>
      ({ exit_code: 0, stdout: 'out', stderr: 'err' })))
  })

  it('echo x 2>/dev/null still prints x on stdout (bash semantics)', async () => {
    const ctx = makeCtx()
    const result = await executeNode(parse('echo x 2>/dev/null'), '', ctx)
    expect(result.stdout).toBe('x\n')
    expect(result.exit_code).toBe(0)
    expect(ctx.toolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('quoted "/dev/null" also discards — no fs_write, no file', async () => {
    const ctx = makeCtx()
    const result = await executeNode(parse('noisy 2>"/dev/null"'), '', ctx)
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('')
    expect(ctx.toolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('a variable that RESOLVES to /dev/null discards at runtime — no fs_write', async () => {
    const env = makeRealEnv()
    env.export('SINK', '/dev/null')
    const ctx = makeCtx({ env })
    const result = await executeNode(parse('noisy > $SINK'), '', ctx)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('err')
    expect(ctx.toolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('a variable target writes to the RESOLVED path, not a file named after the variable', async () => {
    const env = makeRealEnv()
    env.export('TARGET', '/tmp/out.txt')
    const ctx = makeCtx({ env })
    await executeNode(parse('echo hi > $TARGET'), '', ctx)
    expect(ctx.toolRegistry.executeTool).toHaveBeenCalledWith(
      'fs_write',
      expect.objectContaining({ path: 'tmp/out.txt', content: 'hi\n' }),
      expect.anything(),
    )
  })

  it('an absolute-looking target is stored WITHOUT the leading slash and readable back by both spellings', async () => {
    const ctx = makeCtx()
    await executeNode(parse('echo data > /tmp/out.txt'), '', ctx)
    const writeCall = ctx.toolRegistry.executeTool.mock.calls.find((c: any) => c[0] === 'fs_write')
    expect(writeCall![1].path).toBe('tmp/out.txt') // key never keeps the leading slash

    // readable back through the same normalization from either spelling
    testHandlers.set('reader', mockHandler('reader', (c) => ok(c.stdin)))
    const r1 = await executeNode(parse('reader < /tmp/out.txt'), '', ctx)
    const r2 = await executeNode(parse('reader < tmp/out.txt'), '', ctx)
    for (const call of ctx.toolRegistry.executeTool.mock.calls.filter((c: any) => c[0] === 'fs_read')) {
      expect(call[1].path).toBe('tmp/out.txt')
    }
    expect(r1.stdout).toBe('file-content')
    expect(r2.stdout).toBe('file-content')
  })

  it('runtime-resolved /dev/stdout target fails plainly BEFORE the command runs (exit 2)', async () => {
    const calls: string[] = []
    testHandlers.set('tracked', mockHandler('tracked', () => { calls.push('ran'); return ok('x') }))
    const env = makeRealEnv()
    env.export('DEV', '/dev/stdout')
    const ctx = makeCtx({ env })
    const result = await executeNode(parse('tracked > $DEV'), '', ctx)
    expect(result.exit_code).toBe(2)
    expect(result.stderr).toContain('redirect to /dev/stdout is not supported in adf_shell')
    expect(result.stderr).toContain('2>&1')
    expect(calls).toEqual([]) // the command never ran
    expect(ctx.toolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('runtime-resolved /dev/stderr target fails plainly with the >&2 hint', async () => {
    const env = makeRealEnv()
    env.export('DEV', 'dev/stderr')
    const result = await executeNode(parse('noisy 2>$DEV'), '', makeCtx({ env }))
    expect(result.exit_code).toBe(2)
    expect(result.stderr).toContain('redirect to /dev/stderr is not supported in adf_shell')
    expect(result.stderr).toContain('>&2')
  })

  it('static /dev/stdout target is rejected at parse time', () => {
    expect(() => parse('noisy > /dev/stdout')).toThrow(/\/dev\/stdout is not supported/)
  })
})

// ── Glob expansion ──

describe('executor — glob expansion', () => {
  const vfsFiles = [
    'a.md', 'b.md', 'notes.txt',
    'imported/slack/one.txt', 'imported/slack/two.txt', 'imported/mail/x.txt',
  ]

  function globCtx() {
    return makeCtx({
      workspace: { listFiles: () => vfsFiles.map(path => ({ path })) },
    })
  }

  async function argsFor(command: string, ctx = globCtx()): Promise<string[]> {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (c) => { captured = c; return ok('') }))
    await executeNode(parse(command), '', ctx)
    return captured!.args
  }

  it('expands *.md against workspace files', async () => {
    expect(await argsFor('testcmd *.md')).toEqual(['a.md', 'b.md'])
  })

  it('* does not cross / (top level only, includes implicit dirs)', async () => {
    expect(await argsFor('testcmd *')).toEqual(['a.md', 'b.md', 'imported', 'notes.txt'])
  })

  it('expands directory-scoped patterns like imported/slack/*', async () => {
    expect(await argsFor('testcmd imported/slack/*')).toEqual([
      'imported/slack/one.txt', 'imported/slack/two.txt',
    ])
  })

  it('imported/* matches the implicit subdirectories', async () => {
    expect(await argsFor('testcmd imported/*')).toEqual(['imported/mail', 'imported/slack'])
  })

  it('? matches a single character within a segment', async () => {
    expect(await argsFor('testcmd ?.md')).toEqual(['a.md', 'b.md'])
  })

  it('[...] character classes match', async () => {
    expect(await argsFor('testcmd [ab].md')).toEqual(['a.md', 'b.md'])
    expect(await argsFor('testcmd [!a].md')).toEqual(['b.md'])
  })

  it('no match passes the literal pattern through (bash default)', async () => {
    expect(await argsFor('testcmd *.zzz')).toEqual(['*.zzz'])
  })

  it('quoted patterns never glob', async () => {
    expect(await argsFor("testcmd '*.md'")).toEqual(['*.md'])
    expect(await argsFor('testcmd "*.md"')).toEqual(['*.md'])
  })

  it('workspace without listFiles passes patterns through untouched', async () => {
    expect(await argsFor('testcmd *.md', makeCtx())).toEqual(['*.md'])
  })

  it('matches that look like flags are prefixed with ./ (never parsed as flags)', async () => {
    const ctx = makeCtx({
      workspace: { listFiles: () => [{ path: '-dash.md' }, { path: 'a.md' }] },
    })
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (c) => { captured = c; return ok('') }))
    await executeNode(parse('testcmd *.md'), '', ctx)
    expect(captured!.args).toEqual(['./-dash.md', 'a.md'])
    expect(captured!.flags).toEqual({})
  })
})

// ── $? last exit code ──

describe('executor — $? last exit code', () => {
  it('echo $? prints the previous command exit code', async () => {
    testHandlers.set('cmd_fail', mockHandler('cmd_fail', () => err('boom', 3)))
    const ctx = makeCtx({ env: makeRealEnv() })
    const result = await executeNode(parse('cmd_fail; echo $?'), '', ctx)
    expect(result.stdout).toContain('3')
  })

  it('$? resets to 0 after a success', async () => {
    testHandlers.set('cmd_fail', mockHandler('cmd_fail', () => err('boom')))
    testHandlers.set('cmd_ok', mockHandler('cmd_ok', () => ok('fine')))
    const ctx = makeCtx({ env: makeRealEnv() })
    const result = await executeNode(parse('cmd_fail; cmd_ok; echo $?'), '', ctx)
    expect(result.stdout.trim().endsWith('0')).toBe(true)
  })

  it('$? works inside double quotes', async () => {
    testHandlers.set('cmd_fail', mockHandler('cmd_fail', () => err('boom', 2)))
    const ctx = makeCtx({ env: makeRealEnv() })
    const result = await executeNode(parse('cmd_fail; echo "exit=$?"'), '', ctx)
    expect(result.stdout).toContain('exit=2')
  })
})

// ── ${VAR:-default} expansion ──

describe('executor — default expansion', () => {
  it('${VAR:-def} uses the default when unset', async () => {
    const ctx = makeCtx({ env: makeRealEnv() })
    const result = await executeNode(parse('echo ${MISSING:-fallback}'), '', ctx)
    expect(result.stdout).toBe('fallback\n')
  })

  it('${VAR:-def} uses the value when set', async () => {
    const env = makeRealEnv()
    env.export('NAME', 'real')
    const result = await executeNode(parse('echo ${NAME:-fallback}'), '', makeCtx({ env }))
    expect(result.stdout).toBe('real\n')
  })

  it('${VAR-def} keeps a set-but-empty value (unlike :-)', async () => {
    const env = makeRealEnv()
    env.export('EMPTY', '')
    const r1 = await executeNode(parse('echo "[${EMPTY-def}]"'), '', makeCtx({ env }))
    expect(r1.stdout).toBe('[]\n')
    const r2 = await executeNode(parse('echo "[${EMPTY:-def}]"'), '', makeCtx({ env }))
    expect(r2.stdout).toBe('[def]\n')
  })
})

// ── VAR=val cmd prefix assignments ──

describe('executor — prefix assignments', () => {
  it('VAR=val cmd sets the variable for that command only', async () => {
    let seen = ''
    testHandlers.set('reader', mockHandler('reader', (c) => {
      seen = c.env.resolve('GREETING')
      return ok('')
    }))
    const env = makeRealEnv()
    const result = await executeNode(parse('GREETING=hello reader'), '', makeCtx({ env }))
    expect(result.exit_code).toBe(0)
    expect(seen).toBe('hello')
    // command-scoped: the session env is untouched
    expect(env.resolve('GREETING')).toBe('')
  })

  it('quoted assignment values work (VAR="a b")', async () => {
    let seen = ''
    testHandlers.set('reader', mockHandler('reader', (c) => {
      seen = c.env.resolve('VAR')
      return ok('')
    }))
    await executeNode(parse('VAR="a b" reader'), '', makeCtx({ env: makeRealEnv() }))
    expect(seen).toBe('a b')
  })

  it('bare VAR=val sets the session variable', async () => {
    const env = makeRealEnv()
    const result = await executeNode(parse('VAR=persisted'), '', makeCtx({ env }))
    expect(result.exit_code).toBe(0)
    expect(env.resolve('VAR')).toBe('persisted')
  })

  it('args of the command see the assignment overlay', async () => {
    let captured: CommandContext | undefined
    testHandlers.set('testcmd', mockHandler('testcmd', (c) => { captured = c; return ok('') }))
    await executeNode(parse('NAME=world testcmd $NAME'), '', makeCtx({ env: makeRealEnv() }))
    expect(captured!.args).toEqual(['world'])
  })
})

// ── Heredoc $VAR expansion ──

describe('executor — heredoc expansion', () => {
  it('expands $VAR in an unquoted-delimiter heredoc', async () => {
    let receivedStdin = ''
    testHandlers.set('testcmd', mockHandler('testcmd', (c) => {
      receivedStdin = c.stdin
      return ok('')
    }))
    const env = makeRealEnv()
    env.export('FOO', 'bar')
    await executeNode(parse('testcmd <<EOF\nvalue: $FOO and ${FOO}\nEOF'), '', makeCtx({ env }))
    expect(receivedStdin).toBe('value: bar and bar')
  })

  it("keeps a quoted-delimiter heredoc (<<'EOF') literal", async () => {
    let receivedStdin = ''
    testHandlers.set('testcmd', mockHandler('testcmd', (c) => {
      receivedStdin = c.stdin
      return ok('')
    }))
    const env = makeRealEnv()
    env.export('FOO', 'bar')
    await executeNode(parse("testcmd <<'EOF'\nvalue: $FOO\nEOF"), '', makeCtx({ env }))
    expect(receivedStdin).toBe('value: $FOO')
  })

  it('expands ${VAR:-default} in heredocs', async () => {
    let receivedStdin = ''
    testHandlers.set('testcmd', mockHandler('testcmd', (c) => {
      receivedStdin = c.stdin
      return ok('')
    }))
    await executeNode(parse('testcmd <<EOF\n${NOPE:-dflt}\nEOF'), '', makeCtx({ env: makeRealEnv() }))
    expect(receivedStdin).toBe('dflt')
  })
})

// ── Reserved control-flow words ──

describe('executor — reserved control-flow words', () => {
  it.each(['for', 'while', 'if', 'do', 'done', 'then', 'fi'])(
    '%s in command position fails with exit 2 and a clear message',
    async (word) => {
      const result = await executeNode(parse(`${word} x`), '', makeCtx())
      expect(result.exit_code).toBe(2)
      expect(result.stderr).toContain(`${word}: control flow is not supported in adf_shell`)
    },
  )

  it('reserved words as ordinary args still pass through', async () => {
    const result = await executeNode(parse('echo done'), '', makeCtx())
    expect(result.stdout).toBe('done\n')
  })
})

// ── & background operator ──

describe('executor — background operator', () => {
  it('& is a parse error — never silently reinterpreted as sequential execution', () => {
    expect(() => parse('cmd_fail & echo hi')).toThrow(
      /background execution \(&\) is not supported in adf_shell/
    )
  })

  it('trailing & is also a parse error', () => {
    expect(() => parse('cmd_a &')).toThrow(/background execution \(&\) is not supported/)
  })
})

// ── Help before the permission gate ──

describe('executor — help short-circuits the gate', () => {
  it('cmd -h prints help even when its tool is disabled', async () => {
    testHandlers.set('gated', mockHandler('gated', () => ok('ran'), {
      resolvedTools: ['fs_delete'],
    }))
    const ctx = makeCtx({
      config: { name: 'agent-1', tools: [{ name: 'fs_delete', enabled: false }] },
      gate: {},
    })
    const result = await executeNode(parse('gated -h'), '', ctx)
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe('help for gated')
  })

  it('without -h the disabled tool still blocks with exit 126', async () => {
    testHandlers.set('gated', mockHandler('gated', () => ok('ran'), {
      resolvedTools: ['fs_delete'],
    }))
    const ctx = makeCtx({
      config: { name: 'agent-1', tools: [{ name: 'fs_delete', enabled: false }] },
      gate: {},
    })
    const result = await executeNode(parse('gated x'), '', ctx)
    expect(result.exit_code).toBe(126)
  })

  it('a variable that resolves to -h does NOT bypass the gate', async () => {
    testHandlers.set('gated', mockHandler('gated', () => ok('ran'), {
      resolvedTools: ['fs_delete'],
    }))
    const env = makeRealEnv()
    env.export('FLAG', '-h')
    const ctx = makeCtx({
      env,
      config: { name: 'agent-1', tools: [{ name: 'fs_delete', enabled: false }] },
      gate: {},
    })
    const result = await executeNode(parse('gated $FLAG'), '', ctx)
    expect(result.exit_code).toBe(126)
  })
})

// ── AGENT_DID resolution ──

describe('environment — AGENT_DID', () => {
  it('resolves from workspace.getDid (adf_did meta), not the identity table', () => {
    const env = makeRealEnv({
      getDid: () => 'did:key:zTestOnly123',
      getIdentity: () => null,
    })
    expect(env.resolve('AGENT_DID')).toBe('did:key:zTestOnly123')
  })

  it('falls back to empty when no DID exists', () => {
    const env = makeRealEnv({ getDid: () => null, getIdentity: () => null })
    expect(env.resolve('AGENT_DID')).toBe('')
  })
})
