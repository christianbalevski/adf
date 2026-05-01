import { describe, it, expect, vi } from 'vitest'

/**
 * Tests for sqlite3 command: read/write classification, multi-statement
 * splitting, --exec force write, and input source handling.
 *
 * Security boundary: misclassifying a write as a read lets agents bypass
 * db_execute restrictions through the shell.
 */

async function getSqlite3Handler() {
  const { structuredHandlers } = await import(
    '../../../src/main/tools/shell/commands/structured'
  )
  return structuredHandlers.find(h => h.name === 'sqlite3')!
}

function makeCtx(overrides: {
  args?: string[]
  flags?: Record<string, string | boolean | string[]>
  stdin?: string
}) {
  const calls: Array<{ tool: string; sql: string }> = []

  const fakeToolRegistry = {
    executeTool: vi.fn(async (name: string, input: any) => {
      calls.push({ tool: name, sql: input.sql })
      return {
        content: JSON.stringify([{ result: 1 }]),
        isError: false,
      }
    }),
  }

  const ctx: any = {
    args: overrides.args ?? [],
    flags: overrides.flags ?? {},
    stdin: overrides.stdin ?? '',
    workspace: {},
    toolRegistry: fakeToolRegistry,
    config: {},
    env: {},
  }

  return { ctx, calls }
}

// ── Read vs write classification ──

describe('sqlite3 read/write classification', () => {
  it('SELECT → db_query', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['SELECT * FROM adf_loop'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_query')
  })

  it('WITH → db_query', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['WITH cte AS (SELECT 1) SELECT * FROM cte'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_query')
  })

  it('PRAGMA → db_query', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['PRAGMA table_info(adf_loop)'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_query')
  })

  it('EXPLAIN → db_query', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['EXPLAIN SELECT * FROM adf_loop'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_query')
  })

  it('INSERT → db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ["INSERT INTO adf_loop (key, value) VALUES ('a', 'b')"] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('UPDATE → db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ["UPDATE adf_loop SET value = 'x' WHERE key = 'a'"] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('DELETE → db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ["DELETE FROM adf_loop WHERE key = 'a'"] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('CREATE TABLE → db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['CREATE TABLE foo (id INTEGER)'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('DROP TABLE → db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['DROP TABLE foo'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('ALTER TABLE → db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['ALTER TABLE foo ADD COLUMN bar TEXT'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })
})

// ── --exec force write ──

describe('sqlite3 --exec force write', () => {
  it('--exec forces SELECT to use db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ flags: { exec: 'SELECT * FROM adf_loop' } })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('--exec with INSERT still uses db_execute', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ flags: { exec: "INSERT INTO adf_loop VALUES ('a')" } })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })
})

// ── Adversarial classification (security-critical) ──

describe('sqlite3 adversarial classification', () => {
  it('leading whitespace: "  SELECT ..." → db_query', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['  SELECT 1'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_query')
  })

  it('lowercase: "select ..." → db_query', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['select 1'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_query')
  })

  it('SQL comment prefix: "/* comment */ INSERT ..." → db_execute (conservative)', async () => {
    // First word is /*, not in read list → classified as write (conservative/safe)
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['/* comment */ INSERT INTO foo VALUES (1)'] })
    await handler.execute(ctx)
    expect(calls[0].tool).toBe('db_execute')
  })

  it('multi-statement: "SELECT 1; DROP TABLE foo" classifies each independently', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['SELECT 1; DROP TABLE foo'] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(2)
    expect(calls[0].tool).toBe('db_query')
    expect(calls[1].tool).toBe('db_execute')
  })
})

// ── Multi-statement splitting ──

describe('sqlite3 multi-statement splitting', () => {
  it('splits two SELECT statements', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['SELECT 1; SELECT 2'] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(2)
    expect(calls[0].tool).toBe('db_query')
    expect(calls[1].tool).toBe('db_query')
  })

  it('respects escaped single quote in SQL', async () => {
    const handler = await getSqlite3Handler()
    // SQL: SELECT 'it''s'; SELECT 2 — the '' is an escaped single quote
    const { ctx, calls } = makeCtx({ args: ["SELECT 'it''s'; SELECT 2"] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain("it''s")
    expect(calls[1].sql).toBe('SELECT 2')
  })

  it('does not split on semicolon inside double quotes', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['SELECT "col;name" FROM t'] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(1)
  })

  it('returns error for empty SQL', async () => {
    const handler = await getSqlite3Handler()
    const { ctx } = makeCtx({ args: [] })
    const result = await handler.execute(ctx)
    expect(result.exit_code).not.toBe(0)
    expect(result.stderr).toContain('missing SQL')
  })
})

// ── Input sources ──

describe('sqlite3 input sources', () => {
  it('accepts SQL from positional args', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['SELECT 1'] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT 1')
  })

  it('accepts SQL from stdin', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ stdin: 'SELECT 1' })
    await handler.execute(ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT 1')
  })

  it('accepts SQL from --exec flag', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ flags: { exec: 'SELECT 1' } })
    await handler.execute(ctx)
    expect(calls).toHaveLength(1)
  })

  it('filters out database path from args', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: ['agent.adf', 'SELECT 1'] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT 1')
  })

  it('filters out :memory: path from args', async () => {
    const handler = await getSqlite3Handler()
    const { ctx, calls } = makeCtx({ args: [':memory:', 'SELECT 1'] })
    await handler.execute(ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT 1')
  })

  it('reports error on tool failure', async () => {
    const handler = await getSqlite3Handler()
    const ctx: any = {
      args: ['SELECT 1'],
      flags: {},
      stdin: '',
      workspace: {},
      toolRegistry: {
        executeTool: vi.fn(async () => ({
          content: 'table not found',
          isError: true,
        })),
      },
      config: {},
      env: {},
    }
    const result = await handler.execute(ctx)
    expect(result.exit_code).not.toBe(0)
    expect(result.stderr).toContain('table not found')
  })
})
