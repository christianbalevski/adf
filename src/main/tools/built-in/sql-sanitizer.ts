/**
 * Strip SQL comments and string literals, returning only structural SQL.
 * Used for safe table-name validation without parser bypass via comments/literals.
 *
 * - Removes single-line comments: -- ...
 * - Removes block comments: /* ... * /
 * - Replaces string literals ('...') with empty strings ('')
 * - Handles escaped quotes within strings ('' style SQL escaping)
 * - Preserves double-quoted identifiers (table/column names in SQLite)
 * - Rejects multi-statement SQL (semicolons followed by non-whitespace)
 */
export function sanitizeSQL(sql: string): { sanitized: string; error?: string } {
  const trimmed = sql.trim()

  // Reject multi-statement SQL
  // Allow trailing semicolons but reject embedded ones followed by more SQL
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '')
  if (withoutTrailingSemicolon.includes(';')) {
    return { sanitized: '', error: 'Multi-statement SQL is not allowed.' }
  }

  let result = ''
  let i = 0

  while (i < trimmed.length) {
    // Single-line comment: -- to end of line
    if (trimmed[i] === '-' && trimmed[i + 1] === '-') {
      const end = trimmed.indexOf('\n', i)
      if (end === -1) break // comment goes to end of string
      i = end + 1
      continue
    }

    // Block comment: /* to */
    if (trimmed[i] === '/' && trimmed[i + 1] === '*') {
      const end = trimmed.indexOf('*/', i + 2)
      if (end === -1) break // unclosed comment, consume rest
      i = end + 2
      continue
    }

    // Single-quoted string literal
    if (trimmed[i] === "'") {
      result += "''" // Replace with empty string literal
      i++
      while (i < trimmed.length) {
        if (trimmed[i] === "'" && trimmed[i + 1] === "'") {
          i += 2 // escaped quote, skip
          continue
        }
        if (trimmed[i] === "'") {
          i++ // closing quote
          break
        }
        i++
      }
      continue
    }

    // Double-quoted identifier (preserve — these are identifiers, not strings)
    // In SQLite, double quotes are identifiers, not string literals
    if (trimmed[i] === '"') {
      result += '"'
      i++
      while (i < trimmed.length) {
        if (trimmed[i] === '"' && trimmed[i + 1] === '"') {
          result += '""'
          i += 2
          continue
        }
        if (trimmed[i] === '"') {
          result += '"'
          i++
          break
        }
        result += trimmed[i]
        i++
      }
      continue
    }

    result += trimmed[i]
    i++
  }

  return { sanitized: result }
}
