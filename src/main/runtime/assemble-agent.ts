import type { AgentExecutionEvent } from '../../shared/types/ipc.types'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import {
  createDispatch,
  createEvent,
  type AdfBatchDispatch,
  type AdfEventDispatch,
} from '../../shared/types/adf-event.types'
import type { LLMProvider } from '../providers/provider.interface'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { ToolRegistry } from '../tools/tool-registry'
import type { McpClientManager } from '../services/mcp-client-manager'
import type { ChannelAdapterManager } from '../services/channel-adapter-manager'
import type { CodeSandboxService } from './code-sandbox'
import type { StreamBindingManager } from './stream-binding-manager'
import type { TapManager } from './tap-manager'
import type { SystemScopeHandler } from './system-scope-handler'
import type { AdfCallHandler } from './adf-call-handler'
import type { AgentProfileName } from './agent-capability-profiles'
import { AGENT_PROFILES, profileHasAsyncTeardown } from './agent-capability-profiles'
import { AgentExecutor } from './agent-executor'
import { AgentSession } from './agent-session'
import { TriggerEvaluator } from './trigger-evaluator'
import { RuntimeGate } from './runtime-gate'
import { CreateAdfTool, ShellTool, SysUpdateConfigTool } from '../tools/built-in'

export const DEFAULT_STOP_GRACE_MS = 5_000

export type AgentLifecycleState =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'disposed'

export type AgentStopMode = 'graceful' | 'immediate' | 'owner-off' | 'emergency'

export interface DispatchOptions {
  skipTriggerMessage?: boolean
}

export interface AgentHostBindings {
  onEvent?: (event: AgentExecutionEvent) => void
  onAdfEvent?: (event: { type: string; payload: unknown; timestamp: number }) => void
  onTriggerEvent?: (event: AgentExecutionEvent) => void
  onTriggerError?: (error: unknown, dispatch: AdfEventDispatch | AdfBatchDispatch) => void
  onStateOff?: () => void | Promise<void>
  beforeDispatch?: (dispatch: AdfEventDispatch | AdfBatchDispatch) => void | Promise<void>
  onConfigChanged?: (config: AgentConfig) => void | Promise<void>
  onAutostartChild?: (filePath: string) => Promise<boolean>
  onAdapterInbound?: (adapterType: string, message: unknown, meta: unknown) => void
}

export interface HostAttachment {
  detach(): void
}

export interface LifecycleResource {
  name: string
  start?: () => void | Promise<void>
  stop?: () => void | Promise<void>
  disposeSync?: () => void
}

function assertSyncProfileResources<P extends AgentProfileName>(
  profile: P,
  options: AssembleAgentOptions<P>,
): void {
  const nominallySync = profile === 'headlessLive' || profile === 'benchmark'
  if (!nominallySync) return
  if (profileHasAsyncTeardown(profile)) {
    throw new Error(`Sync-safe profile ${profile} declares an async teardown capability`)
  }

  const asyncSubsystems = [
    ['MCP', options.mcpManager],
    ['adapters', options.adapterManager],
    ['compute', options.codeSandboxService],
    ['stream bindings', options.streamBindingManager],
    ['umbilical taps', options.tapManager],
  ] as const
  const configured = asyncSubsystems
    .filter(([, subsystem]) => subsystem != null)
    .map(([name]) => name)

  const asyncOnlyResources = (options.resources ?? [])
    .filter(resource => resource.stop && !resource.disposeSync)
    .map(resource => resource.name)

  if (configured.length > 0 || asyncOnlyResources.length > 0) {
    const details = [...configured, ...asyncOnlyResources].join(', ')
    throw new Error(`Sync-safe profile ${profile} contains async teardown resources: ${details}`)
  }
}

export interface AssembleAgentOptions<P extends AgentProfileName> {
  profile: P
  workspace: AdfWorkspace
  config: AgentConfig
  provider: LLMProvider
  registry: ToolRegistry
  session?: AgentSession
  restoreLoop?: boolean
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  adfCallHandler?: AdfCallHandler | null
  systemScopeHandler?: SystemScopeHandler | null
  mcpManager?: McpClientManager | null
  adapterManager?: ChannelAdapterManager | null
  codeSandboxService?: CodeSandboxService | null
  streamBindingManager?: StreamBindingManager | null
  tapManager?: TapManager | null
  scratchDir?: string | null
  resources?: LifecycleResource[]
  host?: AgentHostBindings
  ownsWorkspace?: boolean
}

