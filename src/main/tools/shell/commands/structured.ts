/**
 * Structured data commands: jq, sqlite3
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import { evaluateJq } from './jq-evaluator'

const jqHandler: CommandHandler = {
  name: 'jq',
  summary: 'JSON processor',
  helpText: [
    'jq \'<expr>\'          Process JSON with jq expression',
    '',
    'Supported: .field, .[0], .[], pipes, comma expressions,',
    '           object/array construction, //, arithmetic, comparisons,',
    '           and/or/not, if-then-else, select(), map(), keys, values,',
    '           length, has(), del(), sort_by(), group_by(), unique_by(),',
    '           to_entries, from_entries, @csv, @tsv, @json, type, tostring,',
    '           try-catch, reduce, $var bindings, .., test(), match(),',
    '           split(), join(), startswith(), endswith(), and more.',
    '',
    'Options:',
    '  -r                 Raw output (no quotes on strings)',
  ].join('\n'),
  category: 'data',
  resolvedTools: [],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.args.length === 0) return err('jq: missing expression')
    const expression = ctx.args[0]
    const rawOutput = !!ctx.flags.r
    const text = ctx.stdin || ''

    if (!text) return err('jq: no input')

    const { outputs, error } = evaluateJq(text, expression, rawOutput)
    if (error) return err(`jq: ${error}`)

    const formatted = outputs.map(v => {
      if (typeof v === 'string' && rawOutput) return v
      if (typeof v === 'string') return JSON.stringify(v)
      return JSON.stringify(v, null, 2)
    })
    return ok(formatted.join('\n'))
  }
}

/** Check if SQL statement is a read query (SELECT/WITH/PRAGMA/EXPLAIN) */
function isReadQuery(sql: string): boolean {
  const first = sql.trimStart().split(/\s/)[0].toUpperCase()
  return ['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN'].includes(first)
}

/** Check if an arg looks like a database path rather than SQL */
function isDbPath(arg: string): boolean {
  // Common SQLite path patterns: file.adf, file.db, file.sqlite, :memory:
  return /\.(adf|db|sqlite)$/i.test(arg) || /^:.*:$/.test(arg)
}

/** Split multi-statement SQL on semicolons, respecting string literals */
function splitStatements(sql: string): string[] {
  const stmts: string[] = []
  let current = ''
  let inString = false
  let quote = ''
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      current += ch
      if (ch === quote) {
        // Check for escaped quote (double-quote in SQL: '')
        if (i + 1 < sql.length && sql[i + 1] === quote) {
          current += sql[i + 1]
          i++
        } else {
          inString = false
        }
      }
    } else if (ch === "'" || ch === '"') {
      inString = true
      quote = ch
      current += ch
    } else if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed) stmts.push(trimmed)
      current = ''
    } else {
      current += ch
    }
  }
  const trimmed = current.trim()
  if (trimmed) stmts.push(trimmed)
  return stmts
}

/** Try to parse JSON rows from db_query output, returns null if not JSON array */
function parseRows(content: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') return parsed
  } catch { /* not JSON */ }
  return null
}

/** Format db_query JSON output as CSV or aligned table */
function formatOutput(content: string, format: 'csv' | 'table'): string {
  const rows = parseRows(content)
  if (!rows) return content // not JSON rows, pass through as-is

  const cols = Object.keys(rows[0])
  if (format === 'csv') {
    const csvEscape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [cols.join(',')]
    for (const row of rows) {
      lines.push(cols.map(c => csvEscape(row[c])).join(','))
    }
    return lines.join('\n')
  }

  // Table format: aligned columns
  const widths = cols.map(c => c.length)
  const stringRows = rows.map(row =>
    cols.map((c, i) => {
      const s = row[c] === null || row[c] === undefined ? 'NULL' : String(row[c])
      widths[i] = Math.max(widths[i], s.length)
      return s
    })
  )
  const header = cols.map((c, i) => c.padEnd(widths[i])).join('  ')
  const sep = widths.map(w => '-'.repeat(w)).join('  ')
  const body = stringRows.map(r => r.map((s, i) => s.padEnd(widths[i])).join('  ')).join('\n')
  return `${header}\n${sep}\n${body}`
}

