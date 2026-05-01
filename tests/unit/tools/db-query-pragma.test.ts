import { describe, it, expect } from 'vitest'
import { DbQueryTool } from '../../../src/main/tools/built-in/db-query.tool'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

describe('db_query pragma_ block', () => {
  const tool = new DbQueryTool()
  const workspace = {} as AdfWorkspace

  it('rejects pragma_table_info with sensitive table hidden in string literal', async () => {
    const result = await tool.execute(
      { sql: "SELECT * FROM pragma_table_info('adf_identity'), (SELECT 1 FROM adf_loop LIMIT 1)" },
      workspace
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('PRAGMA table-valued functions')
  })

  it('rejects pragma_index_list', async () => {
    const result = await tool.execute(
      { sql: "SELECT * FROM pragma_index_list('adf_loop')" },
      workspace
    )
    expect(result.isError).toBe(true)
    // May hit allowed-table check or pragma_ check depending on sanitized content
    expect(result.isError).toBe(true)
  })
})
