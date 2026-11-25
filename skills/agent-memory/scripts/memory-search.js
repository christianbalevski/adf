// Keyword search over every loop's message history: live adf_loop rows and
// archived adf_audit loop blobs. The index lives in three local_ms_* tables and
// is caught up incrementally before every search. Uses db_query and db_execute only.

import { brotliDecompressSync } from 'zlib'

const DOCS = 'local_ms_docs'
const CHUNKS = 'local_ms_chunks'
const FTS = 'local_ms_fts'

const K_DEFAULT = 8
const K_MAX = 20
const CHUNK_TARGET = 1200
const CHUNK_MAX = 1800
// Time spent indexing per call. The sandbox stops a call at
// limits.execution_timeout_ms (60 s by default); the rest is left for the next call.
const BUDGET_MS = 20000
const LIVE_BATCH = 200
const WRITE_BATCH = 100

const STOPWORDS = new Set(('a an and are as at be but by did do does for from had has have he her his how i if in into is it its ' +
  'me my no not of on or our she so than that the their them then there these they this to us was we were what when where ' +
  'which who whom why will with you your').split(' '))

// --- Pure helpers -------------------------------------------------------------

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object.')
  const { query, k = K_DEFAULT, budget_ms = BUDGET_MS } = args
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string.')
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1) throw new Error(`k must be a number from 1 to ${K_MAX}.`)
  if (typeof budget_ms !== 'number' || !Number.isFinite(budget_ms) || budget_ms < 0) throw new Error('budget_ms must be a non-negative number.')
  return { query: query.trim(), k: Math.min(Math.floor(k), K_MAX), budget_ms: Math.min(budget_ms, BUDGET_MS) }
}

// Non-stopword terms, each double-quoted so FTS5 reads it as a plain string,
// joined with OR. Returns null when the query has no searchable term.
function ftsQuery(query) {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  const terms = tokens.filter(t => !STOPWORDS.has(t))
  const use = terms.length ? terms : tokens
  return use.length ? use.map(t => `"${t}"`).join(' OR ') : null
}

// Split text on paragraph boundaries into pieces of about CHUNK_TARGET chars,
// never over CHUNK_MAX. An oversized paragraph is cut at line, then space,
// boundaries where possible.
function chunkText(text) {
  const pieces = []
  for (const para of String(text).split(/\n\s*\n/)) {
    let p = para.trim()
    while (p.length > CHUNK_MAX) {
      let cut = p.lastIndexOf('\n', CHUNK_TARGET)
      if (cut < CHUNK_TARGET / 2) cut = p.lastIndexOf(' ', CHUNK_TARGET)
      if (cut < CHUNK_TARGET / 2) cut = CHUNK_TARGET
      pieces.push(p.slice(0, cut).trim())
      p = p.slice(cut).trim()
    }
    if (p) pieces.push(p)
  }
  const chunks = []
  let cur = ''
  for (const p of pieces) {
    if (cur && cur.length + 2 + p.length > CHUNK_TARGET) { chunks.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur) chunks.push(cur)
  return chunks
}

// What the agent and others said: text blocks, tool results, and the words the
// agent sent through its communication tools. Thinking and other tool inputs are left out.
function sentText(name, input) {
  if (!input) return []
  if (name === 'msg_send' || name === 'loop_send') return [input.content]
  if (name === 'say') return [input.message]
  if (name === 'ask' && Array.isArray(input.questions)) return input.questions.map(q => q?.question)
  return []
}

// Live rows hold content_json as a JSON string, archived entries as the parsed array.
function messageText(content) {
  const blocks = typeof content === 'string' ? JSON.parse(content) : content
  const out = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
    else if (b.type === 'tool_use') out.push(...sentText(b.name, b.input).filter(t => typeof t === 'string'))
    else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') out.push(b.content)
      else if (Array.isArray(b.content)) for (const c of b.content) if (c && typeof c.text === 'string') out.push(c.text)
    }
  }
  return out.join('\n\n')
}

const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
const loopName = source => String(source).replace(/^loop:?/, '') || 'main'

function messageDoc(seq, loop, createdAt, content) {
  const key = `msg:${seq}`
  const ref = `[S${seq}] ${loop}`
  const date = dayOf(createdAt)
  return { key, chunks: chunkText(messageText(content)).map((body, n) => ({ doc: key, n, ref, date, text: `[${ref} · ${date}] ${body}` })) }
}

// --- Index writes ---------------------------------------------------------------

