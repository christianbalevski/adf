import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { RuntimeService } from '../runtime/runtime-service'
import { RuntimeGate } from '../runtime/runtime-gate'
import { withDeadline } from '../utils/concurrency'
import {
  createDaemonHttpApi,
  type DaemonComputeService,
  type DaemonNetworkService,
  type DaemonPackageService,
  type DaemonPythonPackageService,
  type DaemonSandboxPackageService,
  type DaemonSettingsStore,
  type DaemonWsService,
} from './http-api'
import type { DaemonEventBus } from './event-bus'

export interface DaemonHostOptions {
  runtime: RuntimeService
  host?: string
  port?: number
  pidFile?: string
  logger?: boolean
  shutdownAgentTimeoutMs?: number
  computeService?: DaemonComputeService
  settingsStore?: DaemonSettingsStore
  eventBus?: DaemonEventBus
  wsService?: DaemonWsService
  networkService?: DaemonNetworkService
  mcpPackageService?: DaemonPackageService
  mcpPythonPackageService?: DaemonPythonPackageService
  adapterPackageService?: DaemonPackageService
  sandboxPackageService?: DaemonSandboxPackageService
  /**
   * Extra teardown hooks run during stop(), after agents and compute are
   * down. Each hook is independently try-caught; the composition root
   * (daemon/index.ts) uses this for mesh/WS/sandbox/token/WAL teardown.
   */
  onShutdown?: Array<() => void | Promise<void>>
}

export interface DaemonHostAddress {
  host: string
  port: number
}

// Backstop only — RuntimeService.unloadAgent({ mode: 'immediate' }) should
// normally complete well under this. Override via ADF_SHUTDOWN_TIMEOUT_MS.
const DEFAULT_AGENT_UNLOAD_TIMEOUT_MS = 10_000
const SERVER_CLOSE_DEADLINE_MS = 3_000

