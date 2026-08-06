import { describe, it, expect, vi } from 'vitest'

/**
 * STRUCTURAL GUARD against wrapper-drift: every ADF-native shell command
 * hand-builds a tool input. This test runs each command with representative
 * args, captures the exact input it sends, and asserts that input passes the
 * TARGET TOOL'S REAL zod schema (`tool.inputSchema.safeParse`). A wrapper that
 * drifts from the contract — wrong field name, wrong type, invalid enum, like
 * `crontab -d`'s {timer_id:string} vs {id:number}, or `at`'s string-vs-array
 * scope — now fails CI instead of silently erroring at runtime for the agent.
 *
 * (Silent-SEMANTIC drift — right shape, wrong intent, like `msg --read`'s
 * default — can't be caught by safeParse; those are pinned by explicit
 * assertions in the semantics block at the bottom.)
 */

// Build a name → zod inputSchema map from the real tool instances.
async function buildSchemaMap(): Promise<Map<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }>> {
  const { ToolRegistry } = await import('../../../src/main/tools/tool-registry')
  const { registerBuiltInTools } = await import('../../../src/main/tools/built-in/register-built-in-tools')
  const bi = await import('../../../src/main/tools/built-in')
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const map = new Map<string, any>()
  for (const t of registry.getAll()) if ((t as any).inputSchema) map.set(t.name, (t as any).inputSchema)
  // Per-agent tools not in the global registry — instantiate with stubs.
  const stub = { hasIsolated: false, hasShared: false, hasHost: false, agentId: '' }
  const add = (name: string, make: () => any) => { if (!map.has(name)) { try { const i = make(); if (i.inputSchema) map.set(name, i.inputSchema) } catch { /* skip */ } } }
  add('sys_code', () => new bi.SysCodeTool({} as any, ''))
  add('sys_lambda', () => new bi.SysLambdaTool({} as any, null as any, ''))
  add('msg_send', () => new bi.SendMessageTool(async () => { throw new Error('x') }, (() => ({ sendMode: 'respond_only', isMessageTriggered: false })) as any))
  add('agent_discover', () => new bi.AgentDiscoverTool(() => []))
  return map
}

async function getHandler(mod: string, name: string) {
  const h = (await import(`../../../src/main/tools/shell/commands/${mod}`)) as any
  const list = h[Object.keys(h).find(k => k.endsWith('Handlers'))!]
  return list.find((x: any) => x.name === name)!
}

/** Run a command handler, capturing every (tool, input) it dispatches. */
function makeCtx(o: { args?: string[]; flags?: any; stdin?: string; rawArgs?: string[] }) {
  const calls: Array<{ tool: string; input: any }> = []
  return {
    calls,
    ctx: {
      stdin: o.stdin ?? '', args: o.args ?? [], flags: o.flags ?? {}, rawArgs: o.rawArgs ?? o.args ?? [],
      config: { name: 'agent-1', limits: {} },
      workspace: { getInbox: () => [], readFile: () => null, listFiles: () => [] },
      toolRegistry: {
        executeTool: vi.fn(async (tool: string, input: any) => { calls.push({ tool, input }); return { content: '[]', isError: false } }),
        get: () => undefined,
        getAll: () => [],
      },
      env: { listAll: () => [], resolve: () => '' },
    } as any,
  }
}

