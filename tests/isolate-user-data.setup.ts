import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No test may read or write the developer's real user-data directory. Without
// Electron, getUserDataPath() falls back to ~/Library/Application Support/
// adf-studio — the same directory the installed app uses — so a test that
// touched the token-usage ledger (or settings) wiped real data on every run.
// Suites that set ADF_USER_DATA_DIR themselves still win and restore to this.
process.env.ADF_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adf-test-userdata-'))

// Agent leases (runtime/agent-lease.ts) live in a per-user directory that
// ignores ADF_USER_DATA_DIR on purpose; tests that start agents must not
// write leases next to the developer's running Studio or daemon.
process.env.ADF_LEASE_DIR = mkdtempSync(join(tmpdir(), 'adf-test-leases-'))
