import { EventEmitter } from 'events'
import type {
  ChannelAdapter,
  AdapterContext,
  AdapterInstanceConfig,
  AdapterStatus,
  AdapterLogEntry,
  AdapterState,
  InboundMessage,
  OutboundMessage,
  DeliveryResult,
  CreateAdapterFn
} from '../../shared/types/channel-adapter.types'
import type { AdfWorkspace } from '../adf/adf-workspace'

const MAX_LOG_ENTRIES = 500
const MAX_RETRIES = 5
const INITIAL_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 60_000
const HEALTH_CHECK_INTERVAL_MS = 30_000
const MAX_DELIVERY_MAP_SIZE = 10_000

interface ManagedAdapter {
  type: string
  adapter: ChannelAdapter
  config: AdapterInstanceConfig
  status: AdapterStatus
  error?: string
  connectedAt?: number
  restartCount: number
  logs: AdapterLogEntry[]
  healthCheckTimer?: ReturnType<typeof setInterval>
  autoRestart: boolean
  /** True while handleAutoRestart is in-flight (prevents concurrent restarts) */
  restarting: boolean
  /** The adapter context passed to adapter.start() */
  ctx: AdapterContext
}

export interface ChannelAdapterManagerEvents {
  /** Emitted when an inbound message is received from a platform */
  'inbound': (type: string, msg: InboundMessage, meta: { inboxId: string; parentId?: string }) => void
  /** Emitted when adapter status changes */
  'status-changed': (type: string, status: AdapterStatus, error?: string) => void
  /** Emitted on adapter log entries */
  'log': (type: string, entry: AdapterLogEntry) => void
}

/**
 * Manages in-process channel adapter instances.
 *
 * Each adapter runs in the Electron main process. The manager handles
 * lifecycle (start/stop), health checks with auto-reconnect, log capture,
 * and outbound message routing.
 *
 * Mirrors the McpClientManager pattern.
 */
export class ChannelAdapterManager extends EventEmitter {
  private adapters = new Map<string, ManagedAdapter>()
  /** In-memory map: `{adapterType}:{platformMessageId}` → outboxId for O(1) reply resolution */
  private deliveryMap = new Map<string, string>()

  // Type-safe event emitter overrides
  override on<K extends keyof ChannelAdapterManagerEvents>(event: K, listener: ChannelAdapterManagerEvents[K]): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof ChannelAdapterManagerEvents>(event: K, ...args: Parameters<ChannelAdapterManagerEvents[K]>): boolean {
    return super.emit(event, ...args)
  }

  /**
   * Start an adapter instance.
   *
   * @param type       Adapter type key (e.g. 'telegram')
   * @param createFn   Factory function from the adapter package
   * @param config     Per-agent adapter config
   * @param workspace  The agent's workspace (for inbox writes, file storage, identity)
   * @param derivedKey Optional derived key for encrypted identity entries
   * @param appEnv     Optional app-level env vars from AdapterRegistration (fallback for credentials)
   */
  async startAdapter(
    type: string,
    createFn: CreateAdapterFn,
    config: AdapterInstanceConfig,
    workspace: AdfWorkspace,
    derivedKey?: Buffer | null,
    appEnv?: { key: string; value: string }[]
  ): Promise<boolean> {
    if (this.adapters.has(type)) {
      console.warn(`[AdapterManager] Adapter "${type}" already running`)
      return true
    }

    const adapter = createFn()

    const ctx = this.createContext(type, config, workspace, derivedKey ?? null, appEnv)

    const managed: ManagedAdapter = {
      type,
      adapter,
      config,
      status: 'connecting',
      restartCount: 0,
      logs: [],
      autoRestart: true,
      restarting: false,
      ctx
    }
    this.adapters.set(type, managed)
    this.emitStatusChange(managed)
    this.addLog(managed, 'system', `Starting adapter "${type}"`)

    try {
      await adapter.start(ctx)
      managed.status = adapter.status()
      managed.connectedAt = Date.now()
      this.emitStatusChange(managed)
      this.addLog(managed, 'system', `Adapter "${type}" started`)
      this.startHealthCheck(managed)
      return true
    } catch (error) {
      managed.status = 'error'
      managed.error = String(error instanceof Error ? error.message : error)
      this.emitStatusChange(managed)
      this.addLog(managed, 'error', `Failed to start: ${managed.error}`)
      return false
    }
  }

