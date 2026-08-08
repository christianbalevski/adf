/**
 * Shell pipeline protection→HIL flow.
 *
 * A tool call inside a pipeline that is denied by a data protection must pause
 * for a HIL override via gate.onProtectionBlocked (wired by assemble-agent to
 * executor.requestProtectionApproval): approve → re-execute with the one-time
 * bypass; deny → error with feedback; no handler → plain denial (fail closed).
 * Covers the command path (rm → fs_delete), the redirect path (> → fs_write),
 * and the mv handler's inline pre-check.
 */

import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'
import type { ProtectionDenial } from '../../../src/shared/types/tool.types'

function makeShell(opts: {
  onProtectionBlocked?: (
    toolName: string,
    input: Record<string, unknown>,
    protection: ProtectionDenial,
    command: string
  ) => Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown>; feedback?: string }>
  fileProtection?: 'read_only' | 'no_delete' | 'none'
}) {
  const executed: Array<{ tool: string; input: Record<string, unknown> }> = []
  const protection = opts.fileProtection ?? 'no_delete'
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: Record<string, unknown>) => {
      executed.push({ tool: name, input })
      const isOverride = input?._protection_override === true
      if (name === 'fs_delete' && protection !== 'none' && !isOverride) {
        return {
          content: `Cannot delete "${input.path}": file is protected (no-delete).`,
          isError: true,
          protection: { kind: 'file_protection', target: input.path, level: protection }
        }
      }
      if (name === 'fs_write' && protection === 'read_only' && !isOverride) {
        return {
          content: `Cannot write to "${input.path}": file is read-only.`,
          isError: true,
          protection: { kind: 'file_protection', target: input.path, level: 'read_only' }
        }
      }
      return { content: 'OK', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = {
    insertLog: () => {},
    readFile: () => 'contents',
    listFiles: () => [],
    fileExists: () => true,
    getFileProtection: () => protection,
    renameInternalFile: () => true,
  }
  const config: any = {
    name: 'agent-1',
    tools: [
      { name: 'fs_delete', enabled: true, restricted: false },
      { name: 'fs_write', enabled: true, restricted: false },
      { name: 'fs_read', enabled: true, restricted: false },
      { name: 'adf_shell', enabled: true },
    ],
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  if (opts.onProtectionBlocked) shell.onProtectionBlocked = opts.onProtectionBlocked
  return { shell, fakeWorkspace, executed }
}

describe('shell protection HIL', () => {
  it('approved rm re-executes fs_delete with _protection_override', async () => {
    const prompts: Array<{ tool: string; level: string }> = []
    const { shell, fakeWorkspace, executed } = makeShell({
      onProtectionBlocked: async (toolName, _input, protection) => {
        prompts.push({ tool: toolName, level: protection.level })
        return { approved: true }
      },
    })
    const result = await shell.execute({ command: 'rm notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(prompts).toEqual([{ tool: 'fs_delete', level: 'no_delete' }])
    expect(parsed.exit_code).toBe(0)
    const overrideCall = executed.find(e => e.tool === 'fs_delete' && e.input._protection_override === true)
    expect(overrideCall).toBeDefined()
  })

  it('denied rm surfaces the rejection with feedback and does not delete', async () => {
    const { shell, fakeWorkspace, executed } = makeShell({
      onProtectionBlocked: async () => ({ approved: false, feedback: 'keep that file' }),
    })
    const result = await shell.execute({ command: 'rm notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).not.toBe(0)
    expect(parsed.stderr).toContain('rejected')
    expect(parsed.stderr).toContain('keep that file')
    expect(executed.some(e => e.tool === 'fs_delete' && e.input._protection_override === true)).toBe(false)
  })

  it('no handler → plain denial (fail closed, no hang)', async () => {
    const { shell, fakeWorkspace } = makeShell({})
    const result = await shell.execute({ command: 'rm notes.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).not.toBe(0)
    expect(parsed.stderr).toContain('protected')
  })

  it('output redirect to a read-only file triggers the override prompt', async () => {
    const prompts: string[] = []
    const { shell, fakeWorkspace, executed } = makeShell({
      fileProtection: 'read_only',
      onProtectionBlocked: async (toolName) => {
        prompts.push(toolName)
        return { approved: true }
      },
    })
    const result = await shell.execute({ command: 'echo hi > locked.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(prompts).toContain('fs_write')
    expect(parsed.exit_code).toBe(0)
    expect(executed.some(e => e.tool === 'fs_write' && e.input._protection_override === true)).toBe(true)
  })

  it('mv of a protected file consults the gate directly (approve proceeds)', async () => {
    const prompts: Array<{ tool: string; target: string }> = []
    const { shell, fakeWorkspace } = makeShell({
      onProtectionBlocked: async (toolName, _input, protection) => {
        prompts.push({ tool: toolName, target: protection.target })
        return { approved: true }
      },
    })
    const result = await shell.execute({ command: 'mv notes.txt archive.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(prompts).toEqual([{ tool: 'fs_delete', target: 'notes.txt' }])
    expect(parsed.exit_code).toBe(0)
  })

  it('mv denial returns exit 130 with feedback', async () => {
    const { shell, fakeWorkspace } = makeShell({
      onProtectionBlocked: async () => ({ approved: false, feedback: 'nope' }),
    })
    const result = await shell.execute({ command: 'mv notes.txt archive.txt' }, fakeWorkspace)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).toBe(130)
    expect(parsed.stderr).toContain('nope')
  })
})
