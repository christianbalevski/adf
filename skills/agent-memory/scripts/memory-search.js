// Keyword search over every loop's message history: live adf_loop rows and
// archived adf_audit loop blobs, scanned on every call and ranked with BM25.
// Uses db_query only; builds no index and writes nothing.

import { brotliDecompressSync } from 'zlib'

const K_DEFAULT = 8
const K_MAX = 20
const CHUNK_TARGET = 1200
const CHUNK_MAX = 1800
// BM25 as SQLite FTS5 computes it.
const K1 = 1.2
const B = 0.75

const STOPWORDS = new Set(('a an and are as at be but by did do does for from had has have he her his how i if in into is it its ' +
  'me my no not of on or our she so than that the their them then there these they this to us was we were what when where ' +
  'which who whom why will with you your').split(' '))

// Lowercased letter/digit runs with diacritics removed, like FTS5's default unicode61 tokenizer.
const tokens = text => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? []

function queryTerms(query) {
  const all = [...new Set(tokens(query))]
  const terms = all.filter(t => !STOPWORDS.has(t))
  return terms.length ? terms : all
}

// Split text on paragraph boundaries into pieces of about CHUNK_TARGET chars,
// never over CHUNK_MAX. An oversized paragraph is cut at line, then space,
// boundaries where possible.
function chunkText(text) {
  const pieces = []
  // replace + string split: in the sandbox, split() with a RegExp is ~70x slower.
  for (const para of String(text).replace(/\n\s*\n/g, '\u0000').split('\u0000')) {
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

// The words the agent sent through its communication tools.
function sentText(name, input) {
  if (!input) return []
  if (name === 'msg_send' || name === 'loop_send') return [input.content]
  if (name === 'say') return [input.message]
  if (name === 'ask' && Array.isArray(input.questions)) return input.questions.map(q => q?.question)
  return []
}

// This lambda's own return value, however it was stored: a sys_lambda tool result,
// an _async task_complete text block, a sys_code "Result: " tool result, or a
// truncated preview. Indexing it would make later searches return earlier results
// instead of the sources. The full entry shape keeps the match narrow.
const OWN_OUTPUT = /^\{\s*"results":\s*\[\s*\]|"ref":\s*"\[S\d+\] [^"]*",\s*"date":\s*"[\d-]+",\s*"text":\s*"\[\[S\d+\]/

// Runtime copies of the system prompt, status and provider context (agent-session.ts
// appendContextEntry), never sent to the model. The test mirrors loop-parser.ts
// classifyInjectedText: only a head with the `loop_inject=v2` field is model input and stays.
const runtimeContext = t => { const m = t.match(/^\[Context: ([^\]]+)\]/); return !!m && !m[1].split(' | ').slice(1).includes('loop_inject=v2') }

// Text blocks, tool results, and sent words. Thinking and other tool inputs are left out.
// Live rows hold content_json as a JSON string, archived entries as the parsed array.
function messageText(content) {
  const blocks = typeof content === 'string' ? JSON.parse(content) : content
  const out = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') { if (!OWN_OUTPUT.test(b.text) && !runtimeContext(b.text)) out.push(b.text) }
    else if (b.type === 'tool_use') out.push(...sentText(b.name, b.input).filter(t => typeof t === 'string' && !OWN_OUTPUT.test(t)))
    else if (b.type === 'tool_result') {
      const parts = typeof b.content === 'string' ? [b.content]
        : Array.isArray(b.content) ? b.content.map(c => c?.text).filter(t => typeof t === 'string') : []
      out.push(...parts.filter(t => !OWN_OUTPUT.test(t)))
    }
  }
  return out.join('\n\n')
}

const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
// What dayOf can format; toISOString throws past ±8.64e15 ms.
const validTime = ms => typeof ms === 'number' && Number.isFinite(new Date(ms).getTime())
const loopName = source => String(source).replace(/^loop:?/, '') || 'main'

function messageChunks(seq, loop, createdAt, content) {
  const ref = `[S${seq}] ${loop}`
  const date = dayOf(createdAt)
  return chunkText(messageText(content)).map(body => ({ ref, date, text: `[${ref} · ${date}] ${body}` }))
}

function decodeBlob(data) {
  const blob = String(data)
  const buf = Buffer.from(blob.startsWith('base64:') ? blob.slice(7) : blob, 'base64')
  // Imported blobs are untrusted: the 128 MiB cap of src/main/adf/archived-loop-page.ts. Over it, readBlob skips the blob.
  return JSON.parse(brotliDecompressSync(buf, { maxOutputLength: 128 * 1024 * 1024 }).toString())
}

async function readBlob(id) {
  const [row] = await adf.db_query({ sql: 'SELECT source, data FROM adf_audit WHERE id = ?', params: [id], _full: true })
  try {
    return { loop: loopName(row.source), entries: decodeBlob(row.data) }
  } catch {
    return { loop: 'main', entries: [] } // unreadable blob: skip it
  }
}

async function search({ query, k = K_DEFAULT } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string.')
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1) throw new Error(`k must be a number from 1 to ${K_MAX}.`)
  k = Math.min(Math.floor(k), K_MAX)
  const terms = queryTerms(query)
  if (!terms.length) return { results: [] }
  const index = new Map(terms.map((t, i) => [t, i]))

  // One pass. Every chunk counts toward N and the average length; only chunks
  // holding a query term keep their term counts and where they came from.
  let n = 0
  let totalLength = 0
  const df = new Array(terms.length).fill(0)
  const hits = []
  const seen = new Set()
  function scan(seq, loop, createdAt, content, from) {
    if (seen.has(seq) || !validTime(createdAt)) return // a bad date is skipped like an unreadable blob
    seen.add(seq)
    messageChunks(seq, loop, createdAt, content).forEach((chunk, c) => {
      const toks = tokens(chunk.text)
      n++
      totalLength += toks.length
      let tf = null
      for (const t of toks) {
        const i = index.get(t)
        if (i === undefined) continue
        tf ??= new Array(terms.length).fill(0)
        tf[i]++
      }
      if (!tf) return
      tf.forEach((f, i) => { if (f) df[i]++ })
      hits.push({ seq, c, from, ref: chunk.ref, length: toks.length, tf })
    })
  }

  // The first archived copy of each seq wins, then live rows. An archived copy is
  // the original: the runtime can strip tool blocks from live rows in place, same seq.
  const live = await adf.db_query({ sql: 'SELECT seq, loop, content_json, created_at FROM adf_loop', _full: true })
  const blobIds = await adf.db_query({
    sql: "SELECT id FROM adf_audit WHERE source = 'loop' OR source LIKE 'loop:%' ORDER BY id", _full: true
  })
  for (const { id } of blobIds) {
    const { loop, entries } = await readBlob(id)
    for (const e of Array.isArray(entries) ? entries : []) {
      // Malformed entries are skipped like unreadable blobs; scan also needs a valid created_at for the date.
      if (e && typeof e.seq === 'number' && Array.isArray(e.content_json)) {
        scan(e.seq, loop, e.created_at, e.content_json, id)
      }
    }
  }
  for (const r of live) scan(r.seq, r.loop, r.created_at, r.content_json, 'live')

  const avgLength = totalLength / n
  const idf = df.map(d => Math.max(Math.log((n - d + 0.5) / (d + 0.5)), 1e-6))
  for (const h of hits) {
    h.score = h.tf.reduce((s, f, i) => s + idf[i] * (f * (K1 + 1)) / (f + K1 * (1 - B + B * h.length / avgLength)), 0)
  }
  hits.sort((a, b) => b.score - a.score)
  const top = []
  const refs = new Set()
  for (const h of hits) {
    if (top.length === k) break
    if (refs.has(h.ref)) continue // best chunk per ref
    refs.add(h.ref)
    top.push(h)
  }

  // Text only for the winners: re-read their messages, each blob once.
  const texts = new Map()
  for (const r of live) if (top.some(h => h.from === 'live' && h.seq === r.seq)) texts.set(r.seq, messageChunks(r.seq, r.loop, r.created_at, r.content_json))
  for (const id of new Set(top.filter(h => h.from !== 'live').map(h => h.from))) {
    const { loop, entries } = await readBlob(id)
    for (const h of top.filter(t => t.from === id)) {
      const e = entries.find(x => x && x.seq === h.seq)
      texts.set(h.seq, messageChunks(e.seq, loop, e.created_at, e.content_json))
    }
  }
  return { results: top.map(h => texts.get(h.seq)[h.c]) }
}

export { search, queryTerms, tokens, chunkText, messageText }
