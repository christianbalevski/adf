import net from 'node:net'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { nanoid } from 'nanoid'
import { Script } from 'node:vm'
import type {
  BindingSummary,
  BindOptions,
  StreamBindEndpoint,
  StreamBindConfig,
  StreamBindingDeclaration,
  UmbilicalFilter,
} from '../../shared/types/adf-v02.types'
import type { WsConnectionManager, WsRawBindingHandle } from '../services/ws-connection-manager'
import { containerWorkspacePath, type PodmanService } from '../services/podman.service'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { emitUmbilicalEvent } from './emit-umbilical'
import { getUmbilicalBus, type UmbilicalEvent } from './umbilical-bus'

interface StreamEndpointRuntime {
  summary: BindingSummary['a']
  readable: boolean
  writable: boolean
  onData(listener: (data: Buffer) => void | Promise<void>): void
  onClose(listener: (reason: string) => void | Promise<void>): void
  onError(listener: (error: Error) => void | Promise<void>): void
  write(data: Buffer): Promise<void>
  close(reason?: string): void
  dispose(): void
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
  last_flow_at: number
  options: Required<BindOptions>
  summaryTimer?: ReturnType<typeof setInterval>
  terminating: boolean
  aToBChain: Promise<void>
  bToAChain: Promise<void>
}

interface PendingDeclarativeBinding {
  declaration: StreamBindingDeclaration
  created_at: number
  last_error?: string
  retryTimer?: ReturnType<typeof setTimeout>
  pendingEmitted: boolean
}

