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
    if (!trimmed.startsWith('select')) {
      return { content: 'Only SELECT queries are allowed. Use db_execute for writes.', isError: true }
    }

    // Sanitize: strip comments and string literals for safe validation
    const { sanitized, error: sanitizeError } = sanitizeSQL(trimmed)
    if (sanitizeError) {
      return { content: sanitizeError, isError: true }
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
    // hiding sensitive table names inside string literals that sanitizeSQL strips
    if (sanitized.includes('pragma_')) {
      return { content: 'PRAGMA table-valued functions are not allowed in queries.', isError: true }
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