export interface AssembledAgentBase<P extends AgentProfileName> {
  readonly profile: P
  readonly executor: AgentExecutor
  readonly session: AgentSession
  readonly workspace: AdfWorkspace
  readonly registry: ToolRegistry
  readonly triggerEvaluator: TriggerEvaluator
  readonly adfCallHandler: AdfCallHandler | null
  readonly mcpManager: McpClientManager | null
  readonly adapterManager: ChannelAdapterManager | null
  readonly codeSandboxService: CodeSandboxService | null
  readonly streamBindingManager: StreamBindingManager | null
  readonly tapManager: TapManager | null
  readonly scratchDir: string | null
  getLifecycleState(): AgentLifecycleState
  dispatch(dispatch: AdfEventDispatch | AdfBatchDispatch, options?: DispatchOptions): Promise<void>
  dispatchStartup(options?: { hasUserMessage?: boolean }): Promise<boolean>
  start(): Promise<void>
  stop(options?: { mode?: AgentStopMode; graceMs?: number }): Promise<void>
  disposeAsync(options?: { mode?: AgentStopMode; graceMs?: number }): Promise<void>
  attachHost(bindings: AgentHostBindings): HostAttachment
  setWorkspaceOwnership(ownedByHandle: boolean): void
}

export type SyncDisposableProfile = 'headlessLive' | 'benchmark'

export type AssembledAgent<P extends AgentProfileName> = AssembledAgentBase<P> &
  (P extends SyncDisposableProfile ? { dispose(): void } : unknown)

function applyStateTransitionSideEffect(
  executor: AgentExecutor,
  tool: string,
  status: string,
  result: string | undefined,
  sideEffects?: { endTurn?: boolean },
): void {
  if (!sideEffects?.endTurn || tool !== 'sys_set_state' || status !== 'completed' || !result) return
  try {
    const parsed = JSON.parse(result) as { target_state?: string }
    if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
  } catch { /* invalid tool result; executor already surfaced it */ }
}

/**
 * The single production recipe for constructing an AgentExecutor and wiring it
 * to a TriggerEvaluator. This call site is intentionally reusable: future loop
 * coordinators may invoke it N times with derived configs.
 */
