// Keyword search over the agent's whole history: every loop's messages (live
// adf_loop rows and archived adf_audit loop blobs) plus workspace text files.
// The index lives in three local_ms_* tables and is caught up incrementally
// before every search. Uses db_query, db_execute, fs_list, and fs_read only.

import { brotliDecompressSync } from 'zlib'
import { createHash } from 'crypto'

const DOCS = 'local_ms_docs'
const CHUNKS = 'local_ms_chunks'
const FTS = 'local_ms_fts'

const K_DEFAULT = 8
const K_MAX = 20
const MAX_QUERY_CHARS = 1000
const CHUNK_TARGET = 1200
const CHUNK_MAX = 1800
const RESULT_CHARS = 1900
const MAX_FILE_BYTES = 1024 * 1024
// Time spent indexing per call. The sandbox stops a call at
// limits.execution_timeout_ms (60 s by default); the rest is left for the next call.
const BUDGET_MS = 20000
const LIVE_BATCH = 200
const WRITE_BATCH = 100

const STOPWORDS = new Set(('a an and are as at be but by did do does for from had has have he her his how i if in into is it its ' +
  'me my no not of on or our she so than that the their them then there these they this to us was we were what when where ' +
  'which who whom why will with you your').split(' '))

// Mirrors src/main/tools/built-in/mime-utils.ts isTextMime (as file-search does).
const TEXT_MIME_EXACT = new Set([
  'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
  'application/javascript', 'application/typescript', 'application/x-sh',
  'application/sql', 'application/graphql', 'application/xhtml+xml',
  'application/x-httpd-php', 'application/x-ndjson', 'application/ndjson',
  'application/csv', 'application/toml'
])

function isTextMime(mime) {
  if (!mime) return false
  if (mime.startsWith('text/')) return true
  if (/\+(json|xml|yaml)$/.test(mime)) return true
  return TEXT_MIME_EXACT.has(mime)
}

// --- Pure helpers -------------------------------------------------------------

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object.')
  const { query, k = K_DEFAULT, budget_ms = BUDGET_MS } = args
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string.')
  if (query.length > MAX_QUERY_CHARS) throw new Error(`query must not exceed ${MAX_QUERY_CHARS} characters.`)
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

// User and assistant text plus tool results. Thinking and tool-call inputs are left out.
function messageText(content) {
  let blocks = content
  if (typeof blocks === 'string') {
    try { blocks = JSON.parse(blocks) } catch { return blocks }
  }
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text)
    else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') out.push(b.content)
      else if (Array.isArray(b.content)) for (const c of b.content) if (c && typeof c.text === 'string') out.push(c.text)
    }
  }
  return out.join('\n\n')
}

function dayOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 1e12 ? value * 1000 : value)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  }
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(value ?? ''))
  return m ? m[0] : ''
}

const loopName = source => String(source).replace(/^loop:?/, '') || 'main'
const sha256 = text => createHash('sha256').update(text).digest('hex')

function docChunks(key, ref, date, text) {
  return chunkText(text).map(body => ({ doc: key, ref, date, text: `[${ref} · ${date}] ${body}` }))
}

function messageDoc(seq, loop, createdAt, content) {
  const ref = `[S${seq}] ${loop}`
  return { key: `msg:${seq}`, hash: null, stamp: null, chunks: docChunks(`msg:${seq}`, ref, dayOf(createdAt), messageText(content)) }
}

// --- Index writes ---------------------------------------------------------------

