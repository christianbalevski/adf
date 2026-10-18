/**
 * Settings → Backend copy: the "Default changed" row for an install the
 * first launch on the new default moved off Embedded (W5-I), the terse
 * daemon status line with its Details (W5-M), and the guide anchors the
 * page links to.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { daemonDetails, daemonLine, defaultSwitchDetails, defaultSwitchLine } from '../../../src/renderer/components/settings/BackendSettings'
import { DOCS } from '../../../src/shared/constants/docs-links'
import type { BackendDaemonStatus } from '../../../src/shared/types/backend.types'

describe('defaultSwitchLine', () => {
  it('names the date and the version in one line; what moved and what was not done are separate', () => {
    const record = { at: 'not a date', version: '0.8.0', moved: ['Client settings', 'ChatGPT session'], notDone: ['MCP sign-ins: the daemon\'s secret store is locked.'] }
    expect(defaultSwitchLine(record)).toBe('On not a date, Studio 0.8.0 moved agents from inside Studio to this computer.')
    expect(defaultSwitchDetails(record)).toEqual({
      moved: 'Moved: Client settings, ChatGPT session.',
      notDone: 'Not done then, retried at each start: MCP sign-ins: the daemon\'s secret store is locked.',
    })
  })

  it('says "nothing" when nothing moved, and has no not-done line when all was done', () => {
    const record = { at: '2026-10-16T10:00:00.000Z', version: '', moved: [], notDone: [] }
    expect(defaultSwitchLine(record)).toMatch(/^On .*, Studio moved agents from inside Studio to this computer\.$/)
    expect(defaultSwitchDetails(record)).toEqual({ moved: 'Moved: nothing.', notDone: null })
  })
})

describe('daemonLine (the ADF daemon row)', () => {
  const daemon: BackendDaemonStatus = {
    connection: 'connected', progress: null, message: null, url: 'http://127.0.0.1:7385', pid: 4242, version: '0.8.0',
    startedBy: 'studio', how: 'spawned', localProof: { available: true, problem: null }, trust: null, keychainProblem: null, logFile: null,
  }

  it('is connection, pid and who started it; URL and version are under Details', () => {
    expect(daemonLine(daemon)).toBe('Connected · pid 4242 · started by this Studio')
    expect(daemonDetails(daemon)).toEqual(['URL: http://127.0.0.1:7385', 'Version: 0.8.0'])
  })

  it('keeps an untrusted daemon key on the line (it needs an action) and puts a trusted one under Details', () => {
    const untrusted = { ...daemon, how: 'attached' as const, startedBy: 'cli' as const, trust: { state: 'not-trusted' as const, label: null, message: '' } }
    expect(daemonLine(untrusted)).toBe('Connected · pid 4242 · started by the ADF CLI · daemon key not trusted (adf identity trust-daemon)')
    const trusted = { ...daemon, trust: { state: 'trusted' as const, label: null, message: '' } }
    expect(daemonLine(trusted)).not.toMatch(/trusted/)
    expect(daemonDetails(trusted)).toContain('Daemon key: trusted by the owner')
  })

  it('shows the progress line while connecting', () => {
    expect(daemonLine({ ...daemon, connection: 'connecting', progress: 'Waiting for the ADF daemon (pid 7)…', pid: null, startedBy: null })).toBe('Waiting for the ADF daemon (pid 7)…')
  })
})

describe('Backend page docs links', () => {
  /** GitHub's heading slug: lowercased, punctuation dropped, spaces to dashes. */
  const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')

  it('every backend anchor is a heading of docs/guides/studio-backend.md', () => {
    const guide = readFileSync(join(__dirname, '../../../docs/guides/studio-backend.md'), 'utf-8')
    const anchors = new Set(guide.split(/\r?\n/).filter((line) => /^#{2,3} /.test(line)).map((line) => slug(line.replace(/^#+ /, ''))))
    const links = Object.entries(DOCS).filter(([key]) => key.startsWith('backend'))
    expect(links.length).toBeGreaterThan(0)
    for (const [key, url] of links) {
      expect(url, key).toMatch(/\/docs\/guides\/studio-backend\.md#/)
      expect(anchors.has(url.split('#')[1]), `${key}: ${url}`).toBe(true)
    }
  })
})
