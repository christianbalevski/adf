import { describe, it, expect } from 'vitest'
import { DbExecuteTool } from '../../../src/main/tools/built-in/db-execute.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

describe('adf_audit append-only invariant (tool layer)', () => {
  const tool = new DbExecuteTool()
  // The adf_ check fires before workspace.executeSQL, so a stub suffices
  const workspace = {} as AdfWorkspace

  it('rejects UPDATE on adf_audit', async () => {
    const result = await tool.execute(
      { sql: "UPDATE adf_audit SET source = 'tampered' WHERE id = 1" },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Cannot modify adf_* system tables')
  })

  it('rejects DELETE on adf_audit', async () => {
    const result = await tool.execute(
      { sql: 'DELETE FROM adf_audit WHERE id = 1' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Cannot modify adf_* system tables')
  })

  it('rejects INSERT on adf_audit', async () => {
    const result = await tool.execute(
      { sql: "INSERT INTO adf_audit (source, data) VALUES ('fake', x'00')" },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Cannot modify adf_* system tables')
  })

  it('rejects DROP TABLE on adf_audit', async () => {
    const result = await tool.execute(
      { sql: 'DROP TABLE adf_audit' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Cannot modify adf_* system tables')
  })

  it('rejects case-insensitive attempts (mixed case)', async () => {
    const result = await tool.execute(
      { sql: "UPDATE ADF_AUDIT SET source = 'x' WHERE id = 1" },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Cannot modify adf_* system tables')
  })
})
