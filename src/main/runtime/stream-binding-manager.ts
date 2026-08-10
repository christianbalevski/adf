import net from 'node:net'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { nanoid } from 'nanoid'
import type {
  BindingSummary,
  BindOptions,
  EndpointSummary,
  StreamBindEndpoint,
  StreamBindConfig,
  StreamBindingDeclaration,
  UmbilicalFilter,
} from '../../shared/types/adf-v02.types'
import type { WsConnectionManager, WsRawBindingHandle } from '../services/ws-connection-manager'
import { containerWorkspacePath, type PodmanService } from '../services/podman.service'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { emitUmbilicalEvent } from './emit-umbilical'
import { getUmbilicalBus } from './umbilical-bus'
import { compileUmbilicalFilter } from './umbilical-filter'

interface StreamEndpointRuntime {
  summary: EndpointSummary
  readable: boolean
  writable: boolean
  onData(listener: (data: Buffer) => void | Promise<void>): void
  onClose(listener: (reason: string) => void | Promise<void>): void
  onError(listener: (error: Error) => void | Promise<void>): void
  write(data: Buffer): Promise<void>
  close(reason?: string): void
  dispose(): void
  /**
   * Stop the source producing data. Present only on endpoints that can exert
   * real backpressure; a source without `pause` forces the pump to drop frames
   * once its queue is over the high-water mark rather than buffer without limit.
   */
  pause?(): void
  resume?(): void
}

/**
 * One direction of the pump. Chunks land in `queue` as they arrive and are
 * written serially by a single drain loop, so ordering is preserved while
 * `queuedBytes` stays a hard, observable bound on memory held per direction.
 */
interface PumpQueue {
  queue: Buffer[]
  queuedBytes: number
  paused: boolean
  draining: boolean
  /** Resolves when the current drain loop finishes; awaited on terminate. */
  chain: Promise<void>
}

function createPumpQueue(): PumpQueue {
  return { queue: [], queuedBytes: 0, paused: false, draining: false, chain: Promise.resolve() }
}

/** Shared drop counter — endpoints increment it without knowing the binding. */
interface DropCounter {
  count: number
}

interface EndpointContext {
  binding_id: string
  drops: DropCounter
}

interface ActiveBinding {
  binding_id: string
  aConfig: StreamBindEndpoint
  bConfig: StreamBindEndpoint
  a: StreamEndpointRuntime
  b: StreamEndpointRuntime
  bidirectional: boolean
  origin: 'imperative' | 'declarative'
  declaration_id?: string
  status: 'pending' | 'active' | 'draining'
  created_at: number
  bytes_a_to_b: number
  bytes_b_to_a: number
  drops: DropCounter
  last_flow_at: number
  options: Required<BindOptions>
  summaryTimer?: ReturnType<typeof setInterval>
  terminating: boolean
  aToB: PumpQueue
  bToA: PumpQueue
}

interface PendingDeclarativeBinding {
  declaration: StreamBindingDeclaration
  created_at: number
  last_error?: string
  attempts: number
  retryTimer?: ReturnType<typeof setTimeout>
  pendingEmitted: boolean
}

const DEFAULT_QUEUE_HIGH_WATER_BYTES = 4 * 1024 * 1024

const DEFAULT_OPTIONS: Required<BindOptions> = {
  idle_timeout_ms: 0,
  max_duration_ms: 0,
  max_bytes: 0,
  flow_summary_interval_ms: 1000,
  close_a_on_b_close: true,
  close_b_on_a_close: true,
  queue_high_water_bytes: DEFAULT_QUEUE_HIGH_WATER_BYTES,
  drain_timeout_ms: 1000,
}

/** Declarative retry backoff: 1s, 2s, 4s … capped. */
const MATERIALIZE_BASE_RETRY_MS = 1000
const MATERIALIZE_MAX_RETRY_MS = 60_000

/** Process stderr is drained into agent logs, bounded by these. */
const STDERR_MAX_LINE_CHARS = 1000
const STDERR_MAX_BUFFERED_LINES = 50
const STDERR_FLUSH_INTERVAL_MS = 1000

export class StreamBindingManager {
  private bindings = new Map<string, ActiveBinding>()
  private pendingDeclarations = new Map<string, PendingDeclarativeBinding>()
  private declarations = new Map<string, StreamBindingDeclaration>()

  constructor(
    private readonly agentId: string,
    private readonly agentName: string,
    private readonly agentFilePath: string,
    private readonly config: StreamBindConfig | undefined,
    private readonly wsConnectionManager: WsConnectionManager | null,
    private readonly podmanService: PodmanService | null = null,
    private readonly workspace: AdfWorkspace | null = null,
  ) {}

