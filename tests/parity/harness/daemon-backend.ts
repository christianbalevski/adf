import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { CLIENT_SETTINGS_KEYS } from '../../../src/shared/constants/client-settings-keys'
import { serializeStudioRuntimeEntry, studioRuntimeAccount, studioRuntimeScope } from '../../../src/main/daemon/studio-runtime-entry'
import { createRunResources, installEnvironmentStubs, releaseRunResources, srcPath, type BootedBackend, type ParityBackend } from './backend'
import type { FakeElectron } from './electron-fake'
import { FENCE_PATH, removeTreeWithoutLinks, type ParityEnv } from './env'
import { IDENTITY } from './fixtures'
import identityFixture from './identity.fixture.json'

/**
 * Daemon-mode backend (README "Daemon backend (W2-C)"): the built daemon
 * bundle `out/main/daemon.js` in a child process, run by Studio's own
 * Electron binary in Node mode, fenced, on the fake compute seam; Studio
 * main's daemon-mode handlers in this process against the same fake
 * `electron`.
 *
 * What a switch to local mode does before Studio first attaches (W4-A,
 * design §4.3, §5.3) is done here the same way: the client keys of
 * adf-settings.json are copied into studio-client-settings.json, and the
 * owner phrase plus the `studio-runtime:<scope>` entry are in the "OS
 * keychain" (the plaintext test keychain file, ADF_TEST_KEYCHAIN_FILE).
 *
 * Shutdown runs Studio's daemon-mode quit path (end the client session),
 * then kills the daemon with `taskkill /T /F` (a process-group SIGKILL
 * elsewhere). Never a graceful daemon stop: that reaches
 * PodmanService.stopAll (incident 2026-10-14).
 */

const REPO = resolve(__dirname, '../../..')
const ELECTRON = resolve(REPO, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
export const DAEMON_BUNDLE = resolve(REPO, 'out/main/daemon.js')
/** The OS temp dir before any run points TEMP into its root: harness files that are not the backend's state go here. */
const OUTSIDE_TMP = tmpdir()
const BOOT_TIMEOUT_MS = 90_000

/**
 * Every daemon child still alive. If the test process exits before a
 * shutdown ran (a crash, a timeout that kills the worker), they are killed
 * on the way out, the same hard way.
 */
const LIVE_DAEMONS = new Set<number>()
process.on('exit', () => {
  for (const pid of LIVE_DAEMONS) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      else process.kill(-pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
})

type DaemonModeModule = typeof import('../../../src/main/backend/daemon-mode/index')
type LeaseModule = typeof import('../../../src/main/runtime/agent-lease')

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => done(port))
    })
  })
}

/** `safe:` values of the identity fixture use the electron fake's encoding (electron-fake.ts). */
function unsafe(value: unknown): string {
  const text = Buffer.from(String(value).replace(/^safe:/, ''), 'base64').toString('utf-8')
  if (!text.startsWith('parity-safe:')) throw new Error('parity harness: identity fixture value is not in the fake safeStorage encoding')
  return text.slice('parity-safe:'.length)
}

/** The test keychain a local-mode switch leaves behind: owner phrase (Studio mirrors it) and Studio's runtime entry. */
function writeTestKeychain(file: string, settingsPath: string): void {
  const f = identityFixture as Record<string, unknown>
  const values: Record<string, string> = {
    'owner-mnemonic': unsafe(f.ownerMnemonic),
    [studioRuntimeAccount(studioRuntimeScope(settingsPath))]: serializeStudioRuntimeEntry({
      runtimeDid: IDENTITY.runtimeDid,
      runtimeDelegation: f.runtimeDelegation as never,
      runtimePrivateKey: unsafe(f.runtimePrivateKey),
      runtimeEncPrivateKey: unsafe(f.runtimeEncPrivateKey),
      runtimeEncPublicKey: String(f.runtimeEncPublicKey),
    }),
  }
  writeFileSync(file, JSON.stringify(values, null, 2))
}

