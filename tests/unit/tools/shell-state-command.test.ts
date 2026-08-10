import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'
import { statusHandlers } from '../../../src/main/tools/shell/commands/status'
import { adfHandlers } from '../../../src/main/tools/shell/commands/adf'

/**
 * `state [idle|hibernate|off]` — the shell door to sys_set_state.
 *
 * The point of the command is that a yield can be CHAINED with the bookkeeping
 * before it (`meta set status … && state idle`) in one tool call. That only
 * works if the turn-ending side effect survives the trip: handler →
 * pipeline/chain → ShellTool → ToolResult.endTurn + target_state. Every test
 * here pins one link of that chain, plus the read path (bare `state`) which
 * must keep working when sys_set_state is disabled.
 */

const stateHandler = statusHandlers.find(h => h.name === 'state')!
const adfHandler = adfHandlers[0]

// ── Unit harness (handler-level) ──

function makeCtx(o: {
  args?: string[]
  state?: string
  toolResults?: Record<string, { content: string; isError?: boolean; endTurn?: boolean }>
}) {
  const calls: Array<{ tool: string; input: any }> = []
  const ctx = {
    stdin: '',
    args: o.args ?? [],
    flags: {},
    rawArgs: o.args ?? [],
    config: { name: 'agent-1', state: o.state ?? 'active', limits: {} },
    workspace: { listFiles: () => [] },
    toolRegistry: {
      executeTool: vi.fn(async (tool: string, input: any) => {
        calls.push({ tool, input })
        return {
          isError: false,
          content: JSON.stringify({ target_state: input?.state }),
          endTurn: true,
          ...(o.toolResults?.[tool] ?? {}),
        }
      }),
      get: () => undefined,
      getAll: () => [],
    },
    env: { listAll: () => [], resolve: () => '' },
  } as any
  return { ctx, calls }
}

const lit = (value: string) => ({ type: 'literal' as const, value })
const variable = (name: string) => ({ type: 'variable' as const, name })

describe('state: setting', () => {
  it.each(['idle', 'hibernate', 'off'])('state %s calls sys_set_state and reports the turn-ending side effect', async (target) => {
    const { ctx, calls } = makeCtx({ args: [target] })
    const r = await stateHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls).toEqual([{ tool: 'sys_set_state', input: { state: target } }])
    expect(r.end_turn).toBe(true)
    expect(r.target_state).toBe(target)
    expect(r.stdout).toContain(target)
  })

  it('refuses a state the agent cannot set, without calling the tool', async () => {
    for (const bad of ['active', 'suspended', 'sleeping', '']) {
      const { ctx, calls } = makeCtx({ args: [bad] })
      const r = await stateHandler.execute(ctx)
      expect(r.exit_code).not.toBe(0)
      expect(r.stderr).toContain('idle|hibernate|off')
      expect(calls).toEqual([])
    }
  })

  it('refuses extra arguments rather than guessing', async () => {
    const { ctx, calls } = makeCtx({ args: ['idle', 'now'] })
    const r = await stateHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(calls).toEqual([])
  })

  it('a tool error is an ordinary failure — no turn-ending side effect', async () => {
    const { ctx } = makeCtx({
      args: ['idle'],
      toolResults: { sys_set_state: { content: 'nope', isError: true, endTurn: true } },
    })
    const r = await stateHandler.execute(ctx)
    expect(r.exit_code).toBe(1)
    expect(r.stderr).toContain('nope')
    expect(r.end_turn).toBeUndefined()
  })

  it('does not claim the turn ends when the tool did not say so', async () => {
    const { ctx } = makeCtx({
      args: ['idle'],
      toolResults: { sys_set_state: { content: '{}', endTurn: false } },
    })
    const r = await stateHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.end_turn).toBeUndefined()
    expect(r.target_state).toBeUndefined()
  })
})

describe('state: reading', () => {
  it('bare state prints the current state and calls no tool', async () => {
    const { ctx, calls } = makeCtx({ state: 'hibernate' })
    const r = await stateHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('hibernate')
    expect(calls).toEqual([])
  })
})

describe('state: gating (resolveToolsFromArgs)', () => {
  it('the read path needs no tool, so it survives sys_set_state being disabled', () => {
    expect(stateHandler.resolveToolsFromArgs!([])).toEqual([])
    expect(stateHandler.resolveToolsFromArgs!([lit('-h')])).toEqual([])
  })

  it('any set — including a dynamic argument — gates on sys_set_state', () => {
    expect(stateHandler.resolveToolsFromArgs!([lit('idle')])).toEqual(['sys_set_state'])
    expect(stateHandler.resolveToolsFromArgs!([variable('S')])).toEqual(['sys_set_state'])
  })
})

// ── Integration harness (full ShellTool: parse → gate → execute) ──

