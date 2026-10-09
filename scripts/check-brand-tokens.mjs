#!/usr/bin/env node
/**
 * Checks that the vendored brand files match their source in adf-org/brand:
 *
 *   adf-org/brand/tokens.css   -> src/renderer/styles/brand-tokens.css
 *   adf-org/brand/orbital.js   -> src/renderer/lib/brand/orbital.js
 *
 * Exits 1 on drift, 0 when in sync, and 0 with a notice when the source
 * checkout is not present.
 *
 *   node scripts/check-brand-tokens.mjs           check
 *   node scripts/check-brand-tokens.mjs --write   re-vendor from the source
 *
 * Source: $ADF_ORG_DIR/brand, default ../adf-org (a sibling of this repo).
 * Each vendored file is HEADER + the source, byte for byte apart from line
 * endings.
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
const brandDir = join(findOrgDir(), 'brand')

const MARKER = ' * ---- vendored content below; do not edit ---- */'
const FILES = [
  {
    source: join(brandDir, 'tokens.css'),
    target: join(repoRoot, 'src', 'renderer', 'styles', 'brand-tokens.css'),
    header: `/*
 * VENDORED from adf-org/brand/tokens.css (itself generated from
 * brand/tokens.json by brand/build-tokens.mjs). Do not edit here.
 * Regenerate: node scripts/check-brand-tokens.mjs --write
 * Check:      node scripts/check-brand-tokens.mjs  (ADF_ORG_DIR overrides the sibling ../adf-org)
${MARKER}
`
  },
  {
    source: join(brandDir, 'orbital.js'),
    target: join(repoRoot, 'src', 'renderer', 'lib', 'brand', 'orbital.js'),
    // Types live in orbital.d.ts next to it (hand-written, not vendored).
    // A change here changes rendered shapes: bump ORBITAL_RENDER_REV in
    // src/shared/utils/orbital-cache-key.ts so cached bitmaps are redrawn.
    header: `/*
 * VENDORED from adf-org/brand/orbital.js. Do not edit here.
 * Regenerate: node scripts/check-brand-tokens.mjs --write
 * Check:      node scripts/check-brand-tokens.mjs  (ADF_ORG_DIR overrides the sibling ../adf-org)
 * After a re-vendor, bump ORBITAL_RENDER_REV (src/shared/utils/orbital-cache-key.ts).
${MARKER}
`
  }
]

const norm = (s) => s.replace(/\r\n/g, '\n')

if (!existsSync(brandDir)) {
  console.log(`check-brand-tokens: source not found (${brandDir}); skipping.`)
  process.exit(0)
}

const write = process.argv.includes('--write')
let drift = false

for (const { source, target, header } of FILES) {
  if (!existsSync(source)) {
    console.log(`check-brand-tokens: source not found (${source}); skipping.`)
    continue
  }
  const want = norm(readFileSync(source, 'utf8'))

  if (write) {
    writeFileSync(target, header + want)
    console.log(`check-brand-tokens: wrote ${target}`)
    continue
  }

  if (!existsSync(target)) {
    console.error(`check-brand-tokens: ${target} missing; run with --write.`)
    drift = true
    continue
  }

  const vendored = norm(readFileSync(target, 'utf8'))
  const at = vendored.indexOf(MARKER + '\n')
  const body = at === -1 ? null : vendored.slice(at + MARKER.length + 1)

  if (body === want) {
    console.log(`check-brand-tokens: ${target} in sync.`)
    continue
  }

  drift = true
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
}

if (drift) {
  console.error('Run: node scripts/check-brand-tokens.mjs --write')
  process.exit(1)
}
process.exit(0)
