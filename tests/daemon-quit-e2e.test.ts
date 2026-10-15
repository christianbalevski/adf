/**
 * §8.3 quit behaviour against the real daemon bundle (tracker W4-A), end to
 * end: out/main/daemon.js in a fenced Electron-as-Node child on the fake
 * compute seam, a free port, isolated state, and the session expiry
 * shortened through the ADF_TEST_CLIENT_SESSION_EXPIRY_MS test seam (60 s in
 * a real run):
 *
 * - Studio crashed (its exitDaemonWhenClosed session expires): a daemon
 *   Studio started shuts itself down; one the CLI started keeps running.
 * - Studio quits with keepDaemonRunning off: the quit route stops a
 *   Studio-started daemon, not while the terminal app is connected.
 *
 * Every child is killed with taskkill /T /F (never a graceful stop from the
 * test). Skipped without the bundle: `npx electron-vite build`.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIENT_SESSION_EXPIRY_MS } from '../src/main/daemon/client-sessions'
import { FENCE_PATH, removeTreeWithoutLinks } from './parity/harness/env'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { AgentLeaseRegistry } from '../src/main/runtime/agent-lease'
import { waitForDaemonExit } from '../src/main/backend/daemon-mode/daemon-exit'

const REPO = resolve(__dirname, '..')
const BUNDLE = resolve(REPO, 'out/main/daemon.js')
const ELECTRON = resolve(REPO, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
const EXPIRY_MS = 1_500

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/** The sandbox standard library "installed", so the child never reaches npm (as the parity harness does). */
function stdlibManifest(userData: string): void {
  const source = readFileSync(resolve(REPO, 'src/main/services/sandbox-stdlib.service.ts'), 'utf-8')
  const list = source.slice(source.indexOf('const STDLIB_PACKAGES'), source.indexOf(']', source.indexOf('const STDLIB_PACKAGES')))
  const packages: Record<string, unknown> = {}
  for (const m of list.matchAll(/\{ name: '([^']+)', version: '([^']+)' \}/g)) packages[m[1]] = { name: m[1], version: m[2], installedAt: 0 }
  mkdirSync(join(userData, 'sandbox-stdlib'), { recursive: true })
  writeFileSync(join(userData, 'sandbox-stdlib', 'sandbox-stdlib-manifest.json'), JSON.stringify({ packages }))
}

interface Daemon {
  url: string
  token: string
  child: ChildProcess
  log: () => string
  exited: () => number | null
  waitExit: (ms: number) => Promise<boolean>
}

const roots: string[] = []
const children: ChildProcess[] = []

function kill(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch { /* gone */ }
}

afterEach(async () => {
  for (const child of children.splice(0)) kill(child)
  await new Promise((r) => setTimeout(r, 300))
  for (const root of roots.splice(0)) removeTreeWithoutLinks(root)
})

