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
import type { Tool } from '../tools/tool.interface'
import { dedupeToolDeclarations } from '../../shared/utils/tool-declarations'
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
import { CreateAdfTool, ShellTool, SysUpdateConfigTool, LoopSendTool, LoopListTool, LoopManageTool } from '../tools/built-in'
import { LoopPool, MAIN_LOOP, stripLoopNameMarker } from './loop-pool'
import { runDispatchDropCompensation } from './system-dispatch-limits'
// Read-only: used purely to describe config drift in the log, never to gate load.
import { AgentConfigSchema } from '../adf/adf-schema'
import {
  SKILL_INDEX_SOURCE,
  SKILLS_REGISTRY_INJECT_KEY,
  SKILLS_REGISTRY_INJECT_PREFIX,
  SKILLS_REGISTRY_PATH,
} from '../adf/skill-indexer'

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
  /**
   * Late-bound TapManager accessor. The shared umbilical lifecycle resource
   * creates its TapManager inside `start()` (taps must register before
   * `agent.loaded` fires), so hosts using it cannot supply `tapManager`
   * up-front — they expose it through this getter instead.
   */
  getTapManager?: () => TapManager | null
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
  /**
   * This agent's side-loop runtimes (docs/design/agent-loops-mvp.md §6.1). It
   * hangs off the assembled handle rather than any host, because the handle is
   * what survives Studio's foreground/background transfer — a pool owned by
   * `BackgroundManagedAgent` would be orphaned by exactly the transition that
   * makes the loop tabs visible. Always present; empty for an agent with no
   * declared loops, so `loop_manage` can create the first one.
   */
  readonly loopPool: LoopPool
  getLifecycleState(): AgentLifecycleState
  /** True while any accepted dispatch (host hooks + turn) has not yet settled.
   *  Covers the pre-thinking awaits inside executeTurn where the executor
   *  still reports 'idle' — hosts must not release session memory while this
   *  is true. */
  hasInFlightDispatch(): boolean
  dispatch(dispatch: AdfEventDispatch | AdfBatchDispatch, options?: DispatchOptions): Promise<void>
  /**
   * The uniform router (§6.2): `loop ?? 'main'` selects the executor. Every
   * entry point — IPC invoke, runtime-service trigger/sendChat, the daemon, the
   * attached host's trigger path — goes through here rather than special-casing
   * loops, because any event type may target any loop.
   *
   * Rejects with a model/operator-readable error when the loop is unknown or
   * disabled. Callers that must not throw (timers, triggers) use
   * `loopPool.dispatchToLoop` and drop+log instead.
   */
  dispatchTo(loop: string | undefined, dispatch: AdfEventDispatch | AdfBatchDispatch, options?: DispatchOptions): Promise<void>
  dispatchStartup(options?: { hasUserMessage?: boolean }): Promise<boolean>
  /**
   * THE config-change choke point. Every path that changes this agent's config
   * — `sys_update_config`, Studio's save (IPC DOC_SET_AGENT_CONFIG), the
   * runtime service, the loop pool's own writes — must come through here.
   *
   * Hand-rolling the fan-out instead (executor.updateConfig + friends) looks
   * equivalent and is not: it skips `loopPool.reconcile`, so side loops keep
   * running under grants the owner just revoked; it leaves the pool's raw
   * `rawConfig` stale, so the next `loop_manage` write reverts the whole save;
   * it skips the loop_send/loop_list/loop_manage registration sync, so main
   * keeps (or never gains) tool instances the new config no longer implies; and
   * it skips `stripLoopNameMarker`, so an imported .adf can bind main's
   * executor to a side loop's guards (review C2).
   *
   * The caller has already persisted the config (this only fans out). Pass
   * `notifyHost: false` when the caller performs the host-level side effects
   * (mesh update, file rename, MCP/adapter reconcile) itself, so they don't run
   * twice.
   */
  applyConfigChange(config: AgentConfig, options?: { notifyHost?: boolean }): void
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
  // adf_shell counts: `state idle` inside a shell command run as a task or a
  // sync lambda call reports the same top-level target_state.
  if (!sideEffects?.endTurn || (tool !== 'sys_set_state' && tool !== 'adf_shell') || status !== 'completed' || !result) return
  try {
    const parsed = JSON.parse(result) as { target_state?: string }
    if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
  } catch { /* invalid tool result; executor already surfaced it */ }
}

