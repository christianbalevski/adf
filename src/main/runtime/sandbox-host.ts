import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { resolve as resolvePath } from 'path'
import { SANDBOX_WORKER_SCRIPT } from './sandbox-worker-source'
import { SANDBOX_PRELUDE } from './sandbox-prelude'

/**
 * Sandbox host process.
 *
 * Code-sandbox workers used to be worker threads of the main process, so code
 * that escaped the vm realm held the main process's `process`, full fs and
 * every secret in its environment. They now live in a separate process started
 * from the same binary as plain Node (ELECTRON_RUN_AS_NODE) under Node's
 * permission model:
 *
 *   --permission                  fs, child processes, workers, addons, WASI
 *                                 and the inspector are denied by default
 *   --allow-worker                the host runs one worker thread per sandbox
 *   --allow-fs-read=<dir>         only the stdlib and user-package directories
 *                                 (the host's own script arrives over IPC)
 *
 * No fs writes, no child processes, no native addons. The environment is
 * reduced to what the runtime needs to start, so no API key or token reaches
 * it. Network is not covered by Node 24's permission model; the worker scripts
 * deny it in-realm (see sandbox-worker-source.ts).
 *
 * One host serves every sandbox of a given filesystem allowlist; each sandbox
 * is a worker thread inside it, so per-sandbox cost stays a worker spawn. A
 * host with no workers exits after HOST_IDLE_MS.
 */

const HOST_IDLE_MS = 60_000
const HOST_BOOT_TIMEOUT_MS = 30_000

/** Boot script passed with -e: everything else arrives in the 'init' message,
 *  so the host needs no filesystem read access for its own code. */
const HOST_BOOT = [
  "'use strict';",
  "const { Worker } = require('worker_threads');",
  'let script = null, prelude = null;',
  'const workers = new Map();',
  'function send(m) { try { process.send(m); } catch (e) { /* parent gone */ } }',
  "process.on('message', (m) => {",
  "  if (!m || typeof m !== 'object') return;",
  "  if (m.t === 'init') { script = m.script; prelude = m.prelude; send({ t: 'ready' }); return; }",
  "  if (m.t === 'spawn') {",
  '    const wid = m.wid;',
  '    let w;',
  // No execArgv: a worker given its own execArgv runs WITHOUT the process's
  // --permission restrictions. Inheriting is what keeps them in force.
  "    try { w = new Worker(script, { eval: true, workerData: { prelude }, env: {}, argv: [] }); }",
  "    catch (e) { send({ t: 'error', wid, message: String(e && e.message || e) }); send({ t: 'exit', wid, code: 1 }); return; }",
  '    workers.set(wid, w);',
  "    w.on('message', (x) => send({ t: 'msg', wid, m: x }));",
  "    w.on('error', (e) => send({ t: 'error', wid, message: String(e && e.message || e) }));",
  "    w.on('exit', (code) => { workers.delete(wid); send({ t: 'exit', wid, code }); });",
  '    return;',
  '  }',
  "  if (m.t === 'msg') { const w = workers.get(m.wid); if (w) w.postMessage(m.m); return; }",
  "  if (m.t === 'kill') { const w = workers.get(m.wid); if (w) w.terminate(); return; }",
  '});',
  "process.on('disconnect', () => process.exit(0));",
  "process.on('unhandledRejection', () => {});"
].join('\n')

/** Main-process handle for one sandbox worker living in a host process.
 *  Mirrors the slice of the worker_threads.Worker API the sandbox uses. */
export class RemoteWorker extends EventEmitter {
  private exited = false

  constructor(
    private readonly host: SandboxHost,
    readonly wid: number
  ) {
    super()
  }

  postMessage(msg: unknown): void {
    if (this.exited) return
    this.host.send({ t: 'msg', wid: this.wid, m: msg })
  }

  terminate(): Promise<number> {
    if (this.exited) return Promise.resolve(0)
    return new Promise((resolve) => {
      this.once('exit', (code: number) => resolve(code))
      this.host.send({ t: 'kill', wid: this.wid })
    })
  }

  /** Called by the host router. */
  _exit(code: number): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
  }
}

type HostMessage =
  | { t: 'ready' }
  | { t: 'msg'; wid: number; m: unknown }
  | { t: 'error'; wid: number; message: string }
  | { t: 'exit'; wid: number; code: number }

export class SandboxHost {
  private child: ChildProcess | null = null
  private ready = false
  private dead = false
  private queue: unknown[] = []
  private workers = new Map<number, RemoteWorker>()
  private nextWid = 0
  private idleTimer: NodeJS.Timeout | null = null
  private bootTimer: NodeJS.Timeout | null = null
  private failReason = ''

  /** `sources` is overridable so tests can append a probe to the real worker
   *  script and observe the host from inside; production always uses the default. */
  constructor(
    readonly readPaths: string[],
    private readonly sources: { script: string; prelude: string } = {
      script: SANDBOX_WORKER_SCRIPT,
      prelude: SANDBOX_PRELUDE
    }
  ) {}

  get alive(): boolean {
    return !this.dead
  }

  get workerCount(): number {
    return this.workers.size
  }

