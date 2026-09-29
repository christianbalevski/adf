// `adf` starting the daemon on its own: target/paths rules, the ADF Studio
// check, the graceful stop protocol and the CLI hook. Nothing here spawns a
// daemon: ensureDaemon is only exercised on paths that return before a start.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/main/cli'
import {
  daemonPaths,
  daemonTarget,
  daemonUrlFrom,
  ensureDaemon,
  readPidFile,
  stopDaemon,
  studioConflict,
  tailLines,
} from '../src/main/cli/daemon-control'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'adf-autostart-'))
  dirs.push(d)
  return d
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const down = async () => { throw new TypeError('fetch failed') }

describe('daemon target and paths', () => {
  it('only treats loopback URLs as startable', () => {
    expect(daemonTarget('http://127.0.0.1:7385')).toMatchObject({ host: '127.0.0.1', port: 7385, loopback: true })
    expect(daemonTarget('http://localhost:9000/')).toMatchObject({ host: 'localhost', port: 9000, loopback: true, url: 'http://localhost:9000' })
    expect(daemonTarget('http://[::1]:7385')).toMatchObject({ loopback: true })
    expect(daemonTarget('http://10.0.0.5:7385').loopback).toBe(false)
    expect(daemonTarget('https://adf.example.test').loopback).toBe(false)
  })

  it('keeps pid file and log next to the daemon settings, one per port', () => {
    const dir = tempDir()
    const env = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }
    expect(daemonPaths(7385, env)).toMatchObject({ dataDir: dir, pidFile: join(dir, 'adf-daemon.pid'), logFile: join(dir, 'logs', 'adf-daemon.log'), custom: true })
    expect(daemonPaths(7400, env).pidFile).toBe(join(dir, 'adf-daemon-7400.pid'))
    expect(daemonPaths(7400, { ...env, ADF_DAEMON_PIDFILE: join(dir, 'x.pid') }).pidFile).toBe(join(dir, 'x.pid'))
  })

  it('reads JSON and legacy pid files', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.pid'), `${JSON.stringify({ pid: 4242, startedAt: 1 })}\n`)
    writeFileSync(join(dir, 'b.pid'), '77\n')
    expect(readPidFile(join(dir, 'a.pid'))).toEqual({ pid: 4242, startedAt: 1 })
    expect(readPidFile(join(dir, 'b.pid'))).toEqual({ pid: 77 })
    expect(readPidFile(join(dir, 'missing.pid'))).toBeNull()
    writeFileSync(join(dir, 'log.txt'), 'one\ntwo\nthree\n')
    expect(tailLines(join(dir, 'log.txt'), 2)).toBe('two\nthree')
  })

  it('resolves the daemon URL for `adf daemon <sub>`', () => {
    expect(daemonUrlFrom(['--port', '7400', '-f'], {})).toEqual({ url: 'http://127.0.0.1:7400', rest: ['-f'] })
    expect(daemonUrlFrom(['--url=http://127.0.0.1:9/'], {}).url).toBe('http://127.0.0.1:9')
    expect(daemonUrlFrom([], { ADF_DAEMON_PORT: '7401' }).url).toBe('http://127.0.0.1:7401')
    expect(daemonUrlFrom([], {}).url).toBe('http://127.0.0.1:7385')
  })
})

describe('ADF Studio check', () => {
  it('flags a runtime on the same settings whose mesh answers with our runtime id', async () => {
    const dir = tempDir()
    const settingsFile = join(dir, 'adf-settings.json')
    writeFileSync(settingsFile, JSON.stringify({ runtimeId: 'rt-1', meshPort: 7555 }))
    const paths = daemonPaths(7385, { ADF_DAEMON_SETTINGS: settingsFile })
    const seen: string[] = []
    const same = (async (url: string) => { seen.push(url); return json({ runtime_id: 'rt-1' }) }) as typeof fetch
    expect(await studioConflict(paths, {}, same)).toMatch(/most likely ADF Studio/)
    expect(seen).toEqual(['http://127.0.0.1:7555/ping'])
    const other = (async () => json({ runtime_id: 'rt-2' })) as typeof fetch
    expect(await studioConflict(paths, {}, other)).toBeNull()
    expect(await studioConflict(paths, {}, down as typeof fetch)).toBeNull()
  })
})

