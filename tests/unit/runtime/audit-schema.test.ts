import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AdfDatabase } from '../../../src/main/adf/adf-database'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync, existsSync } from 'fs'

describe('adf_audit table schema', () => {
  let db: AdfDatabase
  const testFile = join(tmpdir(), `adf-audit-schema-test-${Date.now()}.adf`)

  beforeAll(() => {
    db = AdfDatabase.create(testFile, { name: 'audit-schema-test' })
  })

  afterAll(() => {
    db?.close()
    for (const suffix of ['', '-shm', '-wal']) {
      const p = testFile + suffix
      if (existsSync(p)) unlinkSync(p)
    }
  })

  it('adf_audit table exists', () => {
    const row = (db as any).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adf_audit'")
      .get() as { name: string } | undefined

    expect(row).toBeDefined()
    expect(row!.name).toBe('adf_audit')
  })

  it('adf_archive table does NOT exist (migration complete)', () => {
    const row = (db as any).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adf_archive'")
      .get()

    expect(row).toBeUndefined()
  })

  it('has all required columns: id, source, start_seq, end_seq, ref, entry_count, size_bytes, data, created_at', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('adf_audit')")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>

    const columnNames = columns.map((c) => c.name)

    const required = [
      'id',
      'source',
      'start_seq',
      'end_seq',
      'ref',
      'entry_count',
      'size_bytes',
      'data',
      'created_at'
    ]

    for (const col of required) {
      expect(columnNames, `missing column: ${col}`).toContain(col)
    }

    expect(columnNames).toHaveLength(required.length)
  })

  it('seq-range columns are nullable and (source, start_seq) is indexed', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('adf_audit')")
      .all() as Array<{ name: string; notnull: number }>
    for (const name of ['start_seq', 'end_seq', 'ref']) {
      const col = columns.find((c: any) => c.name === name)
      expect(col, `missing column: ${name}`).toBeDefined()
      expect(col!.notnull, `${name} must be nullable`).toBe(0)
    }

    const indexes = (db as any).db
      .prepare("PRAGMA index_list('adf_audit')")
      .all() as Array<{ name: string }>
    expect(indexes.map(i => i.name)).toContain('idx_adf_audit_source_start')
  })

  it('adf_loop has the nullable ord position-override column', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('adf_loop')")
      .all() as Array<{ name: string; notnull: number }>
    const ord = columns.find(c => c.name === 'ord')
    expect(ord).toBeDefined()
    expect(ord!.notnull).toBe(0)
  })

  it('data column is BLOB type (for brotli compression)', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('adf_audit')")
      .all() as Array<{ name: string; type: string }>

    const dataCol = columns.find((c) => c.name === 'data')
    expect(dataCol).toBeDefined()
    expect(dataCol!.type.toUpperCase()).toBe('BLOB')
  })
})