/**
 * The embedded side runs with the sandbox standard library "already
 * installed" (a module stub, backend.ts); module stubs do not reach the
 * child, and its real service would `npm install` from the registry (the
 * fence refuses that). The child gets the same answer from a manifest that
 * names every pinned package at its version; the manifest is removed again
 * once the daemon logged that it read it, so the run's state is the
 * daemon's own.
 */
const STDLIB_DIR = 'sandbox-stdlib'
function writeStdlibManifest(env: ParityEnv): string {
  const source = readFileSync(resolve(REPO, 'src/main/services/sandbox-stdlib.service.ts'), 'utf-8')
  const list = source.slice(source.indexOf('const STDLIB_PACKAGES'), source.indexOf(']', source.indexOf('const STDLIB_PACKAGES')))
  const packages: Record<string, { name: string; version: string; installedAt: number }> = {}
  for (const m of list.matchAll(/\{ name: '([^']+)', version: '([^']+)' \}/g)) packages[m[1]] = { name: m[1], version: m[2], installedAt: 0 }
  if (Object.keys(packages).length === 0) throw new Error('parity harness: could not read STDLIB_PACKAGES from sandbox-stdlib.service.ts')
  const dir = join(env.userDataDir, STDLIB_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sandbox-stdlib-manifest.json'), JSON.stringify({ packages }, null, 2))
  return dir
}

async function waitForLog(logFile: string, text: string, timeoutMs: number, from = 0): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (readFileSync(logFile, 'utf-8').slice(from).includes(text)) return true } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/**
 * The harness emulates W4-A's switch to local mode (below). Set to false
 * once W4-A ships the switch: the allowlist entry `w4a:local-mode-switch`
 * matches only while this is true, so it cannot outlive the emulation.
 */
export const EMULATE_W4A = true

/**
 * W4-A EMULATION: what the switch from embedded to local mode does before
 * Studio first attaches (design §4.3, §5.3, tracker W4-A). Until W4-A ships
 * it, the harness does it the same way:
 *
 * - the client keys MOVE from adf-settings.json into
 *   studio-client-settings.json (none stays in both files);
 * - the owner phrase and the `studio-runtime:<scope>` entry go into the "OS
 *   keychain" (the plaintext test keychain file), so the daemon adopts the
 *   fixture's runtime identity.
 *
 * The allowlist entry `w4a:local-mode-switch` (harness/gaps.ts) names it.
 */
export function emulateLocalModeSwitch(env: ParityEnv, keychainFile: string): void {
  const settingsPath = join(env.userDataDir, 'adf-settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  const client: Record<string, unknown> = {}
  for (const key of CLIENT_SETTINGS_KEYS) {
    if (!(key in settings)) continue
    client[key] = settings[key]
    delete settings[key]
  }
  writeFileSync(join(env.userDataDir, 'studio-client-settings.json'), JSON.stringify(client, null, 2))
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  writeTestKeychain(keychainFile, settingsPath)
}

async function waitHealthy(url: string, child: ChildProcess, exited: () => number | null, logFile: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited() !== null) break
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  let tail = ''
  try { tail = readFileSync(logFile, 'utf-8').split(/\r?\n/).slice(-30).join('\n') } catch { /* no log */ }
  throw new Error(`parity harness: the daemon child (pid ${child.pid}) did not answer ${url}/health${exited() !== null ? ` (exited ${exited()})` : ''}\n${tail}`)
}

/** Hard kill of the daemon and everything it started. Never graceful (see the file comment). */
async function killTree(child: ChildProcess, exited: () => number | null): Promise<void> {
  if (child.pid === undefined || exited() !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((done) => execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => done()))
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
  }
  const deadline = Date.now() + 10_000
  while (exited() === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
}