  async bind(input: {
    a: StreamBindEndpoint
    b: StreamBindEndpoint
    bidirectional?: boolean
    options?: BindOptions
    origin?: 'imperative' | 'declarative'
    declaration_id?: string
    binding_id?: string
  }): Promise<{ binding_id: string }> {
    if (input.b.kind === 'umbilical') {
      throw new Error('umbilical endpoints are read-only and cannot appear as b')
    }

    const binding_id = input.binding_id ?? nanoid(12)
    if (this.bindings.has(binding_id)) throw new Error(`Binding already exists: ${binding_id}`)
    const bidirectional = input.a.kind === 'umbilical' ? false : input.bidirectional === true
    const options = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) }
    options.flow_summary_interval_ms = Math.max(100, options.flow_summary_interval_ms)
    options.queue_high_water_bytes = Math.max(1, options.queue_high_water_bytes)
    options.drain_timeout_ms = Math.max(0, options.drain_timeout_ms)

    const drops: DropCounter = { count: 0 }
    const context: EndpointContext = { binding_id, drops }

    const a = await this.createEndpoint(input.a, 'a', context)
    let b: StreamEndpointRuntime | null = null
    try {
      b = await this.createEndpoint(input.b, 'b', context)
      if (!a.readable) throw new Error('endpoint a is not readable')
      if (!b.writable) throw new Error('endpoint b is not writable')
      if (bidirectional && (!b.readable || !a.writable)) {
        throw new Error('bidirectional bindings require both endpoints to be readable and writable')
      }

      const binding: ActiveBinding = {
        binding_id,
        aConfig: input.a,
        bConfig: input.b,
        a,
        b,
        bidirectional,
        origin: input.origin ?? 'imperative',
        declaration_id: input.declaration_id,
        status: 'active',
        created_at: Date.now(),
        bytes_a_to_b: 0,
        bytes_b_to_a: 0,
        drops,
        last_flow_at: Date.now(),
        options,
        terminating: false,
        aToB: createPumpQueue(),
        bToA: createPumpQueue(),
      }

      this.bindPump(binding, 'a_to_b')
      if (bidirectional) this.bindPump(binding, 'b_to_a')
      this.bindLifecycle(binding)
      binding.summaryTimer = setInterval(() => this.emitSummaryAndCheckThresholds(binding), options.flow_summary_interval_ms)
      this.bindings.set(binding_id, binding)
      this.pendingDeclarations.delete(binding.declaration_id ?? binding_id)

      this.emit('binding.created', {
        binding_id,
        a: a.summary,
        b: b.summary,
        bidirectional,
        origin: binding.origin,
        declaration_id: binding.declaration_id,
        options: summarizeOptions(options),
      })
      if (binding.origin === 'declarative') {
        this.emit('binding.materialized', { binding_id, declaration_id: binding.declaration_id })
      }

      return { binding_id }
    } catch (err) {
      a.dispose()
      b?.dispose()
      throw err
    }
  }

  async unbind(bindingId: string): Promise<{ ok: true }> {
    const binding = this.bindings.get(bindingId)
    if (!binding) throw new Error(`Binding not found: ${bindingId}`)
    this.terminate(binding, 'manual')
    return { ok: true }
  }

  bindingsSummary(): BindingSummary[] {
    const active = Array.from(this.bindings.values()).map(binding => ({
      binding_id: binding.binding_id,
      a: binding.a.summary,
      b: binding.b.summary,
      bidirectional: binding.bidirectional,
      origin: binding.origin,
      declaration_id: binding.declaration_id,
      status: binding.status,
      created_at: binding.created_at,
      bytes_a_to_b: binding.bytes_a_to_b,
      bytes_b_to_a: binding.bytes_b_to_a,
      frames_dropped: binding.drops.count,
    }))
    const pending = Array.from(this.pendingDeclarations.values()).map(pendingBinding => ({
      binding_id: pendingBinding.declaration.id,
      a: summarizeEndpoint(pendingBinding.declaration.a),
      b: summarizeEndpoint(pendingBinding.declaration.b),
      bidirectional: pendingBinding.declaration.a.kind === 'umbilical' ? false : pendingBinding.declaration.bidirectional === true,
      origin: 'declarative' as const,
      declaration_id: pendingBinding.declaration.id,
      status: 'pending' as const,
      created_at: pendingBinding.created_at,
      bytes_a_to_b: 0,
      bytes_b_to_a: 0,
      frames_dropped: 0,
      attempts: pendingBinding.attempts,
      last_error: pendingBinding.last_error,
    }))
    return [...active, ...pending]
  }

  loadDeclarations(declarations: StreamBindingDeclaration[]): void {
    const nextIds = new Set(declarations.map(declaration => declaration.id))
    for (const [id, pending] of this.pendingDeclarations) {
      if (!nextIds.has(id)) {
        if (pending.retryTimer) clearTimeout(pending.retryTimer)
        this.pendingDeclarations.delete(id)
      }
    }

    // A declaration that disappeared from config must not keep pumping bytes.
    // Dropping only the pending record left already-materialized bindings alive
    // with no config backing them.
    for (const [id] of this.declarations) {
      if (!nextIds.has(id)) this.declarations.delete(id)
    }
    for (const binding of Array.from(this.bindings.values())) {
      if (binding.origin !== 'declarative') continue
      if (!binding.declaration_id || nextIds.has(binding.declaration_id)) continue
      this.terminate(binding, 'declaration_removed')
    }

    for (const declaration of declarations) {
      this.declarations.set(declaration.id, declaration)
      if (this.bindings.has(declaration.id)) continue
      this.ensurePending(declaration)
      this.scheduleMaterialization(declaration, 0, false)
    }
  }

  stopAll(reason = 'agent_stopped'): void {
    for (const pending of this.pendingDeclarations.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer)
    }
    this.pendingDeclarations.clear()
    for (const binding of Array.from(this.bindings.values())) {
      this.terminate(binding, reason)
    }
  }

  /**
   * Wire one direction of the pump with a bounded queue.
   *
   * A fast source feeding a slow sink used to accumulate every unwritten chunk
   * in an unbounded promise chain — the process would OOM long before anything
   * noticed. Now chunks are queued with a byte budget: crossing the high-water
   * mark pauses the source, and draining back under half of it resumes. Sources
   * that cannot be paused (the umbilical bus fans out synchronously) drop the
   * frame instead and increment `frames_dropped`, which is never silent — it
   * rides along on every `binding.flow_summary`.
   */
  private bindPump(binding: ActiveBinding, direction: 'a_to_b' | 'b_to_a'): void {
    const source = direction === 'a_to_b' ? binding.a : binding.b
    const pump = direction === 'a_to_b' ? binding.aToB : binding.bToA
    const highWater = binding.options.queue_high_water_bytes
    const canPause = typeof source.pause === 'function'

    source.onData((data) => {
      if (binding.terminating || binding.status !== 'active') return
      const bytes = Buffer.from(data)

      if (pump.queuedBytes + bytes.byteLength > highWater && !canPause) {
        // Unpausable source over budget — shed load rather than grow forever.
        binding.drops.count += 1
        return
      }

      pump.queue.push(bytes)
      pump.queuedBytes += bytes.byteLength
      if (canPause && !pump.paused && pump.queuedBytes >= highWater) {
        pump.paused = true
        try { source.pause?.() } catch { /* pausing is best effort */ }
      }
      void this.drainPump(binding, direction)
    })
  }

  /** Start (or join) the single-flight drain loop for one direction. */
  private drainPump(binding: ActiveBinding, direction: 'a_to_b' | 'b_to_a'): Promise<void> {
    const pump = direction === 'a_to_b' ? binding.aToB : binding.bToA
    if (pump.draining) return pump.chain
    pump.draining = true
    pump.chain = this.runPumpDrain(binding, direction).finally(() => { pump.draining = false })
    return pump.chain
  }

  private async runPumpDrain(binding: ActiveBinding, direction: 'a_to_b' | 'b_to_a'): Promise<void> {
    const source = direction === 'a_to_b' ? binding.a : binding.b
    const target = direction === 'a_to_b' ? binding.b : binding.a
    const pump = direction === 'a_to_b' ? binding.aToB : binding.bToA
    const lowWater = Math.floor(binding.options.queue_high_water_bytes / 2)

    try {
      while (pump.queue.length > 0 && !binding.terminating) {
        const chunk = pump.queue.shift()!
        await target.write(chunk)
        pump.queuedBytes -= chunk.byteLength
        if (direction === 'a_to_b') binding.bytes_a_to_b += chunk.byteLength
        else binding.bytes_b_to_a += chunk.byteLength
        binding.last_flow_at = Date.now()
        if (pump.paused && pump.queuedBytes <= lowWater) {
          pump.paused = false
          try { source.resume?.() } catch { /* resuming is best effort */ }
        }
      }
    } catch (err) {
      // The failing endpoint is the write target of this direction.
      this.emit('binding.error', {
        binding_id: binding.binding_id,
        endpoint: direction === 'a_to_b' ? 'b' : 'a',
        direction,
        error: String(err instanceof Error ? err.message : err),
      })
      this.terminate(binding, 'write_error')
    }
  }

  private bindLifecycle(binding: ActiveBinding): void {
    binding.a.onClose((reason) => {
      if (binding.terminating) return
      void this.drainAndTerminate(binding, reason === 'process_exit' ? 'source_process_exit' : 'source_closed')
    })
    binding.b.onClose((reason) => {
      if (binding.terminating) return
      void this.drainAndTerminate(binding, reason === 'process_exit' ? 'target_process_exit' : 'target_closed')
    })
    binding.a.onError((error) => {
      this.emit('binding.error', { binding_id: binding.binding_id, endpoint: 'a', error: error.message })
      this.terminate(binding, 'source_error')
    })
    binding.b.onError((error) => {
      this.emit('binding.error', { binding_id: binding.binding_id, endpoint: 'b', error: error.message })
      this.terminate(binding, 'target_error')
    })
  }

  private emitSummaryAndCheckThresholds(binding: ActiveBinding): void {
    if (binding.terminating) return

    this.emitFlowSummary(binding)

    const now = Date.now()
    const totalBytes = binding.bytes_a_to_b + binding.bytes_b_to_a
    if (binding.options.max_bytes > 0 && totalBytes >= binding.options.max_bytes) {
      this.threshold(binding, 'max_bytes', totalBytes, binding.options.max_bytes)
      return
    }
    if (binding.options.max_duration_ms > 0 && now - binding.created_at >= binding.options.max_duration_ms) {
      this.threshold(binding, 'max_duration_ms', now - binding.created_at, binding.options.max_duration_ms)
      return
    }
    if (binding.options.idle_timeout_ms > 0 && now - binding.last_flow_at >= binding.options.idle_timeout_ms) {
      this.threshold(binding, 'idle_timeout_ms', now - binding.last_flow_at, binding.options.idle_timeout_ms)
    }
  }

  private threshold(binding: ActiveBinding, threshold: string, observed: number, limit: number): void {
    this.emit('binding.threshold_exceeded', {
      binding_id: binding.binding_id,
      threshold,
      observed,
      limit,
    })
    this.terminate(binding, `threshold_exceeded:${threshold}`)
  }

  private async drainAndTerminate(binding: ActiveBinding, reason: string): Promise<void> {
    if (binding.terminating) return
    binding.status = 'draining'
    await Promise.race([
      Promise.allSettled([binding.aToB.chain, binding.bToA.chain]),
      new Promise(resolve => setTimeout(resolve, binding.options.drain_timeout_ms)),
    ])
    this.terminate(binding, reason)
  }

  private terminate(binding: ActiveBinding, reason: string): void {
    if (binding.terminating) return
    binding.terminating = true
    binding.status = 'draining'
    if (binding.summaryTimer) clearInterval(binding.summaryTimer)
    if (reason.startsWith('source_') && binding.options.close_b_on_a_close) binding.b.close('peer_closed')
    if (reason.startsWith('target_') && binding.options.close_a_on_b_close) binding.a.close('peer_closed')
    this.emitFlowSummary(binding)
    // A source that backpressure paused must be un-paused before we let go of
    // it. dispose() for a `ws` endpoint only detaches listeners — the underlying
    // net.Socket stays OPEN for reuse/reconnect, and reasons like 'manual',
    // 'agent_stopped', 'declaration_removed', and 'threshold_exceeded:*' never
    // close it. Left paused, that socket goes permanently silent (no further
    // message/data events) while getConnections() still reports it healthy.
    this.resumePausedSources(binding)
    binding.a.dispose()
    binding.b.dispose()
    this.bindings.delete(binding.binding_id)
    this.emit('binding.terminated', {
      binding_id: binding.binding_id,
      reason,
      origin: binding.origin,
      declaration_id: binding.declaration_id,
      bytes_a_to_b: binding.bytes_a_to_b,
      bytes_b_to_a: binding.bytes_b_to_a,
      frames_dropped: binding.drops.count,
      duration_ms: Date.now() - binding.created_at,
    })
    if (
      binding.origin === 'declarative'
      && binding.declaration_id
      && reason !== 'manual'
      && reason !== 'agent_stopped'
      && reason !== 'declaration_removed'
    ) {
      const declaration = this.declarations.get(binding.declaration_id)
      if (declaration?.reconnect) {
        this.emit('binding.reconnecting', {
          binding_id: binding.binding_id,
          declaration_id: binding.declaration_id,
          reason,
        })
        this.ensurePending(declaration, false)
        this.scheduleMaterialization(declaration, 1000, true)
      }
    }
  }

  /**
   * Un-pause any source that backpressure paused while its endpoint outlives the
   * binding. Both directions are checked independently: `aToB.paused` means the
   * `a` source is paused, `bToA.paused` means `b` is — a bidirectional binding
   * can have paused both. Called from `terminate`, the single funnel for
   * unbind/stopAll/threshold/declaration_removed/drainAndTerminate.
   */
  private resumePausedSources(binding: ActiveBinding): void {
    this.resumePausedDirection(binding, 'a_to_b')
    this.resumePausedDirection(binding, 'b_to_a')
  }

  private resumePausedDirection(binding: ActiveBinding, direction: 'a_to_b' | 'b_to_a'): void {
    const pump = direction === 'a_to_b' ? binding.aToB : binding.bToA
    if (!pump.paused) return
    const source = direction === 'a_to_b' ? binding.a : binding.b
    pump.paused = false
    try {
      source.resume?.()
    } catch (err) {
      // A resume that throws means the socket is already dead — the only case
      // where leaving it paused no longer matters. Never fully silent: log it so
      // a genuinely-stuck socket would still leave a trace.
      this.logEvent('binding.resume_failed', {
        binding_id: binding.binding_id,
        direction,
        error: String(err instanceof Error ? err.message : err),
      })
    }
  }

  private ensurePending(declaration: StreamBindingDeclaration, emitPending = true): PendingDeclarativeBinding {
    let pending = this.pendingDeclarations.get(declaration.id)
    if (!pending) {
      pending = {
        declaration,
        created_at: Date.now(),
        attempts: 0,
        pendingEmitted: false,
      }
      this.pendingDeclarations.set(declaration.id, pending)
    } else {
      pending.declaration = declaration
    }
    if (emitPending && !pending.pendingEmitted) {
      pending.pendingEmitted = true
      this.emit('binding.pending', {
        binding_id: declaration.id,
        declaration_id: declaration.id,
        a: summarizeEndpoint(declaration.a),
        b: summarizeEndpoint(declaration.b),
      })
    }
    return pending
  }

  private scheduleMaterialization(declaration: StreamBindingDeclaration, delayMs: number, reconnecting: boolean): void {
    const pending = this.ensurePending(declaration, !reconnecting)
    if (pending.retryTimer) return
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined
      if (this.bindings.has(declaration.id)) {
        this.pendingDeclarations.delete(declaration.id)
        return
      }
      this.bind({
        a: declaration.a,
        b: declaration.b,
        bidirectional: declaration.bidirectional,
        options: declaration.options,
        origin: 'declarative',
        declaration_id: declaration.id,
        binding_id: declaration.id,
      }).catch((err) => {
        // Exponential backoff — a permanently unreachable target (bad host,
        // podman down) used to be retried once a second for the agent's whole
        // lifetime, logging an error every time.
        const next = this.ensurePending(declaration, !reconnecting)
        next.attempts += 1
        next.last_error = String(err instanceof Error ? err.message : err)
        this.scheduleMaterialization(declaration, backoffDelayMs(next.attempts), reconnecting)
      })
    }, delayMs)
  }

  private async createEndpoint(
    endpoint: StreamBindEndpoint,
    label: 'a' | 'b',
    context: EndpointContext,
  ): Promise<StreamEndpointRuntime> {
    switch (endpoint.kind) {
      case 'ws':
        return this.createWsEndpoint(endpoint.connection_id)
      case 'tcp':
        return this.createTcpEndpoint(endpoint.host, endpoint.port)
      case 'process':
        return this.createProcessEndpoint(endpoint, context)
      case 'umbilical':
        if (label !== 'a') throw new Error('umbilical endpoints can only appear as a')
        return this.createUmbilicalEndpoint(endpoint.filter, context)
      default:
        return assertNever(endpoint)
    }
  }

  private createWsEndpoint(connectionId: string): StreamEndpointRuntime {
    if (!this.wsConnectionManager) throw new Error('WebSocket binding is unavailable in this runtime')
    let dataListener: ((data: Buffer) => void | Promise<void>) | null = null
    let closeListener: ((reason: string) => void | Promise<void>) | null = null
    let errorListener: ((error: Error) => void | Promise<void>) | null = null
    const result = this.wsConnectionManager.bindRawConnection(connectionId, {
      onData: data => dataListener?.(data),
      onClose: reason => closeListener?.(reason),
      onError: error => errorListener?.(error),
    })
    if (!result.handle) throw new Error(result.error ?? 'Failed to bind WebSocket connection')
    const handle: WsRawBindingHandle = result.handle
    if (handle.agentFilePath !== this.agentFilePath) {
      handle.detach()
      throw new Error('WebSocket connection does not belong to this agent')
    }
    return {
      summary: wsEndpointSummary(handle.connectionId, handle.direction, handle.remoteDid),
      readable: true,
      writable: true,
      onData: listener => { dataListener = listener },
      onClose: listener => { closeListener = listener },
      onError: listener => { errorListener = listener },
      write: data => handle.write(data),
      close: reason => handle.close(1000, reason ?? 'Stream binding closed'),
      dispose: () => handle.detach(),
      // `ws` has no pause API of its own; the manager pauses the underlying
      // net.Socket, which stops the TCP read side and lets the kernel window
      // close on the peer.
      pause: () => handle.pause(),
      resume: () => handle.resume(),
    }
  }

  private async createTcpEndpoint(host: string, port: number): Promise<StreamEndpointRuntime> {
    this.assertTcpAllowed(host, port)

    const socket = net.createConnection({ host, port })
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve() }
      const onError = (err: Error) => { cleanup(); reject(err) }
      const cleanup = () => {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })

    let dataListener: ((data: Buffer) => void | Promise<void>) | null = null
    let closeListener: ((reason: string) => void | Promise<void>) | null = null
    let errorListener: ((error: Error) => void | Promise<void>) | null = null
    socket.on('data', data => void dataListener?.(Buffer.from(data)))
    socket.on('close', () => void closeListener?.('tcp_closed'))
    socket.on('error', err => void errorListener?.(err))

    return {
      summary: { kind: 'tcp', host, port },
      readable: true,
      writable: true,
      onData: listener => { dataListener = listener },
      onClose: listener => { closeListener = listener },
      onError: listener => { errorListener = listener },
      write: data => writeToNodeStream(socket, data),
      close: () => socket.destroy(),
      dispose: () => socket.destroy(),
      pause: () => socket.pause(),
      resume: () => socket.resume(),
    }
  }

  private async createProcessEndpoint(
    endpoint: Extract<StreamBindEndpoint, { kind: 'process' }>,
    context: EndpointContext,
  ): Promise<StreamEndpointRuntime> {
    if (endpoint.command.length === 0) throw new Error('Process command cannot be empty')

    let child: ChildProcess | ChildProcessWithoutNullStreams
    let summaryCwd = endpoint.cwd
    if (endpoint.isolation === 'host') {
      if (!this.config?.host_process_bind) throw new Error('Host process stream binding is not enabled for this agent')
      child = spawn(endpoint.command[0], endpoint.command.slice(1), {
        cwd: endpoint.cwd,
        env: endpoint.env ? { ...process.env, ...endpoint.env } : process.env,
        stdio: 'pipe',
      })
    } else if (endpoint.isolation === 'container_shared') {
      if (!this.config?.container_shared_bind) throw new Error('Shared-container process stream binding is not enabled for this agent')
      if (!this.podmanService) throw new Error('Podman is unavailable in this runtime')
      await this.podmanService.ensureRunning()
      await this.podmanService.registerAgent(this.agentId)
      summaryCwd = endpoint.cwd ?? containerWorkspacePath(false, this.agentId)
      child = this.podmanService.spawnExec(
        this.agentId,
        endpoint.command[0],
        endpoint.command.slice(1),
        endpoint.env,
        summaryCwd,
      )
    } else {
      if (!this.config?.container_isolated_bind) throw new Error('Isolated-container process stream binding is not enabled for this agent')
      if (!endpoint.image) throw new Error('container_isolated process bindings require image')
      if (!this.podmanService) throw new Error('Podman is unavailable in this runtime')
      summaryCwd = endpoint.cwd ?? '/workspace'
      child = await this.podmanService.spawnImageProcess(
        endpoint.image,
        endpoint.command[0],
        endpoint.command.slice(1),
        endpoint.env,
        summaryCwd,
      )
    }

    let dataListener: ((data: Buffer) => void | Promise<void>) | null = null
    let closeListener: ((reason: string) => void | Promise<void>) | null = null
    let errorListener: ((error: Error) => void | Promise<void>) | null = null
    if (!child.stdout || !child.stdin) throw new Error('Process endpoint did not expose stdio pipes')
    const stdout = child.stdout
    const stdin = child.stdin
    stdout.on('data', data => void dataListener?.(Buffer.from(data)))
    // stdio:'pipe' opens a stderr pipe whether or not anyone reads it. Leaving
    // it unread lets the OS pipe buffer fill (~64 KiB) and blocks the child on
    // its next stderr write — a chatty process would deadlock mid-stream.
    const stopStderr = this.consumeProcessStderr(child, context.binding_id)
    child.on('exit', () => {
      stopStderr()
      void closeListener?.('process_exit')
    })
    child.on('error', err => void errorListener?.(err))

    const teardown = () => {
      stopStderr()
      try { stdin.destroy() } catch { /* best effort */ }
      try { child.kill() } catch { /* best effort */ }
    }

    return {
      summary: {
        kind: 'process',
        isolation: endpoint.isolation,
        command: endpoint.command.slice(),
        cwd: summaryCwd,
      },
      readable: true,
      writable: true,
      onData: listener => { dataListener = listener },
      onClose: listener => { closeListener = listener },
      onError: listener => { errorListener = listener },
      write: data => writeToNodeStream(stdin, data),
      close: teardown,
      dispose: teardown,
      // Pausing stdout stops reading the child's pipe, which propagates
      // backpressure to the child the moment its own pipe buffer fills.
      pause: () => stdout.pause(),
      resume: () => stdout.resume(),
    }
  }

  /**
   * Drain a child's stderr into the agent log. Always consumes the stream even
   * when there is no workspace to log to — the point is to keep the pipe from
   * filling. Output is truncated per line, capped to the most recent lines, and
   * flushed at most once per interval so a screaming process cannot flood
   * adf_logs.
   */
  private consumeProcessStderr(child: ChildProcess | ChildProcessWithoutNullStreams, bindingId: string): () => void {
    const stderr = child.stderr
    if (!stderr) return () => {}

    let partial = ''
    let recent: string[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const flush = () => {
      flushTimer = null
      if (recent.length === 0) return
      const lines = recent
      recent = []
      if (!this.workspace) return
      try {
        this.workspace.insertLog(
          'warn',
          'stream_bind',
          'process_stderr',
          bindingId,
          lines.join('\n'),
          { binding_id: bindingId, lines },
        )
      } catch {
        // Stream binding observability must not affect the data path.
      }
    }

    const record = (line: string) => {
      if (line.length === 0) return
      recent.push(line.length > STDERR_MAX_LINE_CHARS ? `${line.slice(0, STDERR_MAX_LINE_CHARS)}…` : line)
      if (recent.length > STDERR_MAX_BUFFERED_LINES) recent = recent.slice(-STDERR_MAX_BUFFERED_LINES)
      if (!flushTimer) flushTimer = setTimeout(flush, STDERR_FLUSH_INTERVAL_MS)
    }

    stderr.on('data', (chunk: Buffer | string) => {
      if (stopped) return
      partial += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) record(line.replace(/\r$/, ''))
    })
    stderr.on('error', () => { /* the child is going away; nothing to do */ })

    return () => {
      if (stopped) return
      stopped = true
      if (partial.length > 0) {
        record(partial)
        partial = ''
      }
      if (flushTimer) clearTimeout(flushTimer)
      flush()
      try { stderr.destroy() } catch { /* best effort */ }
    }
  }

  private createUmbilicalEndpoint(filter: UmbilicalFilter | undefined, context: EndpointContext): StreamEndpointRuntime {
    const bus = getUmbilicalBus(this.agentId)
    if (!bus) throw new Error('Umbilical bus is not available for this agent')

    const compiled = compileUmbilicalFilter({
      event_types: filter?.event_types,
      when: filter?.when,
      max_rate_per_sec: filter?.max_rate_per_sec,
      exclude_source: filter?.exclude_source,
    }, {
      whenFilename: `stream-bind:${context.binding_id}:umbilical-filter`,
      // A rate-limited frame is a dropped frame; report it like any other drop.
      onRateLimited: () => { context.drops.count += 1 },
      // Feedback-loop guard, unconditional and not overridable by config: this
      // binding's own binding.* events (flow_summary in particular, which is
      // emitted on a timer) would otherwise be pumped into the binding, whose
      // byte counters move, which emits another flow_summary, forever.
      suppress: event => event.payload?.binding_id === context.binding_id,
    })

    let dataListener: ((data: Buffer) => void | Promise<void>) | null = null
    const unsubscribe = bus.subscribe((event) => {
      if (!compiled.test(event)) return
      const frame = Buffer.from(`${JSON.stringify(event)}\n`, 'utf-8')
      void dataListener?.(frame)
    })
    return {
      summary: { kind: 'umbilical', filter: filter ? { ...filter } : undefined },
      readable: true,
      writable: false,
      onData: listener => { dataListener = listener },
      onClose: () => {},
      onError: () => {},
      write: async () => { throw new Error('Umbilical endpoint is read-only') },
      close: () => {},
      dispose: () => unsubscribe(),
      // Deliberately no pause/resume: the bus fans out synchronously to every
      // subscriber and has no queue to stall. Over-budget frames are dropped by
      // the pump instead of buffered.
    }
  }

  /**
   * Fail closed. `allow_tcp_bind` used to imply "any host, any port" when no
   * allowlist was configured, which made the flag itself the whole policy.
   * An explicit allowlist is now mandatory; `host: '*'` still expresses
   * allow-all, but you have to write it down.
   */
  private assertTcpAllowed(host: string, port: number): void {
    if (!this.config?.allow_tcp_bind) throw new Error('TCP stream binding is not enabled for this agent')
    const rules = this.config.tcp_allowlist
    if (!rules || rules.length === 0) {
      throw new Error(
        'TCP stream binding requires an explicit stream_bind.tcp_allowlist; '
        + 'allow_tcp_bind on its own denies every target. '
        + `Add a rule for ${host}:${port} (use host "*" to allow every host).`,
      )
    }
    const allowed = rules.some(rule => {
      if (rule.host !== host && rule.host !== '*') return false
      if (typeof rule.port === 'number') return rule.port === port
      if (Array.isArray(rule.ports)) return rule.ports.includes(port)
      if (typeof rule.min_port === 'number' || typeof rule.max_port === 'number') {
        const min = rule.min_port ?? 0
        const max = rule.max_port ?? 65535
        return port >= min && port <= max
      }
      return true
    })
    if (!allowed) throw new Error(`TCP binding target is not allow-listed: ${host}:${port}`)
  }

  private emit(event_type: string, payload: Record<string, unknown>): void {
    this.logEvent(event_type, payload)
    emitUmbilicalEvent({
      event_type,
      agentId: this.agentId,
      source: 'system:stream_bind',
      payload,
    })
  }

  private emitFlowSummary(binding: ActiveBinding): void {
    this.emit('binding.flow_summary', {
      binding_id: binding.binding_id,
      bytes_a_to_b: binding.bytes_a_to_b,
      bytes_b_to_a: binding.bytes_b_to_a,
      frames_dropped: binding.drops.count,
      interval_ms: binding.options.flow_summary_interval_ms,
      status: binding.status,
    })
  }

  private logEvent(eventType: string, payload: Record<string, unknown>): void {
    if (!this.workspace) return
    const bindingId = typeof payload.binding_id === 'string' ? payload.binding_id : null
    const reason = typeof payload.reason === 'string' ? ` (${payload.reason})` : ''
    try {
      this.workspace.insertLog('info', 'stream_bind', eventType, bindingId, `${eventType}${reason}`, payload)
    } catch {
      // Stream binding observability must not affect the data path.
    }
  }
}

