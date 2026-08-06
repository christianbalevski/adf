import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * Regression tests for the adversarial-audit findings on the permission gate:
 *  - MCP gating desync via quoted/variable server name (CRITICAL bypass)
 *  - _authorized forge through the mcp flag passthrough
 *  - authorization leaking from an authorized .sh into child scripts/lambdas
 */

function makeShell(opts: {
  restrictedTools?: string[]
  vfs?: Record<string, { content: string; authorized?: boolean }>
  approvalHandler?: (t: string) => Promise<boolean>
  mcpServers?: Array<{ name: string; restricted?: boolean; tools: string[] }>
}) {
  const vfs = opts.vfs ?? {}
  const executed: Array<{ tool: string; input: any }> = []
  const mcpTools = (opts.mcpServers ?? []).flatMap(s => s.tools.map(t => `mcp_${s.name}_${t}`))
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
    get: (n: string) => mcpTools.includes(n) ? { name: n, toProviderFormat: () => ({ description: '', input_schema: {} }) } : undefined,
    getAll: () => mcpTools.map(n => ({ name: n, description: '' })),
  }
  const fakeWorkspace: any = {
    insertLog: () => {}, insertTask: () => {}, listFiles: () => [],
    isFileAuthorized: (p: string) => !!vfs[p]?.authorized,
    getFileProtection: () => 'none',
  }
  const config: any = {
    name: 'agent-1',
    tools: [
      ...['adf_shell', 'fs_read', 'fs_write', 'fs_delete', 'sys_lambda', 'sys_code'].map(n => ({
        name: n, enabled: true, restricted: (opts.restrictedTools ?? []).includes(n),
      })),
    ],
    mcp: { servers: (opts.mcpServers ?? []).map(s => ({ name: s.name, restricted: s.restricted })) },
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  shell.onApprovalRequired = opts.approvalHandler ?? (async () => false)
  return { shell, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('MCP gating desync (CRITICAL) is closed', () => {
  it('quoted restricted server name is still gated', async () => {
    const denials: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      mcpServers: [{ name: 'github', restricted: true, tools: ['create_issue'] }],
      approvalHandler: async (t) => { denials.push(t); return false },
    })
    // The quoted server name defeated the old static AST resolver.
    const r = await run(shell, fakeWorkspace, 'mcp "github" create_issue --title x')
    expect(denials).toContain('mcp_github_create_issue')
    expect(r.exit_code).not.toBe(0)
    expect(executed.some(e => e.tool === 'mcp_github_create_issue')).toBe(false)
  })

  it('literal restricted server is gated (and approved runs)', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      mcpServers: [{ name: 'github', restricted: true, tools: ['create_issue'] }],
      approvalHandler: async () => true,
    })
    const r = await run(shell, fakeWorkspace, 'mcp github create_issue --title x')
    expect(r.exit_code).toBe(0)
    expect(executed.some(e => e.tool === 'mcp_github_create_issue')).toBe(true)
  })

  it('unrestricted server runs without prompting', async () => {
    const asked = vi.fn(async () => true)
    const { shell, fakeWorkspace } = makeShell({
      mcpServers: [{ name: 'calc', restricted: false, tools: ['add'] }],
      approvalHandler: asked,
    })
    await run(shell, fakeWorkspace, 'mcp calc add --a 1')
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('_authorized cannot be forged', () => {
  it('mcp --_authorized flag is stripped before the tool call', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      mcpServers: [{ name: 'calc', tools: ['add'] }],
    })
    await run(shell, fakeWorkspace, 'mcp calc add --a 1 --_authorized')
    const call = executed.find(e => e.tool === 'mcp_calc_add')
    expect(call).toBeTruthy()
    expect(call!.input._authorized).toBeUndefined()
  })
})

describe('authorized .sh does not leak authorization to children', () => {
  it('an authorized parent running ./child.sh does NOT authorize the child', async () => {
    const denials: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['fs_delete'],
      approvalHandler: async (t) => { denials.push(t); return false },
      vfs: {
        'parent.sh': { content: './child.sh\n', authorized: true },
        'child.sh': { content: 'rm target.txt\n', authorized: false },
        'target.txt': { content: 'x' },
      },
    })
    const r = await run(shell, fakeWorkspace, './parent.sh')
    // child.sh is unauthorized → its restricted rm must be gated (denied here)
    expect(denials).toContain('fs_delete')
    expect(executed.some(e => e.tool === 'fs_delete')).toBe(false)
    expect(r.exit_code).not.toBe(0)
  })

  it('authorized .sh does not inject _authorized into sys_lambda (nested code)', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      vfs: { 'run.sh': { content: './task.ts\n', authorized: true }, 'task.ts': { content: 'x', authorized: false } },
    })
    await run(shell, fakeWorkspace, './run.sh')
    const lambdaCall = executed.find(e => e.tool === 'sys_lambda')
    expect(lambdaCall).toBeTruthy()
    expect(lambdaCall!.input._authorized).toBeUndefined()
  })

  it('authorized .sh still bypasses HIL for its OWN direct tool calls', async () => {
    let asked = false
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['fs_delete'],
      approvalHandler: async () => { asked = true; return false },
      vfs: { 'own.sh': { content: 'rm target.txt\n', authorized: true }, 'target.txt': { content: 'x' } },
    })
    const r = await run(shell, fakeWorkspace, './own.sh')
    expect(asked).toBe(false)
    expect(r.exit_code).toBe(0)
    const del = executed.find(e => e.tool === 'fs_delete')
    expect(del!.input._authorized).toBe(true) // its own calls DO get the bypass
  })
})
