#!/usr/bin/env node
/**
 * Counts patterns the codebase is moving away from and holds each count at or
 * below scripts/ratchet-baseline.json. A new occurrence fails; so does a
 * cleanup that is not locked in, so the baseline only ever goes down.
 *
 *   node scripts/check-ratchet.mjs            check
 *   node scripts/check-ratchet.mjs --update   lower the baseline to the current counts
 *   node scripts/check-ratchet.mjs --list <id>  print every occurrence of one pattern
 *
 * Agents copy what the code already does. An exception that is not counted
 * spreads; one that is counted can only shrink.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts/ratchet-baseline.json')

const PATTERNS = [
  {
    id: 'eslint-disable',
    files: /^(src|tools)\/.*\.(ts|tsx|js|mjs)$/,
    regex: /eslint-disable/,
    fix: 'Fix the cause the rule reports. A suppression needs a reason after `--` naming why the rule does not apply.',
  },
  {
    id: 'ts-suppress',
    files: /^(src|tools)\/.*\.(ts|tsx)$/,
    regex: /@ts-(ignore|expect-error|nocheck)/,
    fix: 'Fix the type error, or narrow the type at the boundary it comes from.',
  },
  {
    id: 'any',
    files: /^(src|tools)\/.*\.(ts|tsx)$/,
    regex: /\bas any\b|:\s*any\b|<any>|\bany\[\]/,
    fix: 'Use the real type, `unknown` plus a check, or a generic.',
  },
  {
    id: 'justification-comment',
    files: /^(src|tools)\/.*\.(ts|tsx|js|mjs)$/,
    regex: /\/\/.*(\b(workaround|hack(y|ish)?|for now)\b|back(wards?)?[- ]?compat|remove (this )?(after|once|when)|temporary (diagnostic|fix))/i,
    fix: 'Fix the root cause instead of explaining around it. Pre-1.0: no compatibility shims; old stored loop entries get a read-side normalizer.',
  },
  {
    id: 'todo',
    files: /^(src|tools)\/.*\.(ts|tsx|js|mjs)$/,
    regex: /\b(TODO|FIXME|XXX)\b/,
    fix: 'Do it now, or open an issue and leave the code complete without the note.',
  },
  {
    id: 'renderer-timer',
    files: /^src\/(renderer|web)\/.*\.(ts|tsx)$/,
    regex: /\b(setTimeout|requestAnimationFrame|requestIdleCallback)\(/,
    fix: 'Timers in UI code usually patch over an ordering problem. Derive the value from state, or react to the event that makes it ready.',
  },
  {
    id: 'renderer-useEffect',
    files: /^src\/(renderer|web)\/.*\.tsx?$/,
    regex: /\buseEffect\(/,
    fix: 'Compute derived values during render, handle user actions in the event handler, and subscribe to stores with selectors.',
  },
]

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean)
}

function scan() {
  const files = trackedFiles()
  const hits = Object.fromEntries(PATTERNS.map((p) => [p.id, []]))
  for (const file of files) {
    const patterns = PATTERNS.filter((p) => p.files.test(file))
    if (!patterns.length) continue
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const p of patterns) if (p.regex.test(line)) hits[p.id].push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`)
    })
  }
  return hits
}

const args = process.argv.slice(2)
const hits = scan()

if (args[0] === '--list') {
  const id = args[1]
  if (!hits[id]) { console.error(`Unknown pattern "${id}". Patterns: ${PATTERNS.map((p) => p.id).join(', ')}`); process.exit(2) }
  console.log(hits[id].join('\n'))
  process.exit(0)
}

const counts = Object.fromEntries(Object.entries(hits).map(([id, h]) => [id, h.length]))

if (args[0] === '--update') {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const raised = Object.keys(counts).filter((id) => baseline[id] !== undefined && counts[id] > baseline[id])
  if (raised.length) {
    console.error(`--update only lowers the baseline. Over it: ${raised.join(', ')}. Remove the new occurrences.`)
    process.exit(1)
  }
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n')
  console.log('Baseline updated:', counts)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
let failed = false
for (const p of PATTERNS) {
  const was = baseline[p.id] ?? 0
  const now = counts[p.id]
  if (now > was) {
    failed = true
    console.error(`✖ ${p.id}: ${now} (baseline ${was}). ${p.fix}`)
    console.error(`  See them all: node scripts/check-ratchet.mjs --list ${p.id}`)
  } else if (now < was) {
    failed = true
    console.error(`✖ ${p.id}: ${now}, below the baseline ${was}. Lock in the cleanup: node scripts/check-ratchet.mjs --update`)
  } else {
    console.log(`✓ ${p.id}: ${now}`)
  }
}
process.exit(failed ? 1 : 0)
