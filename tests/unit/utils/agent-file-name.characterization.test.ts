/**
 * Characterization (rule E1, W5-D2): embedded Studio's agent file-name rule
 * (ipc/index.ts isValidAgentFileName before the extraction), now
 * shared/utils/agent-file-name.ts, which the daemon uses too.
 */
import { describe, expect, it } from 'vitest'
import { isValidAgentFileName } from '../../../src/shared/utils/agent-file-name'

describe('agent file-name rule (embedded Studio)', () => {
  it('accepts any length and Windows device names; refuses empty, separators, Windows-refused characters, a trailing dot or space', () => {
    for (const ok of ['agent-1', 'Agent 1', 'a'.repeat(65), 'a'.repeat(300), 'con', 'NUL', 'com1', 'x.y', '.hidden', 'émile', 'name with (2)']) {
      expect(isValidAgentFileName(ok), ok).toBe(true)
    }
    for (const bad of ['', 'a/b', 'a\\b', 'a\bb', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'tab\there', 'nul\u0000', 'trailing.', 'trailing ', '.', '..']) {
      expect(isValidAgentFileName(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})
