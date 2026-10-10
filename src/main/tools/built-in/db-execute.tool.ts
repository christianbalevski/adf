import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { sanitizeSQL } from './sql-sanitizer'
import { emitUmbilicalEvent } from '../../runtime/emit-umbilical'

const InputSchema = z.object({
  sql: z.string().describe(
    'INSERT, UPDATE, DELETE, CREATE TABLE, CREATE VIRTUAL TABLE, or DROP TABLE on local_* tables only. ' +
    'Example: "CREATE TABLE local_notes (id INTEGER PRIMARY KEY, topic TEXT, body TEXT)", ' +
    '"INSERT INTO local_notes (topic, body) VALUES (?, ?)", ' +
    '"CREATE VIRTUAL TABLE local_embeddings USING vec0(embedding float[384])"'
  ),
  params: z.array(z.unknown()).optional().describe('Bind parameters for the statement.')
})

const IDENTIFIER = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|[a-z_][a-z0-9_]*)'

function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"')
  }
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replace(/``/g, '`')
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).replace(/\]\]/g, ']')
  }
  return trimmed
}

export function extractTableName(sql: string): string | null {
  const normalized = sql.trim().toLowerCase()
  const patterns = [
    new RegExp(String.raw`^insert\s+(?:or\s+\w+\s+)?into\s+(${IDENTIFIER})`),
    new RegExp(String.raw`^update\s+(?:or\s+\w+\s+)?(${IDENTIFIER})`),
    new RegExp(String.raw`^delete\s+from\s+(${IDENTIFIER})`),
    new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?(${IDENTIFIER})`),
    new RegExp(String.raw`^create\s+(?:virtual\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENTIFIER})`)
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match?.[1]) return normalizeIdentifier(match[1])
  }
  return null
}

/** Virtual table modules db_execute may create. Others (fts5vocab, dbstat,
 *  csv, ...) read objects outside the table being created. */
const VTAB_MODULES = new Set(['fts5', 'fts4', 'fts3', 'vec0', 'rtree'])

/** Split a module argument list on top-level commas, keeping quoted parts whole. */
function splitVtabArgs(args: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let quote: string | null = null
  for (const ch of args) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '[') quote = ']'
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Reject a CREATE VIRTUAL TABLE that would read tables other than its own.
 * An external-content FTS index reads its content table through internal
 * statements that EXPLAIN never shows, so `content='adf_identity'` (or a
 * quoted variant, which sanitizeSQL blanks) would surface the rows through
 * a local_* name. Runs on the raw SQL. Returns an error message, or the
 * content tables named so the caller can check they aren't views.
 */
export function checkVirtualTable(sql: string): { error: string } | { contentTables: string[] } {
  const contentTables: string[] = []
  const m = sql.match(/^\s*create\s+virtual\s+table\s+[\s\S]*?\busing\s+([a-z0-9_]+)\s*(?:\(([\s\S]*)\))?\s*;?\s*$/i)
  if (!m) return { error: 'Could not parse CREATE VIRTUAL TABLE.' }
  const module = m[1].toLowerCase()
  if (!VTAB_MODULES.has(module)) {
    return { error: `Virtual table module "${module}" is not allowed. Supported: ${[...VTAB_MODULES].join(', ')}.` }
  }
  for (const arg of splitVtabArgs(m[2] ?? '')) {
    const opt = arg.match(/^\s*content\s*=\s*([\s\S]*?)\s*$/i)
    if (!opt) continue
    const target = normalizeIdentifier(opt[1].replace(/^'([\s\S]*)'$/, '"$1"')).toLowerCase()
    if (target === '') continue
    if (!target.startsWith('local_')) return { error: `content= must name a local_* table (got "${target}").` }
    contentTables.push(target)
  }
  return { contentTables }
}

export class DbExecuteTool implements Tool {
  readonly name = 'db_execute'
  readonly description =
    'Execute a write SQL statement (INSERT/UPDATE/DELETE/CREATE TABLE/CREATE VIRTUAL TABLE/DROP TABLE) on local_* tables only. ' +
    'Cannot modify adf_* system tables. Supports vec0 virtual tables for vector search.'
  readonly inputSchema = InputSchema
  readonly category = 'database' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { sql, params } = input as z.infer<typeof InputSchema>

    const trimmed = sql.trim().toLowerCase()

    // Block SELECT (use db_query)
    if (trimmed.startsWith('select')) {
      return { content: 'Use db_query for SELECT statements.', isError: true }
    }

    // Only allow known write verbs — blocks ATTACH, DETACH, ALTER, PRAGMA, VACUUM, etc.
    const ALLOWED_VERBS = ['insert', 'update', 'delete', 'create', 'drop']
    if (!ALLOWED_VERBS.some(v => trimmed.startsWith(v))) {
      return { content: 'Only INSERT, UPDATE, DELETE, CREATE TABLE, and DROP TABLE statements are allowed.', isError: true }
    }

    // Sanitize: strip comments and string literals for safe validation
    const { sanitized, error: sanitizeError } = sanitizeSQL(trimmed)
    if (sanitizeError) {
      return { content: sanitizeError, isError: true }
    }
    const sanitizedTrimmed = sanitized.trim()
    const verb = sanitizedTrimmed.match(/^([a-z]+)/)?.[1]?.toUpperCase() ?? ''
    const tableName = extractTableName(sanitizedTrimmed)

    // Validate against sanitized SQL (comments/literals removed)
    if (sanitizedTrimmed.includes('adf_')) {
      return { content: 'Cannot modify adf_* system tables. Only local_* tables are allowed.', isError: true }
    }

    if (sanitizedTrimmed.startsWith('create')) {
      if (!tableName?.startsWith('local_')) {
        return { content: 'CREATE TABLE must use the local_ prefix (e.g. local_my_data).', isError: true }
      }
      if (/^create\s+virtual\b/.test(sanitizedTrimmed)) {
        const vtab = checkVirtualTable(sql)
        if ('error' in vtab) return { content: vtab.error, isError: true }
        // A local_* view could itself select from adf_*; the index would read
        // through it unseen. Content tables must be real tables.
        for (const t of vtab.contentTables) {
          const rows = workspace.querySQL('SELECT type FROM sqlite_master WHERE lower(name) = ?', [t]) as Array<{ type: string }>
          if (rows.some(r => r.type !== 'table')) {
            return { content: `content= must name a table, not a ${rows[0].type} ("${t}").`, isError: true }
          }
        }
      }
    }

    if (sanitizedTrimmed.startsWith('drop')) {
      if (!tableName?.startsWith('local_')) {
        return { content: 'DROP TABLE is only allowed on local_* tables.', isError: true }
      }
    }

    if (sanitizedTrimmed.startsWith('insert') || sanitizedTrimmed.startsWith('update') || sanitizedTrimmed.startsWith('delete')) {
      if (!tableName?.startsWith('local_')) {
        return { content: 'Write operations are only allowed on local_* tables.', isError: true }
      }
    }

    // Fail-closed enforcement on the objects the statement actually touches,
    // resolved statically. Text checks above are defeated by quoted identifiers
    // (SQLite accepts 'adf_identity' as a table name, and sanitizeSQL blanks it
    // as a string literal), so CREATE local_x AS SELECT * FROM 'adf_identity'
    // reaches here with a clean-looking sanitized string. Mapping opened root
    // pages back to their tables catches the real read/write targets:
    //   - no adf_* table may be read or written (blocks CTAS exfil into local_*)
    //   - every write target must be a local_* table (or an internal
    //     sqlite_* b-tree touched as DDL/autoincrement bookkeeping)
    try {
      const analysis = workspace.analyzeSQL?.(sql, params)
      if (analysis) {
        const touched = [...analysis.reads, ...analysis.writes]
        const adf = touched.find(t => t.startsWith('adf_'))
        if (adf) {
          return { content: `Cannot access adf_* system tables from db_execute ("${adf}"). Only local_* tables are allowed.`, isError: true }
        }
        const badWrite = [...analysis.writes].find(t => !(t.startsWith('local_') || t.startsWith('sqlite_')))
        if (badWrite) {
          return { content: `Write operations are only allowed on local_* tables ("${badWrite}").`, isError: true }
        }
      }
    } catch (error) {
      return { content: `SQL error: ${String(error)}`, isError: true }
    }

    if (tableName?.startsWith('local_')) {
      const isAuthorized = (input as Record<string, unknown>)?._authorized === true
      const protection = workspace.getAgentConfig?.().security?.table_protections?.[tableName] ?? 'none'
      if (protection === 'append_only' && (verb === 'DELETE' || verb === 'UPDATE' || verb === 'DROP')) {
        const action = verb === 'DROP' ? 'drop' : verb.toLowerCase()
        return { content: `Cannot ${action} "${tableName}": table is append-only.`, isError: true }
      }
      if (protection === 'authorized' && !isAuthorized && verb !== 'CREATE') {
        return { content: `Cannot write to "${tableName}": requires authorized code.`, isError: true }
      }
    }

    try {
      const result = workspace.executeSQL(sql, params)
      emitUmbilicalEvent({
        event_type: 'db.write',
        payload: { sql, params: params ?? [], changes: result.changes }
      })
      return { content: JSON.stringify({ changes: result.changes }), isError: false }
    } catch (error) {
      return { content: `SQL error: ${String(error)}`, isError: true }
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
