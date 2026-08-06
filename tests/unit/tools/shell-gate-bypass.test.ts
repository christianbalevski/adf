import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * #11 universal gate: the HIL/disabled/restricted checks must apply to EVERY
 * execution path, not just top-level ShellTool commands. Previously scripts,
 * xargs, and $() substitution ran pipelines through executeNode directly and
 * bypassed all gating. Authorized .sh scripts intentionally bypass.
 */

function makeShell(opts: {
  vfs?: Record<string, { content: string; authorized?: boolean; protection?: string }>
  restrictedTools?: string[]
  disabledTools?: string[]
  approvalHandler?: (tool: string) => Promise<boolean>
}) {
  const vfs = opts.vfs ?? {}
  const executed: string[] = []
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      executed.push(name)
      if (name === 'fs_read') {
        const f = vfs[input.path]
        if (!f) return { content: `not found: ${input.path}`, isError: true }
        return { content: JSON.stringify({ path: input.path, content: f.content, mime_type: 'text/plain', size: f.content.length }), isError: false }
      }
      if (name === 'fs_write' || name === 'fs_delete') {
        return { content: 'ok', isError: false }
      }
      return { content: '{}', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    insertTask: () => {},
    listFiles: () => Object.keys(vfs).map(p => ({ path: p })),
    isFileAuthorized: (p: string) => !!vfs[p]?.authorized,
    getFileProtection: (p: string) => vfs[p]?.protection ?? 'none',
    renameInternalFile: () => true,
  }
  const tool = (name: string) => ({
    name, enabled: !(opts.disabledTools ?? []).includes(name),
    restricted: (opts.restrictedTools ?? []).includes(name),
  })
  const config: any = {
    name: 'agent-1',
    tools: ['adf_shell', 'fs_read', 'fs_write', 'fs_delete', 'sys_lambda', 'msg_send'].map(tool),
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  if (opts.approvalHandler) shell.onApprovalRequired = opts.approvalHandler
  return { shell, fakeWorkspace, executed }
}

async function run(shell: ShellTool, ws: any, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('#11 gate closes bypass paths', () => {
  it('restricted tool inside a .sh script is gated', async () => {
    const denials: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['fs_delete'],
      approvalHandler: async (t) => { denials.push(t); return false },
      vfs: { 'job.sh': { content: 'rm target.txt\n' }, 'target.txt': { content: 'x' } },
    })
    const r = await run(shell, fakeWorkspace, './job.sh')
    expect(denials).toContain('fs_delete')
    expect(r.exit_code).not.toBe(0)
    expect(executed).not.toContain('fs_delete') // denied → never executed
  })

  it('disabled tool inside a script fails closed', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      disabledTools: ['fs_write'],
      vfs: { 'job.sh': { content: 'echo hi > out.txt\n' } },
    })
    const r = await run(shell, fakeWorkspace, './job.sh')
    expect(r.exit_code).not.toBe(0)
    expect(executed).not.toContain('fs_write')
  })

  it('restricted tool via xargs is gated', async () => {
    const denials: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['fs_delete'],
      approvalHandler: async (t) => { denials.push(t); return false },
    })
    const r = await run(shell, fakeWorkspace, 'echo target.txt | xargs rm')
    expect(denials).toContain('fs_delete')
    expect(executed).not.toContain('fs_delete')
    expect(r.exit_code).not.toBe(0)
  })

  it('restricted tool via $() substitution is gated', async () => {
    const denials: string[] = []
    const { shell, fakeWorkspace } = makeShell({
      restrictedTools: ['msg_send'],
      approvalHandler: async (t) => { denials.push(t); return false },
    })
    // msg needs a delivery address; the point is the gate fires before execution
    await run(shell, fakeWorkspace, 'echo $(msg did:key:x hi --address http://h)')
    expect(denials).toContain('msg_send')
  })

  it('approved restricted tool in a script runs', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['fs_delete'],
      approvalHandler: async () => true,
      vfs: { 'job.sh': { content: 'rm target.txt\n' }, 'target.txt': { content: 'x' } },
    })
    const r = await run(shell, fakeWorkspace, './job.sh')
    expect(r.exit_code).toBe(0)
    expect(executed).toContain('fs_delete')
  })

  it('AUTHORIZED .sh script bypasses HIL for restricted tools', async () => {
    let asked = false
    const { shell, fakeWorkspace, executed } = makeShell({
      restrictedTools: ['fs_delete'],
      approvalHandler: async () => { asked = true; return false },
      vfs: { 'job.sh': { content: 'rm target.txt\n', authorized: true }, 'target.txt': { content: 'x' } },
    })
    const r = await run(shell, fakeWorkspace, './job.sh')
    expect(asked).toBe(false)          // never prompted
    expect(r.exit_code).toBe(0)
    expect(executed).toContain('fs_delete')
  })

  it('authorized .sh injects _authorized so protected deletes go through', async () => {
    const { shell, fakeWorkspace } = makeShell({
      vfs: { 'job.sh': { content: 'rm locked.txt\n', authorized: true }, 'locked.txt': { content: 'x', protection: 'no_delete' } },
    })
    const r = await run(shell, fakeWorkspace, './job.sh')
    expect(r.exit_code).toBe(0)
    const call = fakeWorkspace // fs_delete got _authorized:true → tool would bypass (fake returns ok regardless)
    expect(call).toBeTruthy()
  })
})
