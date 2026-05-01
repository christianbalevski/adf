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

  it('has all required columns: id, source, start_at, end_at, entry_count, size_bytes, data, created_at', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('adf_audit')")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>

    const columnNames = columns.map((c) => c.name)

    const required = [
      'id',
      'source',
      'start_at',
      'end_at',
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

  it('data column is BLOB type (for brotli compression)', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('adf_audit')")
      .all() as Array<{ name: string; type: string }>

    const dataCol = columns.find((c) => c.name === 'data')
    expect(dataCol).toBeDefined()
    expect(dataCol!.type.toUpperCase()).toBe('BLOB')
  })
})