  spawnWorker(): RemoteWorker {
    if (this.dead) throw new Error('Sandbox host is not accepting workers')
    this.clearIdle()
    if (!this.child) this.start()
    // A synchronous spawn failure already marked the host dead; a worker
    // registered now would never hear an exit and wait out the boot timeout.
    if (this.dead) throw new Error(this.failReason || 'Sandbox host failed to start')
    const wid = ++this.nextWid
    const worker = new RemoteWorker(this, wid)
    this.workers.set(wid, worker)
    this.send({ t: 'spawn', wid })
    return worker
  }

  send(msg: unknown): void {
    if (this.dead) return
    if (!this.ready) {
      this.queue.push(msg)
      return
    }
    try {
      this.child?.send(msg as never)
    } catch {
      this.fail('Sandbox host channel closed')
    }
  }

  kill(): void {
    if (this.dead) return
    this.fail('Sandbox host shut down')
  }

  private start(): void {
    const unsupported = permissionModelUnsupported(process.versions)
    if (unsupported) {
      this.fail(unsupported)
      return
    }
    const args = [
      '--permission',
      '--allow-worker',
      '--disable-warning=SecurityWarning',
      '--disable-warning=ExperimentalWarning',
      ...this.readPaths.map((p) => `--allow-fs-read=${p}`),
      '-e',
      HOST_BOOT
    ]
    let child: ChildProcess
    try {
      child = spawn(process.execPath, args, {
        env: minimalEnv(),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'advanced',
        windowsHide: true
      })
    } catch (err) {
      this.fail(`Sandbox host failed to start: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.child = child
    child.on('message', (m: HostMessage) => this.route(m))
    child.on('error', (err) => this.fail(`Sandbox host failed to start: ${err.message}`))
    child.on('exit', (code, signal) => {
      this.fail(`Sandbox host exited (${signal ?? code})`)
    })
    // The host never keeps the app alive on its own.
    child.unref()
    const channel = (child as unknown as { channel?: { unref?: () => void } }).channel
    channel?.unref?.()
    child.send({ t: 'init', script: this.sources.script, prelude: this.sources.prelude } as never)
    this.bootTimer = setTimeout(() => {
      if (!this.ready) this.fail(`Sandbox host did not start within ${HOST_BOOT_TIMEOUT_MS}ms`)
    }, HOST_BOOT_TIMEOUT_MS)
    this.bootTimer.unref()
  }

  private route(m: HostMessage): void {
    if (!m || typeof m !== 'object') return
    if (m.t === 'ready') {
      this.ready = true
      if (this.bootTimer) clearTimeout(this.bootTimer)
      const queued = this.queue.splice(0)
      for (const q of queued) this.send(q)
      return
    }
    const worker = this.workers.get(m.wid)
    if (!worker) return
    if (m.t === 'msg') {
      worker.emit('message', m.m)
    } else if (m.t === 'error') {
      worker.emit('error', new Error(m.message))
    } else if (m.t === 'exit') {
      this.workers.delete(m.wid)
      worker._exit(m.code)
      this.onWorkerGone()
    }
  }

  private onWorkerGone(): void {
    if (this.workers.size > 0) return
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      if (this.workers.size === 0) this.kill()
    }, HOST_IDLE_MS)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private fail(reason: string): void {
    if (this.dead) return
    this.dead = true
    this.failReason = reason
    this.clearIdle()
    if (this.bootTimer) clearTimeout(this.bootTimer)
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill() } catch { /* already gone */ }
    }
    const workers = Array.from(this.workers.values())
    this.workers.clear()
    for (const w of workers) {
      if (!this.ready) w.emit('error', new Error(reason))
      w._exit(1)
    }
    onHostDead(this)
  }
}

/** Node's permission model needs 22.13+ without a flag (and --disable-warning
 *  21.3+). Electron always bundles a new enough Node; the daemon runs on
 *  whatever `node` is installed. Returns an error message, or null. */
export function permissionModelUnsupported(versions: { node: string; electron?: string }): string | null {
  const [major, minor] = versions.node.split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 13)) return null
  return `Code execution needs Node.js 22.13 or newer for the sandbox's permission model ` +
    `(this process runs Node ${versions.node}). Upgrade Node, or run the agent in ADF Studio.`
}

/** Only what the runtime needs to start. Notably NOT the parent's env: API
 *  keys, tokens and NODE_OPTIONS stay out of the sandbox process. */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR']) {
      if (process.env[k]) env[k] = process.env[k]
    }
  }
  return env
}

// ---- Registry: one live host per filesystem allowlist ----------------------

const hosts = new Map<string, SandboxHost>()

function keyFor(paths: string[]): string {
  return paths.join('\u0000')
}

function onHostDead(host: SandboxHost): void {
  const key = keyFor(host.readPaths)
  if (hosts.get(key) === host) hosts.delete(key)
}

/** Normalised, de-duplicated read allowlist for the given package roots. */
export function readAllowlist(roots: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const r of roots) if (r) out.add(resolvePath(r))
  return Array.from(out).sort()
}

/** The live host for this allowlist, starting one if needed. */
export function getSandboxHost(readPaths: string[]): SandboxHost {
  const key = keyFor(readPaths)
  let host = hosts.get(key)
  if (!host || !host.alive) {
    host = new SandboxHost(readPaths)
    hosts.set(key, host)
  }
  return host
}

/** Kill every host. Called on app and daemon shutdown, and by tests. */
export function shutdownSandboxHosts(): void {
  for (const host of Array.from(hosts.values())) host.kill()
  hosts.clear()
}
