#!/usr/bin/env node
/**
 * Ensures better-sqlite3 is compiled for the current (system) Node.js runtime.
 * Skips rebuild if the binary already matches.
 *
 * After tests, run `npm install` or `electron-rebuild -f -w better-sqlite3`
 * to restore the Electron-compatible binary.
 */

import { execSync } from 'child_process'

const binding = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'

try {
  // Quick check: try to load the native module — if it works, we're good
  const { createRequire } = await import('module')
  const require = createRequire(import.meta.url)
  require(`../${binding}`)
  // Module loads fine for current Node.js — no rebuild needed
} catch {
  console.log(`[rebuild] better-sqlite3 needs rebuild for Node.js ${process.version}...`)
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' })
  console.log('[rebuild] done.')
}
