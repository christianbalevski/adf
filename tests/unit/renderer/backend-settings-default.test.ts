/**
 * Settings → Backend, W5-I: the "Default changed" row for an install the
 * first launch on the new default moved off Embedded.
 */
import { describe, expect, it } from 'vitest'
import { defaultSwitchLine } from '../../../src/renderer/components/settings/BackendSettings'

describe('defaultSwitchLine', () => {
  it('names the version, what moved and what was not done', () => {
    const line = defaultSwitchLine({ at: 'not a date', version: '0.8.0', moved: ['Client settings', 'ChatGPT session'], notDone: ['MCP sign-ins: the daemon\'s secret store is locked.'] })
    expect(line).toBe('On not a date, Studio 0.8.0 switched this install from Embedded to Local daemon, the new default. Moved: Client settings, ChatGPT session. Not done then, retried at each start: MCP sign-ins: the daemon\'s secret store is locked.')
  })

  it('says "nothing" when nothing moved', () => {
    expect(defaultSwitchLine({ at: '2026-10-16T10:00:00.000Z', version: '', moved: [], notDone: [] })).toMatch(/Studio switched this install .* Moved: nothing\.$/)
  })
})
