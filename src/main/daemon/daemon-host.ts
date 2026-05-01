import { existsSync, rmSync, writeFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { RuntimeService } from '../runtime/runtime-service'
import { RuntimeGate } from '../runtime/runtime-gate'
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
}

export interface DaemonHostAddress {
  host: string
  port: number
}

const DEFAULT_AGENT_UNLOAD_TIMEOUT_MS = 5_000

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
  private server: FastifyInstance | null = null
  private signalHandlersInstalled = false
  private stopping: Promise<void> | null = null

  constructor(opts: DaemonHostOptions) {
    this.runtime = opts.runtime
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 7385
    this.pidFile = opts.pidFile
    this.logger = opts.logger ?? false
    this.shutdownAgentTimeoutMs = opts.shutdownAgentTimeoutMs ?? DEFAULT_AGENT_UNLOAD_TIMEOUT_MS
    this.computeService = opts.computeService
    this.settingsStore = opts.settingsStore
    this.eventBus = opts.eventBus
    this.wsService = opts.wsService
    this.networkService = opts.networkService
    this.mcpPackageService = opts.mcpPackageService
    this.mcpPythonPackageService = opts.mcpPythonPackageService
    this.adapterPackageService = opts.adapterPackageService
    this.sandboxPackageService = opts.sandboxPackageService
  }

  async start(): Promise<DaemonHostAddress> {
    if (this.server) return { host: this.host, port: this.port }

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

  private writePidFile(): void {
    if (!this.pidFile) return
    writeFileSync(this.pidFile, `${process.pid}\n`, 'utf-8')
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
        await this.server.close()
        this.server = null
      }
    } finally {
      await this.stopRuntimeAgents()
      await this.stopCompute()
      this.removePidFile()
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
        this.runtime.unloadAgent(agentId),
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
        console.log('[ADF Daemon] Stopping compute containers...')
        await this.computeService.stopAll()
        // Catch containers that finished starting while agent teardown was already in progress.
        await sleep(500)
        await this.computeService.stopAll()
      } else {
        await this.computeService.stop()
      }
    } catch (err) {
      console.error('[ADF Daemon] Failed to stop compute containers:', err)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
