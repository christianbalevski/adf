import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDaemonEnv,
  decideAttach,
  DaemonProcessController,
  DaemonProcessError,
  type SpawnFn,
} from '../../src/main/backend/daemon-process'
import { CLIENT_API_VERSION, type DaemonVersionInfo } from '../../src/main/daemon/routes/meta-routes'

const TOKEN = 'a'.repeat(43)
const PORT = 17491

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-daemon-process-'))
  settingsPath = join(dir, 'adf-settings.json')
  writeFileSync(join(dir, 'daemon-token'), TOKEN)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function info(over: Partial<DaemonVersionInfo> = {}): DaemonVersionInfo {
  return {
    version: '0.7.8',
    clientApiVersion: CLIENT_API_VERSION,
    settingsPath,
    dataDir: dir,
    runtimeId: 'runtime-1',
    pid: 4242,
    startedBy: 'studio',
    ...over,
  }
}

/** A daemon behind fetch: health, /version and /daemon/shutdown, with every request recorded. */
function fakeDaemon(state: { up: boolean; info: DaemonVersionInfo | null; versionStatus?: number }) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, auth: headers.Authorization ?? null })
    if (!state.up) throw new TypeError('fetch failed')
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/health') return json(200, { ok: true })
    if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized', code: 'unauthorized' })
    if (url.pathname === '/version') {
      if (state.versionStatus) return json(state.versionStatus, { error: 'x' })
      return json(200, state.info)
    }
    if (url.pathname === '/daemon/shutdown') {
      state.up = false
      return json(202, { accepted: true, pid: state.info?.pid })
    }
    return json(404, { error: 'not found' })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function fakeSpawner(onSpawn: () => void = () => {}, pid = 4242) {
  const spawns: Array<{ command: string; args: string[]; options: Parameters<SpawnFn>[2] }> = []
  let unrefs = 0
  const child = Object.assign(new EventEmitter(), { pid, unref: () => { unrefs++ } })
  const spawn: SpawnFn = (command, args, options) => {
    spawns.push({ command, args, options })
    onSpawn()
    return child as unknown as ReturnType<SpawnFn>
  }
  return { spawn, spawns, child, unrefs: () => unrefs }
}

function controller(fetchImpl: typeof fetch, extra: { spawn?: SpawnFn; alive?: (pid: number) => boolean; env?: NodeJS.ProcessEnv } = {}) {
  const logs: string[] = []
  const ctl = new DaemonProcessController({
    settingsPath,
    userDataDir: dir,
    port: PORT,
    daemonEntry: join('app', 'out', 'main', 'daemon.js'),
    execPath: join('app', 'ADF Studio.exe'),
    env: extra.env ?? { PATH: '/usr/bin' },
  }, {
    fetch: fetchImpl,
    spawn: extra.spawn,
    processAlive: extra.alive ?? (() => false),
    sleep: () => new Promise(r => setTimeout(r, 1)),
    log: (line) => logs.push(line),
    startTimeoutMs: 2000,
    stopTimeoutMs: 2000,
    staleWaitMs: 200,
    raceSettleMs: 200,
  })
  return { ctl, logs }
}

describe('buildDaemonEnv', () => {
  it('drops Electron and Node switches, sets run-as-node and the CLI locations', () => {
    const env = buildDaemonEnv({
      PATH: '/usr/bin',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      ELECTRON_ENABLE_LOGGING: '1',
      electron_no_attach_console: '1',
      NODE_OPTIONS: '--inspect=9229',
      ADF_DAEMON_PORT: '9999',
      ADF_DAEMON_STARTED_BY: 'cli',
      MESH_PORT: '7295',
    }, { settingsPath, pidFile: join(dir, 'adf-daemon.pid'), port: PORT, userDataDir: dir })
    expect(Object.keys(env).filter(k => /^ELECTRON_/i.test(k))).toEqual(['ELECTRON_RUN_AS_NODE'])
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      MESH_PORT: '7295',
      ELECTRON_RUN_AS_NODE: '1',
      ADF_DAEMON_PORT: String(PORT),
      ADF_DAEMON_HOST: '127.0.0.1',
      ADF_DAEMON_SETTINGS: settingsPath,
      ADF_DAEMON_PIDFILE: join(dir, 'adf-daemon.pid'),
      ADF_DAEMON_STARTED_BY: 'studio',
      ADF_USER_DATA_DIR: dir,
    })
    expect(env.NODE_OPTIONS).toBeUndefined()
  })
})