export function assembleAgent<P extends AgentProfileName>(
  options: AssembleAgentOptions<P>,
): AssembledAgent<P> {
  assertSyncProfileResources(options.profile, options)

  const {
    profile,
    workspace,
    config,
    provider,
    registry,
    adfCallHandler = null,
    mcpManager = null,
    adapterManager = null,
    codeSandboxService = null,
    streamBindingManager = null,
    tapManager = null,
    scratchDir = null,
  } = options

  const capabilities = AGENT_PROFILES[profile]
  const session = options.session ?? new AgentSession(workspace)
  if (options.restoreLoop && session.getMessages().length === 0) {
    const existingLoop = workspace.getLoop()
    if (existingLoop.length > 0) {
      session.restoreMessages(existingLoop.map((entry) => ({
        role: entry.role,
        content: entry.content_json,
        created_at: entry.created_at,
      })))
    }
  }

  const executor = new AgentExecutor(
    config,
    provider,
    registry,
    session,
    options.basePrompt ?? '',
    options.toolPrompts ?? {},
    options.compactionPrompt,
  )
  executor.recoverStaleTurnCheckpoint()
  if (options.systemScopeHandler) executor.setSystemScopeHandler(options.systemScopeHandler)

  const triggerEvaluator = new TriggerEvaluator(config)
  triggerEvaluator.setDisplayState(config.start_in_state ?? 'idle')
  triggerEvaluator.setWorkspace(workspace)

  let state: AgentLifecycleState = 'created'
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null
  const integrationBindings = options.host ?? null
  let activeHost: AgentHostBindings | null = null
  let activeHostGeneration = 0
  const inFlight = new Set<Promise<void>>()
  let startupEvaluated = false
  let startupTurnDispatched = false
  const resources = options.resources ?? []
  let ownsWorkspace = options.ownsWorkspace ?? true
  let resourcesStopped = false
  let wiringCleaned = false
  const hostBindings = (): AgentHostBindings[] => [integrationBindings, activeHost].filter(
    (bindings): bindings is AgentHostBindings => bindings !== null,
  )

  const attachHost = (bindings: AgentHostBindings): HostAttachment => {
    if (state === 'stopping' || state === 'stopped' || state === 'disposed') {
      throw new Error(`Cannot attach a host while agent lifecycle is ${state}`)
    }
    const generation = ++activeHostGeneration
    activeHost = bindings
    let attached = true
    return {
      detach() {
        if (!attached) return
        attached = false
        if (activeHostGeneration === generation) activeHost = null
      },
    }
  }

  const setWorkspaceOwnership = (ownedByHandle: boolean): void => {
    if (state === 'disposed') throw new Error('Cannot transfer workspace ownership from a disposed agent')
    ownsWorkspace = ownedByHandle
  }

  const dispatch = (
    dispatchValue: AdfEventDispatch | AdfBatchDispatch,
    dispatchOptions?: DispatchOptions,
  ): Promise<void> => {
    if (state !== 'running') {
      return Promise.reject(new Error(`Cannot dispatch while agent lifecycle is ${state}`))
    }
    if (RuntimeGate.stopped) return Promise.resolve()

    // Track the complete accepted dispatch, including asynchronous host hooks.
    // This prevents shutdown from slipping between the lifecycle check and the
    // executor call and disposing the executor underneath a late dispatch.
    const operation = (async () => {
      for (const bindings of hostBindings()) await bindings.beforeDispatch?.(dispatchValue)
      await executor.executeTurn(dispatchValue, dispatchOptions)
    })()
    inFlight.add(operation)
    void operation.then(
      () => { inFlight.delete(operation) },
      () => { inFlight.delete(operation) },
    )
    return operation
  }

  const dispatchStartup = async (startupOptions: { hasUserMessage?: boolean } = {}): Promise<boolean> => {
    if (state !== 'running') throw new Error(`Cannot dispatch startup while agent lifecycle is ${state}`)
    if (startupOptions.hasUserMessage) {
      startupEvaluated = true
      startupTurnDispatched = true
      return false
    }
    if (!startupEvaluated) {
      startupEvaluated = true
      triggerEvaluator.onStartup()
    }
    if ((config.start_in_state ?? 'active') !== 'active' || startupTurnDispatched) return false
    startupTurnDispatched = true
    await dispatch(createDispatch(
      createEvent({ type: 'startup', source: 'system', data: undefined }),
      { scope: 'agent' },
    ))
    return true
  }

  const onEvaluatorTrigger = (dispatchValue: AdfEventDispatch | AdfBatchDispatch): void => {
    void dispatch(dispatchValue).catch((error) => {
      for (const bindings of hostBindings()) bindings.onTriggerError?.(error, dispatchValue)
    })
  }
  const onEvaluatorEvent = (event: AgentExecutionEvent): void => {
    for (const bindings of hostBindings()) bindings.onTriggerEvent?.(event)
  }
  triggerEvaluator.on('trigger', onEvaluatorTrigger)
  triggerEvaluator.on('event', onEvaluatorEvent)

  const onExecutorEvent = (event: AgentExecutionEvent): void => {
    if (event.type === 'state_changed') {
      const payload = event.payload as { state?: string }
      if (payload.state) {
        triggerEvaluator.setDisplayState(payload.state)
        if (payload.state === 'off') {
          for (const bindings of hostBindings()) void bindings.onStateOff?.()
        }
      }
    }
    for (const bindings of hostBindings()) bindings.onEvent?.(event)
  }
  executor.on('event', onExecutorEvent)

  const onWorkspaceLog = (level: string, origin: string | null, event: string | null, target: string | null, message: string): void => {
    triggerEvaluator.onLog(level, origin, event, target, message)
  }
  workspace.setOnLogCallback(onWorkspaceLog)

  executor.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
    triggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
  }
  executor.onTaskCreated = (task) => triggerEvaluator.onTaskCreate(task)
  executor.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
    triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
    applyStateTransitionSideEffect(executor, tool, status, result, sideEffects)
  }
  executor.onLlmCall = (data) => triggerEvaluator.onLlmCall(data)

  if (adfCallHandler) {
    adfCallHandler.onEvent = (event) => {
      for (const bindings of hostBindings()) bindings.onAdfEvent?.(event)
    }
    adfCallHandler.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
      triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
      applyStateTransitionSideEffect(executor, tool, status, result, sideEffects)
    }
    adfCallHandler.onLambdaToolEndTurn = (tool, resultContent) => {
      applyStateTransitionSideEffect(executor, tool, 'completed', resultContent, { endTurn: true })
    }
    adfCallHandler.onHilApproved = (taskId, approved, modifiedArgs, feedback) => {
      executor.resolveHilTask(taskId, approved, modifiedArgs, feedback)
    }
    adfCallHandler.onLlmCall = (data) => triggerEvaluator.onLlmCall(data)
  }

  const sysUpdateTool = registry.get('sys_update_config') as SysUpdateConfigTool | undefined
  if (sysUpdateTool) {
    sysUpdateTool.onConfigChanged = (updatedConfig) => {
      executor.updateConfig(updatedConfig)
      triggerEvaluator.updateConfig(updatedConfig)
      adfCallHandler?.updateConfig(updatedConfig)
      for (const bindings of hostBindings()) void bindings.onConfigChanged?.(updatedConfig)
    }
  }

  const createAdfTool = registry.get('sys_create_adf') as CreateAdfTool | undefined
  if (createAdfTool) {
    createAdfTool.onAutostartChild = async (filePath) => {
      const host = activeHost?.onAutostartChild ?? integrationBindings?.onAutostartChild
      return host?.(filePath) ?? false
    }
  }

  const shellTool = registry.get('adf_shell') as ShellTool | undefined
  if (shellTool) {
    shellTool.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
      triggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
    }
    shellTool.onApprovalRequired = (toolName, command) => executor.requestApproval(toolName, { command })
  }

  const onAdapterInbound = (adapterType: string, message: unknown, meta: unknown): void => {
    const adapterMessage = message as { sender?: string; payload?: unknown; sourceMeta?: unknown }
    triggerEvaluator.onInbox(`${adapterType}:${adapterMessage.sender ?? ''}`, adapterMessage.payload, {
      source: adapterType,
      messageId: (meta as { inboxId?: string }).inboxId,
      parentId: (meta as { parentId?: string }).parentId,
      sourceMeta: adapterMessage.sourceMeta,
    })
    for (const bindings of hostBindings()) bindings.onAdapterInbound?.(adapterType, message, meta)
  }
  if (adapterManager) {
    adapterManager.on('inbound', onAdapterInbound)
  }

  const stopResources = async (): Promise<void> => {
    if (resourcesStopped) return
    resourcesStopped = true
    for (const resource of [...resources].reverse()) {
      try { await resource.stop?.() } catch { /* continue best-effort teardown */ }
    }
  }

  const cleanupWiring = (): void => {
    if (wiringCleaned) return
    wiringCleaned = true
    try { workspace.setOnLogCallback(() => {}) } catch { /* workspace may already be closed */ }
    try { adapterManager?.off('inbound', onAdapterInbound) } catch { /* best effort */ }

    executor.onToolCallIntercepted = undefined
    executor.onTaskCreated = undefined
    executor.onTaskCompleted = undefined
    executor.onLlmCall = undefined
    if (adfCallHandler) {
      adfCallHandler.onEvent = undefined
      adfCallHandler.onTaskCompleted = undefined
      adfCallHandler.onLambdaToolEndTurn = undefined
      adfCallHandler.onHilApproved = undefined
      adfCallHandler.onLlmCall = undefined
    }
    if (sysUpdateTool) sysUpdateTool.onConfigChanged = undefined
    if (createAdfTool) createAdfTool.onAutostartChild = undefined
    if (shellTool) {
      shellTool.onToolCallIntercepted = undefined
      shellTool.onApprovalRequired = undefined
    }
    activeHost = null
    executor.removeAllListeners()
  }

  let teardownPromise: Promise<void> | null = null
  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise
    teardownPromise = (async () => {
      try { triggerEvaluator.stopTimerPolling() } catch { /* continue teardown */ }
      try { executor.abort() } catch { /* continue teardown */ }
      try { triggerEvaluator.dispose() } catch { /* continue teardown */ }
      await stopResources()
      cleanupWiring()
    })()
    return teardownPromise
  }

  const waitForTrackedDispatches = async (graceMs: number): Promise<void> => {
    if (inFlight.size === 0) return
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(Array.from(inFlight)),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, Math.max(0, graceMs))
        }),
      ])
    } finally {
      if (deadline) clearTimeout(deadline)
    }
  }

  const start = (): Promise<void> => {
    if (state === 'running') return Promise.resolve()
    if (state === 'starting' && startPromise) return startPromise
    if (state !== 'created') return Promise.reject(new Error(`Cannot start agent from lifecycle ${state}`))
    state = 'starting'
    startPromise = (async () => {
      try {
        for (const resource of resources) {
          if (state !== 'starting') break
          await resource.start?.()
        }
        if (state !== 'starting') return
        if (capabilities.timers) triggerEvaluator.startTimerPolling(workspace)
        if (state === 'starting') state = 'running'
      } catch (error) {
        await teardown()
        if (state === 'starting') state = 'stopped'
        throw error
      }
    })()
    return startPromise
  }

  const stop = (stopOptions: { mode?: AgentStopMode; graceMs?: number } = {}): Promise<void> => {
    if (state === 'stopped' || state === 'disposed') return Promise.resolve()
    if (state === 'stopping' && stopPromise) return stopPromise
    const pendingStart = state === 'starting' ? startPromise : null
    const mode = stopOptions.mode ?? 'graceful'
    const graceMs = stopOptions.graceMs ?? DEFAULT_STOP_GRACE_MS
    state = 'stopping'
    stopPromise = (async () => {
      // Timer/trigger intake closes synchronously before the first await.
      try { triggerEvaluator.stopTimerPolling() } catch { /* continue shutdown */ }
      if (pendingStart) {
        try { await pendingStart } catch { /* startup rollback preserves its own error */ }
      }
      const immediate = mode === 'immediate' || mode === 'owner-off' || mode === 'emergency'
      if (!immediate) await waitForTrackedDispatches(graceMs)
      await teardown()
      if (state !== 'disposed') state = 'stopped'
    })()
    return stopPromise
  }

  const disposeAsync = (disposeOptions: { mode?: AgentStopMode; graceMs?: number } = {}): Promise<void> => {
    if (state === 'disposed') return Promise.resolve()
    if (disposePromise) return disposePromise
    disposePromise = (async () => {
      await stop(disposeOptions)
      if (ownsWorkspace) {
        try { workspace.dispose() } catch { /* idempotent */ }
      }
      state = 'disposed'
    })()
    return disposePromise
  }

  const result: AssembledAgentBase<P> & { dispose?: () => void } = {
    profile,
    executor,
    session,
    workspace,
    registry,
    triggerEvaluator,
    adfCallHandler,
    mcpManager,
    adapterManager,
    codeSandboxService,
    streamBindingManager,
    tapManager,
    scratchDir,
    getLifecycleState: () => state,
    dispatch,
    dispatchStartup,
    start,
    stop,
    disposeAsync,
    attachHost,
    setWorkspaceOwnership,
  }

  if (!profileHasAsyncTeardown(profile)) {
    result.dispose = () => {
      if (profileHasAsyncTeardown(profile)) {
        throw new Error(`Profile ${profile} requires disposeAsync()`)
      }
      if (state === 'disposed') return
      if (state === 'starting' || state === 'stopping') {
        throw new Error(`Cannot dispose synchronously while agent lifecycle is ${state}`)
      }
      state = 'stopping'
      try { triggerEvaluator.stopTimerPolling() } catch { /* continue teardown */ }
      try { executor.abort() } catch { /* continue teardown */ }
      try { triggerEvaluator.dispose() } catch { /* continue teardown */ }
      if (!resourcesStopped) {
        resourcesStopped = true
        for (const resource of [...resources].reverse()) {
          try { resource.disposeSync?.() } catch { /* continue teardown */ }
        }
      }
      cleanupWiring()
      if (ownsWorkspace) {
        try { workspace.dispose() } catch { /* idempotent */ }
      }
      state = 'disposed'
    }
  }

  return result as AssembledAgent<P>
}
