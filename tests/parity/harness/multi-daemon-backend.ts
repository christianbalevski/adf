import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { createRunResources, installEnvironmentStubs, releaseRunResources, srcPath, type BootedBackend, type ParityBackend } from './backend'
import {
  DAEMON_BUNDLE, ELECTRON, LIVE_DAEMONS, REMOTE_PROXY_HOST,
  freePort, killTree, switchToLocalMode, waitForLog, waitHealthy, writeStdlibManifest,
} from './daemon-backend'
import type { FakeElectron } from './electron-fake'
import { FENCE_PATH, removeTreeWithoutLinks, type ParityEnv } from './env'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { createFixtureAgents, type FixtureAgent, type FixtureSpec } from './fixtures'
import { waitForUsageOnDisk } from './usage-flush'
import { waitForLeasesSettled } from './lease-settle'

/**
 * Multi-daemon backend (docs/design/multi-runtime.md §9.1; README
 * "Multi-daemon backend"): Studio in local mode with a runtime set of two
 * built daemon bundles, each in its own fenced child process.
 *
 * - `local`: the run's own daemon on the run's user data, master token and
 *   local proof, exactly as daemonBackend().
 * - the remote (`remote:<name>`): a second daemon with its own isolated
 *   root (settings, user data, agents, lease registry, keychain file, temp),
 *   its own loopback port and mesh port. Studio reaches it through a
 *   loopback proxy that acts as the other computer (it forwards a public
 *   Host and X-Forwarded-For, so the daemon treats no request as local, and
 *   records any local proof as a leak). The proxy answers GET /remote/hello
 *   with the remote's name and fingerprint: remote access cannot be turned on
 *   in a fenced daemon (its probes spawn tailscale, the firewall and the
 *   network-category tools, which the fence refuses).
 * - a saved connection for it in a Studio connections folder of its own
 *   (cli-remotes.json, its token in the run's file secret store:
 *   ADF_KEYCHAIN=0, ADF_SECRET_STORE=file), pinned to that fingerprint.
 *   Studio's connector is the real remote connector of a saved connection
 *   (savedConnectionTarget, the pin check, the handshake), and a
 *   SavedConnectionsCache on that folder syncs the runtime set, as
 *   main/index.ts does.
 *
 * Every daemon is killed the hard way (taskkill /T /F), never stopped.
 */

type DaemonModeModule = typeof import('../../../src/main/backend/daemon-mode/index')
type LeaseModule = typeof import('../../../src/main/runtime/agent-lease')
type ConnectionsModule = typeof import('../../../src/main/backend/connections')

export interface MultiDaemonOptions {
  /** The saved connection's name; the runtime id is `remote:<name>`. Default `host-1`. */
  remoteName?: string
  /** Agents in the remote's own agents folder. Default agent-2. */
  remoteFixtures?: readonly FixtureSpec[]
  /** Save the connection before Studio boots (default true); false: the test saves it while Studio runs. */
  savedAtBoot?: boolean
  /**
   * Record only This computer's pushes: a push tagged with a runtime is
   * dropped from the recording as it arrives (watermarks stay consistent),
   * so the recording can be compared with a single-runtime one.
   */
  thisComputerOnly?: boolean
  /** Tools made restricted (an LLM call asks for approval) in every fixture agent of both runtimes. */
  restrictTools?: readonly string[]
  /** studio-backend.json keepDaemonRunning: This computer's daemon outlives Studio's quit (a test that quits Studio itself). */
  keepDaemonRunning?: boolean
}

/** Mark tools restricted in an agent file before any daemon opens it. */
function restrictTools(filePath: string, tools: readonly string[]): void {
  const workspace = AdfWorkspace.open(filePath)
  try {
    const config = workspace.getAgentConfig()
    for (const name of tools) {
      const tool = config.tools.find((t) => t.name === name)
      if (tool) Object.assign(tool, { enabled: true, visible: true, restricted: true })
      else config.tools.push({ name, enabled: true, visible: true, restricted: true })
    }
    workspace.setAgentConfig(config)
  } finally {
    workspace.close()
  }
}

interface Child { child: ChildProcess; exited(): number | null; pid: number | undefined }

/** One fenced daemon child: its root, port, token and log. */
interface DaemonSpec {
  label: string
  port: number
  token: string
  settingsPath: string
  userDataDir: string
  outside: string
  extraEnv: NodeJS.ProcessEnv
}