export interface DaemonBackendOptions {
  /** Default `built` (out/main/daemon.js). `source` runs src/main/daemon/index.ts through tsx: development loop only. */
  entry?: 'built' | 'source'
  /**
   * Remote mode (W4-B): Studio runs `mode: 'remote'` with the real remote
   * connector (transport rule, handshake) and reaches the daemon through a
   * loopback proxy that behaves like another machine's: it adds
   * X-Forwarded-For (the daemon then treats no request as local) and strips
   * X-ADF-Local-Proof. A proof seen by the proxy is a leak (Studio must
   * never send one remotely). No interface but loopback is bound.
   */
  remote?: boolean
}

/** Header names the remote proxy drops on the way to the daemon. */
const LOCAL_PROOF = 'x-adf-local-proof'

/**
 * The "other machine": forwards every request to the daemon port, streaming
 * both ways (the client event stream is SSE), as a reverse proxy on another
 * host would. Records the requests that carried a local proof.
 */
async function startRemoteProxy(daemonPort: number): Promise<{ server: Server; port: number; proofsSeen: string[] }> {
  const proofsSeen: string[] = []
  const server = createHttpServer((req, res) => {
    const headers = { ...req.headers }
    if (headers[LOCAL_PROOF] !== undefined) {
      proofsSeen.push(`${req.method} ${req.url}`)
      delete headers[LOCAL_PROOF]
    }
    headers.host = `127.0.0.1:${daemonPort}`
    headers['x-forwarded-for'] = '198.51.100.7'
    const upstream = httpRequest({ host: '127.0.0.1', port: daemonPort, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
    res.on('close', () => upstream.destroy())
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0, proofsSeen }
}

/** The daemon backend's booted form: also lets a test kill and restart the daemon child. */
export interface BootedDaemonBackend extends BootedBackend {
  /** Hard-kill the daemon child (taskkill /T /F), as a crash or a Defender kill would. */
  killDaemon(): Promise<void>
  /** Start a new daemon child on the same port, settings and keychain; resolves once it answers /health. */
  restartDaemon(): Promise<void>
  /** Studio's daemon-mode handle (connection, session, bridge). */
  readonly handle: import('../../../src/main/backend/daemon-mode/index').DaemonModeHandle
}

interface DaemonChild {
  child: ChildProcess
  exited(): number | null
}

export type DaemonParityBackend = ParityBackend & { boot(env: ParityEnv, electron: FakeElectron): Promise<BootedDaemonBackend> }

export function daemonBackend(options: DaemonBackendOptions = {}): DaemonParityBackend {
  return {
    name: 'daemon',
    async boot(env, electron) {
      if ((options.entry ?? 'built') === 'built' && !existsSync(DAEMON_BUNDLE)) {
        throw new Error(`parity harness: ${DAEMON_BUNDLE} is missing; build it first (npx electron-vite build)`)
      }
      const port = await freePort()
      env.allowPort(port)
      const url = `http://127.0.0.1:${port}`
      const token = randomBytes(32).toString('base64url')
      const outside = mkdtempSync(join(OUTSIDE_TMP, 'adf-parity-daemon-'))
      const logFile = join(outside, 'adf-daemon.log')
      const keychainFile = join(outside, 'keychain.json')
      const settingsPath = join(env.userDataDir, 'adf-settings.json')
      if (EMULATE_W4A) emulateLocalModeSwitch(env, keychainFile)

      const startChild = async (): Promise<DaemonChild> => {
        const stdlibDir = writeStdlibManifest(env)
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ADF_DAEMON_PORT: String(port),
          ADF_DAEMON_HOST: '127.0.0.1',
          ADF_DAEMON_SETTINGS: settingsPath,
          ADF_DAEMON_PIDFILE: join(outside, 'daemon.pid'),
          ADF_DAEMON_TOKEN: token,
          ADF_DAEMON_STARTED_BY: 'studio',
          ADF_TEST_SEAMS: '1',
          ADF_COMPUTE: 'fake',
          ADF_TEST_KEYCHAIN_FILE: keychainFile,
        }
        // The test keychain file stands in for the OS keychain; the fence
        // refuses the real keychain addon in the child (fence.cjs).
        delete childEnv.ADF_KEYCHAIN
        delete childEnv.ADF_SECRET_STORE
        const args = (options.entry ?? 'built') === 'built'
          ? ['--require', FENCE_PATH, DAEMON_BUNDLE]
          : ['--require', FENCE_PATH, '--import', 'tsx', resolve(REPO, 'src/main/daemon/index.ts')]
        const logStart = existsSync(logFile) ? readFileSync(logFile, 'utf-8').length : 0
        const out = openSync(logFile, 'a')
        let exitCode: number | null = null
        const child = spawn(ELECTRON, args, { env: childEnv, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32', cwd: outside })
        closeSync(out)
        if (child.pid !== undefined) LIVE_DAEMONS.add(child.pid)
        child.once('exit', (code) => {
          exitCode = code ?? -1
          if (child.pid !== undefined) LIVE_DAEMONS.delete(child.pid)
        })
        const exited = () => exitCode
        try {
          await waitHealthy(url, child, exited, logFile)
          // The fake compute seam MUST be on: a real PodmanService stops every adf-* container on shutdown.
          if (!(await waitForLog(logFile, '[Compute] ADF_COMPUTE=fake', 5_000, logStart))) {
            throw new Error(`parity harness: the daemon child did not log the fake compute seam ([Compute] ADF_COMPUTE=fake); killed (log ${logFile})`)
          }
          if (!(await waitForLog(logFile, '[SandboxStdlib] Standard library up to date', 30_000, logStart))) {
            throw new Error(`parity harness: the daemon child did not report the sandbox standard library as installed (log ${logFile})`)
          }
        } catch (err) {
          await killTree(child, exited)
          throw err
        }
        const stdlibLinks = removeTreeWithoutLinks(stdlibDir)
        if (stdlibLinks.length) throw new Error(`parity harness: ${stdlibDir} contains links: ${stdlibLinks.join(', ')}`)
        return { child, exited }
      }

      let daemon = await startChild()
      const pids: Array<number | undefined> = [daemon.child.pid]
      let proxy: Awaited<ReturnType<typeof startRemoteProxy>> | null = null
      if (options.remote) {
        try {
          proxy = await startRemoteProxy(port)
          env.allowPort(proxy.port)
        } catch (err) {
          await killTree(daemon.child, daemon.exited)
          throw err
        }
      }

      let handle: import('../../../src/main/backend/daemon-mode/index').DaemonModeHandle
      let leases: LeaseModule
      const resources = createRunResources()
      let booted = false
      try {
        vi.resetModules()
        installEnvironmentStubs(electron, resources)
        const daemonMode = (await import(/* @vite-ignore */ srcPath('main/backend/daemon-mode/index.ts'))) as DaemonModeModule
        leases = (await import(/* @vite-ignore */ srcPath('main/runtime/agent-lease.ts'))) as LeaseModule
        let connect: import('../../../src/main/backend/daemon-mode/connection').DaemonConnector = Object.assign(
          async () => ({ baseUrl: url, logFile, description: `the parity daemon pid ${daemon.child.pid} on ${url}`, source: { token: () => token } }),
          { logFile })
        if (proxy) {
          // The real remote connector, on a studio-backend.json config whose token is "safe:" in a stand-in codec.
          const remoteConnector = (await import(/* @vite-ignore */ srcPath('main/backend/daemon-mode/remote/connector.ts'))) as typeof import('../../../src/main/backend/daemon-mode/remote/connector')
          const codec = { available: () => true, encrypt: (p: string) => `safe:${Buffer.from(p).toString('base64')}`, decrypt: (s: string) => Buffer.from(s.slice(5), 'base64').toString() }
          connect = remoteConnector.remoteDaemonConnector({
            v: 1, mode: 'remote', keepDaemonRunning: false,
            remote: { url: `http://127.0.0.1:${proxy.port}`, token: codec.encrypt(token), allowInsecureHttp: false },
          }, codec)
        }
        handle = daemonMode.registerDaemonModeHandlers({
          mode: proxy ? 'remote' : 'local',
          userDataDir: env.userDataDir,
          connect,
          // The OS keychain's shared owner-phrase entry is the test keychain file here, as for the daemon child.
          sharedMnemonic: () => ({
            read: () => {
              try { return (JSON.parse(readFileSync(keychainFile, 'utf-8')) as Record<string, string>)['owner-mnemonic'] ?? null } catch { return null }
            },
            write: () => { throw new Error('parity harness: Studio main does not write the shared owner phrase in daemon mode') },
          }),
          hooks: {
            showMainWindow: () => { electron.openWindow(); return null },
            openFile: (filePath) => { electron.localCalls.push({ api: 'hooks.openFile', args: [filePath] }) },
          },
        })
        electron.openWindow()
        if (!(await handle.ready)) throw new Error('parity harness: Studio daemon mode could not connect to the daemon child')
        booted = true
      } finally {
        // Whatever failed after the child started, the child goes with it.
        if (!booted) {
          await killTree(daemon.child, daemon.exited)
          proxy?.server.close()
        }
      }

      const known = () => pids.filter((p): p is number => p !== undefined)
      let leaks: string[] = []
      return {
        handle,
        async killDaemon() {
          await killTree(daemon.child, daemon.exited)
        },
        async restartDaemon() {
          if (daemon.exited() === null) throw new Error('parity harness: restartDaemon with the daemon still running')
          daemon = await startChild()
          pids.push(daemon.child.pid)
        },
        async shutdown() {
          try {
            await handle.shutdown()
            await leases.resetProcessAgentLeases()
          } finally {
            await killTree(daemon.child, daemon.exited)
            if (proxy) {
              proxy.server.closeAllConnections()
              await new Promise<void>((done) => proxy!.server.close(() => done()))
            }
          }
          leaks = await releaseRunResources(resources, env)
          if (proxy && proxy.proofsSeen.length > 0) leaks.push(`remote mode sent the local proof to the daemon: ${proxy.proofsSeen.join(', ')}`)
          if (daemon.exited() === null) leaks.push(`daemon child pid ${daemon.child.pid} still running after taskkill`)
          // Debugging aid: PARITY_DAEMON_LOG_DIR=<dir> keeps a copy of each run's daemon log.
          if (process.env.PARITY_DAEMON_LOG_DIR) {
            try { copyFileSync(logFile, join(process.env.PARITY_DAEMON_LOG_DIR, `adf-daemon-${daemon.child.pid}.log`)) } catch { /* no log */ }
          }
          const links = removeTreeWithoutLinks(outside)
          if (links.length) leaks.push(`refusing to delete ${outside}; it contains links: ${links.join(', ')}`)
        },
        leaks: () => leaks,
        // The daemon's compute calls are inside the child (ADF_COMPUTE=fake); none reach this process.
        computeCalls: () => resources.compute.calls,
        normalization: () => ({
          ports: [{ value: String(port), name: 'DAEMON_PORT' }, ...(proxy ? [{ value: String(proxy.port), name: 'REMOTE_PROXY_PORT' }] : [])],
          pids: known().map((value, i) => ({ value, name: i === 0 ? 'pid:daemon' : `pid:daemon#${i + 1}` })),
          named: [
            ...known().map((p, i) => ({ value: `adf-scratch-${p}`, name: i === 0 ? 'scratch-root:daemon' : `scratch-root:daemon#${i + 1}` })),
            // local-access.ts: the proof file is named after the daemon's (per-run) port.
            { value: `daemon-local-proof-${port}`, name: 'daemon-local-proof-file' },
          ],
        }),
      }
    },
  }
}