function makeShell(opts: { disabledTools?: string[]; state?: string } = {}) {
  const executed: Array<{ name: string; input: any }> = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      executed.push({ name, input })
      if (name === 'sys_set_state') {
        return { content: JSON.stringify({ target_state: input.state }), isError: false, endTurn: true }
      }
      return { content: 'OK', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    insertTask: () => {},
    listFiles: () => [],
    setIdentity: () => {},
  }
  const tool = (name: string) => ({
    name,
    enabled: !(opts.disabledTools ?? []).includes(name),
    restricted: false,
  })
  const config: any = {
    name: 'agent-1',
    state: opts.state ?? 'active',
    tools: ['adf_shell', 'sys_set_state', 'sys_set_meta', 'sys_get_meta', 'fs_write'].map(tool),
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  return { shell, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  const result = await shell.execute({ command }, ws)
  return { ...JSON.parse(result.content as string), endTurn: result.endTurn }
}

describe('state: end-to-end through the shell', () => {
  it('surfaces endTurn + target_state on the adf_shell tool result', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, 'state idle')
    expect(r.exit_code).toBe(0)
    expect(r.endTurn).toBe(true)
    expect(r.target_state).toBe('idle')
    expect(executed.map(e => e.name)).toEqual(['sys_set_state'])
  })

  it('the whole point: bookkeeping and the yield chain in ONE call', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, `meta set status "shipped" && state idle`)
    expect(r.endTurn).toBe(true)
    expect(r.target_state).toBe('idle')
    expect(executed.map(e => e.name)).toEqual(['sys_set_meta', 'sys_set_state'])
  })

  it('survives later commands in the chain and a pipeline stage', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const chained = await run(shell, fakeWorkspace, 'state hibernate && echo done')
    expect(chained.endTurn).toBe(true)
    expect(chained.target_state).toBe('hibernate')
    expect(chained.stdout).toContain('done')

    const piped = await run(shell, fakeWorkspace, 'state off | grep state')
    expect(piped.endTurn).toBe(true)
    expect(piped.target_state).toBe('off')
  })

  it('the LAST state set wins, like repeated sys_set_state calls in a turn', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const r = await run(shell, fakeWorkspace, 'state hibernate ; state idle')
    expect(r.endTurn).toBe(true)
    expect(r.target_state).toBe('idle')
  })

  it('no turn-ending side effect when nothing set a state', async () => {
    const { shell, fakeWorkspace } = makeShell({ state: 'active' })
    const r = await run(shell, fakeWorkspace, 'state')
    expect(r.stdout.trim()).toBe('active')
    expect(r.endTurn).toBeUndefined()
    expect(r.target_state).toBeUndefined()
  })

  it('a disabled sys_set_state exits 126 and ends nothing; reading still works', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({ disabledTools: ['sys_set_state'], state: 'active' })
    const denied = await run(shell, fakeWorkspace, 'state idle')
    expect(denied.exit_code).toBe(126)
    expect(denied.endTurn).toBeUndefined()
    expect(executed).toEqual([])

    const read = await run(shell, fakeWorkspace, 'state')
    expect(read.exit_code).toBe(0)
    expect(read.stdout.trim()).toBe('active')
  })

  it('the generic door (adf sys_set_state) ends the turn too', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const r = await run(shell, fakeWorkspace, `adf sys_set_state '{"state":"off"}'`)
    expect(r.endTurn).toBe(true)
    expect(r.target_state).toBe('off')
  })

  it('a state set inside $(...) is a discarded subshell side effect', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, 'echo $(state idle)')
    expect(r.endTurn).toBeUndefined()
    expect(r.target_state).toBeUndefined()
    expect(executed.map(e => e.name)).toEqual(['sys_set_state']) // it ran; only the side effect is lost
  })
})

describe('adf: generic door propagation (handler-level)', () => {
  it('carries end_turn and target_state out of the tool result', async () => {
    const { ctx } = makeCtx({ args: ['sys_set_state', '{"state":"hibernate"}'] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.end_turn).toBe(true)
    expect(r.target_state).toBe('hibernate')
  })

  it('ends the turn even when the result carries no parsable target state', async () => {
    const { ctx } = makeCtx({
      args: ['some_tool'],
      toolResults: { some_tool: { content: 'not json', endTurn: true } },
    })
    const r = await adfHandler.execute(ctx)
    expect(r.end_turn).toBe(true)
    expect(r.target_state).toBeUndefined()
  })

  it('an ordinary tool result carries no side effect', async () => {
    const { ctx } = makeCtx({
      args: ['chat_info'],
      toolResults: { chat_info: { content: '{}', endTurn: false } },
    })
    const r = await adfHandler.execute(ctx)
    expect(r.end_turn).toBeUndefined()
  })
})
