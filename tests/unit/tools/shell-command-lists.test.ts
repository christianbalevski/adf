import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * #12 command allow / approval lists (config.shell.commands): a coarse,
 * command-name capability surface layered on the universal gate.
 */

function makeShell(shellCfg?: { allow?: string[]; approval?: string[] }, opts?: {
  approvalHandler?: (label: string) => Promise<boolean>
  authorizedScripts?: Record<string, string>
}) {
  const vfs = opts?.authorizedScripts ?? {}
  const executed: string[] = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      executed.push(name)
      if (name === 'fs_read') {
        const f = vfs[input.path]
        if (f === undefined) return { content: `not found`, isError: true }
        return { content: JSON.stringify({ path: input.path, content: f, mime_type: 'text/plain', size: f.length }), isError: false }
      }
      return { content: '{}', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {}, insertTask: () => {}, listFiles: () => [],
    isFileAuthorized: (p: string) => p in vfs,
    getFileProtection: () => 'none',
  }
  const config: any = {
    name: 'agent-1',
    tools: ['adf_shell', 'fs_read', 'fs_write', 'sys_lambda'].map(n => ({ name: n, enabled: true })),
    limits: { execution_timeout_ms: 5000 },
    ...(shellCfg ? { shell: { commands: shellCfg } } : {}),
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  if (opts?.approvalHandler) shell.onApprovalRequired = opts.approvalHandler
  return { shell, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('#12 command allowlist', () => {
  it('no config → all commands run (back-compatible)', async () => {
    const { shell, fakeWorkspace } = makeShell()
    const r = await run(shell, fakeWorkspace, 'echo hi')
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('hi')
  })

  it('allowlisted command runs', async () => {
    const { shell, fakeWorkspace } = makeShell({ allow: ['echo', 'jq'] })
    const r = await run(shell, fakeWorkspace, 'echo hi')
    expect(r.exit_code).toBe(0)
  })

  it('non-allowlisted command exits 126', async () => {
    const { shell, fakeWorkspace } = makeShell({ allow: ['echo'] })
    const r = await run(shell, fakeWorkspace, 'ls')
    expect(r.exit_code).toBe(126)
    expect(r.stderr).toContain('not permitted')
  })

  it('alias resolves to canonical for the allowlist', async () => {
    // curl has alias wget; allow curl → wget permitted (both resolve to curl)
    const { shell, fakeWorkspace } = makeShell({ allow: ['curl'] })
    const r = await run(shell, fakeWorkspace, 'wget http://example.com')
    // command is permitted (won't be the 126 "not permitted" error)
    expect(r.stderr ?? '').not.toContain('not permitted')
  })

  it('allowlist applies inside scripts too', async () => {
    const { shell, fakeWorkspace } = makeShell(
      { allow: ['echo'] },
      { authorizedScripts: {} },
    )
    // unauthorized script running a non-allowed command
    const reg: any = (shell as any).toolRegistry
    reg.executeTool = vi.fn(async (name: string, input: any) => {
      if (name === 'fs_read' && input.path === 's.sh') {
        return { content: JSON.stringify({ path: 's.sh', content: 'ls\n', mime_type: 'text/plain', size: 3 }), isError: false }
      }
      return { content: '{}', isError: false }
    })
    const r = await run(shell, fakeWorkspace, './s.sh')
    expect(r.exit_code).toBe(126)
  })
})

describe('#12 command approval list', () => {
  it('approval-listed command prompts; approved runs', async () => {
    const asked: string[] = []
    const { shell, fakeWorkspace } = makeShell(
      { approval: ['curl'] },
      { approvalHandler: async (l) => { asked.push(l); return true } },
    )
    await run(shell, fakeWorkspace, 'curl http://example.com')
    expect(asked).toContain('curl')
  })

  it('approval-listed command denied → 130', async () => {
    const { shell, fakeWorkspace } = makeShell(
      { approval: ['echo'] },
      { approvalHandler: async () => false },
    )
    const r = await run(shell, fakeWorkspace, 'echo hi')
    expect(r.exit_code).toBe(130)
    expect(r.stderr).toContain('rejected')
  })

  it('no approval handler → approval-listed command fails closed', async () => {
    const { shell, fakeWorkspace } = makeShell({ approval: ['echo'] })
    const r = await run(shell, fakeWorkspace, 'echo hi')
    expect(r.exit_code).toBe(130)
    expect(r.stderr).toContain('approval')
  })

  it('authorized .sh bypasses the approval list but not the allowlist', async () => {
    const asked: string[] = []
    const { shell, fakeWorkspace } = makeShell(
      { approval: ['echo'], allow: ['./', 'echo', 'cat'] },
      { approvalHandler: async (l) => { asked.push(l); return false }, authorizedScripts: { 'a.sh': 'echo hi\n' } },
    )
    const r = await run(shell, fakeWorkspace, './a.sh')
    expect(asked).toHaveLength(0) // approval bypassed
    expect(r.exit_code).toBe(0)
  })
})