async function startDaemon(env: ParityEnv, spec: DaemonSpec): Promise<Child> {
  if (!existsSync(DAEMON_BUNDLE)) throw new Error(`parity harness: ${DAEMON_BUNDLE} is missing; build it first (npx electron-vite build)`)
  const logFile = join(spec.outside, 'adf-daemon.log')
  const stdlibDir = writeStdlibManifest({ ...env, userDataDir: spec.userDataDir })
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ADF_DAEMON_PORT: String(spec.port),
    ADF_DAEMON_HOST: '127.0.0.1',
    ADF_DAEMON_SETTINGS: spec.settingsPath,
    ADF_DAEMON_PIDFILE: join(spec.outside, 'daemon.pid'),
    ADF_DAEMON_TOKEN: spec.token,
    ADF_DAEMON_STARTED_BY: 'studio',
    ADF_TEST_SEAMS: '1',
    ADF_COMPUTE: 'fake',
    ADF_TEST_KEYCHAIN_FILE: join(spec.outside, 'keychain.json'),
    ...spec.extraEnv,
  }
  delete childEnv.ADF_KEYCHAIN
  delete childEnv.ADF_SECRET_STORE
  const logStart = existsSync(logFile) ? readFileSync(logFile, 'utf-8').length : 0
  const out = openSync(logFile, 'a')
  let exitCode: number | null = null
  const child = spawn(ELECTRON, ['--require', FENCE_PATH, DAEMON_BUNDLE], { env: childEnv, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32', cwd: spec.outside })
  closeSync(out)
  if (child.pid !== undefined) LIVE_DAEMONS.add(child.pid)
  child.once('exit', (code) => {
    exitCode = code ?? -1
    if (child.pid !== undefined) LIVE_DAEMONS.delete(child.pid)
  })
  const exited = () => exitCode
  try {
    await waitHealthy(`http://127.0.0.1:${spec.port}`, child, exited, logFile)
    if (!(await waitForLog(logFile, '[Compute] ADF_COMPUTE=fake', 5_000, logStart))) throw new Error(`parity harness: the ${spec.label} daemon did not log the fake compute seam; killed (log ${logFile})`)
    if (!(await waitForLog(logFile, '[SandboxStdlib] Standard library up to date', 30_000, logStart))) throw new Error(`parity harness: the ${spec.label} daemon did not report the sandbox standard library (log ${logFile})`)
  } catch (err) {
    await killTree(child, exited)
    throw err
  }
  const links = removeTreeWithoutLinks(stdlibDir)
  if (links.length) throw new Error(`parity harness: ${stdlibDir} contains links: ${links.join(', ')}`)
  return { child, exited, pid: child.pid }
}

/** The remote computer as Studio sees it: a proxy in front of its daemon, which answers /remote/hello itself. */
export interface RemoteProxy {
  server: Server
  port: number
  /** Requests that carried a local proof (a leak: Studio never sends one remotely). */
  proofsSeen: string[]
  /** Requests that carried an Authorization header, in order. */
  authorized: string[]
  /** The daemon the proxy forwards to (another computer at the same address: another port). */
  upstream: number
  /** What /remote/hello answers; null: 404, remote access off. */
  hello: { name: string; fingerprint: string } | null
  /** Every request but /health and /remote/hello answers 401 (the device token was revoked). */
  refuse: boolean
  /** Requests are accepted and never answered (a computer that went away without closing its connections). */
  blackhole: boolean
}

async function startProxy(upstream: number, hello: RemoteProxy['hello']): Promise<RemoteProxy> {
  const proxy: RemoteProxy = { server: null as unknown as Server, port: 0, proofsSeen: [], authorized: [], upstream, hello, refuse: false, blackhole: false }
  proxy.server = createHttpServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const headers = { ...req.headers }
    if (headers['x-adf-local-proof'] !== undefined) {
      proxy.proofsSeen.push(`${req.method} ${req.url}`)
      delete headers['x-adf-local-proof']
    }
    if (proxy.blackhole) { req.resume(); return }
    if (headers.authorization) proxy.authorized.push(`${proxy.upstream} ${req.method} ${path}`)
    if (req.method === 'GET' && path === '/remote/hello') {
      req.resume()
      // The daemon that answers at the address shows the hello: nothing answers while it is down.
      const upstream = proxy.upstream
      const alive = await new Promise<boolean>((done) => {
        const probe = httpRequest({ host: '127.0.0.1', port: upstream, method: 'GET', path: '/health', timeout: 2_000 }, (answer) => { answer.resume(); done((answer.statusCode ?? 500) < 500) })
        probe.on('error', () => done(false))
        probe.on('timeout', () => { probe.destroy(); done(false) })
        probe.end()
      })
      if (!alive || upstream !== proxy.upstream) { res.socket?.destroy(); return }
      if (!proxy.hello) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Remote access is off on this computer.', code: 'remote_access_off' })); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ v: 1, name: proxy.hello.name, fingerprint: proxy.hello.fingerprint, pairingOpen: false, api: '2' }))
      return
    }
    if (proxy.refuse && path !== '/health') {
      req.resume()
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    headers.host = REMOTE_PROXY_HOST
    headers['x-forwarded-for'] = '198.51.100.7'
    const up = httpRequest({ host: '127.0.0.1', port: proxy.upstream, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(up)
    res.on('close', () => up.destroy())
  })
  await new Promise<void>((done) => proxy.server.listen(0, '127.0.0.1', () => done()))
  const address = proxy.server.address()
  proxy.port = typeof address === 'object' && address ? address.port : 0
  return proxy
}

/** An agent window as the harness opens it: what was sent to it. */
export interface FakeAgentWindow {
  id: number
  pushes: Array<{ channel: string; args: unknown[] }>
}

export interface BootedMultiBackend extends BootedBackend {
  readonly handle: import('../../../src/main/backend/daemon-mode/index').DaemonModeHandle
  readonly electron: FakeElectron
  /** `remote:<name>`. */
  readonly remoteId: string
  readonly remoteName: string
  /** The remote's agents, in its own agents folder. */
  readonly remoteAgents: Record<string, FixtureAgent>
  readonly proxy: RemoteProxy
  /** Studio's saved connections (cli-remotes.json) and their token store. */
  readonly remotesEnv: NodeJS.ProcessEnv
  /** hooks.closeAgentWindow calls, in order. */
  readonly closedAgentWindows: Array<{ id: number; keep: boolean }>
  /** hooks.runtimeConnected calls, in order. */
  readonly connectedRuntimes: string[]
  /** Save the remote's connection (Studio's Add, `adf pair`): the cache follows the file. */
  saveRemote(): Promise<void>
  /** Forget it (Studio's Remove, `adf remotes forget`). */
  forgetRemote(): Promise<void>
  /** Hard-kill the remote daemon. */
  killRemote(): Promise<void>
  /** Another computer at the remote's address: a third daemon with its own root and fingerprint behind the same proxy. */
  replaceRemoteWithImpostor(): Promise<void>
  /** An agent window on `runtimeId` (default the remote), with a fresh webContents id. */
  openAgentWindow(runtimeId?: string | null): FakeAgentWindow
  /** Wait until `check` holds (polling). */
  until(check: () => boolean, what: string, timeoutMs?: number): Promise<void>
}

export interface MultiParityBackend extends ParityBackend { boot(env: ParityEnv, electron: FakeElectron): Promise<BootedMultiBackend> }

/**
 * A second daemon's root: its user data with a copy of the run's settings
 * (the identity fixture, the mock LLM provider) pointed at its own agents
 * folder, its fixture agents, and the switch to local mode on that folder.
 */
async function prepareRemoteRoot(env: ParityEnv, label: string, fixtures: readonly FixtureSpec[]): Promise<{ root: string; userDataDir: string; settingsPath: string; outside: string; agents: Record<string, FixtureAgent> }> {
  const root = env.createIsolatedDirectory(label)
  const userDataDir = join(root, 'user-data')
  const agentsDir = join(root, 'agents')
  const outside = join(root, 'daemon')
  for (const d of [userDataDir, agentsDir, outside, join(root, 'leases'), join(root, 'temp')]) mkdirSync(d, { recursive: true })
  const agents = createFixtureAgents({ ...env, agentsDir }, fixtures)
  const runSettings = JSON.parse(readFileSync(join(env.userDataDir, 'adf-settings.json'), 'utf-8')) as Record<string, unknown>
  const reviewed = { ...(runSettings.reviewedAgents as Record<string, string> | undefined), ...Object.fromEntries(Object.values(agents).map((a) => [a.id, 'accepted'])) }
  const settingsPath = join(userDataDir, 'adf-settings.json')
  writeFileSync(settingsPath, JSON.stringify({ ...runSettings, agentsFolder: agentsDir, trackedDirectories: [], reviewedAgents: reviewed }, null, 2))
  await switchToLocalMode({ ...env, userDataDir }, join(outside, 'keychain.json'))
  return { root, userDataDir, settingsPath, outside, agents }
}

export function multiDaemonBackend(options: MultiDaemonOptions = {}): MultiParityBackend {
  const remoteName = options.remoteName ?? 'host-1'
  const remoteId = `remote:${remoteName}`
  return {
    name: 'multi',
    async boot(env, electron) {
      // --- This computer: the run's daemon, as daemonBackend() ---
      if (options.restrictTools?.length) {
        for (const f of readdirSync(env.agentsDir)) if (f.endsWith('.adf')) restrictTools(join(env.agentsDir, f), options.restrictTools)
      }
      const localPort = await freePort()
      env.allowPort(localPort)
      const localToken = randomBytes(32).toString('base64url')
      const localOutside = env.createIsolatedDirectory('daemon')
      await switchToLocalMode(env, join(localOutside, 'keychain.json'))
      const local = await startDaemon(env, { label: 'local', port: localPort, token: localToken, settingsPath: join(env.userDataDir, 'adf-settings.json'), userDataDir: env.userDataDir, outside: localOutside, extraEnv: {} })
      const pids: Array<{ value: number; name: string }> = local.pid !== undefined ? [{ value: local.pid, name: 'pid:daemon' }] : []
      const children: Child[] = [local]

      // --- The remote computer: its own root, port, mesh port, lease registry and fingerprint ---
      const remoteRoot = await prepareRemoteRoot(env, 'remote', options.remoteFixtures ?? [{ name: 'agent-2' }])
      if (options.restrictTools?.length) for (const a of Object.values(remoteRoot.agents)) restrictTools(a.filePath, options.restrictTools)
      const remotePort = await freePort()
      const remoteMesh = await freePort()
      env.allowPort(remotePort)
      env.allowPort(remoteMesh)
      const remoteToken = randomBytes(32).toString('base64url')
      const remoteEnv = (root: string): NodeJS.ProcessEnv => ({
        ADF_USER_DATA_DIR: join(root, 'user-data'),
        ADF_LEASE_DIR: join(root, 'leases'),
        ADF_TEMP_DIR: join(root, 'temp'),
        MESH_PORT: String(remoteMesh),
        ADF_DAEMON_STARTED_BY: 'cli',
        ADF_DAEMON_ALLOWED_HOSTS: REMOTE_PROXY_HOST,
      })
      let remote: Child
      try {
        remote = await startDaemon(env, { label: 'remote', port: remotePort, token: remoteToken, settingsPath: remoteRoot.settingsPath, userDataDir: remoteRoot.userDataDir, outside: remoteRoot.outside, extraEnv: remoteEnv(remoteRoot.root) })
      } catch (err) {
        await killTree(local.child, local.exited)
        throw err
      }
      children.push(remote)
      if (remote.pid !== undefined) pids.push({ value: remote.pid, name: 'pid:remote' })
      const { fingerprintOf } = (await import(/* @vite-ignore */ srcPath('main/daemon/remote-access/config.ts'))) as typeof import('../../../src/main/daemon/remote-access/config')
      const fingerprint = fingerprintOf(randomBytes(16).toString('hex'))
      const proxy = await startProxy(remotePort, { name: remoteName, fingerprint })
      env.allowPort(proxy.port)
      const proxyUrl = `http://127.0.0.1:${proxy.port}`

      // --- Studio's saved connections: a folder of their own, the run's file secret store ---
      const studioRemotes = env.createIsolatedDirectory('studio-remotes')
      const remotesEnv: NodeJS.ProcessEnv = { ...process.env, ADF_DAEMON_SETTINGS: join(studioRemotes, 'adf-settings.json'), ADF_KEYCHAIN: '0', ADF_SECRET_STORE: 'file' }
      delete remotesEnv.ADF_TEST_KEYCHAIN_FILE

      let handle: import('../../../src/main/backend/daemon-mode/index').DaemonModeHandle
      let leases: LeaseModule
      let connections: ConnectionsModule
      let cache: import('../../../src/main/backend/connections').SavedConnectionsCache
      const resources = createRunResources()
      const closedAgentWindows: Array<{ id: number; keep: boolean }> = []
      const connectedRuntimes: string[] = []
      let booted = false
      const killAll = async () => {
        for (const c of children) await killTree(c.child, c.exited)
        proxy.server.closeAllConnections()
        await new Promise<void>((done) => proxy.server.close(() => done()))
      }
      try {
        vi.resetModules()
        installEnvironmentStubs(electron, resources)
        const daemonMode = (await import(/* @vite-ignore */ srcPath('main/backend/daemon-mode/index.ts'))) as DaemonModeModule
        leases = (await import(/* @vite-ignore */ srcPath('main/runtime/agent-lease.ts'))) as LeaseModule
        connections = (await import(/* @vite-ignore */ srcPath('main/backend/connections.ts'))) as ConnectionsModule
        const remoteConnector = (await import(/* @vite-ignore */ srcPath('main/backend/daemon-mode/remote/connector.ts'))) as typeof import('../../../src/main/backend/daemon-mode/remote/connector')
        const runtimeTag = (await import(/* @vite-ignore */ srcPath('shared/runtime-tag.ts'))) as typeof import('../../../src/shared/runtime-tag')
        const backendConfig = (await import(/* @vite-ignore */ srcPath('main/backend/backend-config.ts'))) as typeof import('../../../src/main/backend/backend-config')
        if (options.savedAtBoot !== false) {
          await connections.saveConnection(remotesEnv, { url: proxyUrl, token: remoteToken, fingerprint, hostName: remoteName, deviceId: 'device-1', label: 'Studio' }, { confirmFile: async () => true })
        }
        const codec = { available: () => true, encrypt: (p: string) => `safe:${Buffer.from(p).toString('base64')}`, decrypt: (s: string) => Buffer.from(s.slice(5), 'base64').toString() }
        const localLog = join(localOutside, 'adf-daemon.log')
        handle = daemonMode.registerDaemonModeHandlers({
          mode: 'local',
          userDataDir: env.userDataDir,
          ...(options.keepDaemonRunning ? { keepDaemonRunning: true } : {}),
          connect: Object.assign(
            async () => ({ baseUrl: `http://127.0.0.1:${localPort}`, logFile: localLog, description: `the parity daemon pid ${local.pid} on 127.0.0.1:${localPort}`, source: { token: () => localToken } }),
            { logFile: localLog }),
          sharedMnemonic: () => ({
            read: () => {
              try { return (JSON.parse(readFileSync(join(localOutside, 'keychain.json'), 'utf-8')) as Record<string, string>)['owner-mnemonic'] ?? null } catch { return null }
            },
            write: () => { throw new Error('parity harness: Studio main does not write the shared owner phrase in daemon mode') },
          }),
          hooks: {
            showMainWindow: () => { electron.openWindow(); return null },
            openFile: (filePath) => { electron.localCalls.push({ api: 'hooks.openFile', args: [filePath] }) },
            closeAgentWindow: (id, keep) => { closedAgentWindows.push({ id, keep }) },
            runtimeConnected: (id) => { connectedRuntimes.push(id) },
          },
          // The runtime set of main/index.ts: each saved connection through the real remote connector.
          runtimeSet: {
            connectorFor: (name: string) => remoteConnector.remoteDaemonConnector(
              { ...backendConfig.defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name } },
              codec,
              { env: remotesEnv, retry: { initialMs: 100, maxMs: 400 } }),
          },
        })
        const h = handle
        if (options.thisComputerOnly) {
          electron.onPush((record) => {
            if (!runtimeTag.isRuntimeTag(record.args[0])) return
            const i = electron.pushes.lastIndexOf(record)
            if (i >= 0) electron.pushes.splice(i, 1)
          })
        }
        cache = new connections.SavedConnectionsCache(remotesEnv, () => h.runtimes.sync(cache.get()))
        electron.openWindow()
        if (!(await handle.ready)) throw new Error('parity harness: Studio daemon mode could not connect to the local daemon child')
        await cache.refresh()
        cache.watch()
        if (options.savedAtBoot !== false) {
          const rt = handle.runtimes.get(remoteId)
          if (!rt || !(await rt.ready)) throw new Error(`parity harness: ${remoteId} did not connect`)
        }
        booted = true
      } finally {
        if (!booted) await killAll()
      }

      const untilFn = async (check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> => {
        const end = Date.now() + timeoutMs
        while (!check()) {
          if (Date.now() > end) throw new Error(`parity harness: timed out waiting for ${what}`)
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      let nextWindowId = 1000
      let leaks: string[] = []
      return {
        handle,
        electron,
        remoteId,
        remoteName,
        remoteAgents: remoteRoot.agents,
        proxy,
        remotesEnv,
        closedAgentWindows,
        connectedRuntimes,
        until: untilFn,
        async saveRemote() {
          await connections.saveConnection(remotesEnv, { url: proxyUrl, token: remoteToken, fingerprint, hostName: remoteName, deviceId: 'device-1', label: 'Studio' }, { confirmFile: async () => true })
          await cache.refresh()
        },
        async forgetRemote() {
          await connections.forgetConnection(remotesEnv, remoteName)
          await cache.refresh()
        },
        async killRemote() {
          for (const c of children.slice(1)) await killTree(c.child, c.exited)
        },
        async replaceRemoteWithImpostor() {
          for (const c of children.slice(1)) await killTree(c.child, c.exited)
          const other = await prepareRemoteRoot(env, 'impostor', [])
          const port = await freePort()
          env.allowPort(port)
          const impostor = await startDaemon(env, { label: 'impostor', port, token: randomBytes(32).toString('base64url'), settingsPath: other.settingsPath, userDataDir: other.userDataDir, outside: other.outside, extraEnv: remoteEnv(other.root) })
          children.push(impostor)
          if (impostor.pid !== undefined) pids.push({ value: impostor.pid, name: 'pid:impostor' })
          proxy.hello = { name: remoteName, fingerprint: fingerprintOf(randomBytes(16).toString('hex')) }
          proxy.upstream = port
        },
        openAgentWindow(runtimeId = remoteId) {
          const win: FakeAgentWindow = { id: nextWindowId++, pushes: [] }
          handle.windows.open({ id: win.id, send: (channel, ...args) => { win.pushes.push({ channel, args }) }, focused: () => false }, runtimeId)
          return win
        },
        async shutdown() {
          try {
            await handle.shutdown()
            await leases.resetProcessAgentLeases()
          } finally {
            cache.dispose()
            await killAll()
          }
          leaks = await releaseRunResources(resources, env)
          if (proxy.proofsSeen.length > 0) leaks.push(`the local proof went to the remote: ${proxy.proofsSeen.join(', ')}`)
          for (const c of children) if (c.exited() === null) leaks.push(`daemon child pid ${c.pid} still running after taskkill`)
          if (process.env.PARITY_DAEMON_LOG_DIR) {
            try {
              mkdirSync(process.env.PARITY_DAEMON_LOG_DIR, { recursive: true })
              copyFileSync(join(localOutside, 'adf-daemon.log'), join(process.env.PARITY_DAEMON_LOG_DIR, `adf-daemon-${local.pid}.log`))
              copyFileSync(join(remoteRoot.outside, 'adf-daemon.log'), join(process.env.PARITY_DAEMON_LOG_DIR, `adf-daemon-remote-${remote.pid}.log`))
            } catch { /* no log */ }
          }
        },
        leaks: () => leaks,
        computeCalls: () => resources.compute.calls,
        usageOnDisk: async () => {
          await waitForUsageOnDisk(env, async () => {
            const res = await fetch(`http://127.0.0.1:${localPort}/runtime/usage`, { headers: { authorization: `Bearer ${localToken}` }, signal: AbortSignal.timeout(5000) })
            if (!res.ok) throw new Error(`parity harness: GET /runtime/usage answered ${res.status}`)
            return ((await res.json()) as { usage: unknown }).usage
          }, 'multi (local)')
          await waitForLeasesSettled(env, `http://127.0.0.1:${localPort}`)
        },
        normalization: () => ({
          ports: [
            { value: String(localPort), name: 'DAEMON_PORT' },
            { value: String(remotePort), name: 'REMOTE_DAEMON_PORT' },
            { value: String(remoteMesh), name: 'REMOTE_MESH_PORT' },
            { value: String(proxy.port), name: 'REMOTE_PROXY_PORT' },
          ],
          pids,
          named: [
            ...pids.map((p) => ({ value: `adf-scratch-${p.value}`, name: p.name === 'pid:daemon' ? 'scratch-root:daemon' : `scratch-root:${p.name.slice(4)}` })),
            { value: `daemon-local-proof-${localPort}`, name: 'daemon-local-proof-file' },
          ],
        }),
      }
    },
  }
}

