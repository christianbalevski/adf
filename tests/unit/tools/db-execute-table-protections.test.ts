import { describe, it, expect } from 'vitest'
import { DbExecuteTool, extractTableName } from '../../../src/main/tools/built-in/db-execute.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

function workspaceWithProtections(tableProtections: Record<string, 'none' | 'append_only' | 'authorized'>): AdfWorkspace {
  return {
    getAgentConfig: () => ({
      security: {
        allow_unsigned: true,
        table_protections: tableProtections
      }
    }),
    executeSQL: () => ({ changes: 1 })
  } as unknown as AdfWorkspace
}

describe('db_execute table protections', () => {
  const tool = new DbExecuteTool()

  it('extracts target table names from write statements', () => {
    expect(extractTableName('INSERT INTO local_votes (id) VALUES (1)')).toBe('local_votes')
    expect(extractTableName('UPDATE OR REPLACE "local_votes" SET count = 1')).toBe('local_votes')
    expect(extractTableName('DELETE FROM [local_votes] WHERE id = 1')).toBe('local_votes')
    expect(extractTableName('DROP TABLE IF EXISTS `local_votes`')).toBe('local_votes')
    expect(extractTableName('CREATE VIRTUAL TABLE IF NOT EXISTS local_embeddings USING vec0(embedding float[384])')).toBe('local_embeddings')
  })

  it('allows insert into append-only tables', async () => {
    const result = await tool.execute(
      { sql: 'INSERT INTO local_votes (choice) VALUES (?)', params: ['yes'] },
      workspaceWithProtections({ local_votes: 'append_only' })
    )

    expect(result.isError).toBe(false)
  })

  it('blocks update, delete, and drop on append-only tables', async () => {
    const workspace = workspaceWithProtections({ local_votes: 'append_only' })

    for (const sql of [
      'UPDATE local_votes SET choice = ? WHERE id = 1',
      'DELETE FROM local_votes WHERE id = 1',
      'DROP TABLE local_votes'
    ]) {
      const result = await tool.execute({ sql, params: ['no'] }, workspace)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('table is append-only')
    }
  })

  it('blocks unauthorized writes to authorized tables', async () => {
    const result = await tool.execute(
      { sql: 'INSERT INTO local_approvals (request_id) VALUES (?)', params: ['req_1'] },
      workspaceWithProtections({ local_approvals: 'authorized' })
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('requires authorized code')
  })

  it('allows authorized writes to authorized tables', async () => {
    const result = await tool.execute(
      { sql: 'UPDATE local_approvals SET status = ? WHERE id = 1', params: ['approved'], _authorized: true },
      workspaceWithProtections({ local_approvals: 'authorized' })
    )

    expect(result.isError).toBe(false)
  })
})
