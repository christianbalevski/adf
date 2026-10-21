/**
 * R2B-5: help never reads cli-remotes.json. `adf help`, `adf --help` and
 * `adf tui --help` print their usage while the saved remotes cannot be read;
 * only a command that talks to a daemon resolves its URL (and then says
 * which file to fix).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)
// Every read of the saved remotes fails, as with a corrupt file.
const reads = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../src/main/cli/remotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/cli/remotes')>()
  return {
    ...actual,
    selectedRemote: () => {
      reads.count++
      throw new actual.RemotesUnreadableError('/data/cli-remotes.json', '/data/cli-remotes.json is not valid JSON')
    },
  }
})

import { runCli } from '../../src/main/cli/index'
import { tuiUsage } from '../../src/main/tui/index'

function io() {
  const out: string[] = []
  const err: string[] = []
  const fetchSpy = vi.fn(async () => new Response('{}'))
  return { out, err, fetchSpy, io: { stdout: (t: string) => { out.push(t) }, stderr: (t: string) => { err.push(t) }, fetch: fetchSpy as unknown as typeof fetch, ensureDaemon: async () => null, env: {} } }
}

describe('help while cli-remotes.json cannot be read', () => {
  it('adf help and adf --help print the usage', async () => {
    const saved = process.env.ADF_DAEMON_URL
    delete process.env.ADF_DAEMON_URL
    try {
      for (const argv of [['help'], ['--help'], ['-h']]) {
        const c = io()
        expect(await runCli(argv, c.io), `${argv.join(' ')}: ${c.err.join('')}`).toBe(0)
        expect(c.out.join('')).toMatch(/^ADF CLI/)
        expect(c.fetchSpy).not.toHaveBeenCalled()
      }
    } finally {
      if (saved !== undefined) process.env.ADF_DAEMON_URL = saved
    }
  })

  it('adf tui --help prints the terminal app usage', async () => {
    expect(() => tuiUsage()).not.toThrow()
    expect(tuiUsage()).toContain('http://127.0.0.1:7385')
    const c = io()
    const launchTui = vi.fn(async () => 0)
    expect(await runCli(['tui', '--help'], { ...c.io, launchTui })).toBe(0)
    expect(launchTui).toHaveBeenCalledWith(['tui', '--help'])
  })

  it('a command that talks to a daemon still says which file to fix', async () => {
    const saved = process.env.ADF_DAEMON_URL
    delete process.env.ADF_DAEMON_URL
    try {
      const before = reads.count
      const c = io()
      expect(await runCli(['status', 'agent-1'], c.io)).toBe(1)
      expect(c.err.join('')).toContain('/data/cli-remotes.json')
      expect(c.err.join('')).not.toMatch(/Usage/i)
      expect(reads.count).toBeGreaterThan(before)
      expect(c.fetchSpy).not.toHaveBeenCalled()
      // Given an address, no list is read.
      const given = io()
      const at = reads.count
      await runCli(['--url', 'http://127.0.0.1:1', 'agents'], given.io)
      expect(reads.count).toBe(at)
    } finally {
      if (saved !== undefined) process.env.ADF_DAEMON_URL = saved
    }
  })
})
