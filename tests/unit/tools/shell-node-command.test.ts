import { describe, it, expect, vi, afterAll } from 'vitest'
import { codeHandlers } from '../../../src/main/tools/shell/commands/code'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

/**
 * Shell `node` command: -e passthrough, -p print-expression wrapping, and
 * end-to-end behavior through a real sandbox.
 */

const nodeHandler = codeHandlers.find((h) => h.name === 'node')!

function makeCtx(overrides: Record<string, unknown>) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = []
  return {
    calls,
    ctx: {
      stdin: '',
      args: [] as string[],
      flags: {} as Record<string, string | boolean | string[]>,
      rawArgs: [] as string[],
      workspace: {},
      toolRegistry: {
        executeTool: vi.fn(async (tool: string, input: Record<string, unknown>) => {
          calls.push({ tool, input })
          return { content: 'ok', isError: false }
        })
      },
      config: {},
      env: { listAll: () => [] },
      ...overrides
    } as never
  }
}

describe('node command flag handling', () => {
  it('declares both e and p as value flags', () => {
    expect(nodeHandler.valueFlags?.has('e')).toBe(true)
    expect(nodeHandler.valueFlags?.has('p')).toBe(true)
  })

  it('-e dispatches the code to sys_code unchanged', async () => {
    const { ctx, calls } = makeCtx({ flags: { e: 'console.log("hi")' } })
    const result = await nodeHandler.execute(ctx)

    expect(result.exit_code).toBe(0)
    expect(calls[0].tool).toBe('sys_code')
    expect(calls[0].input.code).toBe('console.log("hi")')
  })

  it('-p wraps the expression so its value is printed', async () => {
    const { ctx, calls } = makeCtx({ flags: { p: '1 + 2' } })
    const result = await nodeHandler.execute(ctx)

    expect(result.exit_code).toBe(0)
    expect(calls[0].tool).toBe('sys_code')
    const code = calls[0].input.code as string
    expect(code).toContain('1 + 2')
    expect(code).toContain('console.log')
    // Wrapped through an async arrow so top-level await in the expr works
    expect(code).toContain('await (async () => (')
  })

  it('errors with usage when no code is given', async () => {
    const { ctx } = makeCtx({ flags: {} })
    const result = await nodeHandler.execute(ctx)

    expect(result.exit_code).not.toBe(0)
    expect(result.stderr).toContain('usage')
    expect(result.stderr).toContain('-p')
  })
})

describe('node command end-to-end through the sandbox', () => {
  const sandbox = new CodeSandboxService()
  const agentId = 'shell-node-e2e'

  afterAll(() => {
    sandbox.destroy(agentId)
  })

  function makeSandboxCtx(flags: Record<string, string | boolean>) {
    return {
      stdin: '',
      args: [] as string[],
      flags,
      rawArgs: [] as string[],
      workspace: {},
      toolRegistry: {
        executeTool: async (_tool: string, input: Record<string, unknown>) => {
          const r = await sandbox.execute(agentId, input.code as string, 5000)
          if (r.error) return { content: r.error, isError: true }
          const parts: string[] = []
          if (r.result !== undefined) parts.push(`Result: ${r.result}`)
          if (r.stdout) parts.push(r.stdout)
          return { content: parts.join('\n'), isError: false }
        }
      },
      config: {},
      env: { listAll: () => [] }
    } as never
  }

  it('node -p prints the expression value', async () => {
    const result = await nodeHandler.execute(makeSandboxCtx({ p: '1 + 2' }))
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toContain('3')
  })

  it('node -p supports top-level await in the expression', async () => {
    const result = await nodeHandler.execute(makeSandboxCtx({ p: 'await Promise.resolve("resolved-value")' }))
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toContain('resolved-value')
  })

  it('node -p JSON-prints object values instead of [object Object]', async () => {
    const result = await nodeHandler.execute(makeSandboxCtx({ p: '({ n: 41 + 1 })' }))
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toContain('"n": 42')
    expect(result.stdout).not.toContain('[object Object]')
  })
})
