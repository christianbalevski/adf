import { describe, it, expect, vi } from 'vitest'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

/**
 * Whole-file .sh script execution: heredocs, comments, multi-line chains,
 * and bash-like continue-on-failure semantics (previously the runner was
 * line-by-line and stopped on the first nonzero exit).
 */

function makeShell(vfs: Record<string, string>) {
  const written: Record<string, string> = {}
  const fakeRegistry: any = {
    executeTool: vi.fn(async (name: string, input: any) => {
      if (name === 'fs_read') {
        const content = vfs[input.path]
        if (content === undefined) return { content: `not found: ${input.path}`, isError: true }
        return { content: JSON.stringify({ path: input.path, content }), isError: false }
      }
      if (name === 'fs_write') {
        written[input.path] = input.content
        return { content: 'ok', isError: false }
      }
      return { content: '{}', isError: false }
    }),
    get: () => undefined,
  }
  const fakeWorkspace: any = { insertLog: () => {}, listFiles: () => [] }
  const config: any = {
    name: 'agent-1',
    tools: [
      { name: 'adf_shell', enabled: true },
      { name: 'fs_read', enabled: true },
      { name: 'fs_write', enabled: true },
      { name: 'sys_lambda', enabled: true },
    ],
    limits: { execution_timeout_ms: 5000 },
  }
  const shell = new ShellTool(fakeRegistry, fakeWorkspace, config, null)
  return { shell, fakeWorkspace, written }
}

async function run(shell: ShellTool, ws: any, command: string) {
  const result = await shell.execute({ command }, ws)
  return JSON.parse(result.content as string)
}

describe('.sh whole-file execution', () => {
  it('runs a multi-command script with shebang and comments', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'job.sh': '#!/bin/sh\n# say things\necho one\necho two\n',
    })
    const r = await run(shell, fakeWorkspace, './job.sh')
    expect(r.exit_code).toBe(0)
    expect(r.stdout).toContain('one')
    expect(r.stdout).toContain('two')
  })

  it('supports heredocs spanning lines', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'count.sh': 'wc -l <<EOF\nalpha\nbeta\ngamma\nEOF\n',
    })
    const r = await run(shell, fakeWorkspace, './count.sh')
    expect(r.exit_code).toBe(0)
    // Known deviation from bash: the tokenizer's heredoc body has no trailing
    // newline, so wc -l sees 2 line breaks instead of 3.
    expect(r.stdout.trim()).toBe('2')
  })

  it('bash semantics: a failing command does not stop the script', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'resilient.sh': 'cat missing.txt\necho survived\n',
    })
    const r = await run(shell, fakeWorkspace, './resilient.sh')
    expect(r.stdout).toContain('survived')
  })

  it('&& chains still short-circuit on failure', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'strict.sh': 'cat missing.txt && echo not-reached\necho after\n',
    })
    const r = await run(shell, fakeWorkspace, './strict.sh')
    expect(r.stdout).not.toContain('not-reached')
    expect(r.stdout).toContain('after')
  })

  it('piped stdin reaches the script pipeline', async () => {
    const { shell, fakeWorkspace } = makeShell({
      'lines.sh': 'wc -l\n',
    })
    const r = await run(shell, fakeWorkspace, 'printf "a\\nb\\n" | ./lines.sh')
    expect(r.exit_code).toBe(0)
    expect(r.stdout.trim()).toBe('2')
  })

  it('redirects inside scripts write to the VFS', async () => {
    const { shell, fakeWorkspace, written } = makeShell({
      'save.sh': 'echo hello > out.txt\n',
    })
    const r = await run(shell, fakeWorkspace, './save.sh')
    expect(r.exit_code).toBe(0)
    expect(written['out.txt']).toContain('hello')
  })
})
