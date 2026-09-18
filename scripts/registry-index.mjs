#!/usr/bin/env node
/**
 * Rewrite (or check) registry/index.json from the .adf files in registry/.
 *
 *   npm run registry:index     # write
 *   npm run registry:check     # compare only, exit 1 on drift (CI)
 *
 * The files are the agents; the index is only what the gallery needs before
 * it opens one. This script:
 *  - keeps the hand-written fields of an existing entry (blurb, tags,
 *    min_app_version, ordering) and refreshes the derived ones (name, icon,
 *    sha256, size); `version` is bumped when the file's hash changed;
 *  - adds an entry for a new file with a placeholder blurb — edit it;
 *  - drops entries whose file is gone;
 *  - refuses to write when a file carries an identity, an owner or a DID:
 *    registry agents are claimed by whoever brings them home, and the repo
 *    is public — nothing personal ships. Loop/inbox/outbox rows only warn:
 *    seed memory can be deliberate, an author's chat log usually is not;
 *  - refuses to touch a file that already has a -wal/-shm sidecar (a live
 *    Studio connection may own it, and its hash would be a moving target).
 *    `--force` proceeds anyway; pre-existing sidecars are never deleted.
 *
 * Idempotent: with nothing changed, the written document is byte-identical
 * to the committed one (including `updated_at`).
 *
 * Needs the node ABI build of better-sqlite3, which the npm scripts do for
 * you; run `npx electron-rebuild -f -o better-sqlite3` afterwards to get
 * back to the Electron ABI for `npm run dev`.
 */
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const force = args.includes('--force')
const unknown = args.filter((a) => a !== '--check' && a !== '--force')
if (unknown.length > 0) {
  console.error(`unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(' ')}`)
  console.error('usage: node scripts/registry-index.mjs [--check] [--force]')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registryDir = join(root, 'registry')
const indexPath = join(registryDir, 'index.json')

const committedText = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null
let existing = { version: 1, updated_at: null, agents: [] }
if (committedText !== null) {
  try {
    existing = JSON.parse(committedText)
  } catch (err) {
    console.error(`registry/index.json is not valid JSON: ${err.message}`)
    process.exit(1)
  }
}
const byId = new Map((existing.agents ?? []).map((a) => [a.id, a]))

const files = readdirSync(registryDir).filter((f) => f.endsWith('.adf')).sort()
const problems = []
const agents = []

for (const file of files) {
  const id = file.slice(0, -4)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    problems.push(`${file}: file name must be lowercase letters, digits and dashes`)
    continue
  }
  const path = join(registryDir, file)

  // Capture the sidecar state BEFORE opening: a readonly open of a WAL
  // database creates -wal/-shm and cannot remove them at close, but sidecars
  // that were already there may belong to a live connection (Studio has the
  // agent open) and are never ours to delete.
  const hadSidecars = ['-wal', '-shm'].filter((s) => existsSync(path + s))
  if (hadSidecars.length > 0 && !force) {
    problems.push(`${file}: ${hadSidecars.map((s) => file + s).join(' and ')} present — close the agent in Studio first (or pass --force)`)
    continue
  }

  const db = new Database(path, { readonly: true, fileMustExist: true })
  let config
  let capabilities
  try {
    const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get()
    config = row ? JSON.parse(row.config_json) : null
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    if (config) {
      const enabled = (config.tools ?? []).filter((t) => t && t.enabled)
      const skillFiles = db.prepare("SELECT path FROM adf_files WHERE path LIKE 'skills/%/SKILL.md'").all()
      capabilities = {
        tools: enabled.length,
        code: enabled.some((t) => t.name === 'sys_code' || t.name === 'sys_lambda'),
        channels: Object.keys(config.adapters ?? {}).sort(),
        skills: skillFiles.filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f.path)).length,
      }
    }
    const meta = (key) => db.prepare('SELECT value FROM adf_meta WHERE key = ?').get(key)?.value
    if (count('adf_identity') > 0) problems.push(`${file}: adf_identity has rows — strip the identity before committing`)
    for (const key of ['adf_did', 'adf_owner_did', 'adf_runtime_did']) {
      if (meta(key)) problems.push(`${file}: adf_meta.${key} is set — a registry agent ships without an owner`)
    }
    if (count('adf_attestations') > 0) problems.push(`${file}: adf_attestations has rows — they name a real owner`)
    for (const table of ['adf_loop', 'adf_inbox', 'adf_outbox']) {
      const n = count(table)
      if (n > 0) console.warn(`warning: ${file}: ${table} has ${n} row${n === 1 ? '' : 's'} — make sure that is deliberate`)
    }
  } finally {
    db.close()
  }
  // Reap only the sidecars this open created; pre-existing ones stay.
  if (hadSidecars.length === 0) {
    for (const side of ['-wal', '-shm']) {
      try { if (existsSync(path + side)) unlinkSync(path + side) } catch { /* ignore */ }
    }
  }

  // Hash AFTER the open/close/reap cycle: that is the state of the bytes a
  // downloader will verify, and the state git sees.
  const bytes = readFileSync(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  if (!config) {
    problems.push(`${file}: no agent config`)
    continue
  }
  if (config.name !== id) problems.push(`${file}: config.name is "${config.name}" but the file name is "${id}" — they must match`)

  const prev = byId.get(id)
  const entry = {
    id,
    file,
    name: config.name,
    ...(config.icon ? { icon: config.icon } : {}),
    blurb: prev?.blurb ?? (config.description || 'Describe this agent in registry/index.json.'),
    tags: prev?.tags ?? [],
    sha256,
    size: bytes.length,
    version: prev ? (prev.sha256 === sha256 ? prev.version : prev.version + 1) : 1,
    ...(prev?.min_app_version ? { min_app_version: prev.min_app_version } : {}),
    ...(capabilities ? { capabilities } : {}),
  }
  agents.push(entry)
}

