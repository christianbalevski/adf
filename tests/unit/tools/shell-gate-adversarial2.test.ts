import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'
import { evaluateToolNames } from '../../../src/main/tools/shell/executor/preflight'

/**
 * Regression tests for the SECOND-pass adversarial findings (holes in the
 * first-round fixes): wrapped-registry auth leak, shell wholesale config
 * bypass, MCP underscore/server-restricted gaps, recursion depth, signal.
 */

function makeShell(opts: {
  restrictedTools?: string[]
  vfs?: Record<string, { content: string; authorized?: boolean }>
}) {
  const vfs = opts.vfs ?? {}
  const executed: Array<{ tool: string; input: any }> = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      executed.push({ tool: name, input })
      if (name === 'fs_read') {
        const f = vfs[input.path]
        if (!f) return { content: 'nf', isError: true }
        return { content: JSON.stringify({ path: input.path, content: f.content, mime_type: 'text/plain', size: f.content.length }), isError: false }
      }
      return { content: 'ok', isError: false }
    }),
    get: () => undefined,
    getAll: () => [],
  }
  const fakeWorkspace: any = {
    insertLog: () => {}, insertTask: () => {}, listFiles: () => [],
    isFileAuthorized: (p: string) => !!vfs[p]?.authorized,
    getFileProtection: () => 'none',
  }
  const config: any = {
    name: 'agent-1',
    tools: ['adf_shell', 'fs_read', 'fs_write', 'fs_delete'].map(n => ({
      name: n, enabled: true, restricted: (opts.restrictedTools ?? []).includes(n),
    })),
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  shell.onApprovalRequired = async () => false
  return { shell, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('registry-leak fix: unauthorized child does not inherit _authorized', () => {
  it('authorized parent → unauthorized ./child.sh: child fs_write has NO _authorized', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      vfs: {
        'parent.sh': { content: './child.sh\n', authorized: true },
        'child.sh': { content: 'echo pwn > secret.txt\n', authorized: false },
      },
    })
    await run(shell, fakeWorkspace, './parent.sh')
    const write = executed.find(e => e.tool === 'fs_write' && e.input.path === 'secret.txt')
    expect(write).toBeTruthy()
    expect(write!.input._authorized).toBeUndefined() // NOT escalated
  })

  it('authorized parent → authorized ./child.sh: child DOES get _authorized', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      vfs: {
        'parent.sh': { content: './child.sh\n', authorized: true },
        'child.sh': { content: 'echo ok > f.txt\n', authorized: true },
      },
    })
    await run(shell, fakeWorkspace, './parent.sh')
    const write = executed.find(e => e.tool === 'fs_write' && e.input.path === 'f.txt')
    expect(write!.input._authorized).toBe(true)
  })

  it('recursion depth is bounded (self-calling script errors, does not hang)', async () => {
    const { shell, fakeWorkspace } = makeShell({
      vfs: { 'self.sh': { content: './self.sh\n' } },
    })
    const r = await run(shell, fakeWorkspace, './self.sh')
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('nesting too deep')
  })
})

describe('MCP restriction fixes', () => {
  it('server name with underscores is matched by prefix (git_hub)', () => {
    const config: any = { tools: [], mcp: { servers: [{ name: 'git_hub', restricted: true }] } }
    const evalr = evaluateToolNames(['mcp_git_hub_create'], config)
    expect(evalr.approvalRequired).toContain('mcp_git_hub_create')
  })

  it('restricted server gates its tool even when a per-tool declaration exists', () => {
    const config: any = {
      tools: [{ name: 'mcp_github_create', enabled: true, restricted: false }],
      mcp: { servers: [{ name: 'github', restricted: true }] },
    }
    const evalr = evaluateToolNames(['mcp_github_create'], config)
    expect(evalr.approvalRequired).toContain('mcp_github_create')
  })

  it('unrestricted server with underscores is not falsely gated', () => {
    const config: any = { tools: [], mcp: { servers: [{ name: 'git_hub', restricted: false }] } }
    const evalr = evaluateToolNames(['mcp_git_hub_create'], config)
    expect(evalr.approvalRequired).not.toContain('mcp_git_hub_create')
  })
})

describe('sys_update_config shell boundary', () => {
  async function makeTool() {
    const { SysUpdateConfigTool } = await import('../../../src/main/tools/built-in/sys-update-config.tool')
    return new SysUpdateConfigTool()
  }
  const config: any = { name: 'a', tools: [], shell: { commands: { allow: ['echo'] } }, locked_fields: [] }
  const ws: any = { getAgentConfig: () => config, setAgentConfig: () => {}, getConfig: () => config }

  it('blocks wholesale shell replacement by unauthorized code', async () => {
    const tool = await makeTool()
    const r = await tool.execute({ path: 'shell', value: { commands: { allow: ['*'], approval: [] } } }, ws)
    expect(r.isError).toBe(true)
    expect(String(r.content)).toContain('security boundary')
  })

  it('blocks shell.commands.allow modification by unauthorized code', async () => {
    const tool = await makeTool()
    const r = await tool.execute({ path: 'shell.commands.allow', value: ['*'] }, ws)
    expect(r.isError).toBe(true)
  })
})
