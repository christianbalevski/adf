import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // .claude/ can hold session worktrees (full repo copies) — scanning them
    // double-runs every suite and races port-binding integration tests.
    // skills/*/tests are node:test suites for the skill packages; they run in
    // the agent sandbox with its own dependencies (jszip, pdf-lib), not here.
    exclude: [...configDefaults.exclude, '**/.claude/**', 'skills/**'],
  },
})