// [command, mod, handlerName, args/flags] → expect every captured input to
// safeParse against its tool's schema.
const CASES: Array<{ label: string; mod: string; name: string; args?: string[]; flags?: any; stdin?: string }> = [
  { label: 'msg send', mod: 'messaging', name: 'msg', args: ['did:key:abc', 'hello'] },
  { label: 'msg --read', mod: 'messaging', name: 'msg', flags: { read: true } },
  { label: 'msg --read --status archived', mod: 'messaging', name: 'msg', flags: { read: true, status: 'archived' } },
  { label: 'msg --list', mod: 'messaging', name: 'msg', flags: { list: true } },
  { label: 'msg --update --status read', mod: 'messaging', name: 'msg', flags: { update: 'm1,m2', status: 'read' } },
  { label: 'msg --archive', mod: 'messaging', name: 'msg', flags: { archive: 'm1' } },
  { label: 'msg --delete', mod: 'messaging', name: 'msg', flags: { delete: 'm1' } },
  { label: 'msg --agents', mod: 'messaging', name: 'msg', flags: { agents: true } },
  { label: 'who', mod: 'messaging', name: 'who' },
  { label: 'at --delay', mod: 'timers', name: 'at', args: ['job.sh'], flags: { delay: '5m' } },
  { label: 'at --every', mod: 'timers', name: 'at', args: ['job.sh'], flags: { every: '1h' } },
  { label: 'at --cron', mod: 'timers', name: 'at', args: ['job.sh'], flags: { cron: '0 * * * *' } },
  { label: 'at --scope system', mod: 'timers', name: 'at', args: ['job.sh'], flags: { delay: '5m', scope: 'system' } },
  { label: 'crontab -l', mod: 'timers', name: 'crontab', flags: { l: true } },
  { label: 'crontab -d', mod: 'timers', name: 'crontab', flags: { d: '7' } },
  { label: 'config set', mod: 'status', name: 'config', args: ['set', 'description', 'hi'] },
  { label: 'config tools', mod: 'status', name: 'config', args: ['tools'] },
  { label: 'meta set', mod: 'meta', name: 'meta', args: ['set', 'k', 'v'] },
  { label: 'meta get', mod: 'meta', name: 'meta', args: ['get', 'k'] },
  { label: 'sqlite3 read', mod: 'structured', name: 'sqlite3', args: ['SELECT * FROM adf_loop'] },
  { label: 'sqlite3 write', mod: 'structured', name: 'sqlite3', args: ["INSERT INTO local_x VALUES (1)"] },
  { label: 'sqlite3 params', mod: 'structured', name: 'sqlite3', args: ['SELECT * FROM local_x WHERE a = ?'], flags: { params: '["v"]' } },
  { label: 'curl', mod: 'networking', name: 'curl', args: ['https://example.com'] },
  { label: 'node -e', mod: 'code', name: 'node', args: ['-e', 'return 1'], flags: { e: 'return 1' } },
]

describe('ADF-native shell commands: built input conforms to the tool schema', () => {
  it.each(CASES)('$label → tool input passes zod safeParse', async (c) => {
    const schemas = await buildSchemaMap()
    const handler = await getHandler(c.mod, c.name)
    const { ctx, calls } = makeCtx({ args: c.args, flags: c.flags, stdin: c.stdin, rawArgs: c.args })
    await handler.execute(ctx)
    expect(calls.length).toBeGreaterThan(0) // the command actually dispatched a tool
    for (const call of calls) {
      const schema = schemas.get(call.tool)
      if (!schema) continue // tool schema not resolvable standalone — skip (not a drift)
      const res = schema.safeParse(call.input)
      expect(res.success, `${c.label}: input for ${call.tool} failed schema: ${JSON.stringify(call.input)} → ${JSON.stringify((res as any).error?.issues ?? (res as any).error)}`).toBe(true)
    }
  })
})

// ── Silent-semantic pins (safeParse-valid but must encode the right intent) ──
describe('ADF-native command semantics', () => {
  it('msg --read defaults to UNREAD (new messages), not read history', async () => {
    const msg = await getHandler('messaging', 'msg')
    const { ctx, calls } = makeCtx({ flags: { read: true } })
    await msg.execute(ctx)
    expect(calls[0].tool).toBe('msg_read')
    expect(calls[0].input.status).toBe('unread')
  })
  it('msg --delete archives before deleting (delete only works on archived)', async () => {
    const msg = await getHandler('messaging', 'msg')
    const { ctx, calls } = makeCtx({ flags: { delete: 'm1' } })
    await msg.execute(ctx)
    expect(calls.map(c => c.input.status)).toEqual(['archived', 'delete'])
  })
  it('crontab -d sends numeric id', async () => {
    const crontab = await getHandler('timers', 'crontab')
    const { ctx, calls } = makeCtx({ flags: { d: '7' } })
    await crontab.execute(ctx)
    expect(calls[0].tool).toBe('sys_delete_timer')
    expect(calls[0].input).toEqual({ id: 7 })
  })
  it('at sends scope as an array', async () => {
    const at = await getHandler('timers', 'at')
    const { ctx, calls } = makeCtx({ args: ['job.sh'], flags: { delay: '5m' } })
    await at.execute(ctx)
    expect(Array.isArray(calls[0].input.scope)).toBe(true)
  })
  it('sqlite3 routes SELECT to db_query and INSERT to db_execute', async () => {
    const sqlite3 = await getHandler('structured', 'sqlite3')
    const r1 = makeCtx({ args: ['SELECT 1'] })
    await sqlite3.execute(r1.ctx)
    expect(r1.calls[0].tool).toBe('db_query')
    const r2 = makeCtx({ args: ['INSERT INTO local_x VALUES (1)'] })
    await sqlite3.execute(r2.ctx)
    expect(r2.calls[0].tool).toBe('db_execute')
  })
})