// Keep the previous ordering for entries that already existed; new ones go last.
const order = new Map((existing.agents ?? []).map((a, i) => [a.id, i]))
agents.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || a.id.localeCompare(b.id))

if (problems.length > 0) {
  console.error(checkOnly ? 'registry check failed:' : 'registry/index.json NOT written:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

// Idempotence: an unchanged agents array keeps the committed date, so
// re-running the script never produces a diff on its own.
const unchanged = JSON.stringify(existing.agents ?? []) === JSON.stringify(agents)
const updatedAt = unchanged && typeof existing.updated_at === 'string'
  ? existing.updated_at
  : new Date().toISOString().slice(0, 10)
const doc = { version: 1, updated_at: updatedAt, agents }
const text = JSON.stringify(doc, null, 2) + '\n'

if (checkOnly) {
  const drift = []
  if (committedText === null) {
    drift.push('registry/index.json does not exist — run `npm run registry:index`')
  } else {
    const committedById = new Map((existing.agents ?? []).map((a) => [a.id, a]))
    for (const entry of agents) {
      const prev = committedById.get(entry.id)
      if (!prev) {
        drift.push(`${entry.file} is not listed in index.json`)
        continue
      }
      for (const field of ['file', 'name', 'sha256', 'size', 'version']) {
        if (prev[field] !== entry[field]) {
          drift.push(`${entry.id}.${field}: index says ${JSON.stringify(prev[field])}, the file says ${JSON.stringify(entry[field])}`)
        }
      }
    }
    const onDisk = new Set(agents.map((a) => a.id))
    for (const prev of existing.agents ?? []) {
      if (!onDisk.has(prev.id)) drift.push(`index.json lists "${prev.id}" but registry/${prev.file} is missing`)
    }
    if (drift.length === 0 && committedText !== text) {
      drift.push('index.json has the right entries but differs in ordering, formatting or updated_at')
    }
  }
  if (drift.length > 0) {
    console.error('registry/index.json is out of date:')
    for (const d of drift) console.error(`  - ${d}`)
    console.error('run `npm run registry:index` and commit the result')
    process.exit(1)
  }
  console.log(`registry/index.json is up to date: ${agents.length} agent${agents.length === 1 ? '' : 's'}`)
  process.exit(0)
}

writeFileSync(indexPath, text)
console.log(`wrote ${indexPath}: ${agents.length} agent${agents.length === 1 ? '' : 's'}`)
