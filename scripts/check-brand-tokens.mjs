#!/usr/bin/env node
/**
 * Checks that src/renderer/styles/brand-tokens.css matches the brand source,
 * adf-org/brand/tokens.css. Exits 1 on drift, 0 when in sync, and 0 with a
 * notice when the source checkout is not present.
 *
 *   node scripts/check-brand-tokens.mjs           check
 *   node scripts/check-brand-tokens.mjs --write   re-vendor from the source
 *
 * Source: $ADF_ORG_DIR/brand/tokens.css, default ../adf-org (a sibling of
 * this repo). The vendored file is HEADER + the source, byte for byte apart
 * from line endings.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Default: the nearest ancestor's sibling `adf-org`, so git worktrees nested
// under the main checkout still find it.
function findOrgDir() {
  if (process.env.ADF_ORG_DIR) return resolve(process.env.ADF_ORG_DIR)
  for (let dir = repoRoot; ; dir = dirname(dir)) {
    const candidate = resolve(dir, '..', 'adf-org')
    if (existsSync(join(candidate, 'brand', 'tokens.css'))) return candidate
    if (dirname(dir) === dir) return resolve(repoRoot, '..', 'adf-org')
  }
}
const source = join(findOrgDir(), 'brand', 'tokens.css')
const target = join(repoRoot, 'src', 'renderer', 'styles', 'brand-tokens.css')

const MARKER = ' * ---- vendored content below; do not edit ---- */'
const HEADER = `/*
 * VENDORED from adf-org/brand/tokens.css (itself generated from
 * brand/tokens.json by brand/build-tokens.mjs). Do not edit here.
 * Regenerate: node scripts/check-brand-tokens.mjs --write
 * Check:      node scripts/check-brand-tokens.mjs  (ADF_ORG_DIR overrides the sibling ../adf-org)
${MARKER}
`

const norm = (s) => s.replace(/\r\n/g, '\n')

if (!existsSync(source)) {
  console.log(`check-brand-tokens: source not found (${source}); skipping.`)
  process.exit(0)
}

const want = norm(readFileSync(source, 'utf8'))

if (process.argv.includes('--write')) {
  writeFileSync(target, HEADER + want)
  console.log(`check-brand-tokens: wrote ${target}`)
  process.exit(0)
}

if (!existsSync(target)) {
  console.error(`check-brand-tokens: ${target} missing; run with --write.`)
  process.exit(1)
}

const vendored = norm(readFileSync(target, 'utf8'))
const at = vendored.indexOf(MARKER + '\n')
const body = at === -1 ? null : vendored.slice(at + MARKER.length + 1)

if (body === want) {
  console.log('check-brand-tokens: in sync.')
  process.exit(0)
}

console.error(`check-brand-tokens: DRIFT between ${target} and ${source}.`)
if (body !== null) {
  const a = body.split('\n')
  const b = want.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`  first difference at content line ${i + 1}:`)
      console.error(`  - vendored: ${a[i] ?? '<eof>'}`)
      console.error(`  + source:   ${b[i] ?? '<eof>'}`)
      break
    }
  }
} else {
  console.error('  vendored header marker not found.')
}
console.error('Run: node scripts/check-brand-tokens.mjs --write')
process.exit(1)