async function ensureTables() {
  try {
    await adf.db_execute({ sql: `CREATE TABLE IF NOT EXISTS ${DOCS} (key TEXT PRIMARY KEY, hash TEXT, stamp TEXT)` })
  } catch (error) {
    throw new Error(`memory-search keeps its index in local_ms_* tables and needs db_execute, which failed: ${error?.message ?? error}`)
  }
  // UNIQUE (doc, id) is there for its index: db_execute cannot run CREATE INDEX,
  // and every per-doc delete would otherwise scan the whole chunks table.
  await adf.db_execute({ sql: `CREATE TABLE IF NOT EXISTS ${CHUNKS} (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, ref TEXT NOT NULL, date TEXT, text TEXT NOT NULL, UNIQUE (doc, id))` })
  await adf.db_execute({ sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(text)` })
}

// Drop any chunks a doc already has (from an earlier, interrupted call or an
// older version of the file). FTS rows go first so none is left without its chunk.
async function dropChunks(keys) {
  const list = JSON.stringify(keys)
  await adf.db_execute({ sql: `DELETE FROM ${FTS} WHERE rowid IN (SELECT id FROM ${CHUNKS} WHERE doc IN (SELECT value FROM json_each(?)))`, params: [list] })
  await adf.db_execute({ sql: `DELETE FROM ${CHUNKS} WHERE doc IN (SELECT value FROM json_each(?))`, params: [list] })
}

// Write docs idempotently: clear, insert chunks, index them, then record the doc.
// The doc row is written last, so a doc cut off midway is redone next call.
async function writeDocs(docs) {
  for (let i = 0; i < docs.length; i += WRITE_BATCH) {
    const batch = docs.slice(i, i + WRITE_BATCH)
    const keys = batch.map(d => d.key)
    await dropChunks(keys)
    const chunks = batch.flatMap(d => d.chunks)
    for (let j = 0; j < chunks.length; j += WRITE_BATCH) {
      const part = chunks.slice(j, j + WRITE_BATCH)
      await adf.db_execute({
        sql: `INSERT INTO ${CHUNKS} (doc, ref, date, text) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`,
        params: part.flatMap(c => [c.doc, c.ref, c.date, c.text])
      })
    }
    if (chunks.length) {
      await adf.db_execute({
        sql: `INSERT INTO ${FTS} (rowid, text) SELECT id, text FROM ${CHUNKS} WHERE doc IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(keys)]
      })
    }
    await adf.db_execute({
      sql: `INSERT OR REPLACE INTO ${DOCS} (key, hash, stamp) VALUES ${batch.map(() => '(?, ?, ?)').join(', ')}`,
      params: batch.flatMap(d => [d.key, d.hash, d.stamp])
    })
  }
}

