import { lstatSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { resetProcessAgentLeases } from '../src/main/runtime/agent-lease'

// No test may read or write the developer's real user-data directory. Without
// Electron, getUserDataPath() falls back to ~/Library/Application Support/
// adf-studio — the same directory the installed app uses — so a test that
// touched the token-usage ledger (or settings) wiped real data on every run.
// Suites that set ADF_USER_DATA_DIR themselves still win and restore to this.
process.env.ADF_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adf-test-userdata-'))

// Agent leases (runtime/agent-lease.ts) live in a per-user directory that
// ignores ADF_USER_DATA_DIR on purpose; tests that start agents must not
// write leases next to the developer's running Studio or daemon.
// Created lazily inside this suite's user-data dir: no extra temp dir per
// test file, even when its afterAll never runs (every test skipped).
const leaseDirForSuite = join(process.env.ADF_USER_DATA_DIR, 'agent-leases')
process.env.ADF_LEASE_DIR = leaseDirForSuite

/** Remove a tree that holds only lease files; links are unlinked, never followed. */
function removeLeaseTree(dir: string): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = lstatSync(p)
      if (st.isDirectory() && !st.isSymbolicLink()) removeLeaseTree(p)
      else unlinkSync(p)
    } catch { /* busy or gone: leave it */ }
  }
  try { rmdirSync(dir) } catch { /* not empty: leave it */ }
}

afterAll(async () => {
  await resetProcessAgentLeases()
  removeLeaseTree(leaseDirForSuite)
})
