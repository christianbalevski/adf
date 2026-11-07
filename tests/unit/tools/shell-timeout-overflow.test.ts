/**
 * limits.execution_timeout_ms has no upper bound; a value past Node's timer
 * range used to fire the shell's abort timer after 1 ms. It is clamped.
 */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

it('a shell limit beyond Node\'s timer range does not time the command out immediately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adf-shell-overflow-'))
  dirs.push(dir)
  const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'agent', autonomous: false })
  const config = workspace.getAgentConfig()
  config.limits = { ...config.limits, execution_timeout_ms: 3_000_000_000 }
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  try {
    const result = await new ShellTool(registry, workspace, () => config).execute({ command: 'sleep 0.2 && echo ok' }, workspace)
    expect(JSON.parse(result.content)).toMatchObject({ exit_code: 0, stdout: 'ok\n' })
  } finally {
    workspace.close()
  }
})
