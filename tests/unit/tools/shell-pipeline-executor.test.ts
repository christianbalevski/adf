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

  it('stops pipeline on first non-zero exit', async () => {
    const calls: string[] = []
    testHandlers.set('cmd_a', mockHandler('cmd_a', () => { calls.push('a'); return err('fail') }))
    testHandlers.set('cmd_b', mockHandler('cmd_b', () => { calls.push('b'); return ok('B') }))

    const ast = parse('cmd_a | cmd_b')
    const result = await executeNode(ast, '', makeCtx())

    expect(calls).toEqual(['a'])
    expect(result.exit_code).toBe(1)
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

  it('append redirect reads existing, appends, then writes', async () => {
    const ctx = makeCtx()
    const ast = parse('echo hello >> out.txt')
    const result = await executeNode(ast, '', ctx)

    // Should have called fs_read first (via shellReadFile), then fs_write
    const calls = ctx.toolRegistry.executeTool.mock.calls
    const readCall = calls.find((c: any) => c[0] === 'fs_read')
    const writeCall = calls.find((c: any) => c[0] === 'fs_write')
    expect(readCall).toBeDefined()
    expect(writeCall).toBeDefined()
    // The written content should include both existing and new content
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