/** Max schema issues quoted into the load-time warn row. */
const CONFIG_VALIDATION_ISSUE_LIMIT = 5

/**
 * Diagnostic-only config validation at load. Existing .adf files predate parts
 * of the schema and hosts must keep opening them, so a failure NEVER rejects
 * the config or throws — it writes one warn row so the drift is visible.
 */
function validateConfigOnLoad(workspace: AdfWorkspace, config: AgentConfig): void {
  try {
    const parsed = AgentConfigSchema.safeParse(config)
    if (parsed.success) return
    const issues = parsed.error.issues
    const summary = issues
      .slice(0, CONFIG_VALIDATION_ISSUE_LIMIT)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    const more = issues.length > CONFIG_VALIDATION_ISSUE_LIMIT
      ? ` (+${issues.length - CONFIG_VALIDATION_ISSUE_LIMIT} more)`
      : ''
    workspace.insertLog(
      'warn',
      'runtime',
      'config_validation',
      null,
      `Agent config does not match AgentConfigSchema (${issues.length} issue(s)): ${summary}${more}`,
    )
  } catch { /* validation is diagnostic — never block agent load */ }
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
  // `metadata.loop_name` is a derived-config-only marker. An imported or
  // hand-edited .adf that pre-declares it would bind MAIN's executor to a side
  // loop's stream and turn on the side-loop guards for the host. Strip at load.
  stripLoopNameMarker(config)
  const session = options.session ?? new AgentSession(workspace)
  if (options.restoreLoop && session.getMessages().length === 0) {
    const existingLoop = workspace.getLoop()
    if (existingLoop.length > 0) {
      session.restoreMessages(existingLoop.map((entry) => ({
        role: entry.role,
        content: entry.content_json,
        created_at: entry.created_at,
        seq: entry.seq,
      })))
    }
  }

  // Code-execution context must join the same live session as the executor.
  // `loop_inject` queues its messages here and the executor drains them only
  // at model boundaries, never inside a tool_use/tool_result exchange.
  adfCallHandler?.attachSession(session)

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
  // Both sweeps run before any turn of this session: every row/field they see
  // predates this load, so nothing legitimately in flight can be affected.
  executor.reconcileOrphanedTasks()
  validateConfigOnLoad(workspace, config)
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
      // An idle-sweep release (or any external reset) can leave the in-memory
      // session empty while the loop table holds full history. Starting a turn
      // that way silently truncates the LLM context to post-reset messages, so
      // rehydrate at this choke point — every dispatch path shares it,
      // including hosts whose beforeDispatch does not rehydrate. System-scope
      // dispatches (lambda/timer handlers) never read the session; skipping
      // them avoids release/rehydrate churn on lambda-heavy swept agents.
      if (dispatchValue.scope !== 'system' && session.getMessages().length === 0) {
        const existingLoop = workspace.getLoop()
        if (existingLoop.length > 0) {
          session.restoreMessages(existingLoop.map((entry) => ({
            role: entry.role,
            content: entry.content_json,
            created_at: entry.created_at,
            seq: entry.seq,
          })))
        }
      }
      await executor.executeTurn(dispatchValue, dispatchOptions)
    })()
    inFlight.add(operation)
    void operation.then(
      () => { inFlight.delete(operation) },
      () => { inFlight.delete(operation) },
    )
    return operation
  }

  /** The uniform router — see AssembledAgentBase.dispatchTo. */
  const dispatchTo = (
    loop: string | undefined,
    dispatchValue: AdfEventDispatch | AdfBatchDispatch,
    dispatchOptions?: DispatchOptions,
  ): Promise<void> => {
    const target = loop ?? dispatchValue.loop ?? MAIN_LOOP
    if (target === MAIN_LOOP) return dispatch(dispatchValue, dispatchOptions)
    const routed = loopPool.dispatchToLoop(target, dispatchValue)
    if (!routed.ok) return Promise.reject(new Error(`Cannot run this on loop "${target}": ${routed.reason}.`))
    return routed.done
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
      // Unread sweep: messages that arrived while no trigger wiring existed
      // (adapter offline catch-up, a crash between inbox write and wake) sit
      // durably in the inbox with no trigger pending. Replay the newest
      // unread row per (sender, source) through on_inbox with its real
      // messageId so target filters match real data. Agent scope only — a
      // system-scope lambda may have processed a row before a restart without
      // marking it read; only the agent's own awareness is being recovered.
      // Multiple fires coalesce via the executor's pendingTriggers dedup and
      // its unread==0 guard; shouldFire already suppresses off/suspended/
      // hibernate, and an 'active' start's own turn makes the fires no-ops.
      const unread = workspace.getInbox('unread')
      if (unread.length > 0) {
        const newestByOrigin = new Map<string, (typeof unread)[number]>()
        for (const row of unread) {
          const key = `${row.from}\u0000${row.source ?? ''}`
          const prev = newestByOrigin.get(key)
          if (!prev || row.received_at > prev.received_at) newestByOrigin.set(key, row)
        }
        for (const row of newestByOrigin.values()) {
          triggerEvaluator.onInbox(row.from, row.content, {
            source: row.source,
            messageId: row.id,
            skipSystemScope: true,
          })
        }
      }
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
    const target = dispatchValue.loop ?? MAIN_LOOP
    if (target !== MAIN_LOOP) {
      // Triggers and timers DROP an undeliverable dispatch and log it; they
      // never fall back to main. A trigger written for a deleted or disabled
      // loop would otherwise run its work with main's unattenuated authority
      // (review B3), which is the whole hole §2.3 closes.
      const routed = loopPool.dispatchToLoop(target, dispatchValue)
      if (!routed.ok) {
        // A5: this is the REAL drop site for agent-scope dispatches (loop gone or
        // disabled). Run any registered drop-compensation before returning — a
        // `once` timer was settled (expired) before its emit, so without this its
        // rewind (un-expire / restore next_wake) never runs and it would never
        // fire when the loop is re-enabled. The SystemDispatchQueue only
        // compensates system-scope drops; this covers the loop-router path.
        runDispatchDropCompensation(dispatchValue)
        const eventType = 'event' in dispatchValue ? dispatchValue.event.type : dispatchValue.events[0]?.type
        try {
          workspace.insertLog('warn', 'runtime', 'loop_dispatch_dropped', target,
            `Dropped a ${eventType ?? 'trigger'} dispatch targeting loop "${target}" — ${routed.reason}. Orphaned targets are never re-pointed at main.`)
        } catch { /* observability is never fatal */ }
        return
      }
      void routed.done.catch((error) => {
        for (const bindings of hostBindings()) bindings.onTriggerError?.(error, dispatchValue)
      })
      return
    }
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
  workspace.setOnFileChangeCallback((change) => {
    triggerEvaluator.onFileChange(change.path, change.operation, change.content, change.previousContent, {
      source: change.source,
      metadata: change.metadata,
    })
    // Keep open editor tabs live for EVERY write path, not just the executor's
    // own fs_write dispatch. Shell redirection, sys_code, lambdas, fs_transfer,
    // the daemon HTTP API and mesh attachment delivery all reach the DB through
    // workspace.writeFile, so this choke point is the only place that sees them
    // all. Emitting here also means a *failed* write never fires (the event is
    // raised after the row is committed), and binary files are skipped for free
    // — `content` is populated only for text-like files.
    //
    // README.md/document.md keep their own `document_updated` event, which also
    // carries the document store; re-emitting them here would double-update.
    // Studio's own edits are skipped: the editor already holds that content, and
    // echoing it back would fight the user's cursor mid-edit.
    if (
      change.operation !== 'deleted' &&
      change.content !== undefined &&
      change.source !== 'system:studio' &&
      change.path !== 'README.md' &&
      change.path !== 'document.md'
    ) {
      const fileEvent: AgentExecutionEvent = {
        type: 'file_updated',
        payload: { path: change.path, content: change.content, previousContent: change.previousContent },
        timestamp: Date.now(),
      }
      for (const bindings of hostBindings()) bindings.onEvent?.(fileEvent)
    }
  })

  // Skills: the workspace reindexes `skills/*/SKILL.md` off its write choke
  // point (every writer, no sync step). A mid-session change must NOT rewrite
  // the `{{skills-registry.json}}` prompt snapshot — that would invalidate the
  // provider's prompt cache on a file write — so the new catalog reaches the
  // live session as a keyed context injection instead, exactly as the
  // agent-space loader's `loop_inject` did, now with runtime provenance.
  // Compaction / loop_clear re-snapshot the file the normal way.
  const onSkillRegistryChanged = (json: string): void => {
    if (state !== 'running') return
    const maxChars = Math.max(1, (executor.getConfig().limits?.max_tool_result_tokens ?? 16000) * 3)
    let content = `${SKILLS_REGISTRY_INJECT_PREFIX}\n${json}`
    if (content.length > maxChars) {
      // Dropping the update silently would leave the model believing a catalog
      // that no longer exists. Truncate with a pointer to the real file, and
      // say so in the log — a catalog this large is itself worth noticing.
      const note = `\n… [truncated: the catalog exceeds this session's injection budget —`
        + ` fs_read ${SKILLS_REGISTRY_PATH} for the complete list]`
      const room = maxChars - SKILLS_REGISTRY_INJECT_PREFIX.length - 1 - note.length
      try {
        workspace.insertLog(
          'warn',
          'runtime',
          'skill_index',
          SKILLS_REGISTRY_PATH,
          `Skill catalog update is ${content.length} chars, over the ${maxChars}-char injection budget — `
            + (room > 0 ? 'delivered truncated.' : 'not delivered.'),
        )
      } catch { /* diagnostic only */ }
      if (room <= 0) return
      content = `${SKILLS_REGISTRY_INJECT_PREFIX}\n${json.slice(0, room)}${note}`
    }
    const text = `[Context: ${SKILLS_REGISTRY_INJECT_KEY} | loop_inject=v2 | origin=${SKILL_INDEX_SOURCE}`
      + ` | key=${SKILLS_REGISTRY_INJECT_KEY}] ${content}`
    try {
      const seq = workspace.appendToLoop('user', [{ type: 'text', text }])
      session.queueContextInjection({
        role: 'user',
        text,
        category: SKILLS_REGISTRY_INJECT_KEY,
        origin: SKILL_INDEX_SOURCE,
        seq,
        key: SKILLS_REGISTRY_INJECT_KEY,
      })
      for (const bindings of hostBindings()) {
        bindings.onAdfEvent?.({
          type: 'context_injected',
          payload: {
            category: SKILLS_REGISTRY_INJECT_KEY,
            origin: SKILL_INDEX_SOURCE,
            key: SKILLS_REGISTRY_INJECT_KEY,
            content: text,
            delivery: 'next_boundary',
          },
          timestamp: Date.now(),
        })
      }
    } catch { /* a catalog update must never break the turn that triggered it */ }
  }
  workspace.setOnSkillRegistryChangedCallback(onSkillRegistryChanged)
  // Index once up front so the first turn's prompt snapshot is current. The
  // workspace already materialized the registry at open; this catches anything
  // written between open and session start. No injection fires (state is
  // 'created').
  try { workspace.refreshSkillIndex() } catch { /* diagnostics land in adf_logs */ }

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
    adfCallHandler.requestProtectionApproval = (method, args, protection) =>
      executor.requestProtectionApproval(method, args, protection)
    adfCallHandler.onLlmCall = (data) => triggerEvaluator.onLlmCall(data)
  }

  // --- Side-loop pool (docs/design/agent-loops-mvp.md §6) ---------------------
  //
  // Built here, once, for every host: Studio's foreground path, the background
  // manager and the headless runtime all go through assembleAgent, so none of
  // them can forget to attach it and none of them can attach a second one.
  //
  // The pool reads the RAW host config, never main's executor copy.
  let rawConfig: AgentConfig = config
  const loopPool = new LoopPool({
    workspace,
    registry,
    // Live, not captured: a host model change (Studio save, runtime service)
    // swaps main's provider on the executor, and every loop without its own
    // model override must follow it.
    getProvider: () => executor.getProvider() ?? provider,
    basePrompt: options.basePrompt ?? '',
    toolPrompts: options.toolPrompts ?? {},
    compactionPrompt: options.compactionPrompt,
    adfCallHandler,
    codeSandboxService,
    mcpManager,
    getHostConfig: () => rawConfig,
    saveConfig: (next) => {
      // Through the workspace, then the same fan-out sys_update_config uses —
      // so a loop change reaches Studio, the executor, the evaluator and the
      // call handler by exactly the path every other config change takes.
      workspace.setAgentConfig(next)
      sysUpdateOnConfigChanged(next)
    },
    onLoopEvent: (event) => {
      for (const bindings of hostBindings()) bindings.onEvent?.(event)
    },
    onLoopAdfEvent: (event) => {
      for (const bindings of hostBindings()) bindings.onAdfEvent?.(event)
    },
    main: {
      session,
      // Main's own busy-ness, deliberately: the agent is `idle` when MAIN is
      // idle, not when the whole organism is quiet (§6.3).
      isBusy: () => executor.isTurnActive() || inFlight.size > 0,
      dispatch: (value) => dispatch(value),
      getState: () => executor.getState(),
    },
  })

  // Main's turn-boundary hook: drain a `loop_send` wake that arrived while main
  // was mid-turn, so a busy main runs a successor turn like a busy side loop
  // does (the pool queues it in `mainPendingWakes`). Side-loop executors get the
  // equivalent inside `createRuntime`; main's executor lives out here, so it is
  // wired here. Nothing else sets main's `onTurnSettled`.
  executor.onTurnSettled = () => loopPool.consumeMainWake()

  /**
   * Main's loop tools. `loop_send`/`loop_list`/`loop_manage` are ordinary
   * declared tools registered into MAIN's registry whenever their own
   * declaration is enabled — the same rule as `ws_connections`, `stream_bindings`
   * and every other capability tool, which are present when enabled and simply
   * return empty or error when there is nothing to act on. A loop-less agent's
   * `loop_list` returns just `main`; its `loop_send` errors on any target it
   * names. We deliberately do NOT gate these on `loops.length`: that made two
   * tools flicker in and out of the schema on loop count for a "byte-identical
   * prompt" guarantee that `loop_manage` (default-on) already voids, and it was
   * inconsistent with how every other tool behaves.
   *
   * Gate on `enabled` via the declaration, NOT the sys_code presence idiom
   * (`tools.some(t => t.name === x)`): the DEFAULT_TOOLS backfill writes a
   * declaration for all three into every config, so a presence test is always
   * true. This is MAIN's registry only — a side loop gets these three solely
   * through its derived allow-list (deriveLoopConfig), and `loop_manage` is
   * never grantable to a loop at all (LOOP_PROHIBITED_TOOLS).
   */
  const syncLoopToolRegistration = (forConfig: AgentConfig): void => {
    // Resolve duplicate declarations first-wins, exactly as the executor's
    // schema builder and deriveLoopConfig do (review S9): a raw `.some` would
    // register on ANY enabled duplicate and disagree with the fences behind it.
    const declared = dedupeToolDeclarations(forConfig.tools ?? []).deduped
    const enabled = (name: string): boolean =>
      declared.some(t => t.name === name && t.enabled)
    const sync = (name: string, make: () => Tool): void => {
      if (enabled(name)) {
        if (!registry.get(name)) registry.register(make())
      } else {
        registry.unregister(name)
      }
    }
    sync('loop_send', () => new LoopSendTool(() => loopPool))
    sync('loop_list', () => new LoopListTool(() => loopPool))
    sync('loop_manage', () => new LoopManageTool(() => loopPool))
    registry.clearCache()
  }
  syncLoopToolRegistration(config)

  const sysUpdateTool = registry.get('sys_update_config') as SysUpdateConfigTool | undefined
  /** See AssembledAgentBase.applyConfigChange — this is that choke point. */
  const applyConfigChange = (
    updatedConfig: AgentConfig,
    configOptions?: { notifyHost?: boolean },
  ): void => {
    // The raw host config never reaches a loop: the pool re-derives per loop
    // and pushes the DERIVED config to each loop's executor and call handler.
    // Handing a side loop this object would be total attenuation loss (D6b).
    stripLoopNameMarker(updatedConfig)
    rawConfig = updatedConfig
    executor.updateConfig(updatedConfig)
    triggerEvaluator.updateConfig(updatedConfig)
    adfCallHandler?.updateConfig(updatedConfig)
    // The first loop appearing (or the last one leaving) flips main's
    // loop_send/loop_list registration; a loop_manage toggle flips its own.
    syncLoopToolRegistration(updatedConfig)
    loopPool.reconcile(updatedConfig)
    if (configOptions?.notifyHost === false) return
    for (const bindings of hostBindings()) void bindings.onConfigChanged?.(updatedConfig)
  }
  const sysUpdateOnConfigChanged = (updatedConfig: AgentConfig): void => {
    applyConfigChange(updatedConfig)
  }
  if (sysUpdateTool) {
    sysUpdateTool.onConfigChanged = sysUpdateOnConfigChanged
  }

  const createAdfTool = registry.get('sys_create_adf') as CreateAdfTool | undefined
  const createAdfOnAutostartChild = async (filePath: string): Promise<boolean> => {
    const host = activeHost?.onAutostartChild ?? integrationBindings?.onAutostartChild
    return host?.(filePath) ?? false
  }
  if (createAdfTool) {
    createAdfTool.onAutostartChild = createAdfOnAutostartChild
  }

  // The shell is always registered; the config's enabled/visible flags alone
  // govern whether it is exposed to the model (getToolsForAgent).
  let shellTool = registry.get('adf_shell') as ShellTool | undefined
  if (!shellTool) {
    shellTool = new ShellTool(registry, workspace, () => executor.getConfig(), mcpManager)
    registry.register(shellTool)
  }
  // The shell gate reads config through the executor, which EVERY config
  // fan-out site (sys_update_config, IPC handlers, background manager, ...)
  // already updates via executor.updateConfig(). Re-point on every assembly so
  // a shell reused from a prior registry lifetime tracks THIS executor, never
  // a stale snapshot — otherwise enabled tools exit 126 in the shell.
  shellTool.setConfigProvider(() => executor.getConfig())
  // Named closures so teardown can identity-check ownership (see cleanupWiring).
  const shellOnToolCallIntercepted: ShellTool['onToolCallIntercepted'] =
    (tool, args, taskId, origin, systemScopeHandled) => {
      triggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
    }
  const shellOnApprovalRequired: ShellTool['onApprovalRequired'] =
    (toolName, command) => executor.requestApproval(toolName, { command })
  // Interactive shell approvals have no auto-deny — abort/teardown resolves
  // parked approvals as denied.
  const shellOnProtectionBlocked: ShellTool['onProtectionBlocked'] =
    (toolName, input, protection) =>
      executor.requestProtectionApproval(toolName, input, protection, { timeoutMs: null })
  shellTool.onToolCallIntercepted = shellOnToolCallIntercepted
  shellTool.onApprovalRequired = shellOnApprovalRequired
  shellTool.onProtectionBlocked = shellOnProtectionBlocked

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
    // Hosts start adapters (which may fully drain offline catch-up) BEFORE
    // this listener exists; the manager buffers those 'inbound' events until
    // releaseInbound(). Released in start() rather than here: dispatch()
    // rejects every trigger while the lifecycle is still 'created'.
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
    try { workspace.setOnFileChangeCallback(null) } catch { /* workspace may already be closed */ }
    try { workspace.setOnSkillRegistryChangedCallback(null) } catch { /* workspace may already be closed */ }
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
      adfCallHandler.requestProtectionApproval = undefined
      adfCallHandler.onLlmCall = undefined
    }
    // Registry-resident tools (shell, sys_update_config, sys_create_adf) can
    // be REUSED by a newer assembly on the same registry, which re-points
    // these callbacks at ITS executor. A late teardown of this (older)
    // lifecycle must then leave them alone — clearing unconditionally would
    // strip the LIVE agent's wiring, most critically the shell's protection
    // HIL: a protected-file denial would then surface with no human override
    // path at all (same clobber class as the MCP reconnect config bug).
    // Identity-check: only clear what this lifecycle still owns.
    if (sysUpdateTool && sysUpdateTool.onConfigChanged === sysUpdateOnConfigChanged) {
      sysUpdateTool.onConfigChanged = undefined
    }
    if (createAdfTool && createAdfTool.onAutostartChild === createAdfOnAutostartChild) {
      createAdfTool.onAutostartChild = undefined
    }
    if (shellTool) {
      if (shellTool.onToolCallIntercepted === shellOnToolCallIntercepted) {
        shellTool.onToolCallIntercepted = undefined
      }
      if (shellTool.onApprovalRequired === shellOnApprovalRequired) {
        shellTool.onApprovalRequired = undefined
      }
      if (shellTool.onProtectionBlocked === shellOnProtectionBlocked) {
        shellTool.onProtectionBlocked = undefined
      }
    }
    activeHost = null
    executor.removeAllListeners()
  }

  let teardownPromise: Promise<void> | null = null
  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise
    teardownPromise = (async () => {
      try { triggerEvaluator.stopTimerPolling() } catch { /* continue teardown */ }
      // Stopping the agent stops every loop of it — a mind is not left running
      // behind a stopped body (§6.3, suspend/off cascade).
      try { loopPool.dispose() } catch { /* continue teardown */ }
      try { executor.abort() } catch { /* continue teardown */ }
      try { triggerEvaluator.dispose() } catch { /* continue teardown */ }
      await stopResources()
      cleanupWiring()
    })()
    return teardownPromise
  }

  /**
   * Graceful drain before teardown. Main's tracked dispatches first, then any
   * side loop still mid-turn: `teardown()` disposes the pool, which aborts a
   * running loop turn outright, so without this a graceful stop is graceful for
   * main and an abort for every other mind in the agent. Both halves share the
   * SAME grace budget — a slow loop must not extend shutdown past what the
   * caller asked for; whatever is still running when it expires is aborted, as
   * before.
   */
  const waitForTrackedDispatches = async (graceMs: number): Promise<void> => {
    const deadlineAt = Date.now() + Math.max(0, graceMs)
    if (inFlight.size > 0) {
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
    while (loopPool.anyLoopRunning() && Date.now() < deadlineAt) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
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
        if (state === 'starting') {
          state = 'running'
          // Flush 'inbound' events buffered while no listener existed — only
          // now do both halves hold: the assembler's listener is wired and
          // dispatch() accepts. Optional call: some test hosts pass a bare
          // EventEmitter stand-in without the gate.
          adapterManager?.releaseInbound?.()
        }
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
      // Durability: loop entries buffered so far become durable NOW, before
      // the stop grace below burns wall-clock. The abort() inside teardown()
      // still flushes anything appended during the grace window.
      try { session.flushToLoop() } catch { /* continue shutdown */ }
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
    get tapManager() { return options.getTapManager?.() ?? tapManager },
    scratchDir,
    loopPool,
    getLifecycleState: () => state,
    hasInFlightDispatch: () => inFlight.size > 0,
    dispatch,
    dispatchTo,
    dispatchStartup,
    applyConfigChange,
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
      try { loopPool.dispose() } catch { /* continue teardown */ }
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