describe('decideAttach', () => {
  it('attaches to a daemon on the same settings and client API version', () => {
    expect(decideAttach(info(), { settingsPath })).toEqual({ kind: 'attach' })
  })
  it('refuses a daemon on another settings file and names it', () => {
    const d = decideAttach(info({ settingsPath: join(dir, 'other', 'adf-settings.json') }), { settingsPath })
    expect(d.kind).toBe('settings-mismatch')
    expect(d.kind === 'settings-mismatch' && d.message).toContain(join(dir, 'other', 'adf-settings.json'))
  })
  it('reports a client API version mismatch with both versions', () => {
    const d = decideAttach(info({ clientApiVersion: CLIENT_API_VERSION + 1, version: '0.9.0' }), { settingsPath })
    expect(d).toMatchObject({ kind: 'version-mismatch', daemonVersion: '0.9.0', daemonClientApiVersion: CLIENT_API_VERSION + 1 })
  })
})

describe('DaemonProcessController', () => {
  it('detects no daemon', async () => {
    const { fetchImpl } = fakeDaemon({ up: false, info: null })
    expect(await controller(fetchImpl).ctl.detect()).toEqual({ state: 'absent' })
  })

  it('detects a starting daemon from a live pid in the CLI pid file', async () => {
    const { fetchImpl } = fakeDaemon({ up: false, info: null })
    writeFileSync(join(dir, `adf-daemon-${PORT}.pid`), JSON.stringify({ pid: 777, startedAt: Date.now() }))
    const { ctl } = controller(fetchImpl, { alive: (pid) => pid === 777 })
    expect(ctl.paths.pidFile).toBe(join(dir, `adf-daemon-${PORT}.pid`))
    expect(await ctl.detect()).toEqual({ state: 'starting', pid: 777 })
  })

  it('detects a running daemon through GET /version with the data dir token', async () => {
    const { fetchImpl, calls } = fakeDaemon({ up: true, info: info({ startedBy: 'cli' }) })
    expect(await controller(fetchImpl).ctl.detect()).toEqual({ state: 'running', info: info({ startedBy: 'cli' }) })
    expect(calls.find(c => c.path === '/version')?.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('ignores a pid file from before this boot (the pid now belongs to another process)', async () => {
    const { fetchImpl } = fakeDaemon({ up: false, info: null })
    writeFileSync(join(dir, `adf-daemon-${PORT}.pid`), JSON.stringify({ pid: 777, startedAt: 1, image: 'adf-daemon' }))
    const { ctl } = controller(fetchImpl, { alive: () => true })
    expect(await ctl.detect()).toEqual({ state: 'absent' })
  })

  it('treats a live but silent pid as stale after the wait, removes the pid file and spawns', async () => {
    const pidFile = join(dir, `adf-daemon-${PORT}.pid`)
    writeFileSync(pidFile, JSON.stringify({ pid: 777, startedAt: Date.now(), image: 'adf-daemon' }))
    const state = { up: false, info: info({ pid: 4242 }) }
    const { fetchImpl } = fakeDaemon(state)
    const spawner = fakeSpawner(() => setTimeout(() => { state.up = true }, 0))
    const { ctl, logs } = controller(fetchImpl, { spawn: spawner.spawn, alive: (pid) => pid === 777 })
    const result = await ctl.ensure()
    expect(result).toMatchObject({ kind: 'spawned', handle: { pid: 4242, spawnedHere: true } })
    expect(existsSync(pidFile)).toBe(false)
    expect(logs.some(l => l.includes('treating the pid file as stale'))).toBe(true)
  })

  it('reports a daemon that rejects the token as unidentified', async () => {
    const { fetchImpl } = fakeDaemon({ up: true, info: info() })
    const { ctl } = controller(fetchImpl, { env: { ADF_DAEMON_TOKEN: 'b'.repeat(43) } })
    const d = await ctl.detect()
    expect(d).toMatchObject({ state: 'unidentified', status: 401 })
    expect(d.state === 'unidentified' && d.message).toBe(`A daemon is running on port ${PORT} but Studio cannot authenticate to it (token from ADF_DAEMON_TOKEN).`)
  })

  it('spawns detached, hidden, in Node mode, on the CLI pid file, and attaches', async () => {
    const state = { up: false, info: info({ pid: 4242 }) }
    const { fetchImpl } = fakeDaemon(state)
    // The daemon answers once it has been spawned.
    const spawner = fakeSpawner(() => setTimeout(() => { state.up = true }, 0))
    const { ctl, logs } = controller(fetchImpl, { spawn: spawner.spawn })
    const progress: string[] = []
    const result = await ctl.ensure(text => progress.push(text))
    expect(result.kind).toBe('spawned')
    expect(result.kind === 'spawned' && result.handle).toMatchObject({ pid: 4242, spawnedHere: true })
    expect(spawner.spawns).toHaveLength(1)
    const { command, args, options } = spawner.spawns[0]
    expect(command).toBe(join('app', 'ADF Studio.exe'))
    expect(args).toEqual([join('app', 'out', 'main', 'daemon.js')])
    expect(options).toMatchObject({ detached: true, windowsHide: true, cwd: dir })
    expect(options.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      ADF_DAEMON_PIDFILE: join(dir, `adf-daemon-${PORT}.pid`),
      ADF_DAEMON_SETTINGS: settingsPath,
      ADF_DAEMON_STARTED_BY: 'studio',
    })
    expect(spawner.unrefs()).toBe(1)
    expect(progress).toEqual(['Starting the ADF daemon…'])
    expect(logs.some(l => l.includes('Starting the ADF daemon'))).toBe(true)
    expect(logs.some(l => l.includes('Started and attached to the ADF daemon pid 4242'))).toBe(true)
  })

  it('attaches to the winner, not spawnedHere, when the child loses the start race and exits', async () => {
    const state = { up: false, info: info({ pid: 900, startedBy: 'cli' }) }
    const { fetchImpl } = fakeDaemon(state)
    // A CLI daemon binds the port; ours exits on EADDRINUSE.
    const spawner = fakeSpawner(() => setTimeout(() => { spawner.child.emit('exit', 1); setTimeout(() => { state.up = true }, 20) }, 0), 4242)
    const { ctl, logs } = controller(fetchImpl, { spawn: spawner.spawn, alive: (pid) => pid === 900 })
    const result = await ctl.ensure()
    expect(result).toMatchObject({ kind: 'attached', handle: { pid: 900, spawnedHere: false } })
    expect(logs.some(l => l.includes('exited (code 1)') && l.includes('pid 900'))).toBe(true)
  })

  it('does not mark another daemon spawnedHere when it answers before the child', async () => {
    const state = { up: false, info: info({ pid: 900, startedBy: 'studio' }) }
    const { fetchImpl, calls } = fakeDaemon(state)
    const spawner = fakeSpawner(() => setTimeout(() => { state.up = true }, 0), 4242)
    const { ctl } = controller(fetchImpl, { spawn: spawner.spawn, alive: () => true })
    const result = await ctl.ensure()
    expect(result).toMatchObject({ kind: 'attached', handle: { pid: 900, spawnedHere: false } })
    expect(calls.some(c => c.path === '/daemon/shutdown')).toBe(false)
  })

  it('attaches to a running daemon without spawning', async () => {
    const { fetchImpl } = fakeDaemon({ up: true, info: info({ startedBy: 'cli', pid: 900 }) })
    const spawner = fakeSpawner()
    const result = await controller(fetchImpl, { spawn: spawner.spawn }).ctl.ensure()
    expect(result).toMatchObject({ kind: 'attached', handle: { pid: 900, spawnedHere: false } })
    expect(spawner.spawns).toHaveLength(0)
  })

  it('does not attach to, restart or replace a daemon of another client API version', async () => {
    const { fetchImpl, calls } = fakeDaemon({ up: true, info: info({ clientApiVersion: 99 }) })
    const spawner = fakeSpawner()
    const result = await controller(fetchImpl, { spawn: spawner.spawn }).ctl.ensure()
    expect(result).toMatchObject({ kind: 'refused', decision: { kind: 'version-mismatch' } })
    expect(spawner.spawns).toHaveLength(0)
    expect(calls.some(c => c.path === '/daemon/shutdown')).toBe(false)
  })

  it('fails visibly when the spawned daemon exits during startup', async () => {
    const { fetchImpl } = fakeDaemon({ up: false, info: null })
    const spawner = fakeSpawner(() => setTimeout(() => spawner.child.emit('exit', 1), 0))
    const { ctl, logs } = controller(fetchImpl, { spawn: spawner.spawn })
    await expect(ctl.spawn()).rejects.toThrow(DaemonProcessError)
    await expect(ctl.spawn()).rejects.toThrow(/exited during startup \(code 1\)/)
    expect(logs.some(l => l.includes('exited during startup'))).toBe(true)
  })

  it('stops a daemon Studio started, through POST /daemon/shutdown with the token', async () => {
    const state = { up: true, info: info({ startedBy: 'studio', pid: 4242 }) }
    const { fetchImpl, calls } = fakeDaemon(state)
    const { ctl } = controller(fetchImpl, { alive: () => state.up })
    const attached = await ctl.ensure()
    if (attached.kind !== 'attached') throw new Error(attached.kind)
    const result = await ctl.stop(attached.handle)
    expect(result.stopped).toBe(true)
    expect(calls.filter(c => c.path === '/daemon/shutdown')).toEqual([{ method: 'POST', path: '/daemon/shutdown', auth: `Bearer ${TOKEN}` }])
  })

  it('never stops a daemon the CLI started', async () => {
    const state = { up: true, info: info({ startedBy: 'cli', pid: 900 }) }
    const { fetchImpl, calls } = fakeDaemon(state)
    const { ctl, logs } = controller(fetchImpl, { alive: () => state.up })
    const attached = await ctl.ensure()
    if (attached.kind !== 'attached') throw new Error(attached.kind)
    const result = await ctl.stop(attached.handle)
    expect(result).toEqual({ stopped: false, message: 'Not stopping the ADF daemon pid 900: it was started by cli, not Studio.' })
    expect(calls.some(c => c.path === '/daemon/shutdown')).toBe(false)
    expect(logs).toContain('[DaemonProcess] Not stopping the ADF daemon pid 900: it was started by cli, not Studio.')
  })

  it('never stops a different daemon that took the port after Studio attached', async () => {
    const state = { up: true, info: info({ startedBy: 'studio', pid: 4242 }) }
    const { fetchImpl, calls } = fakeDaemon(state)
    const { ctl } = controller(fetchImpl, { alive: () => true })
    const attached = await ctl.ensure()
    if (attached.kind !== 'attached') throw new Error(attached.kind)
    state.info = info({ startedBy: 'studio', pid: 5555 })
    const result = await ctl.stop(attached.handle)
    expect(result.stopped).toBe(false)
    expect(result.message).toContain('pid 5555')
    expect(calls.some(c => c.path === '/daemon/shutdown')).toBe(false)
  })
})
