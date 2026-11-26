/**
 * Strip SQL comments and string literals, returning only structural SQL.
 * Used for safe table-name validation without parser bypass via comments/literals.
 *
 * - Removes single-line comments: -- ...
 * - Removes block comments: /* ... * /
 * - Replaces string literals ('...') with empty strings ('')
 * - Handles escaped quotes within strings ('' style SQL escaping)
 * - Preserves quoted identifiers ("...", `...`, [...]), scanned as one token
 *   so a quote or comment marker inside a name is not misread
 * - Rejects multi-statement SQL: a ; left after literals and comments are
 *   removed, other than one trailing ;
 */
export function sanitizeSQL(sql: string): { sanitized: string; error?: string } {
  const trimmed = sql.trim()

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

    // Quoted identifier (preserve — these are identifiers, not strings)
    // In SQLite, "...", `...` and [...] are identifiers, not string literals;
    // a doubled quote escapes in the first two, and [...] ends at the first ]
    if (trimmed[i] === '"' || trimmed[i] === '`' || trimmed[i] === '[') {
      const close = trimmed[i] === '[' ? ']' : trimmed[i]
      result += trimmed[i]
      i++
      while (i < trimmed.length) {
        if (trimmed[i] === close && close !== ']' && trimmed[i + 1] === close) {
          result += close + close
          i += 2
          continue
        }
        if (trimmed[i] === close) {
          result += close
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

  // Literals and comments are gone, so any ; left (bar one trailing) ends a
  // statement and starts another.
  if (result.replace(/;\s*$/, '').includes(';')) {
    return { sanitized: '', error: 'Multi-statement SQL is not allowed.' }
  }

  return { sanitized: result }
}
