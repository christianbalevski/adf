import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * on_tool_call through adf_shell — LIVE BUG REPRODUCTION.
 *
 * on_tool_call is documented as "observational, post-execution", and that is
 * what the direct tool-call path does: run the tool, then notify. The shell did
 * the opposite — it refused the command with exit 130, inserted an `adf_shell`
 * task, and told the agent "it will be resolved by the operator". Nothing ever
 * resolved it: TriggerEvaluator.onToolCall takes an unused taskId and only
 * dispatches the trigger's targets, so a `msg send` under an on_tool_call
 * trigger silently never sent, the task sat pending forever, and the agent was
 * instructed not to retry.
 *
 * These tests pin the fixed semantics: the command RUNS, observers fire once
 * per matched tool after it runs, and no task is created. Blocking a tool call
 * remains the job of `restricted: true` (HIL), which still works.
 */

function makeShell(opts: {
  triggerTools?: string[]
  disabled?: string[]
  restricted?: string[]
  approve?: boolean
} = {}) {
  const executed: Array<{ name: string; input: any }> = []
  const observed: Array<{ tool: string; args: string; taskId: string; origin: string }> = []
  const tasks: Array<{ id: string; tool: string; args: string }> = []

  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      executed.push({ name, input })
      return { content: `${name}-ok`, isError: false }
    }),
    get: () => undefined,
    getAll: () => [],
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    insertTask: vi.fn((id: string, tool: string, args: string) => { tasks.push({ id, tool, args }) }),
    listFiles: () => [],
    readFile: () => null,
    setIdentity: () => {},
  }
  const tool = (name: string) => ({
    name,
    enabled: !(opts.disabled ?? []).includes(name),
    restricted: (opts.restricted ?? []).includes(name),
  })
  const config: any = {
    name: 'agent-1',
    id: 'agent-1-id',
    state: 'active',
    tools: ['adf_shell', 'msg_send', 'msg_list', 'fs_read', 'fs_write', 'sys_get_config'].map(tool),
    limits: { execution_timeout_ms: 5000 },
    triggers: opts.triggerTools
      ? { on_tool_call: { enabled: true, targets: [{ scope: 'system', lambda: 'watch.ts:onCall', filter: { tools: opts.triggerTools } }] } }
      : {},
  }

  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  shell.onToolCallIntercepted = (tool, args, taskId, origin) => { observed.push({ tool, args, taskId, origin }) }
  if (opts.restricted?.length) {
    shell.onApprovalRequired = async () => opts.approve ?? false
  }
  return { shell, fakeWorkspace, executed, observed, tasks }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('on_tool_call in the shell: the tool RUNS', () => {
  it('a matched msg_send sends, exits 0, and creates no task', async () => {
    const { shell, fakeWorkspace, executed, observed, tasks } = makeShell({ triggerTools: ['msg_send'] })
    const r = await run(shell, fakeWorkspace, `msg did:key:zAbc "start Ch.9 now"`)

    expect(r.exit_code).toBe(0)
    expect(executed.map(e => e.name)).toEqual(['msg_send'])   // it actually sent
    expect(tasks).toEqual([])                                  // no orphan task
    expect(r.stderr).not.toContain('intercepted')
    expect(r.stderr).not.toContain('resolved by the operator')
  })

  it('fires the observer once per matched tool, after execution', async () => {
    const { shell, fakeWorkspace, observed } = makeShell({ triggerTools: ['msg_send'] })
    await run(shell, fakeWorkspace, `msg did:key:zAbc "hello"`)

    expect(observed).toHaveLength(1)
    expect(observed[0].tool).toBe('msg_send')
    expect(observed[0].origin).toBe('agent:agent-1:agent-1-id')
    expect(JSON.parse(observed[0].args)).toMatchObject({ intercepted_by: ['msg_send'] })
  })

  it('a long chain around the matched command still runs end to end', async () => {
    // The reported shape: a matched msg_send buried in a chain killed every
    // command in the invocation with exit 130.
    const { shell, fakeWorkspace, executed, observed, tasks } = makeShell({ triggerTools: ['msg_send'] })
    const r = await run(shell, fakeWorkspace, `whoami && msg did:key:zAbc "push" && echo EXIT:$? ; msg --list`)

    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('EXIT:0')
    expect(executed.map(e => e.name)).toEqual(['msg_send', 'msg_list'])
    expect(observed.map(o => o.tool)).toEqual(['msg_send'])
    expect(tasks).toEqual([])
  })

  it('a glob filter observes every matching tool the pipeline ran', async () => {
    const { shell, fakeWorkspace, observed } = makeShell({ triggerTools: ['msg_*'] })
    await run(shell, fakeWorkspace, `msg --list && msg did:key:zAbc "hi"`)
    expect(observed.map(o => o.tool).sort()).toEqual(['msg_list', 'msg_send'])
  })

  it('observes a tool reached through a redirect (fs_write)', async () => {
    const { shell, fakeWorkspace, executed, observed } = makeShell({ triggerTools: ['fs_write'] })
    const r = await run(shell, fakeWorkspace, 'echo hi > out.txt')
    expect(r.exit_code).toBe(0)
    expect(executed.map(e => e.name)).toEqual(['fs_write'])
    expect(observed.map(o => o.tool)).toEqual(['fs_write'])
  })

  it('does not fire for tools the command never ran', async () => {
    const { shell, fakeWorkspace, observed } = makeShell({ triggerTools: ['msg_send'] })
    await run(shell, fakeWorkspace, 'echo hello')
    expect(observed).toEqual([])
  })

  it('an observer that throws does not break the command', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({ triggerTools: ['msg_send'] })
    shell.onToolCallIntercepted = () => { throw new Error('lambda blew up') }
    const r = await run(shell, fakeWorkspace, `msg did:key:zAbc "hi"`)
    expect(r.exit_code).toBe(0)
    expect(executed.map(e => e.name)).toEqual(['msg_send'])
  })
})

