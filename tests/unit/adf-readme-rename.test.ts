import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'

describe('README.md canonical rename', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function newAdf(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'adf-readme-'))
    dirs.push(dir)
    const adfPath = join(dir, `${name}.adf`)
    return adfPath
  }

  it('creates a new agent with a no_delete README.md and no document.md', () => {
    const adfPath = newAdf('fresh')
    const db = AdfDatabase.create(adfPath, { name: 'fresh' })
    try {
      const paths = db.listFiles().map((f) => f.path)
      expect(paths).toContain('README.md')
      expect(paths).not.toContain('document.md')

      const readme = db.readFile('README.md')
      expect(readme?.protection).toBe('no_delete')

      // The canonical document accessor resolves to README.md
      expect(db.getDocument()?.path).toBe('README.md')
    } finally {
      db.close()
    }
  })

  it('migrates a legacy v21 document.md → README.md on open', () => {
    const adfPath = newAdf('legacy')
    const seed = AdfDatabase.create(adfPath, { name: 'legacy' })
    seed.close()

    // Recreate the legacy on-disk state: a v21 file whose canonical file is
    // document.md (not README.md), plus a watch glob pointed at document.*
    const raw = new Database(adfPath)
    raw.prepare("UPDATE adf_files SET path = 'document.md' WHERE path = 'README.md'").run()
    const cfgRow = raw.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    const cfg = JSON.parse(cfgRow.config_json)
    cfg.triggers = cfg.triggers ?? {}
    cfg.triggers.on_file_change = { enabled: true, targets: [{ scope: 'agent', filter: { watch: 'document.*' } }] }
    raw.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(cfg))
    raw.prepare("UPDATE adf_meta SET value = '21' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      const paths = db.listFiles().map((f) => f.path)
      expect(paths).toContain('README.md')
      expect(paths).not.toContain('document.md')
      expect(db.getDocument()?.path).toBe('README.md')
      expect(db.getMeta('adf_schema_version')).toBe('23')

      // The stored watch glob was repointed document.* → README.*
      const target = db.getConfig().triggers?.on_file_change?.targets?.[0]
      expect(target?.filter?.watch).toBe('README.*')
    } finally {
      db.close()
    }
  })

  it('does not clobber an existing README.md if a stray document.md is also present', () => {
    const adfPath = newAdf('both')
    const seed = AdfDatabase.create(adfPath, { name: 'both' })
    seed.close()

    const raw = new Database(adfPath)
    // README.md stays; add an unrelated stray document.md, downgrade to v21
    raw.prepare(
      "INSERT INTO adf_files (path, content, mime_type, size, protection, authorized, created_at, updated_at) " +
      "VALUES ('document.md', ?, 'text/markdown', 5, 'none', 1, '2020-01-01', '2020-01-01')"
    ).run(Buffer.from('stray'))
    raw.prepare("UPDATE adf_meta SET value = '21' WHERE key = 'adf_schema_version'").run()
    raw.close()

    const db = AdfDatabase.open(adfPath)
    try {
      const paths = db.listFiles().map((f) => f.path)
      expect(paths).toContain('README.md')
      // The stray document.md is left untouched (not renamed, not deleted)
      expect(paths).toContain('document.md')
      // Canonical accessor still prefers README.md
      expect(db.getDocument()?.path).toBe('README.md')
    } finally {
      db.close()
    }
  })
})