const DEFAULT_OPTIONS: Required<BindOptions> = {
  idle_timeout_ms: 0,
  max_duration_ms: 0,
  max_bytes: 0,
  flow_summary_interval_ms: 1000,
  close_a_on_b_close: true,
  close_b_on_a_close: true,
}

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

    const a = await this.createEndpoint(input.a, 'a')
    let b: StreamEndpointRuntime | null = null
    try {
      b = await this.createEndpoint(input.b, 'b')
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
        last_flow_at: Date.now(),
        options,
        terminating: false,
        aToBChain: Promise.resolve(),
        bToAChain: Promise.resolve(),
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

  private bindPump(binding: ActiveBinding, direction: 'a_to_b' | 'b_to_a'): void {
    const source = direction === 'a_to_b' ? binding.a : binding.b
    const target = direction === 'a_to_b' ? binding.b : binding.a
    const chainKey = direction === 'a_to_b' ? 'aToBChain' : 'bToAChain'

    source.onData((data) => {
      if (binding.terminating || binding.status !== 'active') return
      const bytes = Buffer.from(data)
      binding[chainKey] = binding[chainKey].then(async () => {
        if (binding.terminating) return
        await target.write(bytes)
        if (direction === 'a_to_b') binding.bytes_a_to_b += bytes.byteLength
        else binding.bytes_b_to_a += bytes.byteLength
        binding.last_flow_at = Date.now()
      }).catch((err) => {
        this.emit('binding.error', {
          binding_id: binding.binding_id,
          direction,
          error: String(err instanceof Error ? err.message : err),
        })
        this.terminate(binding, 'write_error')
      })
    })
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
      Promise.allSettled([binding.aToBChain, binding.bToAChain]),
      new Promise(resolve => setTimeout(resolve, 1000)),
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
      duration_ms: Date.now() - binding.created_at,
    })
    if (
      binding.origin === 'declarative'
      && binding.declaration_id
      && reason !== 'manual'
      && reason !== 'agent_stopped'
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

  private ensurePending(declaration: StreamBindingDeclaration, emitPending = true): PendingDeclarativeBinding {
    let pending = this.pendingDeclarations.get(declaration.id)
    if (!pending) {
      pending = {
        declaration,
        created_at: Date.now(),
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
        const next = this.ensurePending(declaration, !reconnecting)
        next.last_error = String(err instanceof Error ? err.message : err)
        this.scheduleMaterialization(declaration, 1000, reconnecting)
      })
    }, delayMs)
  }

  private async createEndpoint(endpoint: StreamBindEndpoint, label: 'a' | 'b'): Promise<StreamEndpointRuntime> {
    switch (endpoint.kind) {
      case 'ws':
        return this.createWsEndpoint(endpoint.connection_id)
      case 'tcp':
        return this.createTcpEndpoint(endpoint.host, endpoint.port)
      case 'process':
        return this.createProcessEndpoint(endpoint)
      case 'umbilical':
        if (label !== 'a') throw new Error('umbilical endpoints can only appear as a')
        return this.createUmbilicalEndpoint(endpoint.filter)
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
      summary: {
        kind: 'ws',
        connection_id: handle.connectionId,
        direction: handle.direction,
        remote_did: handle.remoteDid,
      },
      readable: true,
      writable: true,
      onData: listener => { dataListener = listener },
      onClose: listener => { closeListener = listener },
      onError: listener => { errorListener = listener },
      write: data => handle.write(data),
      close: reason => handle.close(1000, reason ?? 'Stream binding closed'),
      dispose: () => handle.detach(),
    }
  }

  private async createTcpEndpoint(host: string, port: number): Promise<StreamEndpointRuntime> {
    if (!this.config?.allow_tcp_bind) throw new Error('TCP stream binding is not enabled for this agent')
    if (!this.isTcpAllowed(host, port)) throw new Error(`TCP binding target is not allow-listed: ${host}:${port}`)

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
    }
  }

  private async createProcessEndpoint(endpoint: Extract<StreamBindEndpoint, { kind: 'process' }>): Promise<StreamEndpointRuntime> {
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
    child.stdout.on('data', data => void dataListener?.(Buffer.from(data)))
    child.on('exit', () => void closeListener?.('process_exit'))
    child.on('error', err => void errorListener?.(err))

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
      write: data => writeToNodeStream(child.stdin, data),
      close: () => {
        try { child.stdin.destroy() } catch { /* best effort */ }
        try { child.kill() } catch { /* best effort */ }
      },
      dispose: () => {
        try { child.stdin.destroy() } catch { /* best effort */ }
        try { child.kill() } catch { /* best effort */ }
      },
    }
  }

  private createUmbilicalEndpoint(filter?: UmbilicalFilter): StreamEndpointRuntime {
    const bus = getUmbilicalBus(this.agentId)
    if (!bus) throw new Error('Umbilical bus is not available for this agent')
    const matcher = compileUmbilicalFilter(filter)
    let dataListener: ((data: Buffer) => void | Promise<void>) | null = null
    const unsubscribe = bus.subscribe((event) => {
      if (!matcher(event)) return
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
    }
  }

  private isTcpAllowed(host: string, port: number): boolean {
    const rules = this.config?.tcp_allowlist
    if (!rules || rules.length === 0) return true
    return rules.some(rule => {
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

function compileUmbilicalFilter(filter?: UmbilicalFilter): (event: UmbilicalEvent) => boolean {
  const types = filter?.event_types?.length ? filter.event_types : ['*']
  const exact = new Set<string>()
  const prefixes: string[] = []
  let any = false
  for (const type of types) {
    if (type === '*') any = true
    else if (type.endsWith('.*')) prefixes.push(type.slice(0, -1))
    else exact.add(type)
  }

  let whenFn: ((event: UmbilicalEvent) => boolean) | null = null
  if (filter?.when) {
    const script = new Script(`Boolean(${filter.when})`, { filename: 'stream-bind:umbilical-filter' })
    whenFn = (event) => {
      try {
        const clonedEvent = JSON.parse(JSON.stringify(event)) as UmbilicalEvent
        return Boolean(script.runInNewContext(
          { event: clonedEvent },
          { timeout: 10, contextCodeGeneration: { strings: false, wasm: false } },
        ))
      } catch {
        return false
      }
    }
  }

  return (event) => {
    const matchesType = any || exact.has(event.event_type) || prefixes.some(prefix => event.event_type.startsWith(prefix))
    if (!matchesType) return false
    return whenFn ? whenFn(event) : true
  }
}

function summarizeOptions(options: Required<BindOptions>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== 0),
  )
}

function summarizeEndpoint(endpoint: StreamBindEndpoint): BindingSummary['a'] {
  switch (endpoint.kind) {
    case 'ws':
      return { kind: 'ws', connection_id: endpoint.connection_id }
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