describe('msg send syntax', () => {
  it('`msg send --to X --content Y` names the real mistake instead of "missing body"', async () => {
    const { shell, fakeWorkspace, executed } = makeShell()
    const r = await run(shell, fakeWorkspace, `msg send --to did:key:zAbc --content "hello"`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('no `send` subcommand')
    expect(r.stderr).toContain('msg <to> "body"')
    expect(executed).toEqual([])
  })
})

describe('on_tool_call does not become a permission', () => {
  it('a disabled tool still exits 126 and never runs or observes', async () => {
    const { shell, fakeWorkspace, executed, observed } = makeShell({ triggerTools: ['msg_send'], disabled: ['msg_send'] })
    const r = await run(shell, fakeWorkspace, `msg did:key:zAbc "hi"`)
    expect(r.exit_code).toBe(126)
    expect(executed).toEqual([])
    expect(observed).toEqual([])
  })

  it('restricted (HIL) still blocks: denied → not run, not observed', async () => {
    const { shell, fakeWorkspace, executed, observed } = makeShell({
      triggerTools: ['msg_send'], restricted: ['msg_send'], approve: false,
    })
    const r = await run(shell, fakeWorkspace, `msg did:key:zAbc "hi"`)
    expect(r.exit_code).toBe(130)
    expect(executed).toEqual([])
    expect(observed).toEqual([])
  })

  it('restricted + approved → runs AND observes (approval is the gate, the trigger is the watcher)', async () => {
    const { shell, fakeWorkspace, executed, observed } = makeShell({
      triggerTools: ['msg_send'], restricted: ['msg_send'], approve: true,
    })
    const r = await run(shell, fakeWorkspace, `msg did:key:zAbc "hi"`)
    expect(r.exit_code).toBe(0)
    expect(executed.map(e => e.name)).toEqual(['msg_send'])
    expect(observed.map(o => o.tool)).toEqual(['msg_send'])
  })
})
