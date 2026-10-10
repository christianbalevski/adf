import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import { sanitizeSQL } from './sql-sanitizer'
import { emitUmbilicalEvent } from '../../runtime/emit-umbilical'

const InputSchema = z.object({
  sql: z.string().describe(
    'SELECT query on adf_loop, adf_inbox, adf_outbox, adf_timers, adf_files, adf_audit, adf_logs, adf_tasks, or local_* tables. ' +
    'Examples: "SELECT * FROM adf_loop ORDER BY seq DESC LIMIT 50", ' +
    '"SELECT * FROM local_notes WHERE topic = ?", ' +
    '"SELECT rowid, distance FROM local_embeddings WHERE embedding MATCH ? AND k = 10"'
  ),
  params: z.array(z.unknown()).optional().describe('Bind parameters for the query.')
})

/** JSON.stringify replacer: encode BLOBs as base64 strings instead of {type:"Buffer",data:[...]} */
function blobReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && (value as Record<string, unknown>).type === 'Buffer' && Array.isArray((value as Record<string, unknown>).data)) {
    return 'base64:' + Buffer.from((value as { data: number[] }).data).toString('base64')
  }
  return value
}

/** Allowed table prefixes for read-only queries */
const ALLOWED_PREFIXES = ['adf_loop', 'adf_inbox', 'adf_outbox', 'adf_timers', 'adf_files', 'adf_audit', 'adf_logs', 'adf_tasks', 'local_']

/**
 * Real tables (resolved by static analysis) that db_query may read. Anything
 * else — adf_identity/adf_meta/adf_config and any other adf_* system table — is
 * rejected fail-closed. sqlite_master is allowed for schema introspection;
 * local_* tables are matched by prefix.
 */
const ADF_READ_ALLOWED = new Set([
  'adf_loop', 'adf_inbox', 'adf_outbox', 'adf_timers', 'adf_files', 'adf_audit', 'adf_logs', 'adf_tasks'
])

function isAllowedReadTable(name: string): boolean {
  return name === 'sqlite_master' || name.startsWith('local_') || ADF_READ_ALLOWED.has(name)
}

export class DbQueryTool implements Tool {
  readonly name = 'db_query'
  readonly description =
    'Run a read-only SQL SELECT on the ADF database. ' +
    'Allowed tables: adf_loop, adf_inbox, adf_outbox, adf_timers, adf_files, adf_audit, adf_logs, adf_tasks, and any local_* table.'
  readonly inputSchema = InputSchema
  readonly category = 'database' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { sql, params } = input as z.infer<typeof InputSchema>

    const trimmed = sql.trim().toLowerCase()
    // Read-only statements: SELECT, EXPLAIN (never executes the plan), and WITH
    // (CTE) provided it doesn't modify data. Keeps writes and PRAGMA out of the
    // unauthenticated read path while letting CTEs/EXPLAIN work.
    const isReadPrefix = trimmed.startsWith('select') || trimmed.startsWith('explain') || trimmed.startsWith('with')
    if (!isReadPrefix) {
      return { content: 'Only read queries (SELECT/WITH/EXPLAIN) are allowed. Use db_execute for writes.', isError: true }
    }

    // Sanitize: strip comments and string literals for safe validation
    const { sanitized, error: sanitizeError } = sanitizeSQL(trimmed)
    if (sanitizeError) {
      return { content: sanitizeError, isError: true }
    }

    // A WITH statement that modifies data is a write, not a read.
    if (trimmed.startsWith('with') && /\b(insert|update|delete|replace|drop|create|alter|attach|detach|vacuum|reindex)\b/.test(sanitized)) {
      return { content: 'WITH statements that modify data are not allowed in db_query. Use db_execute.', isError: true }
    }

    // Validate tables against sanitized SQL (comments/literals removed)
    const hasFrom = /\bfrom\b/.test(sanitized)
    if (hasFrom) {
      const hasAllowedTable = ALLOWED_PREFIXES.some(p => sanitized.includes(p)) || sanitized.includes('sqlite_master')
      if (!hasAllowedTable) {
        return {
          content: `Query must reference an allowed table: ${ALLOWED_PREFIXES.join(', ')}`,
          isError: true
        }
      }
    }

    // Block access to sensitive tables (check sanitized SQL, not raw)
    if (sanitized.includes('adf_meta') || sanitized.includes('adf_config') || sanitized.includes('adf_identity')) {
      return { content: 'Access to adf_meta, adf_config, and adf_identity is not allowed. Use sys_get_config instead.', isError: true }
    }

    // Block PRAGMA table-valued functions (e.g. pragma_table_info) — prevents
    // hiding sensitive table names inside string literals that sanitizeSQL strips.
    // These and the raw-page tables below are virtual, so static analysis can't
    // see them; check the raw text, since SQLite also accepts a quoted string
    // as a table name ('dbstat') and sanitizeSQL blanks those.
    if (trimmed.includes('pragma_')) {
      return { content: 'PRAGMA table-valued functions are not allowed in queries.', isError: true }
    }

    // Raw-page virtual tables can read arbitrary bytes of the database file —
    // including adf_identity/adf_meta — bypassing per-table root-page checks.
    if (trimmed.includes('sqlite_dbpage') || trimmed.includes('dbstat')) {
      return { content: 'Access to raw-page virtual tables (sqlite_dbpage, dbstat) is not allowed.', isError: true }
    }

    // Fail-closed enforcement on what the statement ACTUALLY touches, resolved
    // statically (quoting, aliases, views, subqueries and CTEs are all defeated
    // by mapping opened root pages back to their owning table). The text checks
    // above stay as a cheap first line; this is the real boundary.
    try {
      const analysis = workspace.analyzeSQL(sql, params)
      if (!analysis.readonly) {
        return { content: 'Only read-only statements are allowed in db_query. Use db_execute for writes.', isError: true }
      }
      const touched = [...analysis.reads, ...analysis.writes]
      const sensitive = touched.find(t => t === 'adf_identity' || t === 'adf_meta' || t === 'adf_config')
      if (sensitive) {
        return { content: 'Access to adf_meta, adf_config, and adf_identity is not allowed. Use sys_get_config instead.', isError: true }
      }
      const forbidden = touched.find(t => !isAllowedReadTable(t))
      if (forbidden) {
        return {
          content: `Query must reference only allowed tables (${ALLOWED_PREFIXES.join(', ')}); "${forbidden}" is not allowed.`,
          isError: true
        }
      }
    } catch (error) {
      // Analysis prepares the statement, so a syntax error surfaces here with
      // the same shape the execution path would have produced.
      return { content: `SQL error: ${String(error)}`, isError: true }
    }

    const _full = (input as Record<string, unknown>)?._full === true
    const MAX_ROWS = 500

    try {
      const rows = workspace.querySQL(sql, params)
      emitUmbilicalEvent({
        event_type: 'db.read',
        payload: { sql, params: params ?? [], row_count: rows.length }
      })
      if (rows.length === 0) {
        return { content: '[]', isError: false }
      }
      if (!_full && rows.length > MAX_ROWS) {
        const truncated = rows.slice(0, MAX_ROWS)
        return {
          content: [
            JSON.stringify(truncated, blobReplacer, 2),
            ``,
            `--- TRUNCATED at ${MAX_ROWS} rows (query returned ${rows.length} rows) ---`,
            `Add LIMIT to your query, or use _full: true from code execution to get all rows.`
          ].join('\n'),
          isError: false
        }
      }
      return { content: JSON.stringify(rows, blobReplacer, 2), isError: false }
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
