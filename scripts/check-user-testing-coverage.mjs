#!/usr/bin/env node
/**
 * Checks docs/design/daemon-backend-user-testing.md against the bridge
 * (`AdfApi` in src/preload/api.ts) and against itself:
 *
 *   - every AdfApi member is named in Appendix A;
 *   - every name in Appendix A is an AdfApi member;
 *   - every checklist ID Appendix A cites, and every ID the checklist body
 *     refers to, exists (a range such as AGT-01..AGT-09 runs in document
 *     order, so it may cross prefixes); no ID is defined twice;
 *   - every part of an Appendix A ID cell is an ID or a range, optionally
 *     followed by a note in parentheses.
 *
 *   node scripts/check-user-testing-coverage.mjs [api.ts …]
 *
 * Arguments name other copies of api.ts (for example one taken from another
 * branch with `git show <branch>:src/preload/api.ts`); the members of all of
 * them are checked as one bridge, as after a merge of those branches. Exit
 * code 1 when anything is missing, unknown, dangling or malformed.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const apiPaths = process.argv.length > 2 ? process.argv.slice(2) : [join(root, 'src', 'preload', 'api.ts')]
const checklistPath = join(root, 'docs', 'design', 'daemon-backend-user-testing.md')

/** Member names of `export interface AdfApi { … }` (depth-1 properties and methods). */
function adfApiMembers(source) {
  const start = source.indexOf('export interface AdfApi {')
  if (start < 0) throw new Error('No "export interface AdfApi {" in an api.ts given')
  const members = new Set()
  let depth = 0
  let inBlockComment = false
  for (const line of source.slice(start).split(/\r?\n/)) {
    let text = line
    if (inBlockComment) {
      const end = text.indexOf('*/')
      if (end < 0) continue
      text = text.slice(end + 2)
      inBlockComment = false
    }
    text = text.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
    const open = text.indexOf('/*')
    if (open >= 0) { inBlockComment = true; text = text.slice(0, open) }
    if (depth === 1) {
      const m = text.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/)
      if (m) members.add(m[1])
    }
    for (const ch of text) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth === 0 && members.size > 0) break
  }
  return members
}

const members = new Set(apiPaths.flatMap((path) => [...adfApiMembers(readFileSync(path, 'utf8'))]))
const doc = readFileSync(checklistPath, 'utf8')
const lines = doc.split(/\r?\n/)

const appendixStart = lines.findIndex((l) => l.startsWith('## Appendix A.'))
const appendixEnd = lines.findIndex((l) => l.startsWith('## Appendix B.'))
if (appendixStart < 0 || appendixEnd < 0) throw new Error('Appendix A or B heading not found')
const body = lines.slice(0, appendixStart)
const appendix = lines.slice(appendixStart, appendixEnd)

const ID_ROW = /^\| ([A-Z]+-\d+) \|/
/** Checklist IDs in document order (a range runs in this order). */
const order = body.map((l) => l.match(ID_ROW)?.[1]).filter(Boolean)
const checklistIds = new Set(order)
const prefixes = new Set(order.map((id) => id.split('-')[0]))
const duplicates = [...new Set(order.filter((id, i) => order.indexOf(id) !== i))]

const dangling = []
const badParts = []

/** The IDs from `from` to `to` in document order; an endpoint that does not exist is dangling. */
function expandRange(from, to, where) {
  for (const id of [from, to]) if (!checklistIds.has(id)) dangling.push(`${id} (${where})`)
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  if (a < 0 || b < 0) return []
  if (b < a) { badParts.push(`${from}..${to} runs backwards (${where})`); return [] }
  return order.slice(a, b + 1)
}

/** An Appendix A ID cell: comma-separated IDs or ranges, each optionally followed by a note in parentheses. */
function expandCell(cell, where) {
  const ids = []
  for (const part of cell.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z]+-\d+)(?:\.\.([A-Z]+-\d+))?(?:\s+\(.*\))?$/)
    if (!m) { badParts.push(`"${part}" is not an ID or a range (${where})`); continue }
    if (m[2]) ids.push(...expandRange(m[1], m[2], where))
    else {
      if (!checklistIds.has(m[1])) dangling.push(`${m[1]} (${where})`)
      ids.push(m[1])
    }
  }
  return ids
}

const named = new Map()
for (const line of appendix) {
  const cells = line.split('|').map((c) => c.trim())
  if (cells.length < 4 || !cells[1].includes('`')) continue
  const ids = expandCell(cells[2], `cited for ${cells[1]}`)
  for (const m of cells[1].matchAll(/`([A-Za-z_$][\w$]*)`/g)) named.set(m[1], ids)
}

// Cross-references in the checklist body ("SW-01..SW-05", "(DMN-17)"); only the checklist's own prefixes count.
for (const line of body) {
  const own = line.match(ID_ROW)
  const text = own ? line.slice(own[0].length) : line
  const where = own ? `body of ${own[1]}` : 'checklist text'
  for (const m of text.matchAll(/\b([A-Z]+-\d+)(?:\.\.([A-Z]+-\d+))?\b/g)) {
    if (!prefixes.has(m[1].split('-')[0])) continue
    if (m[2]) expandRange(m[1], m[2], where)
    else if (!checklistIds.has(m[1])) dangling.push(`${m[1]} (${where})`)
  }
}

const missing = [...members].filter((m) => !named.has(m)).sort()
const unknown = [...named.keys()].filter((m) => !members.has(m)).sort()

console.log(`api: ${apiPaths.join(', ')}`)
console.log(`AdfApi members: ${members.size}; named in Appendix A: ${named.size}; checklist items: ${checklistIds.size}`)
if (missing.length) console.log(`Not in Appendix A (${missing.length}): ${missing.join(', ')}`)
if (unknown.length) console.log(`In Appendix A but not in AdfApi (${unknown.length}): ${unknown.join(', ')}`)
if (duplicates.length) console.log(`Checklist IDs defined twice: ${duplicates.join(', ')}`)
if (dangling.length) console.log(`IDs the checklist does not have (${dangling.length}):\n  ${[...new Set(dangling)].join('\n  ')}`)
if (badParts.length) console.log(`Malformed ID cells or ranges (${badParts.length}):\n  ${badParts.join('\n  ')}`)
if (missing.length || unknown.length || duplicates.length || dangling.length || badParts.length) process.exit(1)
console.log('Appendix A covers every AdfApi member; every cited and cross-referenced ID exists.')
