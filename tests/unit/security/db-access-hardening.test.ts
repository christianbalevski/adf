import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { DbQueryTool } from '../../../src/main/tools/built-in/db-query.tool'
import { DbExecuteTool } from '../../../src/main/tools/built-in/db-execute.tool'

/**
 * Integration tests against a REAL better-sqlite3 database. These reproduce the
 * db_query / db_execute access-control bypasses (finding #1): the old text- and
 * sanitizer-based checks blank single-quoted literals, so a quoted table name
 * (which SQLite accepts as an identifier), an alias, a view, a subquery, or a
 * CREATE ... AS SELECT could all reach adf_identity / adf_meta / adf_config.
 * The fix binds enforcement to the objects the statement actually resolves to.
 */
describe('db access hardening (real sqlite)', () => {
  const query = new DbQueryTool()
  const execute = new DbExecuteTool()
  let ws: AdfWorkspace
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'adf-dbsec-'))
    ws = AdfWorkspace.create(join(dir, 'agent-1.adf'), { name: 'agent-1' })
    // Seed a secret and some local scratch, plus a local view/trigger that read adf_* .
    ws.setIdentity('crypto:signing:private_key', 'TOP-SECRET-PKCS8')
    ws.executeSQL('CREATE TABLE local_notes (id INTEGER PRIMARY KEY, body TEXT)')
    ws.executeSQL("INSERT INTO local_notes (body) VALUES ('hello')")
    ws.executeSQL('CREATE VIEW local_peek AS SELECT value FROM adf_identity')
  })

  afterAll(() => {
    try { ws.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  const rejected = (r: { isError?: boolean; content: string }) => expect(r.isError).toBe(true)

  describe('db_query', () => {
    it('allows a normal local_ read', async () => {
      const r = await query.execute({ sql: 'SELECT * FROM local_notes' }, ws)
      expect(r.isError).toBe(false)
      expect(r.content).toContain('hello')
    })

    it('blocks quoted table name reaching adf_identity', async () => {
      const r = await query.execute({ sql: "SELECT * FROM 'adf_identity'" }, ws)
      rejected(r)
      expect(r.content).not.toContain('TOP-SECRET')
    })

    it('blocks alias masking adf_identity as local_x', async () => {
      const r = await query.execute({ sql: 'SELECT * FROM adf_identity AS local_x' }, ws)
      rejected(r)
      expect(r.content).not.toContain('TOP-SECRET')
    })

    it('blocks a local_ view that selects adf_identity', async () => {
      const r = await query.execute({ sql: 'SELECT * FROM local_peek' }, ws)
      rejected(r)
      expect(r.content).not.toContain('TOP-SECRET')
    })

    it('blocks a subquery reading adf_identity', async () => {
      const r = await query.execute(
        { sql: 'SELECT (SELECT value FROM adf_identity) AS x FROM local_notes' },
        ws
      )
      rejected(r)
      expect(r.content).not.toContain('TOP-SECRET')
    })

    it('blocks a CTE reading adf_config', async () => {
      const r = await query.execute(
        { sql: 'WITH c AS (SELECT * FROM adf_config) SELECT * FROM c' },
        ws
      )
      rejected(r)
    })

    it('blocks reading a non-allowlisted adf_* table (adf_peers)', async () => {
      const r = await query.execute({ sql: 'SELECT * FROM adf_peers' }, ws)
      rejected(r)
    })

    it('blocks dbstat raw-page virtual table', async () => {
      const r = await query.execute({ sql: 'SELECT * FROM dbstat' }, ws)
      rejected(r)
    })

    it('blocks a quoted dbstat / pragma_ table name', async () => {
      rejected(await query.execute({ sql: "SELECT * FROM 'dbstat'" }, ws))
      rejected(await query.execute({ sql: "SELECT * FROM 'pragma_table_info'('adf_identity')" }, ws))
    })
  })

  describe('db_execute', () => {
    it('allows a normal local_ write', async () => {
      const r = await execute.execute(
        { sql: "INSERT INTO local_notes (body) VALUES ('world')" },
        ws
      )
      expect(r.isError).toBe(false)
    })

    it('blocks CREATE local_x AS SELECT from a quoted adf_identity', async () => {
      const r = await execute.execute(
        { sql: "CREATE TABLE local_steal AS SELECT * FROM 'adf_identity'" },
        ws
      )
      rejected(r)
      // The exfil table must not have been created.
      const check = await query.execute({ sql: 'SELECT * FROM local_steal' }, ws)
      expect(check.isError).toBe(true)
    })

    it('blocks INSERT ... SELECT that reads adf_identity into a local_ table', async () => {
      await execute.execute({ sql: 'CREATE TABLE local_sink (v BLOB)' }, ws)
      const r = await execute.execute(
        { sql: "INSERT INTO local_sink (v) SELECT value FROM 'adf_identity'" },
        ws
      )
      rejected(r)
      const check = await query.execute({ sql: 'SELECT * FROM local_sink' }, ws)
      expect(check.content).toBe('[]')
    })

    it('allows CREATE local_x AS SELECT from a local_ table', async () => {
      const r = await execute.execute(
        { sql: 'CREATE TABLE local_copy AS SELECT body FROM local_notes' },
        ws
      )
      expect(r.isError).toBe(false)
      const check = await query.execute({ sql: 'SELECT * FROM local_copy' }, ws)
      expect(check.content).toContain('hello')
    })

    it.each([
      "content='adf_identity'",
      'content="adf_identity"',
      'content=[adf_identity]',
      'content=`adf_identity`',
      'CONTENT = adf_identity',
      "content='ADF_IDENTITY'"
    ])('blocks an FTS5 index with external content over adf_identity (%s)', async (opt) => {
      const name = `local_fts_${Math.random().toString(36).slice(2, 8)}`
      const r = await execute.execute(
        { sql: `CREATE VIRTUAL TABLE ${name} USING fts5(value, ${opt})` },
        ws
      )
      rejected(r)
      const check = await query.execute({ sql: `SELECT * FROM ${name}` }, ws)
      expect(check.content).not.toContain('TOP-SECRET')
    })

    it('blocks an FTS5 index whose content table is a local_ view', async () => {
      const r = await execute.execute(
        { sql: "CREATE VIRTUAL TABLE local_fts_view USING fts5(value, content='local_peek')" },
        ws
      )
      rejected(r)
    })

    it('blocks virtual table modules that read other objects', async () => {
      rejected(await execute.execute(
        { sql: "CREATE VIRTUAL TABLE local_vocab USING fts5vocab('local_x', 'row')" },
        ws
      ))
    })

    it('allows FTS5 over a local_ table and contentless FTS5', async () => {
      const ext = await execute.execute(
        { sql: "CREATE VIRTUAL TABLE local_notes_fts USING fts5(body, content='local_notes', content_rowid='id')" },
        ws
      )
      expect(ext.isError).toBe(false)
      const none = await execute.execute(
        { sql: "CREATE VIRTUAL TABLE local_bare_fts USING fts5(body, content='')" },
        ws
      )
      expect(none.isError).toBe(false)
      const plain = await execute.execute({ sql: 'CREATE VIRTUAL TABLE local_plain_fts USING fts5(body)' }, ws)
      expect(plain.isError).toBe(false)
    })
  })
})