function envShutdownTimeoutMs(): number | undefined {
  const raw = Number(process.env.ADF_SHUTDOWN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.')
}

export class DaemonHost {
  private readonly runtime: RuntimeService
  private readonly host: string
  private readonly port: number
  private readonly pidFile?: string
  private readonly logger: boolean
  private readonly shutdownAgentTimeoutMs: number
  private readonly computeService?: DaemonComputeService
  private readonly settingsStore?: DaemonSettingsStore
  private readonly eventBus?: DaemonEventBus
  private readonly wsService?: DaemonWsService
  private readonly networkService?: DaemonNetworkService
  private readonly mcpPackageService?: DaemonPackageService
  private readonly mcpPythonPackageService?: DaemonPythonPackageService
  private readonly adapterPackageService?: DaemonPackageService
  private readonly sandboxPackageService?: DaemonSandboxPackageService
  private readonly onShutdown: Array<() => void | Promise<void>>
  private server: FastifyInstance | null = null
  private signalHandlersInstalled = false
  private stopping: Promise<void> | null = null

  constructor(opts: DaemonHostOptions) {
    this.runtime = opts.runtime
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 7385
    this.pidFile = opts.pidFile
    this.logger = opts.logger ?? false
    this.shutdownAgentTimeoutMs = opts.shutdownAgentTimeoutMs ?? envShutdownTimeoutMs() ?? DEFAULT_AGENT_UNLOAD_TIMEOUT_MS
    this.computeService = opts.computeService
    this.settingsStore = opts.settingsStore
    this.eventBus = opts.eventBus
    this.wsService = opts.wsService
    this.networkService = opts.networkService
    this.mcpPackageService = opts.mcpPackageService
    this.mcpPythonPackageService = opts.mcpPythonPackageService
    this.adapterPackageService = opts.adapterPackageService
    this.sandboxPackageService = opts.sandboxPackageService
    this.onShutdown = opts.onShutdown ?? []
  }

  async start(): Promise<DaemonHostAddress> {
    if (this.server) return { host: this.host, port: this.port }

    // Binding beyond loopback without auth would expose settings and full
    // agent control to the network.
    if (!isLoopbackHost(this.host) && !process.env.ADF_DAEMON_TOKEN) {
      throw new Error(
        `Refusing to bind daemon to non-loopback host ${this.host} without authentication. ` +
        'Set ADF_DAEMON_TOKEN to enable bearer-token auth, or bind to 127.0.0.1.',
      )
    }

    this.assertNotAlreadyRunning()

    this.server = createDaemonHttpApi(this.runtime, {
      logger: this.logger,
      computeService: this.computeService,
      settingsStore: this.settingsStore,
      eventBus: this.eventBus,
      wsService: this.wsService,
      networkService: this.networkService,
      mcpPackageService: this.mcpPackageService,
      mcpPythonPackageService: this.mcpPythonPackageService,
      adapterPackageService: this.adapterPackageService,
      sandboxPackageService: this.sandboxPackageService,
    })
    await this.server.listen({ host: this.host, port: this.port })
    this.writePidFile()
    this.installSignalHandlers()
    return { host: this.host, port: this.port }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopOnce().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  getServer(): FastifyInstance | null {
    return this.server
  }

  /**
   * Refuse to start when the pid file points at a live process; delete a
   * stale pid file (owner died without cleanup) and continue.
   */
  private assertNotAlreadyRunning(): void {
    if (!this.pidFile || !existsSync(this.pidFile)) return
    let pid = NaN
    try { pid = Number.parseInt(readFileSync(this.pidFile, 'utf-8').trim(), 10) } catch { /* unreadable = stale */ }
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch (err) {
        // EPERM: exists but not signalable — still alive. ESRCH: gone.
        alive = (err as NodeJS.ErrnoException)?.code === 'EPERM'
      }
      if (alive) {
        throw new Error(
          `ADF daemon already running as PID ${pid} (pid file: ${this.pidFile}). ` +
          'Stop it first, or remove the pid file if this is wrong.',
        )
      }
    }
    console.log(`[ADF Daemon] Removing stale pid file ${this.pidFile}`)
    try { rmSync(this.pidFile) } catch { /* ignore */ }
  }

  private writePidFile(): void {
    if (!this.pidFile) return
    try {
      // 'wx' after the stale-check unlink: fail loudly instead of silently
      // clobbering a pid file written by a daemon that raced us to start.
      writeFileSync(this.pidFile, `${process.pid}\n`, { encoding: 'utf-8', flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new Error(
          `Pid file ${this.pidFile} appeared during startup — another daemon is starting concurrently.`,
        )
      }
      throw err
    }
  }

  private removePidFile(): void {
    if (!this.pidFile || !existsSync(this.pidFile)) return
    rmSync(this.pidFile)
  }

  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return
    this.signalHandlersInstalled = true
    const shutdown = async () => {
      console.log('[ADF Daemon] Shutting down...')
      try {
        await this.stop()
      } finally {
        console.log('[ADF Daemon] Shutdown complete.')
        process.exit(0)
      }
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }

  private async stopOnce(): Promise<void> {
    // Flip the global gate FIRST so any in-flight microtasks (queued 'trigger'
    // listeners, pending executeTurn calls, mid-tick checkTimers) noop instead
    // of leaking past shutdown. Resume() runs on the next deliberate start.
    RuntimeGate.stop()
    try {
      if (this.server) {
        const server = this.server
        this.server = null
        // forceCloseConnections + the SSE-socket sweep in http-api should make
        // close fast; the deadline is a backstop so a wedged connection can
        // never block agent/compute teardown.
        await withDeadline(server.close(), SERVER_CLOSE_DEADLINE_MS, () => {
          console.error(`[ADF Daemon] HTTP server close exceeded ${SERVER_CLOSE_DEADLINE_MS}ms — continuing shutdown`)
        })
      }
    } finally {
      await this.stopRuntimeAgents()
      await this.stopCompute()
      await this.runShutdownHooks()
      this.removePidFile()
    }
  }

  private async runShutdownHooks(): Promise<void> {
    for (const hook of this.onShutdown) {
      try { await hook() } catch (err) {
        console.error('[ADF Daemon] Shutdown hook failed:', err)
      }
    }
  }

  private async stopRuntimeAgents(): Promise<void> {
    const agents = this.runtime.listAgents()
    if (agents.length > 0) console.log(`[ADF Daemon] Unloading ${agents.length} agent(s)...`)
    await Promise.allSettled(agents.map(agent => this.unloadAgentWithTimeout(agent.id)))
  }

  private async unloadAgentWithTimeout(agentId: string): Promise<void> {
    try {
      await withTimeout(
        // Immediate mode: shutdown teardown, not a polite user-driven unload —
        // the host timeout below is a backstop, not the normal path.
        this.runtime.unloadAgent(agentId, { mode: 'immediate' }),
        this.shutdownAgentTimeoutMs,
        `Timed out unloading agent ${agentId} after ${this.shutdownAgentTimeoutMs}ms`,
      )
    } catch (err) {
      console.error(`[ADF Daemon] Failed to unload agent ${agentId}:`, err)
    }
  }

  private async stopCompute(): Promise<void> {
    if (!this.computeService) return
    try {
      if (this.computeService.stopAll) {
        // Wait for in-flight container starts so a container that finishes
        // starting mid-teardown cannot outlive the single stopAll below.
        if (this.computeService.pendingStarts) {
          try { await this.computeService.pendingStarts() } catch { /* proceed to stop */ }
        }
        console.log('[ADF Daemon] Stopping compute containers...')
        await this.computeService.stopAll()
      } else {
        await this.computeService.stop()
      }
    } catch (err) {
      console.error('[ADF Daemon] Failed to stop compute containers:', err)
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
