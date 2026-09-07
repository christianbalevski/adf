import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { CreateAdfTool } from '../../../src/main/tools/built-in/sys-create-adf.tool'

/** Regression at the caller boundary: sys_create_adf must not clobber a child. */
describe('sys_create_adf collision handling', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('returns an error while preserving the existing child and sidecars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-tool-collision-'))
    dirs.push(dir)
    const parentPath = join(dir, 'parent.adf')
    const childPath = join(dir, 'child-agent.adf')
    const parent = AdfWorkspace.create(parentPath, { name: 'parent-agent' })
    const child = AdfDatabase.create(childPath, { name: 'original-child' })
    child.close()

    const original = readFileSync(childPath)
    const wal = Buffer.from('original-child-wal')
    const shm = Buffer.from('original-child-shm')
    writeFileSync(`${childPath}-wal`, wal)
    writeFileSync(`${childPath}-shm`, shm)

    try {
      const result = await new CreateAdfTool().execute({ name: 'child-agent' }, parent)

      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/Failed to create agent/)
      expect(readFileSync(childPath)).toEqual(original)
      expect(readFileSync(`${childPath}-wal`)).toEqual(wal)
      expect(readFileSync(`${childPath}-shm`)).toEqual(shm)
      expect(existsSync(join(dir, '.child-agent.adf.create-'))).toBe(false)
      const nonParentEntries = readdirSync(dir).filter((entry) => !entry.startsWith('parent.adf')).sort()
      expect(nonParentEntries).toEqual([
        'child-agent.adf',
        'child-agent.adf-shm',
        'child-agent.adf-wal',
      ])
    } finally {
      parent.close()
    }
  }, 30_000)
})
