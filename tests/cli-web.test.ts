import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/main/cli'
import { openWebBrowser, runWebCommand } from '../src/main/cli/web'
import { ensureDaemonToken } from '../src/main/daemon/daemon-token'
import { mintLocalProof } from '../src/main/daemon/local-access'

vi.mock('electron', () => { throw new Error('CLI browser launch must not import Electron') })
const directories: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function harness(port = 7385) {
  const directory = mkdtempSync(join(tmpdir(), 'adf-cli-web-'))
  directories.push(directory)
  const env: NodeJS.ProcessEnv = { ADF_DAEMON_SETTINGS: join(directory, 'settings.json') }
  const { token } = ensureDaemonToken(directory)
  const { proof } = mintLocalProof(directory, port)
  const origin = `http://127.0.0.1:${port}`
  const ticket = 't'.repeat(43)
  const url = `${origin}/studio/#ticket=${ticket}`
  const fetcher = vi.fn(async () => Response.json({ url }))
  const io = { env, fetch: fetcher as typeof fetch, ensureDaemon: vi.fn(async () => null), openBrowser: vi.fn(async () => {}), stdout: vi.fn(), stderr: vi.fn() }
  return { io, fetcher, token, proof, origin, ticket, url }
}

describe('adf web', () => {
  it('dispatches without Electron, starts locally, authenticates and opens without printing credentials', async () => {
    const h = harness()
    expect(await runCli(['web'], h.io)).toBe(0)
    expect(h.io.ensureDaemon).toHaveBeenCalledExactlyOnceWith(h.origin, h.io.env)
    expect(h.fetcher).toHaveBeenCalledExactlyOnceWith(`${h.origin}/web/launch`, expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({ Authorization: `Bearer ${h.token}`, 'X-ADF-Local-Proof': h.proof }),
    }))
    expect(h.io.openBrowser).toHaveBeenCalledExactlyOnceWith(h.url)
    const output = JSON.stringify([h.io.stdout.mock.calls, h.io.stderr.mock.calls])
    for (const secret of [h.token, h.proof, h.ticket]) expect(output).not.toContain(secret)
    expect(output).toContain('/studio/')
  })

  it('selects a custom local port and carries that selection into daemon startup', async () => {
    const h = harness(17321)
    expect(await runWebCommand(['--port=17321'], h.io)).toBe(0)
    expect(h.io.ensureDaemon).toHaveBeenCalledWith(h.origin, expect.objectContaining({ ADF_DAEMON_PORT: '17321' }))
    expect(h.io.openBrowser).toHaveBeenCalledWith(h.url)
    expect(h.io.env.ADF_DAEMON_PORT).toBeUndefined()
  })

  it('honors no-autostart flags and ignores saved remote selection', async () => {
    const h = harness()
    h.io.env.ADF_REMOTE = 'a-nonexistent-remote'
    expect(await runWebCommand(['--no-daemon'], h.io)).toBe(0)
    h.io.env.ADF_NO_AUTOSTART = '1'
    expect(await runWebCommand([], h.io)).toBe(0)
    expect(h.io.ensureDaemon).not.toHaveBeenCalled()
  })

  it.each(['https://example.com', 'http://127.attacker.test:7385', 'file:///tmp/adf', 'http://user:password@localhost:7385', 'http://localhost:7385/path', 'http://localhost:7385/?secret=1', 'http://127.0.0.1:17322'])('rejects unsafe or unknown target before reading/sending credentials: %s', async (url) => {
    const h = harness()
    expect(await runWebCommand(['--url', url], h.io)).toBe(2)
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.io.ensureDaemon).not.toHaveBeenCalled()
    expect(h.io.openBrowser).not.toHaveBeenCalled()
  })

  it.each([['--port'], ['--port=0'], ['--port=65536'], ['--port=oops'], ['--port=7385', '--url=http://localhost:7385'], ['--token=secret']])('validates options: %j', async (...args) => {
    const h = harness()
    expect(await runWebCommand(args, h.io)).toBe(2)
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.io.ensureDaemon).not.toHaveBeenCalled()
  })

  it.each(['https://example.com/studio/#ticket=', 'http://127.0.0.1:9999/studio/#ticket=', 'http://127.0.0.1:7385/not-studio/#ticket='])('refuses launch URL redirection: %s', async (prefix) => {
    const h = harness()
    h.fetcher.mockResolvedValue(Response.json({ url: prefix + h.ticket }))
    expect(await runWebCommand([], h.io)).toBe(1)
    expect(h.io.openBrowser).not.toHaveBeenCalled()
  })

  it('reports old daemons and browser launch failures without echoing server errors or tickets', async () => {
    const h = harness()
    h.fetcher.mockResolvedValueOnce(Response.json({ error: h.token }, { status: 404 }))
    expect(await runWebCommand([], h.io)).toBe(1)
    expect(h.io.stderr.mock.calls.flat().join('')).toContain('Update adf')
    h.io.openBrowser.mockRejectedValueOnce(new Error(h.url))
    expect(await runWebCommand([], h.io)).toBe(1)
    const errors = h.io.stderr.mock.calls.flat().join('')
    expect(errors).toContain('headless host')
    expect(errors).not.toContain(h.ticket)
    expect(errors).not.toContain(h.token)
  })

  it('help does not start or authenticate a daemon', async () => {
    const h = harness()
    expect(await runCli(['web', '--help'], h.io)).toBe(0)
    expect(h.io.stdout.mock.calls.flat().join('')).toContain('adf daemon pair')
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.io.ensureDaemon).not.toHaveBeenCalled()
  })

  it('accepts the global URL option before the command without resolving saved remotes', async () => {
    const h = harness()
    h.io.env.ADF_REMOTE = 'unknown-remote'
    expect(await runCli(['--url', h.origin, 'web'], h.io)).toBe(0)
    expect(h.io.openBrowser).toHaveBeenCalledWith(h.url)
  })

  it('keeps a long-running browser launcher detached without reporting false failure', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const start = vi.fn(() => child)
    const opened = openWebBrowser('http://localhost:7385/studio/#ticket=test', { spawn: start as unknown as typeof spawn })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(opened).resolves.toBeUndefined()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['http://localhost:7385/studio/#ticket=test']), expect.objectContaining({ detached: true, stdio: 'ignore' }))
  })

  it.each(['error', 'exit'])('reports an immediate browser launcher %s without the URL', async event => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const opened = openWebBrowser('http://localhost:7385/studio/#ticket=private', { spawn: (() => child) as unknown as typeof spawn })
    const checked = expect(opened).rejects.toThrow(/Browser launch/)
    child.emit(event, event === 'error' ? new Error('private') : 3)
    await checked
  })
})