async function removeDocs(keys) {
  for (let i = 0; i < keys.length; i += WRITE_BATCH) {
    const part = keys.slice(i, i + WRITE_BATCH)
    await dropChunks(part)
    await adf.db_execute({ sql: `DELETE FROM ${DOCS} WHERE key IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(part)] })
  }
}

// --- Catch-up ---------------------------------------------------------------------

async function catchUp(budgetMs) {
  const started = Date.now()
  let added = 0
  let removed = 0
  let worked = false
  // The first unit of work always runs, so every call makes progress.
  const outOfTime = () => worked && Date.now() - started >= budgetMs

  await ensureTables()
  const known = new Map()
  for (const r of await adf.db_query({ sql: `SELECT key, hash, stamp FROM ${DOCS}`, _full: true })) known.set(r.key, r)

  // Work list, derived fresh each call: whatever the sources hold that the index does not.
  const liveSeqs = (await adf.db_query({ sql: 'SELECT seq FROM adf_loop ORDER BY seq', _full: true }))
    .map(r => r.seq).filter(seq => !known.has(`msg:${seq}`))
  const auditIds = (await adf.db_query({
    sql: "SELECT id FROM adf_audit WHERE source = 'loop' OR source LIKE 'loop:%' ORDER BY id", _full: true
  })).map(r => r.id).filter(id => !known.has(`audit:${id}`))
  const listing = (await adf.fs_list({ _full: true })) ?? []
  const listed = new Set(listing.map(f => `file:${f.path}`))
  const vanished = [...known.keys()].filter(key => key.startsWith('file:') && !listed.has(key))
  const files = listing.filter(f => known.get(`file:${f.path}`)?.stamp !== `${f.updated_at}|${f.size}|${f.mime_type}`)

  if (vanished.length) {
    await removeDocs(vanished)
    removed += vanished.length
    worked = true
  }

  // Live messages, in batches.
  let li = 0
  while (li < liveSeqs.length && !outOfTime()) {
    const seqs = liveSeqs.slice(li, li + LIVE_BATCH)
    li += seqs.length
    const rows = await adf.db_query({
      sql: 'SELECT seq, loop, content_json, created_at FROM adf_loop WHERE seq IN (SELECT value FROM json_each(?))',
      params: [JSON.stringify(seqs)], _full: true
    })
    const docs = rows.map(r => messageDoc(r.seq, r.loop || 'main', r.created_at, r.content_json))
    await writeDocs(docs)
    for (const d of docs) known.set(d.key, d)
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
    const docs = []
    const seen = new Set()
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e.seq !== 'number' || seen.has(e.seq) || known.has(`msg:${e.seq}`)) continue
      seen.add(e.seq)
      docs.push(messageDoc(e.seq, loop, e.created_at, e.content_json))
    }
    await writeDocs(docs)
    for (const d of docs) known.set(d.key, d)
    await writeDocs([{ key: `audit:${id}`, hash: null, stamp: null, chunks: [] }])
    added += docs.length
    worked = true
  }

  // Files: re-read only when the listing stamp moved; re-chunk only when the content hash did.
  let skipped = 0
  let fi = 0
  while (fi < files.length && !outOfTime()) {
    const f = files[fi++]
    const key = `file:${f.path}`
    const stamp = `${f.updated_at}|${f.size}|${f.mime_type}`
    const prev = known.get(key)
    let doc = { key, hash: '', stamp, chunks: [] }
    if (isTextMime(f.mime_type) && f.size <= MAX_FILE_BYTES) {
      let read = null
      try { read = await adf.fs_read({ path: f.path }) } catch { read = null }
      const content = read && typeof read.content === 'string' && isTextMime(read.mime_type) ? read.content : null
      if (content !== null && !content.includes('\u0000') && content.length <= MAX_FILE_BYTES) {
        const hash = sha256(content)
        doc = { key, hash, stamp, chunks: prev?.hash === hash ? null : docChunks(key, key, dayOf(f.updated_at), content) }
      } else skipped++
    } else skipped++
    if (doc.chunks === null) {
      // Same content under a new stamp: keep the chunks, record the stamp.
      await adf.db_execute({ sql: `UPDATE ${DOCS} SET stamp = ? WHERE key = ?`, params: [stamp, key] })
    } else {
      // Binary and oversized files get a doc row with no chunks, so they are not re-read until they change.
      await writeDocs([doc])
      if (doc.chunks.length) added++
      else if (prev?.hash) removed++
    }
    known.set(key, doc)
    worked = true
  }

  const pending = (liveSeqs.length - li) + (auditIds.length - ai) + (files.length - fi)
  return { added, removed, skipped, pending, complete: pending === 0, ms: Date.now() - started }
}

// --- Entry point ----------------------------------------------------------------------

async function search(args = {}) {
  const { query, k, budget_ms } = validateArgs(args)
  const indexed = await catchUp(budget_ms)
  const match = ftsQuery(query)
  if (!match) return { results: [], indexed }
  const rows = await adf.db_query({
    sql: `SELECT c.ref, c.date, c.text FROM ${FTS} JOIN ${CHUNKS} c ON c.id = ${FTS}.rowid WHERE ${FTS} MATCH ? ORDER BY bm25(${FTS}) LIMIT ?`,
    params: [match, k], _full: true
  })
  return {
    results: rows.map(r => ({ ref: r.ref, date: r.date, text: r.text.length > RESULT_CHARS ? `${r.text.slice(0, RESULT_CHARS)}…` : r.text })),
    indexed
  }
}

export { search, validateArgs, ftsQuery, chunkText, messageText, dayOf, isTextMime }
