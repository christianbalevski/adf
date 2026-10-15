#!/usr/bin/env node
/**
 * Checks Appendix A of docs/design/daemon-backend-user-testing.md against the
 * bridge (`AdfApi` in src/preload/api.ts):
 *
 *   - every AdfApi member is named in the appendix;
 *   - every name in the appendix is an AdfApi member;
 *   - every checklist ID the appendix cites exists in the checklist
 *     (ranges such as AGT-01..AGT-09 are expanded).
 *
 *   node scripts/check-user-testing-coverage.mjs [api.ts …]
 *
 * Arguments name other copies of api.ts (for example one taken from another
 * branch with `git show <branch>:src/preload/api.ts`); the members of all of
 * them are checked as one bridge, as after a merge of those branches. Exit
 * code 1 when anything is missing, unknown or dangling.
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
  for (const line of source.slice(start).split('\n')) {
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

function expandIds(cell) {
  const ids = []
  for (const part of cell.split(',').map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^([A-Z]+)-(\d+)\.\.([A-Z]+)-(\d+)$/)
    if (range && range[1] === range[3]) {
      const width = range[2].length
      for (let n = Number(range[2]); n <= Number(range[4]); n++) ids.push(`${range[1]}-${String(n).padStart(width, '0')}`)
      continue
    }
    const one = part.match(/^([A-Z]+-\d+)/)
    if (one) ids.push(one[1])
  }
  return ids
}

const members = new Set(apiPaths.flatMap((path) => [...adfApiMembers(readFileSync(path, 'utf8'))]))
const doc = readFileSync(checklistPath, 'utf8')

const appendixStart = doc.indexOf('## Appendix A.')
const appendixEnd = doc.indexOf('## Appendix B.')
if (appendixStart < 0 || appendixEnd < 0) throw new Error('Appendix A or B heading not found')
const appendix = doc.slice(appendixStart, appendixEnd)
const body = doc.slice(0, appendixStart)

const checklistIds = new Set([...body.matchAll(/^\| ([A-Z]+-\d+) \|/gm)].map((m) => m[1]))

const named = new Map()
const dangling = []
for (const line of appendix.split('\n')) {
  const cells = line.split('|').map((c) => c.trim())
  if (cells.length < 4 || !cells[1].includes('`')) continue
  const ids = expandIds(cells[2])
  for (const m of cells[1].matchAll(/`([A-Za-z_$][\w$]*)`/g)) named.set(m[1], ids)
  for (const id of ids) if (!checklistIds.has(id)) dangling.push(`${id} (cited for ${cells[1]})`)
}

const missing = [...members].filter((m) => !named.has(m)).sort()
const unknown = [...named.keys()].filter((m) => !members.has(m)).sort()

console.log(`api: ${apiPaths.join(', ')}`)
console.log(`AdfApi members: ${members.size}; named in Appendix A: ${named.size}; checklist items: ${checklistIds.size}`)
if (missing.length) console.log(`Not in Appendix A (${missing.length}): ${missing.join(', ')}`)
if (unknown.length) console.log(`In Appendix A but not in AdfApi (${unknown.length}): ${unknown.join(', ')}`)
if (dangling.length) console.log(`Appendix A cites IDs the checklist does not have (${dangling.length}):\n  ${[...new Set(dangling)].join('\n  ')}`)
if (missing.length || unknown.length || dangling.length) process.exit(1)
console.log('Appendix A covers every AdfApi member, and every cited ID exists.')
