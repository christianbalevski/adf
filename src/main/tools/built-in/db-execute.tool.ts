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