function writeToNodeStream(stream: NodeJS.WritableStream, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      stream.removeListener('error', onError)
      stream.removeListener('drain', onDrain)
    }
    stream.once('error', onError)
    const ok = stream.write(data, (err?: Error | null) => {
      if (err) onError(err)
    })
    if (ok) {
      cleanup()
      resolve()
    } else {
      stream.once('drain', onDrain)
    }
  })
}

function backoffDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(MATERIALIZE_MAX_RETRY_MS, MATERIALIZE_BASE_RETRY_MS * 2 ** exponent)
}

function summarizeOptions(options: Required<BindOptions>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== 0),
  )
}

/**
 * Single source of the `ws` endpoint summary shape so live and pending
 * bindings agree on their keys — they used to disagree under one type, with
 * pending summaries silently missing direction/remote_did.
 */
function wsEndpointSummary(
  connectionId: string,
  direction?: 'inbound' | 'outbound',
  remoteDid?: string,
): EndpointSummary {
  return { kind: 'ws', connection_id: connectionId, direction, remote_did: remoteDid }
}

function summarizeEndpoint(endpoint: StreamBindEndpoint): EndpointSummary {
  switch (endpoint.kind) {
    case 'ws':
      return wsEndpointSummary(endpoint.connection_id)
    case 'tcp':
      return { kind: 'tcp', host: endpoint.host, port: endpoint.port }
    case 'process':
      return {
        kind: 'process',
        isolation: endpoint.isolation,
        command: endpoint.command.slice(),
        cwd: endpoint.cwd,
      }
    case 'umbilical':
      return { kind: 'umbilical', filter: endpoint.filter ? { ...endpoint.filter } : undefined }
    default:
      return assertNever(endpoint)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported endpoint: ${JSON.stringify(value)}`)
}