  /**
   * Stop a specific adapter.
   */
  async stopAdapter(type: string): Promise<void> {
    const managed = this.adapters.get(type)
    if (!managed) return

    managed.autoRestart = false
    this.stopHealthCheck(managed)

    try {
      await managed.adapter.stop()
    } catch (error) {
      console.warn(`[AdapterManager] Error stopping "${type}":`, error)
    }

    managed.status = 'disconnected'
    this.emitStatusChange(managed)
    this.addLog(managed, 'system', `Adapter "${type}" stopped`)
    this.adapters.delete(type)
  }

  /**
   * Stop all adapters.
   */
  async stopAll(): Promise<void> {
    const types = Array.from(this.adapters.keys())
    await Promise.allSettled(types.map(type => this.stopAdapter(type)))
  }

  /**
   * Send an outbound message through a specific adapter.
   */
  async send(type: string, message: OutboundMessage): Promise<DeliveryResult> {
    const managed = this.adapters.get(type)
    if (!managed) {
      return { success: false, error: `Adapter "${type}" not running` }
    }
    if (managed.status !== 'connected') {
      return { success: false, error: `Adapter "${type}" not connected (status: ${managed.status})` }
    }

    try {
      const result = await managed.adapter.send(message)
      this.addLog(managed, 'info', `Sent to ${message.recipientId}: ${result.success ? 'delivered' : result.error}`)
      return result
    } catch (error) {
      const errorMsg = String(error instanceof Error ? error.message : error)
      this.addLog(managed, 'error', `Send failed: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * Check if an adapter can deliver to a given recipient.
   */
  canDeliver(type: string, recipientId: string): boolean {
    const managed = this.adapters.get(type)
    if (!managed || managed.status !== 'connected') return false
    return managed.adapter.canDeliver(recipientId)
  }

  /**
   * Get status of a specific adapter.
   */
  getStatus(type: string): AdapterStatus | null {
    const managed = this.adapters.get(type)
    return managed?.status ?? null
  }

  /**
   * Get states of all running adapters.
   */
  getStates(): AdapterState[] {
    return Array.from(this.adapters.values()).map(m => ({
      type: m.type,
      status: m.status,
      error: m.error,
      connectedAt: m.connectedAt,
      restartCount: m.restartCount,
      logs: [...m.logs]
    }))
  }

  /**
   * Get the state of a specific adapter.
   */
  getState(type: string): AdapterState | null {
    const managed = this.adapters.get(type)
    if (!managed) return null
    return {
      type: managed.type,
      status: managed.status,
      error: managed.error,
      connectedAt: managed.connectedAt,
      restartCount: managed.restartCount,
      logs: [...managed.logs]
    }
  }

  /**
   * Get logs for a specific adapter.
   */
  getLogs(type: string): AdapterLogEntry[] {
    return [...(this.adapters.get(type)?.logs ?? [])]
  }

  /**
   * Restart a specific adapter.
   */
  async restart(type: string): Promise<boolean> {
    const managed = this.adapters.get(type)
    if (!managed) return false

    this.addLog(managed, 'system', 'Manual restart requested')
    this.stopHealthCheck(managed)

    try {
      await managed.adapter.stop()
    } catch { /* ignore */ }

    managed.restartCount = 0
    managed.autoRestart = true
    managed.status = 'connecting'
    this.emitStatusChange(managed)

    try {
      await managed.adapter.start(managed.ctx)
      managed.status = managed.adapter.status()
      managed.connectedAt = Date.now()
      this.emitStatusChange(managed)
      this.addLog(managed, 'system', `Adapter "${type}" restarted`)
      this.startHealthCheck(managed)
      return true
    } catch (error) {
      managed.status = 'error'
      managed.error = String(error instanceof Error ? error.message : error)
      this.emitStatusChange(managed)
      this.addLog(managed, 'error', `Restart failed: ${managed.error}`)
      return false
    }
  }

  /**
   * Check if a given adapter type is running and connected.
   */
  isConnected(type: string): boolean {
    const managed = this.adapters.get(type)
    return managed?.status === 'connected'
  }

  /**
   * Get all running adapter type keys.
   */
  getRunningTypes(): string[] {
    return Array.from(this.adapters.keys())
  }

  /**
   * Register a delivery mapping so inbound replies can resolve parent_id in O(1).
   * Called by the mesh-manager after a successful adapter send.
   */
  registerDelivery(type: string, platformMessageId: number | string, outboxId: string): void {
    const key = `${type}:${platformMessageId}`
    this.deliveryMap.set(key, outboxId)
    // Evict oldest entries when over capacity
    if (this.deliveryMap.size > MAX_DELIVERY_MAP_SIZE) {
      const it = this.deliveryMap.keys()
      for (let i = 0; i < this.deliveryMap.size - MAX_DELIVERY_MAP_SIZE; i++) {
        this.deliveryMap.delete(it.next().value!)
      }
    }
  }

  /**
   * Look up an outboxId for a platform reply reference.
   * Checks the in-memory map first (O(1)), falls back to SQL on miss.
   */
  private resolveParentFromReply(
    type: string,
    replyToMessageId: unknown,
    workspace: AdfWorkspace
  ): string | null {
    // Fast path: in-memory map
    const key = `${type}:${replyToMessageId}`
    const cached = this.deliveryMap.get(key)
    if (cached) return cached

    // Slow path: SQL fallback (covers cold-start / restart scenarios)
    return workspace.findOutboxByMetaValue('message_id', replyToMessageId)
  }

  // --- Private helpers ---

  /**
   * Create an AdapterContext that bridges the adapter to the ADF runtime.
   */
  private createContext(
    type: string,
    config: AdapterInstanceConfig,
    workspace: AdfWorkspace,
    derivedKey: Buffer | null,
    appEnv?: { key: string; value: string }[]
  ): AdapterContext {
    return {
      ingest: (msg: InboundMessage) => {
        // Resolve parent_id from reply_to_message_id
        let parentId = msg.parentId
        if (!parentId && msg.sourceMeta) {
          const replyToMsgId = msg.sourceMeta.reply_to_message_id
          if (replyToMsgId != null) {
            const outboxId = this.resolveParentFromReply(type, replyToMsgId, workspace)
            if (outboxId) {
              parentId = outboxId
            }
          }
        }

        // Write to inbox
        const inboxId = workspace.addToInbox({
          from: `${type}:${msg.sender}`,
          thread_id: msg.traceId,
          parent_id: parentId,
          subject: msg.subject,
          message_id: msg.messageId,
          sender_alias: msg.senderName,
          return_path: msg.returnPath,
          content: msg.payload,
          attachments: msg.attachments?.map(a => ({
            filename: a.filename,
            content_type: a.mimeType ?? 'application/octet-stream',
            transfer: 'imported' as const,
            path: a.path,
            size_bytes: a.size
          })),
          source: type,
          source_context: msg.sourceMeta,
          original_message: msg.originalMessage,
          sent_at: msg.sentAt,
          received_at: Date.now(),
          status: 'unread'
        })

        // Emit event for IPC layer to handle trigger firing
        this.emit('inbound', type, msg, { inboxId, parentId })
      },

      writeAttachment: (path: string, data: Buffer, mimeType?: string) => {
        workspace.writeFileBuffer(path, data, mimeType)
      },

      getConfig: () => config,

      getCredential: (key: string) => {
        // Try identity keystore first (per-agent credentials)
        const identityVal = workspace.getIdentityDecrypted(`adapter:${type}:${key}`, derivedKey)
        if (identityVal) return identityVal
        // Fall back to app-level env vars from AdapterRegistration
        if (appEnv) {
          const entry = appEnv.find((e) => e.key === key)
          if (entry) return entry.value
        }
        return null
      },

      log: (level: 'info' | 'warn' | 'error', message: string) => {
        const managed = this.adapters.get(type)
        if (managed) {
          this.addLog(managed, level, message)
        }
      }
    }
  }

  /**
   * Start periodic health checks for a connected adapter.
   */
  private startHealthCheck(managed: ManagedAdapter): void {
    this.stopHealthCheck(managed)
    managed.healthCheckTimer = setInterval(() => {
      if (!this.adapters.has(managed.type)) return

      const currentStatus = managed.adapter.status()

      if (currentStatus !== managed.status) {
        managed.status = currentStatus
        this.emitStatusChange(managed)
      }

      if ((currentStatus === 'disconnected' || currentStatus === 'error') && managed.autoRestart && !managed.restarting) {
        this.addLog(managed, 'system', `Health check: adapter ${currentStatus}, attempting reconnect`)
        this.handleAutoRestart(managed).catch(err =>
          console.error(`[AdapterManager] Auto-restart error for "${managed.type}":`, err)
        )
      }
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private stopHealthCheck(managed: ManagedAdapter): void {
    if (managed.healthCheckTimer) {
      clearInterval(managed.healthCheckTimer)
      managed.healthCheckTimer = undefined
    }
  }

  /**
   * Handle auto-restart after disconnection with exponential backoff.
   */
  private async handleAutoRestart(managed: ManagedAdapter): Promise<void> {
    if (managed.restartCount >= MAX_RETRIES) {
      this.addLog(managed, 'system', `Max restart attempts (${MAX_RETRIES}) reached, giving up`)
      managed.autoRestart = false
      return
    }

    managed.restarting = true
    managed.restartCount++
    const backoff = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, managed.restartCount - 1),
      MAX_BACKOFF_MS
    )
    this.addLog(managed, 'system', `Auto-restart ${managed.restartCount}/${MAX_RETRIES} in ${backoff / 1000}s...`)

    await new Promise(r => setTimeout(r, backoff))

    // Check if still managed and wants restart
    if (!this.adapters.has(managed.type) || !managed.autoRestart) {
      managed.restarting = false
      return
    }

    try {
      await managed.adapter.stop()
    } catch { /* ignore */ }

    managed.status = 'connecting'
    this.emitStatusChange(managed)

    try {
      await managed.adapter.start(managed.ctx)
      managed.status = managed.adapter.status()
      managed.connectedAt = Date.now()
      // Don't reset restartCount here — the adapter may appear connected briefly
      // then fail asynchronously (e.g. polling 409). Count only resets on manual restart.
      this.emitStatusChange(managed)
      this.addLog(managed, 'system', `Auto-restart successful`)
    } catch (error) {
      managed.status = 'error'
      managed.error = String(error instanceof Error ? error.message : error)
      this.emitStatusChange(managed)
      this.addLog(managed, 'error', `Auto-restart failed: ${managed.error}`)
    } finally {
      managed.restarting = false
    }
  }

  private addLog(managed: ManagedAdapter, level: AdapterLogEntry['level'], message: string): void {
    const entry: AdapterLogEntry = {
      timestamp: Date.now(),
      level,
      message
    }
    managed.logs.push(entry)
    // Ring buffer: batch-trim at 20% over capacity
    if (managed.logs.length > MAX_LOG_ENTRIES + 100) {
      managed.logs.splice(0, managed.logs.length - MAX_LOG_ENTRIES)
    }
    this.emit('log', managed.type, entry)
  }

  private emitStatusChange(managed: ManagedAdapter): void {
    this.emit('status-changed', managed.type, managed.status, managed.error)
  }
}