describe('ensureDaemon', () => {
  it('does nothing when the daemon answers, for remote URLs and when disabled', async () => {
    const up = (async () => json({ ok: true })) as typeof fetch
    expect(await ensureDaemon('http://127.0.0.1:7385', { fetch: up })).toBeNull()
    expect(await ensureDaemon('http://10.1.2.3:7385', { fetch: down as typeof fetch })).toBeNull()
    expect(await ensureDaemon('http://127.0.0.1:7385', { fetch: down as typeof fetch, disabled: true })).toBeNull()
    expect(await ensureDaemon('http://127.0.0.1:7385', { fetch: down as typeof fetch, env: { ADF_NO_AUTOSTART: '1' } })).toBeNull()
  })

  it('refuses to start next to a running Studio, with advice', async () => {
    const dir = tempDir()
    const settingsFile = join(dir, 'adf-settings.json')
    writeFileSync(settingsFile, JSON.stringify({ runtimeId: 'rt-1' }))
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/ping')) return json({ runtime_id: 'rt-1' })
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await expect(ensureDaemon('http://127.0.0.1:7385', { fetch: fetchImpl, env: { ADF_DAEMON_SETTINGS: settingsFile }, log: () => {} }))
      .rejects.toMatchObject({ advice: expect.stringContaining('Quit ADF Studio') })
  })
})

describe('stopDaemon', () => {
  it('asks the daemon to shut down and waits until it is gone', async () => {
    const dir = tempDir()
    let alive = true
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('http://127.0.0.1:7391', '')}`)
      if (url.endsWith('/daemon/shutdown')) { setTimeout(() => { alive = false }, 50); return json({ accepted: true }, 202) }
      if (!alive) throw new TypeError('fetch failed')
      return json({ ok: true })
    }) as typeof fetch
    const result = await stopDaemon(daemonTarget('http://127.0.0.1:7391'), { fetch: fetchImpl, env: { ADF_DAEMON_SETTINGS: join(dir, 's.json') } })
    expect(result).toEqual({ stopped: true, message: 'ADF daemon stopped.' })
    expect(calls).toContain('POST /daemon/shutdown')
  })

  it('never hard-kills a daemon without the stop endpoint', async () => {
    const dir = tempDir()
    const fetchImpl = (async (url: string) => (url.endsWith('/daemon/shutdown') ? json({ error: 'Not Found' }, 404) : json({ ok: true }))) as typeof fetch
    const result = await stopDaemon(daemonTarget('http://127.0.0.1:7392'), { fetch: fetchImpl, env: { ADF_DAEMON_SETTINGS: join(dir, 's.json') } })
    expect(result.stopped).toBe(false)
    expect(result.message).toMatch(/Ctrl\+C/)
  })
})

describe('adf starts the daemon before it needs it', () => {
  function io(ensure: CliIo['ensureDaemon'], handler: (url: string) => Promise<Response> = async () => json([])) {
    let out = ''
    let err = ''
    const urls: string[] = []
    const value: CliIo = {
      fetch: handler as typeof fetch,
      stdout: t => { out += t },
      stderr: t => { err += t },
      ensureDaemon: async url => { urls.push(url); return ensure ? ensure(url) : null },
      launchTui: async () => 0,
    }
    return { value, out: () => out, err: () => err, urls }
  }

  it('for commands and the TUI (with the URL they target), not for help', async () => {
    const a = io(async () => null)
    expect(await runCli(['--url', 'http://127.0.0.1:7777', 'agents'], a.value)).toBe(0)
    expect(await runCli(['help'], a.value)).toBe(0)
    expect(await runCli(['--view', 'chat'], a.value)).toBe(0)
    expect(await runCli(['tui', '--help'], a.value)).toBe(0)
    expect(a.urls).toEqual(['http://127.0.0.1:7777', 'http://127.0.0.1:7385'])
  })

  it('says the daemon keeps running after the TUI, and stops with the advice when it cannot start', async () => {
    const started = io(async () => ({ pid: 4321 }))
    expect(await runCli([], started.value)).toBe(0)
    expect(started.out()).toContain('The daemon (pid 4321) keeps running in the background. Stop it with: adf daemon stop')

    const failed = io(async () => { throw Object.assign(new Error('ADF Studio is running.'), { advice: 'Quit ADF Studio, then run adf again.' }) })
    expect(await runCli(['agents'], failed.value)).toBe(1)
    expect(failed.err()).toContain('ADF Studio is running.\nQuit ADF Studio, then run adf again.')
  })
})
