/**
 * File-protection UX in the shell — chmod levels, honest rm errors, and the
 * HIL unprotect path. Runs against a REAL AdfDatabase/AdfWorkspace so the
 * DB's CHECK constraint and its guarded DELETE (protection = 'none') are
 * actually exercised — the two live bugs this pins:
 *  - chmod wrote legacy 'protected'/'normal' → SqliteError CHECK failure
 *  - an approved/authorized delete of a protected file reported
 *    "File not found" because the guarded DELETE couldn't see the row
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { FsDeleteTool } from '../../../src/main/tools/built-in/fs-delete.tool'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { ShellTool } from '../../../src/main/tools/shell/shell.tool'
import { filesystemHandlers } from '../../../src/main/tools/shell/commands/filesystem'
import type { CommandContext } from '../../../src/main/tools/shell/commands/types'

const dirs: string[] = []
const workspaces: AdfWorkspace[] = []

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    try { (ws as unknown as { close?: () => void }).close?.() } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function realWorkspace(): AdfWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'adf-protection-ux-'))
  dirs.push(dir)
  const adfPath = join(dir, 'agent.adf')
  const db = AdfDatabase.create(adfPath, { name: 'protection-ux' })
  const ws = new AdfWorkspace(db, adfPath)
  workspaces.push(ws)
  return ws
}

const chmod = filesystemHandlers.find(h => h.name === 'chmod')!

function chmodCtx(
  ws: AdfWorkspace,
  args: string[],
  extra: Partial<CommandContext> = {},
  flags: Record<string, string | boolean | string[]> = {}
): CommandContext {
  return {
    stdin: '',
    args,
    flags,
    workspace: ws,
    toolRegistry: {} as never,
    config: { name: 'agent-1', limits: {} } as never,
    env: {} as never,
    ...extra,
  } as CommandContext
}

// ── chmod writes valid levels (real DB CHECK constraint) ──

describe('chmod protection levels (real schema)', () => {
  it('+p defaults to read_only and passes the DB CHECK', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    const r = await chmod.execute(chmodCtx(ws, ['+p', 'tmp/p.txt']))
    expect(r.exit_code).toBe(0)
    expect(ws.getFileProtection('tmp/p.txt')).toBe('read_only')
  })

  it('+p=no_delete writes no_delete', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    const r = await chmod.execute(chmodCtx(ws, ['+p=no_delete', 'tmp/p.txt']))
    expect(r.exit_code).toBe(0)
    expect(ws.getFileProtection('tmp/p.txt')).toBe('no_delete')
  })

  it('-p on an unprotected file succeeds and leaves it none', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    const r = await chmod.execute(chmodCtx(ws, ['tmp/p.txt'], {}, { p: true }))
    expect(r.exit_code).toBe(0)
    expect(ws.getFileProtection('tmp/p.txt')).toBe('none')
  })

  it('help text documents the levels and the default', () => {
    expect(chmod.helpText).toContain('read_only')
    expect(chmod.helpText).toContain('no_delete')
    expect(chmod.helpText).toContain('default')
  })
})

// ── chmod -p on a protected file → HIL override ──

describe('chmod -p HIL override', () => {
  it('prompts the gate and clears protection on approval', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const prompts: Array<{ tool: string; level: string; target: string }> = []
    const r = await chmod.execute(chmodCtx(ws, ['tmp/p.txt'], {
      gate: {
        onProtectionBlocked: async (tool, _input, protection) => {
          prompts.push({ tool, level: protection.level, target: protection.target })
          return { approved: true }
        },
      },
    }, { p: true }))
    expect(prompts).toEqual([{ tool: 'fs_write', level: 'no_delete', target: 'tmp/p.txt' }])
    expect(r.exit_code).toBe(0)
    expect(ws.getFileProtection('tmp/p.txt')).toBe('none')
  })

  it('denied override refuses plainly, names the level, keeps protection', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'read_only')
    const r = await chmod.execute(chmodCtx(ws, ['tmp/p.txt'], {
      gate: { onProtectionBlocked: async () => ({ approved: false, feedback: 'keep it locked' }) },
    }, { p: true }))
    expect(r.exit_code).toBe(130)
    expect(r.stderr).toContain('protected (read_only)')
    expect(r.stderr).toContain('keep it locked')
    expect(ws.getFileProtection('tmp/p.txt')).toBe('read_only')
  })

  it('no gate → fail closed with a plain protection error (no silent clear)', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const r = await chmod.execute(chmodCtx(ws, ['tmp/p.txt'], {}, { p: true }))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('protected (no_delete)')
    expect(ws.getFileProtection('tmp/p.txt')).toBe('no_delete')
  })

  it('changing an existing protection level also requires the gate', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'read_only')
    const r = await chmod.execute(chmodCtx(ws, ['+p=no_delete', 'tmp/p.txt']))
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain('protected (read_only)')
    expect(ws.getFileProtection('tmp/p.txt')).toBe('read_only')
  })

  it('authorized scripts bypass the gate (same privilege as the UI)', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const r = await chmod.execute(chmodCtx(ws, ['tmp/p.txt'], { authorized: true }, { p: true }))
    expect(r.exit_code).toBe(0)
    expect(ws.getFileProtection('tmp/p.txt')).toBe('none')
  })
})

// ── fs_delete on a protected file (real DB) ──

describe('fs_delete on protected files (real schema)', () => {
  it('denial names the protection level — never "File not found"', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const result = await new FsDeleteTool().execute({ path: 'tmp/p.txt' }, ws)
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('not found')
    expect(result.content).toContain('protected (no_delete)')
    expect(result.protection).toEqual({ kind: 'file_protection', target: 'tmp/p.txt', level: 'no_delete' })
    expect(ws.fileExists('tmp/p.txt')).toBe(true)
  })

  it('_protection_override actually deletes the protected row (was "File not found")', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const result = await new FsDeleteTool().execute({ path: 'tmp/p.txt', _protection_override: true }, ws)
    expect(result.isError).toBe(false)
    expect(ws.fileExists('tmp/p.txt')).toBe(false)
  })

  it('_authorized deletes a read_only file too', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'read_only')
    const result = await new FsDeleteTool().execute({ path: 'tmp/p.txt', _authorized: true }, ws)
    expect(result.isError).toBe(false)
    expect(ws.fileExists('tmp/p.txt')).toBe(false)
  })

  it('a genuinely missing file still reports File not found', async () => {
    const ws = realWorkspace()
    const result = await new FsDeleteTool().execute({ path: 'tmp/nope.txt' }, ws)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('File not found')
  })
})

// ── end-to-end: shell rm / adf fs_delete over a real workspace ──

function makeShell(ws: AdfWorkspace, onProtectionBlocked?: ShellTool['onProtectionBlocked']) {
  const registry = new ToolRegistry()
  registry.register(new FsDeleteTool())
  const config = {
    name: 'agent-1',
    tools: [
      { name: 'fs_delete', enabled: true, restricted: false },
      { name: 'fs_write', enabled: true, restricted: false },
      { name: 'fs_read', enabled: true, restricted: false },
      { name: 'adf_shell', enabled: true },
    ],
    limits: { execution_timeout_ms: 5000 },
  } as never
  const shell = new ShellTool(registry, ws, config, null)
  if (onProtectionBlocked) shell.onProtectionBlocked = onProtectionBlocked
  return shell
}

describe('shell rm / adf fs_delete on protected files (end-to-end)', () => {
  it('rm surfaces the protection level (not "File not found") when no gate exists', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const shell = makeShell(ws)
    const result = await shell.execute({ command: 'rm tmp/p.txt' }, ws)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).not.toBe(0)
    expect(parsed.stderr).not.toContain('not found')
    expect(parsed.stderr).toContain('protected (no_delete)')
    expect(ws.fileExists('tmp/p.txt')).toBe(true)
  })

  it('rm deletes the protected file after HIL approval', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const prompts: string[] = []
    const shell = makeShell(ws, async (toolName) => {
      prompts.push(toolName)
      return { approved: true }
    })
    const result = await shell.execute({ command: 'rm tmp/p.txt' }, ws)
    const parsed = JSON.parse(result.content as string)
    expect(prompts).toEqual(['fs_delete'])
    expect(parsed.exit_code).toBe(0)
    expect(ws.fileExists('tmp/p.txt')).toBe(false)
  })

  it('rm denial keeps the file and reports the rejection', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')
    const shell = makeShell(ws, async () => ({ approved: false, feedback: 'keep that file' }))
    const result = await shell.execute({ command: 'rm tmp/p.txt' }, ws)
    const parsed = JSON.parse(result.content as string)
    expect(parsed.exit_code).not.toBe(0)
    expect(parsed.stderr).toContain('rejected')
    expect(parsed.stderr).toContain('keep that file')
    expect(ws.fileExists('tmp/p.txt')).toBe(true)
  })

  it('adf fs_delete gets a protection error (not not-found) and HIL where gated', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    ws.setFileProtection('tmp/p.txt', 'no_delete')

    // No gate → plain protection error, file survives.
    const plain = makeShell(ws)
    const r1 = await plain.execute({ command: `adf fs_delete '{"path":"tmp/p.txt"}'` }, ws)
    const p1 = JSON.parse(r1.content as string)
    expect(p1.exit_code).not.toBe(0)
    const out1 = `${p1.stdout}\n${p1.stderr}`
    expect(out1).not.toContain('not found')
    expect(out1).toContain('protected (no_delete)')
    expect(ws.fileExists('tmp/p.txt')).toBe(true)

    // Gate approves → deleted.
    const gated = makeShell(ws, async () => ({ approved: true }))
    const r2 = await gated.execute({ command: `adf fs_delete '{"path":"tmp/p.txt"}'` }, ws)
    const p2 = JSON.parse(r2.content as string)
    expect(p2.exit_code).toBe(0)
    expect(ws.fileExists('tmp/p.txt')).toBe(false)
  })

  it('chmod +p then rm round-trip: protect, denial, HIL-approved delete', async () => {
    const ws = realWorkspace()
    ws.writeFile('tmp/p.txt', 'x')
    const noGate = makeShell(ws)

    // chmod +p=no_delete via the shell (the exact live repro that CHECK-failed)
    const prot = await noGate.execute({ command: 'chmod +p=no_delete tmp/p.txt' }, ws)
    expect(JSON.parse(prot.content as string).exit_code).toBe(0)
    expect(ws.getFileProtection('tmp/p.txt')).toBe('no_delete')

    // rm without a gate → plain protection denial
    const denied = await noGate.execute({ command: 'rm tmp/p.txt' }, ws)
    expect(JSON.parse(denied.content as string).stderr).toContain('protected (no_delete)')

    // rm with an approving gate → gone
    const gated = makeShell(ws, async () => ({ approved: true }))
    const removed = await gated.execute({ command: 'rm tmp/p.txt' }, ws)
    expect(JSON.parse(removed.content as string).exit_code).toBe(0)
    expect(ws.fileExists('tmp/p.txt')).toBe(false)
  })
})
