import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * Config staleness fixes:
 *
 * 1. The shell gate must evaluate the agent's CURRENT config, not a snapshot
 *    captured at ShellTool construction. Previously updateConfig() existed but
 *    no fan-out site called it, so tools enabled after construction still
 *    exited 126 ("enabled ≠ usable") and `config set` appeared to lie (the
 *    write persisted, sys_get_config read fresh, but the gate stayed stale).
 *    ShellTool now reads config through a provider function; assembleAgent
 *    wires it to the executor's live config, which every config fan-out site
 *    already updates via executor.updateConfig().
 *
 * 2. The `config` command previously gated ALL subcommands on BOTH
 *    sys_get_config and sys_update_config, so read-only `config` /
 *    `config tools` exited 126 whenever sys_update_config was disabled.
 *    Read subcommands now require only sys_get_config; `config set` requires
 *    only sys_update_config.
 */

interface ToolFlags { enabled?: boolean; restricted?: boolean }

function makeConfig(tools: Record<string, ToolFlags>) {
  return {
    name: 'agent-1',
    tools: Object.entries(tools).map(([name, f]) => ({
      name,
      enabled: f.enabled !== false,
      restricted: f.restricted === true,
    })),
    limits: { execution_timeout_ms: 5000 },
  } as any
}

function makeHarness() {
  const executed: string[] = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      executed.push(name)
      if (name === 'db_query') return { content: '[]', isError: false }
      if (name === 'sys_get_config') {
        if (input?.section === 'tools') {
          return {
            content: JSON.stringify({
              tools: [{
                name: 'fs_read', enabled: true, visible: true, restricted: false,
                source: 'built-in', description: 'Read a file.', schema: {},
              }],
            }),
            isError: false,
          }
        }
        return { content: '{"name":"agent-1"}', isError: false }
      }
      if (name === 'sys_update_config') return { content: 'Updated.', isError: false }
      if (name === 'fs_write') return { content: 'ok', isError: false }
      return { content: '{}', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    insertTask: () => {},
    listFiles: () => [],
    isFileAuthorized: () => false,
    getFileProtection: () => 'none',
    renameInternalFile: () => true,
  }
  return { fakeRegistry, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('shell gate tracks live config (no stale snapshot)', () => {
  it('newly-ENABLED tool passes the gate after updateConfig (was 126)', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(
      fakeRegistry, fakeWorkspace,
      makeConfig({ db_query: { enabled: false } }), null,
    )

    const before = await run(shell, fakeWorkspace, 'ps')
    expect(before.exit_code).toBe(126)
    expect(executed).not.toContain('db_query')

    // Simulate what sys_update_config's onConfigChanged fan-out does.
    shell.updateConfig(makeConfig({ db_query: { enabled: true } }))

    const after = await run(shell, fakeWorkspace, 'ps')
    expect(after.exit_code).toBe(0)
    expect(executed).toContain('db_query')
  })

  it('newly-DISABLED tool exits 126 after updateConfig', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(
      fakeRegistry, fakeWorkspace,
      makeConfig({ fs_write: { enabled: true } }), null,
    )

    const before = await run(shell, fakeWorkspace, 'echo hi > out.txt')
    expect(before.exit_code).toBe(0)
    expect(executed).toContain('fs_write')

    shell.updateConfig(makeConfig({ fs_write: { enabled: false } }))
    executed.length = 0

    const after = await run(shell, fakeWorkspace, 'echo hi > out.txt')
    expect(after.exit_code).toBe(126)
    expect(after.stderr).toContain('fs_write')
    expect(executed).not.toContain('fs_write')
  })

  it('provider-fn construction (assembleAgent wiring): executor.updateConfig alone refreshes the gate', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    // Mimic AgentExecutor's config lifecycle: the shell is constructed with a
    // live provider and NOBODY ever calls shellTool.updateConfig.
    const executorLike = {
      config: makeConfig({ db_query: { enabled: false } }),
      updateConfig(c: any) { this.config = c },
      getConfig() { return this.config },
    }
    const shell = new ShellTool(
      fakeRegistry, fakeWorkspace,
      () => executorLike.getConfig(), null,
    )

    expect((await run(shell, fakeWorkspace, 'ps')).exit_code).toBe(126)

    // Any of the existing fan-out sites (IPC, background manager, sys_update_config).
    executorLike.updateConfig(makeConfig({ db_query: { enabled: true } }))

    expect((await run(shell, fakeWorkspace, 'ps')).exit_code).toBe(0)
    expect(executed).toContain('db_query')
  })

  it('setConfigProvider re-points a reused shell at a new live source', async () => {
    const { fakeRegistry, fakeWorkspace } = makeHarness()
    const shell = new ShellTool(
      fakeRegistry, fakeWorkspace,
      makeConfig({ db_query: { enabled: false } }), null,
    )
    expect((await run(shell, fakeWorkspace, 'ps')).exit_code).toBe(126)

    const live = { config: makeConfig({ db_query: { enabled: true } }) }
    shell.setConfigProvider(() => live.config)
    expect((await run(shell, fakeWorkspace, 'ps')).exit_code).toBe(0)

    live.config = makeConfig({ db_query: { enabled: false } })
    expect((await run(shell, fakeWorkspace, 'ps')).exit_code).toBe(126)
  })
})

