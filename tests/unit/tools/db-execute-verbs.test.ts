import { describe, it, expect } from 'vitest'
import { DbExecuteTool } from '../../../src/main/tools/built-in/db-execute.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

describe('db_execute verb whitelist', () => {
  const tool = new DbExecuteTool()
  // Validation fires before workspace methods — stub suffices for rejection cases
  const workspace = {} as AdfWorkspace

  const BLOCKED_MSG = 'Only INSERT, UPDATE, DELETE, CREATE TABLE, and DROP TABLE statements are allowed'

  it('rejects ATTACH DATABASE', async () => {
    const result = await tool.execute(
      { sql: "ATTACH DATABASE '/tmp/x.db' AS x" },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('rejects DETACH DATABASE', async () => {
    const result = await tool.execute(
      { sql: 'DETACH DATABASE x' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('allows DROP TABLE on local_ table', async () => {
    const mockWorkspace = {
      executeSQL: () => ({ changes: 0 })
    } as unknown as AdfWorkspace

    const result = await tool.execute(
      { sql: 'DROP TABLE local_data' },
      mockWorkspace
    )
    expect(result.isError).toBe(false)
  })

  it('rejects DROP TABLE on non-local table', async () => {
    const result = await tool.execute(
      { sql: 'DROP TABLE adf_loop' },
      workspace
    )
    expect(result.isError).toBe(true)
  })

  it('rejects ALTER TABLE', async () => {
    const result = await tool.execute(
      { sql: 'ALTER TABLE local_data ADD col TEXT' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('rejects PRAGMA', async () => {
    const result = await tool.execute(
      { sql: 'PRAGMA journal_mode' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('rejects VACUUM', async () => {
    const result = await tool.execute(
      { sql: 'VACUUM' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('rejects BEGIN', async () => {
    const result = await tool.execute(
      { sql: 'BEGIN' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('rejects SAVEPOINT', async () => {
    const result = await tool.execute(
      { sql: 'SAVEPOINT x' },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain(BLOCKED_MSG)
  })

  it('allows INSERT into local_ table', async () => {
    const mockWorkspace = {
      executeSQL: () => ({ changes: 1 })
    } as unknown as AdfWorkspace

    const result = await tool.execute(
      { sql: 'INSERT INTO local_data VALUES (1)' },
      mockWorkspace
    )
    expect(result.isError).toBe(false)
  })

  it('allows CREATE TABLE with local_ prefix', async () => {
    const mockWorkspace = {
      executeSQL: () => ({ changes: 0 })
    } as unknown as AdfWorkspace

    const result = await tool.execute(
      { sql: 'CREATE TABLE local_data (id INTEGER PRIMARY KEY)' },
      mockWorkspace
    )
    expect(result.isError).toBe(false)
  })
})
