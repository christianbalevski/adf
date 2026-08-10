import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'
import { adfHandlers } from '../../../src/main/tools/shell/commands/adf'

/**
 * `adf <tool> ['<json>']` — the generic tool-bus door.
 *
 * Pins the contract:
 * - happy path: JSON input dispatched verbatim; omitted input defaults to {}
 * - gating: literal tool names resolve statically; variable/substitution
 *   names FAIL CLOSED before execution (never an ungated dynamic dispatch)
 * - SECURITY: top-level underscore keys (_authorized, _protection_override,
 *   _full, any future _*) are refused WITHOUT calling the tool — those are
 *   runtime-injected privilege params (tool-registry.ts) that would let an
 *   agent self-authorize past protection checks
 * - adf_shell recursion refused; malformed JSON fails plainly with the parse
 *   message; tool isError maps to stderr + exit 1
 */

const adfHandler = adfHandlers[0]

// ── Unit harness (handler-level) ──

function makeCtx(o: { args?: string[]; flags?: any; stdin?: string; toolResults?: Record<string, { content: string; isError?: boolean }> }) {
  const calls: Array<{ tool: string; input: any }> = []
  const ctx = {
    stdin: o.stdin ?? '',
    args: o.args ?? [],
    flags: o.flags ?? {},
    rawArgs: o.args ?? [],
    config: { name: 'agent-1', limits: {} },
    workspace: { listFiles: () => [] },
    toolRegistry: {
      executeTool: vi.fn(async (tool: string, input: any) => {
        calls.push({ tool, input })
        return { isError: false, content: 'RESULT', ...(o.toolResults?.[tool] ?? {}) }
      }),
      get: () => undefined,
      getAll: () => [],
    },
    env: { listAll: () => [], resolve: () => '' },
  } as any
  return { ctx, calls }
}

const lit = (value: string) => ({ type: 'literal' as const, value })
const quoted = (value: string) => ({ type: 'quoted' as const, quote: 'single' as const, parts: [lit(value)] })
const variable = (name: string) => ({ type: 'variable' as const, name })
const substitution = () => ({ type: 'substitution' as const, pipeline: { kind: 'pipeline', stages: [] } as any })

