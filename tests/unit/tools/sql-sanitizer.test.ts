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
})
