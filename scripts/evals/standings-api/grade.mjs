/**
 * Grade a standings-api eval run.
 *
 * Checks (deterministic):
 *  1. schema  — GET /agents/<handle>/standings on the mesh server returns 200
 *               and matches the demanded JSON shape (20 rows, pos 1..20, ints).
 *  2. truth   — every team name the agent served appears in the live source
 *               page (harness re-fetch as answer key); points non-increasing.
 *  3. reply   — adf_outbox holds a reply to the runner DID containing the
 *               /standings URL; adf_inbox holds the mission.
 *  4. state   — agent is back in idle (not off: routes must stay reachable).
 *  5. metrics — token/tool/turn ledger from the umbilical replay ring, with
 *               adf_loop json_extract fallback.
 *
 * Usage:
 *   node scripts/evals/standings-api/grade.mjs --adf <path.adf> --agent <agentId> \
 *     [--handle agent-1] [--daemon http://127.0.0.1:7385] [--mesh http://127.0.0.1:7296] \
 *     [--runner-did <did>] [--source <url>] [--out <report.json>]
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`Missing --${name}`)
}

const adfPath = arg('adf')
const agentId = arg('agent')
const handle = arg('handle', 'agent-1')
const daemon = arg('daemon', 'http://127.0.0.1:7385')
const mesh = arg('mesh', 'http://127.0.0.1:7296')
const runnerDid = arg('runner-did', '')
const sourceUrl = arg('source', 'https://www.bbc.com/sport/football/premier-league/table')
const outPath = arg('out', '')

const report = { eval: 'standings-api', graded_at: new Date().toISOString(), checks: {}, metrics: {} }
const checks = report.checks

function check(name, pass, detail) {
  checks[name] = { pass: Boolean(pass), detail }
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

// --- 1. schema ---------------------------------------------------------------
let served = null
try {
  const routeUrl = `${mesh}/agents/${handle}/standings`
  const res = await fetch(routeUrl)
  if (res.status !== 200) {
    const body = await res.text().catch(() => '')
    check('schema', false, `route returned ${res.status} (url: ${routeUrl}, body: ${body.slice(0, 200)})`)
  } else {
    served = await res.json()
    const rows = served?.standings
    const rowOk = (r, i) =>
      Number.isInteger(r?.pos) && r.pos === i + 1 &&
      typeof r?.team === 'string' && r.team.length > 0 &&
      Number.isInteger(r?.played) && Number.isInteger(r?.points)
    const ok =
      typeof served?.updated_at === 'string' && !Number.isNaN(Date.parse(served.updated_at)) &&
      typeof served?.source === 'string' && served.source.includes('bbc.') &&
      Array.isArray(rows) && rows.length === 20 && rows.every(rowOk)
    check('schema', ok, ok ? '20 rows, shape exact' : `shape mismatch (rows: ${Array.isArray(rows) ? rows.length : 'none'})`)
  }
} catch (err) {
  check('schema', false, `route unreachable: ${err.message}`)
}

// --- 2. truth ----------------------------------------------------------------
if (served?.standings?.length === 20) {
  try {
    const html = await (await fetch(sourceUrl, { headers: { 'user-agent': 'Mozilla/5.0 (eval-grader)' } })).text()
    const missing = served.standings.filter((r) => !html.includes(r.team))
    const pointsOrdered = served.standings.every(
      (r, i, a) => i === 0 || a[i - 1].points >= r.points,
    )
    check(
      'truth',
      missing.length === 0 && pointsOrdered,
      missing.length ? `teams not on source page: ${missing.map((m) => m.team).join(', ')}` : `all teams on source page; points ordered: ${pointsOrdered}`,
    )
  } catch (err) {
    check('truth', false, `source re-fetch failed: ${err.message}`)
  }
} else {
  check('truth', false, 'skipped: no valid served data')
}

// --- 3. reply + mission rows (direct SQLite) ---------------------------------
let db
try {
  const Database = require('better-sqlite3')
  db = new Database(adfPath, { readonly: true })
  const outbox = db.prepare('SELECT * FROM adf_outbox ORDER BY id DESC LIMIT 50').all()
  const inbox = db.prepare('SELECT * FROM adf_inbox ORDER BY id DESC LIMIT 50').all()
  const missionRow = inbox.find((r) => JSON.stringify(r).toLowerCase().includes('premier league'))
  const replyRow = outbox.find((r) => {
    const s = JSON.stringify(r)
    return s.includes('/standings') && (!runnerDid || s.includes(runnerDid))
  })
  check('reply', Boolean(missionRow && replyRow),
    `mission inbox row: ${Boolean(missionRow)}, reply outbox row with /standings url${runnerDid ? ' to runner DID' : ''}: ${Boolean(replyRow)}`)
} catch (err) {
  check('reply', false, `sqlite: ${err.message}`)
}

// --- 4. state ----------------------------------------------------------------
try {
  const status = await (await fetch(`${daemon}/agents/${agentId}/status`)).json()
  const state = status.targetState ?? status.runtimeState ?? status.state
  check('state', state === 'idle', `state=${state} (must be idle, not off — routes stay reachable)`)
} catch (err) {
  check('state', false, err.message)
}

// --- 5. metrics --------------------------------------------------------------
try {
  const res = await fetch(`${daemon}/agents/${agentId}/umbilical/events?since_seq=0&limit=5000`)
  const body = res.ok ? await res.json() : null
  const events = body?.events ?? (Array.isArray(body) ? body : [])
  const llm = events.filter((e) => (e.event_type ?? e.type) === 'llm.completed')
  const tools = events.filter((e) => (e.event_type ?? e.type) === 'tool.completed')
  const turns = events.filter((e) => (e.event_type ?? e.type) === 'turn.completed')
  const sum = (k) => llm.reduce((a, e) => a + (e.payload?.[k] ?? 0), 0)
  const toolsByName = {}
  for (const t of tools) {
    const n = t.payload?.tool_name ?? t.payload?.name ?? '?'
    toolsByName[n] = (toolsByName[n] ?? 0) + 1
  }
  report.metrics = {
    source: 'umbilical',
    llm_calls: llm.length,
    turns: turns.length,
    tool_calls: tools.length,
    tools_by_name: toolsByName,
    tokens: {
      input: sum('input_tokens'),
      output: sum('output_tokens'),
      cache_read: sum('cache_read_tokens'),
      cache_write: sum('cache_write_tokens'),
      reasoning: sum('reasoning_tokens'),
    },
    cost_usd: llm.reduce((a, e) => a + (e.payload?.cost_usd ?? 0), 0),
  }
} catch { /* fall through to loop ledger */ }

if (!report.metrics.llm_calls && db) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS llm_calls,
             SUM(COALESCE(json_extract(tokens, '$.input'), 0))  AS input,
             SUM(COALESCE(json_extract(tokens, '$.output'), 0)) AS output
      FROM adf_loop WHERE tokens IS NOT NULL`).get()
    report.metrics = { source: 'adf_loop (fallback — compaction/model_invoke not included)', ...row }
  } catch (err) {
    report.metrics = { source: 'unavailable', error: err.message }
  }
}
db?.close()

// --- summary -----------------------------------------------------------------
const names = Object.keys(checks)
const passed = names.filter((n) => checks[n].pass)
report.outcome = { passed: passed.length, total: names.length, pass: passed.length === names.length }
console.log(`\n${passed.length}/${names.length} checks passed`)
console.log(JSON.stringify(report.metrics, null, 2))
if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`report written: ${outPath}`)
}
process.exit(report.outcome.pass ? 0 : 1)
