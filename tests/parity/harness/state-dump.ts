import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import Database from 'better-sqlite3'
import type { ParityEnv } from './env'

/**
 * What a run left on disk, read after the backend shut down:
 * - every fixture `.adf` as a canonical table dump,
 * - every top-level JSON file in user data (the settings files),
 * - the listing of the whole run root.
 *
 * Read-only: `.adf` files are opened with `readonly: true`, after the
 * backend closed them.
 */
export interface PersistedState {
  adf: Record<string, AdfDump>
  userDataJson: Record<string, unknown>
  tree: string[]
}

export interface AdfDump {
  tables: Record<string, { columns: string[]; rows: unknown[] }>
}

/**
 * Binary cells: a brotli-compressed JSON blob (how the runtime stores loop
 * content) is decoded; anything else becomes `<bytes len=N sha256=…>` with
 * the real hash, so equal bytes compare equal and different bytes do not.
 */
function cell(value: unknown): unknown {
  if (!Buffer.isBuffer(value)) return value
  try {
    return { brotliJson: JSON.parse(brotliDecompressSync(value).toString('utf-8')) }
  } catch { /* not brotli JSON */ }
  return `<bytes len=${value.length} sha256=${createHash('sha256').update(value).digest('hex').slice(0, 16)}>`
}

export function dumpAdf(filePath: string): AdfDump {
  const db = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const tables = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string; sql: string }[]
    const out: AdfDump['tables'] = {}
    for (const { name, sql } of tables) {
      const quoted = `"${name.replace(/"/g, '""')}"`
      const columns = (db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[]).map((c) => c.name)
      // Virtual tables (vec0) have no stable row order or readable shadow content.
      if (/^CREATE VIRTUAL TABLE/i.test(sql)) {
        out[name] = { columns, rows: ['<virtual table>'] }
        continue
      }
      const withoutRowid = /WITHOUT ROWID\s*$/i.test(sql.trim())
      const order = withoutRowid ? columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ') : 'rowid'
      const rows = (db.prepare(`SELECT * FROM ${quoted} ORDER BY ${order}`).all() as Record<string, unknown>[])
        .map((row) => Object.fromEntries(columns.map((c) => [c, cell(row[c])])))
      out[name] = { columns, rows }
    }
    return { tables: out }
  } finally {
    db.close()
  }
}

/**
 * Relative path and type of everything under `root`. No sizes: settings
 * embed the run path, whose length differs per OS; contents are dumped instead.
 */
export function listTree(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const rel = relative(root, p).split(sep).join('/')
      if (skip(rel)) continue
      const s = lstatSync(p)
      if (s.isSymbolicLink()) out.push(`l ${rel}`)
      else if (s.isDirectory()) { out.push(`d ${rel}/`); walk(p) }
      else out.push(`f ${rel}`)
    }
  }
  walk(root)
  return out
}

export function dumpPersistedState(env: ParityEnv, adfFiles: readonly string[]): PersistedState {
  // Listed first: opening a WAL database, even read-only, creates -wal/-shm beside it.
  // The fence log is the harness's own file, checked separately.
  const tree = listTree(env.root, (rel) => rel === 'violations.log')
  const adf: PersistedState['adf'] = {}
  for (const file of adfFiles) adf[relative(env.root, file).split(sep).join('/')] = dumpAdf(file)
  const userDataJson: Record<string, unknown> = {}
  for (const name of readdirSync(env.userDataDir).sort()) {
    if (!name.endsWith('.json')) continue
    try { userDataJson[name] = JSON.parse(readFileSync(join(env.userDataDir, name), 'utf-8')) }
    catch (err) { userDataJson[name] = `<unparsable: ${(err as Error).message}>` }
  }
  return { adf, userDataJson, tree }
}
