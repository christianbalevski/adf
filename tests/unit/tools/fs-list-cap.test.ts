import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { FsListTool } from '../../../src/main/tools/built-in/fs-list.tool'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

/**
 * fs_list used to serialize EVERY file in the ADF into the model's context.
 * It now caps like db_query — visibly, with a `_full: true` escape hatch for
 * code execution and internal callers (shell `ls`) that need every row.
 */

function workspaceWith(n: number, prefix = 'data/'): AdfWorkspace {
  const files = Array.from({ length: n }, (_, i) => ({
    path: `${prefix}f${i}.txt`, size: 10, mime_type: 'text/plain',
    protection: null, created_at: 1, updated_at: 1
  }))
  return {
    listFilePage: (prefix: string | undefined, limit: number | undefined) => {
      const matches = prefix ? files.filter((file) => file.path.startsWith(prefix)) : files
      return { files: matches.slice(0, limit), total: matches.length }
    }
  } as unknown as AdfWorkspace
}

async function getLsHandler() {
  const { filesystemHandlers } = await import('../../../src/main/tools/shell/commands/filesystem')
  return filesystemHandlers.find(h => h.name === 'ls')!
}

describe('fs_list truncation', () => {
  it('returns every row untruncated below the cap', async () => {
    const r = await new FsListTool().execute({}, workspaceWith(500))
    expect(r.isError).toBe(false)
    expect(r.content).not.toContain('TRUNCATED')
    expect(JSON.parse(r.content)).toHaveLength(500)
  })

  it('truncates above the cap with a visible notice', async () => {
    const r = await new FsListTool().execute({}, workspaceWith(750))
    expect(r.isError).toBe(false)
    expect(r.content).toContain('--- TRUNCATED at 500 files (750 match) ---')
    expect(r.content).toContain('_full: true')
    const rows = JSON.parse(r.content.split('\n')[0])
    expect(rows).toHaveLength(500)
  })

  it('_full returns the whole listing as one JSON array', async () => {
    const r = await new FsListTool().execute({ _full: true }, workspaceWith(750))
    expect(r.content).not.toContain('TRUNCATED')
    expect(JSON.parse(r.content)).toHaveLength(750)
  })

  it('counts only files matching the prefix', async () => {
    const r = await new FsListTool().execute({ prefix: 'other/' }, workspaceWith(750))
    expect(JSON.parse(r.content)).toHaveLength(0)
  })

  it('preserves literal prefix matching, insertion order, and exact counts on SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-list-files-'))
    const ws = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'list-files' })
    try {
      const paths = Array.from({ length: 530 }, (_, i) => `data/_%[${530 - i}]`)
      const specialPaths = [
        'data/_%[', 'DATA/_%[0]', 'data/XX[0]', 'data/_%x[0]',
        'emoji/😀', 'emoji/😁', 'emoji/𝄞', 'path\0with-nul', 'path-after',
        '\uD7FFitem', '\uE000item', '\u{10FFFF}end', 'x\u{10FFFF}end',
      ]
      const db = ws.getDatabase()
      db.transaction(() => {
        for (const path of [...paths, ...specialPaths]) db.writeFile(path, Buffer.from('x'))
      })
      const effectiveListing = ws.listFiles()
      const tool = new FsListTool()
      for (const prefix of ['data/_%[', 'emoji/\uD83D', 'emoji/😀', 'path\0', '\uD7FF', '\u{10FFFF}', 'x\u{10FFFF}', 'absent']) {
        const expected = effectiveListing.filter((file) => file.path.startsWith(prefix)).map((file) => file.path)
        const full = await tool.execute({ prefix, _full: true }, ws)
        expect(JSON.parse(full.content).map((file: { path: string }) => file.path)).toEqual(expected)
        const capped = await tool.execute({ prefix }, ws)
        expect(JSON.parse(capped.content.split('\n')[0]).map((file: { path: string }) => file.path)).toEqual(expected.slice(0, 500))
        if (expected.length > 500) expect(capped.content).toContain(`--- TRUNCATED at 500 files (${expected.length} match prefix "${prefix}") ---`)
        else expect(capped.content).not.toContain('TRUNCATED')
      }
      const capped = await tool.execute({}, ws)
      expect(JSON.parse(capped.content.split('\n')[0]).map((file: { path: string }) => file.path)).toEqual(effectiveListing.slice(0, 500).map((file) => file.path))
      expect(capped.content).toContain(`--- TRUNCATED at 500 files (${effectiveListing.length} match) ---`)
    } finally {
      ws.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shell ls cap', () => {
  /** ls dispatches to the real tool so the _full hand-off is exercised. */
  function ctxFor(workspace: AdfWorkspace, args: string[] = []) {
    const tool = new FsListTool()
    return {
      stdin: '', args, flags: {}, rawArgs: args, config: {}, env: {},
      workspace,
      toolRegistry: {
        executeTool: vi.fn((name: string, input: any, ws: AdfWorkspace) =>
          name === 'fs_list' ? tool.execute(input, ws) : Promise.resolve({ content: '{}', isError: false })
        )
      },
    } as any
  }

  it('keeps stdout one parseable JSON array past the fs_list cap', async () => {
    const ls = await getLsHandler()
    const r = await ls.execute(ctxFor(workspaceWith(750)))
    expect(r.exit_code).toBe(0)
    const rows = JSON.parse(r.stdout)
    expect(rows).toHaveLength(500)
    expect(r.stderr).toContain('showing first 500 of 750 files')
  })

  it('does not truncate or warn below the cap', async () => {
    const ls = await getLsHandler()
    const r = await ls.execute(ctxFor(workspaceWith(12)))
    expect(JSON.parse(r.stdout)).toHaveLength(12)
    expect(r.stderr).toBe('')
  })

  it('still reports a prefix that matches nothing', async () => {
    const ls = await getLsHandler()
    const r = await ls.execute(ctxFor(workspaceWith(3), ['nope/']))
    expect(r.exit_code).toBe(2)
    expect(r.stderr).toContain('No such file or directory')
    expect(JSON.parse(r.stdout)).toEqual([])
  })
})
