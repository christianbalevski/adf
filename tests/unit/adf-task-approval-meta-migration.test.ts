import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'

let rootDir: string

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'adf-task-approval-meta-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('adf_tasks.approval_meta (v26 → v27)', () => {
  it('adds the approval_meta column when migrating a pre-v27 file', () => {
    const adfPath = join(rootDir, 'legacy.adf')
    AdfDatabase.create(adfPath, { name: 'legacy' }).close()

    // Recreate a pre-v27 file: drop the column and set the recorded version.
    const raw = new Database(adfPath)
    raw.exec('CREATE TABLE adf_tasks_old AS SELECT id, tool, args, status, result, error, created_at, completed_at, origin, requires_authorization, executor_managed FROM adf_tasks')
    raw.exec('DROP TABLE adf_tasks')
    raw.exec('ALTER TABLE adf_tasks_old RENAME TO adf_tasks')
    raw.prepare("UPDATE adf_meta SET value = '26' WHERE key = 'adf_schema_version'").run()
    raw.close()

    // Sanity: the column is gone pre-migration.
    const pre = new Database(adfPath)
    const preCols = (pre.prepare('PRAGMA table_info(adf_tasks)').all() as Array<{ name: string }>).map(c => c.name)
    expect(preCols).not.toContain('approval_meta')
    pre.close()

    const db = AdfDatabase.open(adfPath)
    try {
      expect(db.getMeta('adf_schema_version')).toBe(String(ADF_LATEST_SCHEMA_VERSION))
      const cols = (db as unknown as { db: InstanceType<typeof Database> }).db
        .prepare('PRAGMA table_info(adf_tasks)').all() as Array<{ name: string }>
      expect(cols.map(c => c.name)).toContain('approval_meta')
    } finally {
      db.close()
    }
  })

  it('round-trips approval metadata (reason + protection + description) on a task row', () => {
    const adfPath = join(rootDir, 'fresh.adf')
    const db = AdfDatabase.create(adfPath, { name: 'fresh' })
    try {
      const meta = JSON.stringify({
        reason: 'protection',
        protection: { kind: 'file_protection', target: 'notes.md', level: 'no_delete', description: 'Delete "notes.md" — file is protected (no_delete)' },
      })
      db.insertTask('task_1', 'fs_delete', '{"path":"notes.md"}', 'hil:agent:1', true, true, meta)
      db.updateTaskStatus('task_1', 'pending_approval')

      const task = db.getTask('task_1')
      expect(task).not.toBeNull()
      expect(task!.approval_meta).toEqual({
        reason: 'protection',
        protection: { kind: 'file_protection', target: 'notes.md', level: 'no_delete', description: 'Delete "notes.md" — file is protected (no_delete)' },
      })
      // Present on the listing paths too (tasks panel / on_task_create reads).
      const pending = db.getTasksByStatus('pending_approval')
      expect(pending[0].approval_meta?.protection?.description).toContain('notes.md')
    } finally {
      db.close()
    }
  })

  it('leaves approval_meta undefined for a plain task and tolerates malformed JSON', () => {
    const adfPath = join(rootDir, 'plain.adf')
    const db = AdfDatabase.create(adfPath, { name: 'plain' })
    try {
      db.insertTask('task_plain', 'fs_read', '{"path":"x"}', 'lambda')
      expect(db.getTask('task_plain')!.approval_meta).toBeUndefined()

      // Malformed JSON in the column must not throw — it degrades to undefined.
      ;(db as unknown as { db: InstanceType<typeof Database> }).db
        .prepare("UPDATE adf_tasks SET approval_meta = 'not json' WHERE id = 'task_plain'").run()
      expect(db.getTask('task_plain')!.approval_meta).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