describe('adf: happy path', () => {
  it('dispatches the tool with the parsed JSON input and prints the raw result', async () => {
    const { ctx, calls } = makeCtx({ args: ['agent_discover', '{"scope":"all"}'] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('RESULT')
    expect(calls).toEqual([{ tool: 'agent_discover', input: { scope: 'all' } }])
  })

  it('omitted input defaults to {}', async () => {
    const { ctx, calls } = makeCtx({ args: ['chat_info'] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).toBe(0)
    expect(calls).toEqual([{ tool: 'chat_info', input: {} }])
  })

  it('tool isError maps to stderr + exit 1', async () => {
    const { ctx } = makeCtx({
      args: ['fs_transfer', '{"direction":"up"}'],
      toolResults: { fs_transfer: { content: 'no such container', isError: true } },
    })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('fs_transfer')
    expect(r.stderr).toContain('no such container')
  })

  it('no args prints usage explaining the tool-bus door and the single-JSON-argument contract', async () => {
    const { ctx, calls } = makeCtx({ args: [] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('adf <tool_name>')
    expect(r.stderr.toLowerCase()).toContain('no dedicated shell')
    expect(r.stderr).toContain('single-quote')
    expect(calls).toEqual([])
  })
})

describe('adf: gating (resolveToolsFromArgs)', () => {
  it('returns the literal tool name for static args (bare and quoted)', () => {
    expect(adfHandler.resolveToolsFromArgs!([lit('fs_read'), quoted('{"path":"x"}')])).toEqual(['fs_read'])
    expect(adfHandler.resolveToolsFromArgs!([quoted('agent_discover')])).toEqual(['agent_discover'])
  })

  it('returns [] for no args and for -h (nothing to gate)', () => {
    expect(adfHandler.resolveToolsFromArgs!([])).toEqual([])
    expect(adfHandler.resolveToolsFromArgs!([lit('-h')])).toEqual([])
  })

  it('FAILS CLOSED on a variable or substitution tool name', () => {
    expect(() => adfHandler.resolveToolsFromArgs!([variable('TOOL')])).toThrow(/tool name must be a literal/)
    expect(() => adfHandler.resolveToolsFromArgs!([substitution()])).toThrow(/tool name must be a literal/)
    // quoted arg containing a variable part is dynamic too
    const mixed = { type: 'quoted' as const, quote: 'double' as const, parts: [lit('fs_'), variable('X')] }
    expect(() => adfHandler.resolveToolsFromArgs!([mixed])).toThrow(/tool name must be a literal/)
  })
})

describe('adf: refusals (handler-level)', () => {
  it('refuses any top-level underscore key without calling the tool', async () => {
    for (const json of ['{"path":"x","_authorized":true}', '{"_protection_override":true}', '{"_full":true}', '{"_anything":1}']) {
      const { ctx, calls } = makeCtx({ args: ['fs_delete', json] })
      const r = await adfHandler.execute(ctx)
      expect(r.exit_code).not.toBe(0)
      expect(r.stderr).toContain('refused')
      expect(r.stderr).toContain('_')
      expect(calls).toEqual([]) // the registry was NEVER called
    }
  })

  it('refuses invoking adf_shell through adf (recursion)', async () => {
    const { ctx, calls } = makeCtx({ args: ['adf_shell', '{"command":"ls"}'] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('adf_shell')
    expect(r.stderr.toLowerCase()).toContain('recursi')
    expect(calls).toEqual([])
  })

  it('malformed JSON fails plainly with the parse message', async () => {
    const { ctx, calls } = makeCtx({ args: ['chat_info', '{scope: all}'] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('invalid JSON')
    expect(r.stderr.length).toBeGreaterThan('adf: invalid JSON input: '.length) // carries the parser's message
    expect(calls).toEqual([])
  })

  it('non-object JSON (array/string/null) is refused', async () => {
    for (const json of ['[1,2]', '"str"', 'null', '42']) {
      const { ctx, calls } = makeCtx({ args: ['chat_info', json] })
      const r = await adfHandler.execute(ctx)
      expect(r.exit_code).not.toBe(0)
      expect(r.stderr).toContain('JSON object')
      expect(calls).toEqual([])
    }
  })

  it('extra positional args (unquoted JSON) fail with quoting guidance', async () => {
    const { ctx, calls } = makeCtx({ args: ['chat_info', '{"a":', '1}'] })
    const r = await adfHandler.execute(ctx)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('single-quote')
    expect(calls).toEqual([])
  })
})

// ── Integration harness (full ShellTool: parse → gate → execute) ──

function makeShell(opts: {
  restrictedTools?: string[]
  disabledTools?: string[]
  approvalHandler?: (tool: string) => Promise<boolean>
} = {}) {
  const executed: string[] = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string) => {
      executed.push(name)
      return { content: 'OK', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    insertTask: () => {},
    listFiles: () => [],
  }
  const tool = (name: string) => ({
    name,
    enabled: !(opts.disabledTools ?? []).includes(name),
    restricted: (opts.restrictedTools ?? []).includes(name),
  })
  const config: any = {
    name: 'agent-1',
    tools: ['adf_shell', 'fs_read', 'fs_delete', 'chat_info', 'sys_update_config'].map(tool),
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  if (opts.approvalHandler) shell.onApprovalRequired = opts.approvalHandler
  return { shell, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('adf: end-to-end through the shell', () => {
  it("adf fs_delete '{\"path\":\"x\",\"_authorized\":true}' is refused without calling the tool", async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, `adf fs_delete '{"path":"x","_authorized":true}'`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('refused')
    expect(executed).toEqual([]) // fs_delete never dispatched
  })

  it('a literal tool name is gated statically: disabled tool exits 126, never runs', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({ disabledTools: ['fs_delete'] })
    const r = await run(shell, fakeWorkspace, `adf fs_delete '{"path":"x"}'`)
    expect(r.exit_code).toBe(126)
    expect(executed).toEqual([])
  })

  it('a literal restricted tool goes through HIL approval (deny → never runs)', async () => {
    const denials: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['sys_update_config'],
      approvalHandler: async (t) => { denials.push(t); return false },
    })
    const r = await run(shell, fakeWorkspace, `adf sys_update_config '{"section":"tools"}'`)
    expect(denials).toContain('sys_update_config')
    expect(r.exit_code).not.toBe(0)
    expect(executed).toEqual([])
  })

  it('a variable tool name fails closed before execution', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, `T=fs_read; adf $T '{}'`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('tool name must be a literal')
    expect(executed).toEqual([])
  })

  it('a substitution tool name fails closed without running the substitution', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, `adf $(echo fs_read) '{}'`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('tool name must be a literal')
    expect(executed).toEqual([])
  })

  it('happy path end-to-end: quoted JSON survives parsing as one argument', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, `adf chat_info '{"chat_id":"telegram:12345"}'`)
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toBe('OK')
    expect(executed).toEqual(['chat_info'])
  })
})
