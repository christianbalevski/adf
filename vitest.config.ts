import { defineConfig, configDefaults } from 'vitest/config'

// .claude/ can hold session worktrees (full repo copies) — scanning them
// double-runs every suite and races port-binding integration tests.
// skills/*/tests are node:test suites for the skill packages; they run in
// the agent sandbox with its own dependencies (jszip, pdf-lib), not here.
// PARITY_EXCLUDE=1 leaves out tests/parity: CI's full-suite jobs run under
// Node, where the daemon side is skipped, and the daemon-parity job runs the
// harness under Electron-as-Node with the daemon side required.
const exclude = [
  ...configDefaults.exclude, '.claude/**', 'skills/*/tests/**',
  ...(process.env.PARITY_EXCLUDE === '1' ? ['tests/parity/**'] : []),
]

export default defineConfig({
  test: {
    exclude,
    projects: [
      // The TUI suites (ink renders, mock daemons) run in worker threads: the
      // forks pool's child processes die at teardown on Windows ("Worker
      // exited unexpectedly"). They never load native modules.
      // Each test drives a real ink render against a mock daemon; on a loaded
      // CI runner (macOS: 400 files in parallel) a whole chat turn can pass 5s.
      { extends: true, test: { name: 'tui', include: ['tests/tui/**/*.test.{ts,tsx}'], setupFiles: ['tests/isolate-user-data.setup.ts', 'tests/tui/no-browser.setup.ts'], pool: 'threads', testTimeout: 15_000 } },
      { extends: true, test: { name: 'unit', exclude: [...exclude, 'tests/tui/**'], setupFiles: ['tests/isolate-user-data.setup.ts'] } },
    ],
  },
})
