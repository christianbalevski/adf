import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { AdfDatabase, SCHEMA_SQL, ADF_LATEST_SCHEMA_VERSION } from '../../src/main/adf/adf-database'
import { AGENT_DEFAULTS, DEFAULT_TOOLS } from '../../src/shared/types/adf-v02.types'

const SPEC_PATH = join(__dirname, '../../ADF_SPEC_v0.2.md')
const TOOLS_DIR = join(__dirname, '../../src/main/tools')

// Body of the section whose heading starts with `heading`, up to the next
// heading of the same or higher level.
function sectionBody(md: string, heading: string): string {
  const start = md.indexOf(heading)
  expect(start, `spec is missing the "${heading}" heading`).toBeGreaterThan(-1)
  const level = heading.match(/^#+/)![0].length
  const rest = md.slice(start + heading.length)
  const next = rest.search(new RegExp(`\\n#{1,${level}} `))
  return next === -1 ? rest : rest.slice(0, next)
}

// Data rows of every markdown table in `body`, as arrays of trimmed cells.
function tableRows(body: string): string[][] {
  return body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()))
}

const unquote = (cell: string): string => cell.replace(/^`|`$/g, '')

// Every `readonly name = '<tool>'` declared under src/main/tools.
function registeredToolNames(dir: string): string[] {
  const names = new Set<string>()
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      for (const n of registeredToolNames(p)) names.add(n)
    } else if (p.endsWith('.ts')) {
      for (const m of readFileSync(p, 'utf-8').matchAll(/readonly name = '([a-z_]+)'/g)) names.add(m[1])
    }
  }
  return [...names].sort()
}

// Pull the fenced ```sql block out of "### 3.2 Protected Schema" (the canonical
// DDL the spec publishes), stopping before the next subsection.
function extractProtectedSchemaSql(md: string): string {
  const start = md.indexOf('### 3.2 Protected Schema')
  expect(start, 'spec is missing the "### 3.2 Protected Schema" heading').toBeGreaterThan(-1)
  const end = md.indexOf('### 3.3', start)
  const section = md.slice(start, end === -1 ? undefined : end)
  const block = section.match(/```sql\r?\n([\s\S]*?)```/)
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

  it('every schema version the spec states equals ADF_LATEST_SCHEMA_VERSION', () => {
    const md = readFileSync(SPEC_PATH, 'utf-8')
    const stated = [
      ...md.matchAll(/schema version is \**(\d+)/gi),
      ...md.matchAll(/\| `adf_schema_version` \| `(\d+)` \|/g)
    ].map((m) => Number(m[1]))
    expect(stated.length, 'spec states the schema version in §3.2, §3.5 and §17').toBeGreaterThanOrEqual(3)
    for (const v of stated) expect(v).toBe(ADF_LATEST_SCHEMA_VERSION)

    // §17.1 lists the latest revision first.
    const first = tableRows(sectionBody(md, '### 17.1'))[1]
    expect(Number(first[0])).toBe(ADF_LATEST_SCHEMA_VERSION)
  })

  it('§14.3 default tools match DEFAULT_TOOLS', () => {
    const rows = tableRows(sectionBody(readFileSync(SPEC_PATH, 'utf-8'), '### 14.3')).slice(1)
    const spec = rows.map(([name, enabled, visible, restricted]) => ({
      name: unquote(name),
      enabled: enabled === 'yes',
      visible: visible === 'yes',
      restricted: restricted === 'yes'
    }))
    const code = DEFAULT_TOOLS.map((t) => ({
      name: t.name,
      enabled: t.enabled,
      visible: t.visible,
      restricted: t.restricted === true
    }))
    expect(spec).toEqual(code)
  })

  it('§14.2 default triggers match AGENT_DEFAULTS.triggers', () => {
    const rows = tableRows(sectionBody(readFileSync(SPEC_PATH, 'utf-8'), '### 14.2')).slice(1)
    const spec = Object.fromEntries(
      rows.map(([trigger, enabled, targets]) => [
        unquote(trigger),
        { enabled: enabled === 'yes', targets: JSON.parse(unquote(targets)) }
      ])
    )
    expect(spec).toEqual(AGENT_DEFAULTS.triggers)
  })

  it('§10 tool catalog names equal the built-in tool names', () => {
    const body = sectionBody(readFileSync(SPEC_PATH, 'utf-8'), '## 10.')
    const catalog = body.slice(0, body.indexOf('### 10.9'))
    const names = new Set<string>()
    for (const [first] of tableRows(catalog)) {
      const m = first.match(/^`([a-z_]+)`$/)
      if (m) names.add(m[1])
    }
    expect([...names].sort()).toEqual(registeredToolNames(TOOLS_DIR))
  })
})
