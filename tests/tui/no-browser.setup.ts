import { vi } from 'vitest'

// No TUI test may open a real browser. Sign-in, web-page and file-open flows
// all go through cli/auth-flow's openBrowser; a test that forgets to inject
// its own opener (or resets a seam to the default) would otherwise launch the
// developer's browser at a fixture URL on every run.
vi.mock('../../src/main/cli/auth-flow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/cli/auth-flow')>()),
  openBrowser: vi.fn(),
  // tui/interop's cjs() reads `.default`; a mock throws on a missing export.
  default: undefined,
}))
