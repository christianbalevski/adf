import { describe, it, expect } from 'vitest'
import { sanitizeSQL } from '../../../src/main/tools/built-in/sql-sanitizer'

describe('sanitizeSQL', () => {
  it('strips single-line comments', () => {
    const { sanitized } = sanitizeSQL('SELECT * FROM secret -- adf_loop')
    expect(sanitized).not.toContain('adf_loop')
    expect(sanitized).toContain('secret')
  })

  it('strips block comments', () => {
    const { sanitized } = sanitizeSQL('SELECT * FROM secret /* adf_loop */')
    expect(sanitized).not.toContain('adf_loop')
  })

  it('replaces single-quoted string literals', () => {
    const { sanitized } = sanitizeSQL("SELECT * FROM secret WHERE 'adf_loop' = 'adf_loop'")
    expect(sanitized).not.toContain('adf_loop')
    expect(sanitized).toContain('secret')
  })

  it('preserves double-quoted identifiers', () => {
    const { sanitized } = sanitizeSQL('SELECT * FROM "adf_loop"')
    expect(sanitized).toContain('adf_loop')
  })

  it('handles escaped single quotes', () => {
    const { sanitized } = sanitizeSQL("SELECT * FROM t WHERE name = 'it''s adf_meta'")
    expect(sanitized).not.toContain('adf_meta')
  })

  it('rejects multi-statement SQL', () => {
    const { error } = sanitizeSQL('SELECT 1; DROP TABLE local_data')
    expect(error).toBeTruthy()
  })

  it('allows trailing semicolons', () => {
    const { sanitized, error } = sanitizeSQL('SELECT * FROM adf_loop;')
    expect(error).toBeUndefined()
    expect(sanitized).toContain('adf_loop')
  })

  it('handles no-FROM constant expressions', () => {
    const { sanitized } = sanitizeSQL('SELECT 1 + 1')
    expect(sanitized).toContain('1 + 1')
  })

  it('strips literals containing blocked table names', () => {
    const { sanitized } = sanitizeSQL("SELECT * FROM adf_loop WHERE note LIKE '%adf_meta%'")
    expect(sanitized).toContain('adf_loop')
    expect(sanitized).not.toContain('adf_meta')
  })

  it('handles multiple comments in one query', () => {
    const { sanitized } = sanitizeSQL("SELECT * FROM adf_loop -- comment\nWHERE 1=1 /* another */")
    expect(sanitized).toContain('adf_loop')
    expect(sanitized).not.toContain('comment')
    expect(sanitized).not.toContain('another')
  })

  it('handles unclosed block comment', () => {
    const { sanitized } = sanitizeSQL('SELECT * FROM adf_loop /* unclosed')
    expect(sanitized).toContain('adf_loop')
    expect(sanitized).not.toContain('unclosed')
  })

  it('handles empty string', () => {
    const { sanitized } = sanitizeSQL('')
    expect(sanitized).toBe('')
  })

  it('handles escaped double quotes in identifiers', () => {
    const { sanitized } = sanitizeSQL('SELECT * FROM "table""name"')
    expect(sanitized).toContain('table""name')
  })
  describe('a semicolon is a statement break only outside literals and comments', () => {
    const MULTI = 'Multi-statement SQL is not allowed.'

    it.each([
      ["INSERT INTO local_notes (body) VALUES ('first; second')"],
      ["INSERT INTO local_notes (body) VALUES ('it''s; fine''')"],
      ['SELECT 1 -- first; second\nFROM local_t'],
      ['SELECT 1 /* first; second */ FROM local_t'],
      ["INSERT INTO local_notes (body) VALUES ('a; b');"],
    ])('accepts %s', (sql) => {
      expect(sanitizeSQL(sql).error).toBeUndefined()
    })

    it.each([
      ['SELECT 1; DROP TABLE x'],
      ["SELECT 'a'; DROP TABLE x"],
      ["SELECT 'a;'; DROP TABLE x"],
      ['SELECT 1 /* ; */; DROP TABLE x'],
      ['SELECT 1 -- ;\n; DROP TABLE x'],
      ['SELECT 1 -- note\nFROM t; DROP TABLE x'],
      // A double-quoted identifier is kept in the output, so a ; inside it
      // still counts. SQLite would accept "a;b" as a name; refusing it is the
      // conservative side and costs nothing real.
      ['SELECT "a;b" FROM t; DROP TABLE x'],
      ['SELECT "a;b" FROM t'],
      // Backtick and bracket identifiers are names too: a quote inside them
      // must not open a string literal that hides the statements after it.
      ["SELECT `a'` FROM t; DROP TABLE x; SELECT `'`"],
      ["SELECT [a'] FROM t; DROP TABLE x; SELECT [']"],
      ['SELECT [a--b] FROM t; DROP TABLE x'],
      // Unterminated identifiers keep everything after them, ; included.
      ['SELECT "a; DROP TABLE x'],
      ['SELECT [a; DROP TABLE x'],
    ])('refuses %s', (sql) => {
      expect(sanitizeSQL(sql).error).toBe(MULTI)
    })

    it('an unterminated string or comment swallows the rest, as SQLite does: no second statement survives', () => {
      // SQLite reads an unclosed '...' to the end of input (then fails with
      // "unrecognized token") and an unclosed /* ... as a comment to the end.
      // Either way the text after it is not a statement.
      for (const sql of ["SELECT 'a; DROP TABLE x", 'SELECT 1 /* ; DROP TABLE x', 'SELECT 1 -- ; DROP TABLE x']) {
        const { sanitized, error } = sanitizeSQL(sql)
        expect(error).toBeUndefined()
        expect(sanitized).not.toContain('DROP')
      }
    })
  })
})
