import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // .claude/ can hold session worktrees (full repo copies) — scanning them
    // double-runs every suite and races port-binding integration tests.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
})
