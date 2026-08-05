import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * HIL approval flow for shell-gated tools.
 *
 * Regression: assemble-agent wires shellTool.onApprovalRequired to
 * executor.requestApproval — a method that did not exist on AgentExecutor,
 * so every gated shell command failed with a TypeError instead of prompting.
 * These tests pin the ShellTool side of the contract; the prototype test
 * pins the executor side.
 */

function makeShell(opts: {
  restricted?: boolean
  onApprovalRequired?: (toolName: string, command: string) => Promise<boolean>
}) {
  const executed: Array<{ tool: string; input: unknown }> = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: unknown) => {
      executed.push({ tool: name, input })
      return { content: JSON.stringify({ content: 'file contents' }), isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    readFile: () => 'file contents',
    listFiles: () => [],
  }
  const config: any = {
    name: 'agent-1',
    tools: [
      { name: 'fs_read', enabled: true, restricted: opts.restricted ?? true },
      { name: 'adf_shell', enabled: true },
    ],
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  if (opts.onApprovalRequired) shell.onApprovalRequired = opts.onApprovalRequired
  return { shell, fakeWorkspace, executed }
}

describe('shell HIL approval', () => {
  it('gated command without handler fails closed with explanatory stderr', async () => {
    const { shell, fakeWorkspace } = makeShell({})
    const result = await shell.execute({ command: 'cat notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).toBe(130)
    expect(parsed.stderr).toContain('approval')
  })

  it('approved command executes the gated tool', async () => {
    const approvals: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      onApprovalRequired: async (toolName) => {
        approvals.push(toolName)
        return true
      },
    })
    const result = await shell.execute({ command: 'cat notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(approvals).toEqual(['fs_read'])
    expect(parsed.exit_code).toBe(0)
    expect(executed.some(e => e.tool === 'fs_read')).toBe(true)
  })

  it('denied command returns exit 130 without executing the tool', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      onApprovalRequired: async () => false,
    })
    const result = await shell.execute({ command: 'cat notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).toBe(130)
    expect(parsed.stderr).toContain('rejected')
    expect(executed).toHaveLength(0)
  })

  it('unrestricted command never consults the approval handler', async () => {
    const handler = vi.fn(async () => true)
    const { shell, fakeWorkspace } = makeShell({ restricted: false, onApprovalRequired: handler })
    const result = await shell.execute({ command: 'cat notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).toBe(0)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('AgentExecutor approval contract', () => {
  it('exposes requestApproval (wired by assemble-agent for shell HIL)', async () => {
    const { AgentExecutor } = await import('../../../src/main/runtime/agent-executor')
    expect(typeof AgentExecutor.prototype.requestApproval).toBe('function')
    expect(typeof AgentExecutor.prototype.requestHilApproval).toBe('function')
  })
})
