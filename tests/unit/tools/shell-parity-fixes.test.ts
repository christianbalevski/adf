import { describe, it, expect, vi } from 'vitest'
import { parse } from '../../../src/main/tools/shell/parser/parser'

/**
 * #17 batch: parser line-continuation, `at` scope array, `./x.ts` sys_lambda
 * input shape.
 */

async function getHandler(mod: string, name: string) {
  const handlers = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = handlers[Object.keys(handlers).find(k => k.endsWith('Handlers'))!]
  return list.find((h: any) => h.name === name)!
}

function makeCtx(overrides: any) {
  const calls: Array<{ tool: string; input: any }> = []
  return {
    calls,
    ctx: {
      stdin: '', args: [], flags: {}, rawArgs: [],
      workspace: {},
      toolRegistry: { executeTool: vi.fn(async (tool: string, input: any) => { calls.push({ tool, input }); return { content: '{}', isError: false } }) },
      config: {}, env: {},
      ...overrides,
    },
  }
}

describe('#17 parser line continuation', () => {
  it('&& before a newline is not an empty command', () => {
    expect(() => parse('echo a &&\necho b')).not.toThrow()
  })
  it('|| before a newline continues', () => {
    expect(() => parse('cat missing ||\necho fallback')).not.toThrow()
  })
  it('| before a newline continues the pipeline', () => {
    expect(() => parse('echo a |\ncat')).not.toThrow()
  })
})

describe('#17 at sends scope as an array', () => {
  it('at --delay passes scope:[...] to sys_set_timer', async () => {
    const at = await getHandler('timers', 'at')
    const { ctx, calls } = makeCtx({ args: ['job.sh'], flags: { delay: '5m' } })
    await at.execute(ctx)
    expect(calls[0].tool).toBe('sys_set_timer')
    expect(Array.isArray(calls[0].input.scope)).toBe(true)
    expect(calls[0].input.scope).toEqual(['agent'])
    expect(calls[0].input.lambda).toBe('job.sh')
  })
  it('--scope system is honored', async () => {
    const at = await getHandler('timers', 'at')
    const { ctx, calls } = makeCtx({ args: ['job.sh'], flags: { every: '1h', scope: 'system' } })
    await at.execute(ctx)
    expect(calls[0].input.scope).toEqual(['system'])
  })
})

describe('#17 ./x.ts sends sys_lambda { source, args:object }', () => {
  it('builds source path and object args from stdin', async () => {
    const script = await getHandler('code', './')
    const { ctx, calls } = makeCtx({ args: ['./calc.ts'], stdin: 'payload' })
    await script.execute(ctx)
    expect(calls[0].tool).toBe('sys_lambda')
    expect(calls[0].input.source).toBe('calc.ts')
    expect(calls[0].input.args).toEqual({ stdin: 'payload' })
    expect(calls[0].input.path).toBeUndefined()
  })
  it('source includes :function when a function name is given', async () => {
    const script = await getHandler('code', './')
    const { ctx, calls } = makeCtx({ args: ['./calc.ts', 'run'] })
    await script.execute(ctx)
    expect(calls[0].input.source).toBe('calc.ts:run')
  })
  it('--args must be a JSON object, not an array', async () => {
    const script = await getHandler('code', './')
    const { ctx } = makeCtx({ args: ['./calc.ts'], flags: { args: '[1,2]' } })
    const r = await script.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('object')
  })
})
