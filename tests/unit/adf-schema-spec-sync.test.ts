import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, SCHEMA_SQL } from '../../src/main/adf/adf-database'

const SPEC_PATH = join(__dirname, '../../ADF_SPEC_v0.2.md')

// Pull the fenced ```sql block out of "### 3.2 Protected Schema" (the canonical
// DDL the spec publishes), stopping before the next subsection.
function extractProtectedSchemaSql(md: string): string {
  const start = md.indexOf('### 3.2 Protected Schema')
  expect(start, 'spec is missing the "### 3.2 Protected Schema" heading').toBeGreaterThan(-1)
  const end = md.indexOf('### 3.3', start)
  const section = md.slice(start, end === -1 ? undefined : end)
  const block = section.match(/```sql\n([\s\S]*?)```/)
  expect(block, 'spec §3.2 is missing a ```sql DDL block').toBeTruthy()
  return block![1]
}

// Normalize a DDL blob into a sorted array of canonical statements so the
// comparison is insensitive to comments, `IF NOT EXISTS`, and whitespace/layout.
function normalizeStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) =>
      s
        .replace(/IF NOT EXISTS/gi, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim()
    )
    .filter((s) => s.length > 0 && /adf_/.test(s))
    .sort()
}

// Names of adf_ tables and explicit indexes declared in a DDL blob.
function declaredObjectNames(sql: string): string[] {
  const names = new Set<string>()
  const re = /CREATE\s+(?:TABLE|INDEX)\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w]*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    if (/^(adf_|idx_adf_)/.test(m[1])) names.add(m[1])
  }
  return [...names].sort()
}

describe('ADF spec ↔ schema sync', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("spec §3.2 DDL matches the code's SCHEMA_SQL exactly", () => {
    const specStatements = normalizeStatements(extractProtectedSchemaSql(readFileSync(SPEC_PATH, 'utf-8')))
    const codeStatements = normalizeStatements(SCHEMA_SQL)

    // Equal as sets of normalized statements — any column/constraint/index drift fails here.
    expect(specStatements).toEqual(codeStatements)
    expect(specStatements.length).toBeGreaterThan(10) // sanity: all 11 tables + indexes present
  })

  it('SCHEMA_SQL produces exactly the adf_ tables and indexes it declares', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-schema-sync-'))
    dirs.push(dir)
    const adfPath = join(dir, 'schema.adf')
    const db = AdfDatabase.create(adfPath, { name: 'schema' })
    db.close()

    const raw = new Database(adfPath, { readonly: true })
    try {
      const live = (
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE (name LIKE 'adf_%' OR name LIKE 'idx_adf_%') AND sql IS NOT NULL"
          )
          .all() as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort()

      expect(live).toEqual(declaredObjectNames(SCHEMA_SQL))
    } finally {
      raw.close()
    }
  })
})