async function startDaemon(startedBy: 'studio' | 'cli'): Promise<Daemon & { root: string; pid: number }> {
  const root = mkdtempSync(join(tmpdir(), 'adf-quit-e2e-'))
  roots.push(root)
  const userData = join(root, 'user-data')
  const temp = join(root, 'temp')
  const home = join(root, 'home')
  for (const d of [userData, temp, home, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(d, { recursive: true })
  stdlibManifest(userData)
  // A provider for the agent the switch test loads; it never runs a turn, so nothing calls it.
  writeFileSync(join(userData, 'adf-settings.json'), JSON.stringify({
    providers: [{ id: 'p1', type: 'openai-compatible', name: 'P1', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModel: 'm1' }],
    defaultProviderId: 'p1', providerChecksEnabled: false, remoteCatalogsEnabled: false, updateChecksEnabled: false, meshEnabled: false,
  }))
  const port = await freePort()
  const meshPort = await freePort()
  const token = randomBytes(32).toString('base64url')
  const logFile = join(root, 'adf-daemon.log')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ADF_DAEMON_PORT: String(port),
    ADF_DAEMON_HOST: '127.0.0.1',
    ADF_DAEMON_SETTINGS: join(userData, 'adf-settings.json'),
    ADF_DAEMON_PIDFILE: join(root, 'daemon.pid'),
    ADF_DAEMON_TOKEN: token,
    ADF_DAEMON_STARTED_BY: startedBy,
    ADF_USER_DATA_DIR: userData,
    ADF_TEST_SEAMS: '1',
    ADF_COMPUTE: 'fake',
    ADF_KEYCHAIN: '0',
    ADF_TEST_CLIENT_SESSION_EXPIRY_MS: String(EXPIRY_MS),
    MESH_PORT: String(meshPort),
    MESH_HOST: '127.0.0.1',
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PARITY_FENCE_LOG: join(root, 'violations.log'),
    PARITY_FENCE_ROOT: root,
    PARITY_FENCE_PORTS: `${port},${meshPort}`,
  }
  delete env.ADF_SECRET_STORE
  delete env.ADF_TEST_KEYCHAIN_FILE
  const out = openSync(logFile, 'a')
  let exitCode: number | null = null
  let onExit: (() => void) | null = null
  const child = spawn(ELECTRON, ['--require', FENCE_PATH, BUNDLE], { env, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32', cwd: root })
  closeSync(out)
  children.push(child)
  child.once('exit', (code) => { exitCode = code ?? -1; onExit?.() })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  for (;;) {
    if (exitCode !== null) throw new Error(`daemon exited during boot (${exitCode}):\n${readFileSync(logFile, 'utf-8')}`)
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`daemon did not answer:\n${readFileSync(logFile, 'utf-8')}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  expect(readFileSync(logFile, 'utf-8')).toContain('[Compute] ADF_COMPUTE=fake')
  return {
    root,
    pid: child.pid!,
    url,
    token,
    child,
    log: () => readFileSync(logFile, 'utf-8'),
    exited: () => exitCode,
    waitExit: (ms) => new Promise<boolean>((done) => {
      if (exitCode !== null) return done(true)
      const timer = setTimeout(() => { onExit = null; done(false) }, ms)
      onExit = () => { clearTimeout(timer); done(true) }
    }),
  }
}

async function call<T>(d: Daemon, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${d.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${d.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status >= 300) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}\n${d.log().split(/\r?\n/).slice(-15).join('\n')}`)
  return await res.json() as T
}

const openSession = (d: Daemon, client: string, exitDaemonWhenClosed: boolean) =>
  call<{ sessionId: string }>(d, 'POST', '/client/sessions', { client, version: '1.0.0', exitDaemonWhenClosed })

describe.skipIf(!existsSync(BUNDLE))('quit behaviour against the daemon bundle (§8.3)', () => {
  it('a real run waits 60 s for a crashed Studio\'s session', () => {
    expect(CLIENT_SESSION_EXPIRY_MS).toBe(60_000)
  })

  it('Studio crashed: the daemon Studio started shuts down once its session expires', async () => {
    const d = await startDaemon('studio')
    await openSession(d, 'studio', true)
    // Studio never comes back (no stream, no quit): the orphan rule.
    expect(await d.waitExit(EXPIRY_MS + 25_000)).toBe(true)
    expect(d.log()).toMatch(/expired and asked to stop the daemon when closed, and no other client session is open/)
  }, 90_000)

  it('Studio crashed: a daemon the CLI started keeps running', async () => {
    const d = await startDaemon('cli')
    await openSession(d, 'studio', true)
    expect(await d.waitExit(EXPIRY_MS + 3_000)).toBe(false)
    expect(d.log()).toMatch(/Not stopping the daemon: .*started by cli, not Studio/)
  }, 90_000)

  it('a switch to embedded: Studio waits for the daemon process, which unloads its agent and frees its lease before it is gone', async () => {
    const d = await startDaemon('studio')
    const agentsDir = join(d.root, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const filePath = join(agentsDir, 'agent-1.adf')
    AdfWorkspace.create(filePath, { name: 'agent-1', handle: 'agent-1', autonomous: false, start_in_state: 'idle', model: { provider: 'p1', model_id: 'm1' } }).close()
    await call(d, 'POST', '/agents/load', { filePath })
    const studio = await openSession(d, 'studio', true)
    // While it runs there, another runtime cannot take the agent.
    const other = new AgentLeaseRegistry({ kind: 'studio-embedded', pid: 4_000_000 + Math.floor(Math.random() * 1000), sweepDeadEntries: false })
    try {
      expect((await other.acquire(filePath)).ok).toBe(false)
      await call(d, 'POST', `/client/sessions/${studio.sessionId}/quit`, { stopDaemon: true })
      // /health goes quiet first (the server closes before the agents unload); the pid is what Studio waits on.
      expect(await waitForDaemonExit(d.pid, 25_000)).toBe(true)
      expect(d.log()).toContain('stopping the daemon: Studio started this daemon run')
      expect(await d.waitExit(2_000)).toBe(true)
      // Embedded Studio can start the agent now.
      expect((await other.acquire(filePath)).ok).toBe(true)
    } finally {
      await other.close()
    }
  }, 90_000)

  it('Studio quits (keepDaemonRunning off): the daemon stops, unless the terminal app is still connected', async () => {
    const d = await startDaemon('studio')
    const studio = await openSession(d, 'studio', true)
    const tui = await openSession(d, 'tui', false)
    const held = await call<{ stopping: boolean; reason: string }>(d, 'POST', `/client/sessions/${studio.sessionId}/quit`, { stopDaemon: true })
    expect(held).toMatchObject({ stopping: false })
    expect(await d.waitExit(1_000)).toBe(false)
    // A second Studio session, quitting after the terminal app left: now it stops.
    const again = await openSession(d, 'studio', true)
    await call(d, 'DELETE', `/client/sessions/${tui.sessionId}`)
    const stop = await call<{ stopping: boolean; reason: string }>(d, 'POST', `/client/sessions/${again.sessionId}/quit`, { stopDaemon: true })
    expect(stop).toMatchObject({ stopping: true })
    expect(await d.waitExit(25_000)).toBe(true)
    expect(d.log()).toContain('stopping the daemon: Studio started this daemon run and no other client session is open')
  }, 90_000)
})