async function ensureTables() {
  try {
    await adf.db_execute({ sql: `CREATE TABLE IF NOT EXISTS ${DOCS} (key TEXT PRIMARY KEY)` })
  } catch (error) {
    throw new Error(`memory-search keeps its index in local_ms_* tables and needs db_execute, which failed: ${error?.message ?? error}`)
  }
  // UNIQUE (doc, n) makes a rewrite of the same chunk a no-op, and its index is
  // the doc index (db_execute cannot run CREATE INDEX).
  await adf.db_execute({ sql: `CREATE TABLE IF NOT EXISTS ${CHUNKS} (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, n INTEGER NOT NULL, ref TEXT NOT NULL, date TEXT, text TEXT NOT NULL, UNIQUE (doc, n))` })
  await adf.db_execute({ sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(text)` })
}

// Every statement is safe to repeat, so a call killed midway, or two calls
// indexing the same docs at once, leave one copy of each chunk. Message text
// never changes, so (doc, n) always names the same chunk. The doc row goes last.
async function writeDocs(docs) {
  for (let i = 0; i < docs.length; i += WRITE_BATCH) {
    const batch = docs.slice(i, i + WRITE_BATCH)
    const chunks = batch.flatMap(d => d.chunks)
    for (let j = 0; j < chunks.length; j += WRITE_BATCH) {
      const part = chunks.slice(j, j + WRITE_BATCH)
      await adf.db_execute({
        sql: `INSERT OR IGNORE INTO ${CHUNKS} (doc, n, ref, date, text) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
        params: part.flatMap(c => [c.doc, c.n, c.ref, c.date, c.text])
      })
    }
    if (chunks.length) {
      await adf.db_execute({
        sql: `INSERT INTO ${FTS} (rowid, text) SELECT c.id, c.text FROM ${CHUNKS} c
              WHERE c.doc IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM ${FTS} f WHERE f.rowid = c.id)`,
        params: [JSON.stringify(batch.map(d => d.key))]
      })
    }
    await adf.db_execute({
      sql: `INSERT OR IGNORE INTO ${DOCS} (key) VALUES ${batch.map(() => '(?)').join(', ')}`,
      params: batch.map(d => d.key)
    })
  }
}

// --- Catch-up ---------------------------------------------------------------------

async function catchUp(budgetMs) {
  const started = Date.now()
  let added = 0
  let worked = false
  // The first unit of work always runs, so every call makes progress.
  const outOfTime = () => worked && Date.now() - started >= budgetMs

  await ensureTables()
  const known = new Set((await adf.db_query({ sql: `SELECT key FROM ${DOCS}`, _full: true })).map(r => r.key))

  // Work list, derived fresh each call: whatever the sources hold that the index does not.
  const liveSeqs = (await adf.db_query({ sql: 'SELECT seq FROM adf_loop ORDER BY seq', _full: true }))
    .map(r => r.seq).filter(seq => !known.has(`msg:${seq}`))
  const auditIds = (await adf.db_query({
    sql: "SELECT id FROM adf_audit WHERE source = 'loop' OR source LIKE 'loop:%' ORDER BY id", _full: true
  })).map(r => r.id).filter(id => !known.has(`audit:${id}`))

  // Live messages, in batches.
  let li = 0
  while (li < liveSeqs.length && !outOfTime()) {
    const seqs = liveSeqs.slice(li, li + LIVE_BATCH)
    li += seqs.length
    const rows = await adf.db_query({
      sql: 'SELECT seq, loop, content_json, created_at FROM adf_loop WHERE seq IN (SELECT value FROM json_each(?))',
      params: [JSON.stringify(seqs)], _full: true
    })
    const docs = rows.map(r => messageDoc(r.seq, r.loop, r.created_at, r.content_json))
    await writeDocs(docs)
    for (const d of docs) known.add(d.key)
    added += docs.length
    worked = true
  }

  // Archived loop blobs, one at a time; a blob can be megabytes. A seq already
  // indexed (live earlier, or from an overlapping blob) is skipped.
  let ai = 0
  while (ai < auditIds.length && !outOfTime()) {
    const id = auditIds[ai++]
    const [row] = await adf.db_query({ sql: 'SELECT id, source, data FROM adf_audit WHERE id = ?', params: [id], _full: true })
    let entries = []
    if (row) {
      const blob = String(row.data)
      try {
        entries = JSON.parse(brotliDecompressSync(Buffer.from(blob.startsWith('base64:') ? blob.slice(7) : blob, 'base64')).toString())
      } catch { entries = [] } // unreadable blob: record it and move on
    }
    const loop = row ? loopName(row.source) : 'main'
    const docs = (Array.isArray(entries) ? entries : [])
      .filter(e => e && typeof e.seq === 'number' && !known.has(`msg:${e.seq}`))
      .map(e => messageDoc(e.seq, loop, e.created_at, e.content_json))
    await writeDocs(docs)
    for (const d of docs) known.add(d.key)
    await writeDocs([{ key: `audit:${id}`, chunks: [] }])
    added += docs.length
    worked = true
  }

  const pending = (liveSeqs.length - li) + (auditIds.length - ai)
  return { added, pending, complete: pending === 0, ms: Date.now() - started }
}

// --- Entry point ----------------------------------------------------------------------

async function search(args = {}) {
  const { query, k, budget_ms } = validateArgs(args)
  const indexed = await catchUp(budget_ms)
  const match = ftsQuery(query)
  if (!match) return { results: [], indexed }
  const results = await adf.db_query({
    sql: `SELECT c.ref, c.date, c.text FROM ${FTS} JOIN ${CHUNKS} c ON c.id = ${FTS}.rowid WHERE ${FTS} MATCH ? ORDER BY bm25(${FTS}) LIMIT ?`,
    params: [match, k], _full: true
  })
  return { results, indexed }
}

export { search, validateArgs, ftsQuery, chunkText, messageText }