const sqlite3Handler: CommandHandler = {
  name: 'sqlite3',
  summary: 'Execute SQL queries',
  helpText: [
    'sqlite3 "<sql>"         Query the agent database',
    'sqlite3 --exec "<sql>"  Force write mode',
    '',
    'Auto-detects SELECT/WITH/PRAGMA/EXPLAIN as reads.',
    'INSERT/UPDATE/DELETE/CREATE/DROP auto-detected as writes.',
    'Multiple statements separated by ; are supported.',
    'Database path arguments are ignored (always uses agent DB).',
    '',
    'Options:',
    '  --exec             Force execute mode (INSERT/UPDATE/DELETE)',
    '  --csv              CSV output',
    '  --json             JSON output',
  ].join('\n'),
  category: 'data',
  resolvedTools: ['db_query', 'db_execute'],

  async execute(ctx: CommandContext): Promise<CommandResult> {
    // Collect SQL from all sources. The shell's flag parser makes --exec consume the
    // next arg as its value, so --exec "SQL" yields ctx.flags.exec = "SQL" (string).
    // Handle all combinations:
    //   sqlite3 "SQL"                  → args=["SQL"], flags.exec=undefined
    //   sqlite3 --exec "SQL"           → args=[], flags.exec="SQL"
    //   sqlite3 --exec "SQL1" "SQL2"   → args=["SQL2"], flags.exec="SQL1"
    //   echo "SQL" | sqlite3           → args=[], stdin="SQL"
    //   sqlite3 :memory: "SQL"         → args=[":memory:","SQL"], filter db path
    //   sqlite3 agent.adf "SQL"        → args=["agent.adf","SQL"], filter db path

    // The shell's flag parser treats all long flags as value-consuming, so
    // --exec/--json/--csv will each swallow the next positional arg as their value.
    // Detect this: if a flag is a string (not boolean true), it consumed SQL.
    const execFlag = ctx.flags.exec
    const jsonFlag = ctx.flags.json
    const csvFlag = ctx.flags.csv

    const forceExec = !!execFlag
    const format = csvFlag ? 'csv' : jsonFlag ? 'json' : 'table'

    // Gather SQL fragments from all sources
    const sqlParts: string[] = []

    // Recover SQL consumed by boolean flags
    for (const flag of [execFlag, jsonFlag, csvFlag]) {
      if (typeof flag === 'string') sqlParts.push(flag)
    }

    // Positional args (skip database path args)
    for (const a of ctx.args) {
      if (!isDbPath(a)) sqlParts.push(a)
    }

    // Stdin fallback
    if (sqlParts.length === 0 && ctx.stdin) {
      sqlParts.push(ctx.stdin.trim())
    }

    const rawSql = sqlParts.join('; ')
    if (!rawSql) return err('sqlite3: missing SQL query')

    // Split multi-statement SQL
    const statements = splitStatements(rawSql)
    if (statements.length === 0) return err('sqlite3: empty SQL')

    const outputs: string[] = []
    for (const sql of statements) {
      const isRead = !forceExec && isReadQuery(sql)
      const toolName = isRead ? 'db_query' : 'db_execute'

      const result = await ctx.toolRegistry.executeTool(toolName, { sql }, ctx.workspace)
      if (result.isError) {
        const msg = result.content
        if (msg.includes('restricted') || msg.includes('not allowed')) {
          return err(`sqlite3: ${msg}\nNote: Only adf_* tables are accessible. Use "sqlite3 'SELECT name FROM sqlite_master WHERE type=\\'table\\''" to list tables.`)
        }
        return err(`sqlite3: ${msg}`)
      }
      if (result.content) outputs.push(result.content)
    }

    // db_query always returns JSON. Reformat for --csv / --table output.
    const combined = outputs.join('\n')
    if (format === 'json' || !combined) return ok(combined)
    return ok(formatOutput(combined, format))
  }
}

export const structuredHandlers: CommandHandler[] = [jqHandler, sqlite3Handler]
