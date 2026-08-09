/**
 * End-to-end protection ENFORCEMENT through the full ShellTool (parse →
 * executor → protection-gated registry → real fs tools → real DB). Anchors
 * the invariant that a protected file cannot be deleted/overwritten from the
 * shell without a HIL override: the handler-level tests in
 * shell-protection-ux.test.ts bypass the executor, so this closes that gap.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { FsDeleteTool } from '../../../src/main/tools/built-in/fs-delete.tool'
import { FsWriteTool } from '../../../src/main/tools/built-in/fs-write.tool'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function realWorkspace(): AdfWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'adf-enforce-'))
  dirs.push(dir)
  const adfPath = join(dir, 'agent.adf')
  const db = AdfDatabase.create(adfPath, { name: 'enforce' })
  return new AdfWorkspace(db, adfPath)
}

function enabledConfig() {
  return {
    name: 'agent-1',
    tools: [
      { name: 'fs_delete', enabled: true, visible: true, restricted: false },
      { name: 'fs_write', enabled: true, visible: true, restricted: false },
      { name: 'fs_read', enabled: true, visible: true, restricted: false },
      { name: 'fs_list', enabled: true, visible: true, restricted: false },
    ],
    limits: { execution_timeout_ms: 5000 },
  } as any
}

function makeShell(ws: AdfWorkspace) {
  const registry = new ToolRegistry()
  registry.register(new FsDeleteTool())
  registry.register(new FsWriteTool())
  const cfg = enabledConfig()
  const shell = new ShellTool(registry, ws, () => cfg, null as any)
  const prompts: Array<{ tool: string; level: string; target: string }> = []
  shell.onProtectionBlocked = async (toolName, _input, protection) => {
    prompts.push({ tool: toolName, level: (protection as any).level, target: (protection as any).target })
    return { approved: false } // DENY so enforcement means the op does NOT happen
  }
  return { shell, ws, prompts }
}

async function run(shell: ShellTool, ws: AdfWorkspace, command: string) {
  return JSON.parse((await shell.execute({ command }, ws)).content as string)
}

describe('PROBE: protection enforcement through full ShellTool', () => {
  it('rm on a no_delete file prompts HIL and (denied) does NOT delete', async () => {
    const { shell, ws, prompts } = makeShell(realWorkspace())
    ws.writeFile('tmp/x.txt', 'secret')
    ws.setFileProtection('tmp/x.txt', 'no_delete')
    const r = await run(shell, ws, 'rm tmp/x.txt')
    expect(prompts, `prompts=${JSON.stringify(prompts)} result=${JSON.stringify(r)}`).toHaveLength(1)
    expect(ws.getFileProtection('tmp/x.txt')).toBe('no_delete')
    expect(ws.readFile('tmp/x.txt')).toBe('secret')
  })

  it('adf fs_delete on a no_delete file prompts HIL and (denied) does NOT delete', async () => {
    const { shell, ws, prompts } = makeShell(realWorkspace())
    ws.writeFile('tmp/x.txt', 'secret')
    ws.setFileProtection('tmp/x.txt', 'no_delete')
    const r = await run(shell, ws, `adf fs_delete '{"path":"tmp/x.txt"}'`)
    expect(prompts, `prompts=${JSON.stringify(prompts)} result=${JSON.stringify(r)}`).toHaveLength(1)
    expect(ws.readFile('tmp/x.txt')).toBe('secret')
  })

  it('echo > read_only file prompts HIL and (denied) does NOT overwrite', async () => {
    const { shell, ws, prompts } = makeShell(realWorkspace())
    ws.writeFile('tmp/r.txt', 'original')
    ws.setFileProtection('tmp/r.txt', 'read_only')
    const r = await run(shell, ws, 'echo pwned > tmp/r.txt')
    expect(prompts, `prompts=${JSON.stringify(prompts)} result=${JSON.stringify(r)}`).toHaveLength(1)
    expect(ws.readFile('tmp/r.txt')).toBe('original')
  })
})