describe('config command gating split (read vs set)', () => {
  const readOnlyConfig = () => makeConfig({
    sys_get_config: { enabled: true },
    sys_update_config: { enabled: false },
  })

  it('`config` and `config tools` need only sys_get_config (update disabled)', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(fakeRegistry, fakeWorkspace, readOnlyConfig(), null)

    const dump = await run(shell, fakeWorkspace, 'config')
    expect(dump.exit_code).toBe(0)

    const tools = await run(shell, fakeWorkspace, 'config tools')
    expect(tools.exit_code).toBe(0)

    const one = await run(shell, fakeWorkspace, 'config tools fs_read')
    expect(one.exit_code).toBe(0)

    expect(executed).toContain('sys_get_config')
    expect(executed).not.toContain('sys_update_config')
  })

  it('`config set` still exits 126 when sys_update_config is disabled', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(fakeRegistry, fakeWorkspace, readOnlyConfig(), null)

    const r = await run(shell, fakeWorkspace, 'config set tools.fs_delete.enabled true')
    expect(r.exit_code).toBe(126)
    expect(r.stderr).toContain('sys_update_config')
    expect(executed).not.toContain('sys_update_config')
  })

  it('`config set` needs only sys_update_config — bootstraps even with sys_get_config disabled', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(fakeRegistry, fakeWorkspace, makeConfig({
      sys_get_config: { enabled: false },
      sys_update_config: { enabled: true },
    }), null)

    const r = await run(shell, fakeWorkspace, 'config set tools.sys_get_config.enabled true')
    expect(r.exit_code).toBe(0)
    expect(executed).toContain('sys_update_config')
  })

  it('malformed `config set` (too few args) errors instead of falling through to a read', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(fakeRegistry, fakeWorkspace, makeConfig({
      sys_get_config: { enabled: false },
      sys_update_config: { enabled: true },
    }), null)

    const r = await run(shell, fakeWorkspace, 'config set only-path')
    expect(r.exit_code).not.toBe(0)
    expect(executed).not.toContain('sys_get_config')
  })

  it('restricted sys_update_config does not prompt HIL for read-only `config`', async () => {
    const { fakeRegistry, fakeWorkspace } = makeHarness()
    const shell = new ShellTool(fakeRegistry, fakeWorkspace, makeConfig({
      sys_get_config: { enabled: true },
      sys_update_config: { enabled: true, restricted: true },
    }), null)
    let asked = false
    shell.onApprovalRequired = async () => { asked = true; return false }

    const r = await run(shell, fakeWorkspace, 'config')
    expect(r.exit_code).toBe(0)
    expect(asked).toBe(false)
  })

  it('dynamic subcommand ($VAR) fails closed: requires the write tool too', async () => {
    const { fakeRegistry, fakeWorkspace, executed } = makeHarness()
    const shell = new ShellTool(fakeRegistry, fakeWorkspace, readOnlyConfig(), null)

    // $A could expand to `set` at runtime — the static gate must not assume a read.
    const r = await run(shell, fakeWorkspace, 'export A=set; config $A tools.fs_delete.enabled true')
    expect(r.exit_code).toBe(126)
    expect(executed).not.toContain('sys_update_config')
  })
})
