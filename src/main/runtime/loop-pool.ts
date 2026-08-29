/**
 * The runtime side of agent loops: one `LoopRuntime` per enabled side loop,
 * hanging off `AssembledAgent` (docs/design/agent-loops-mvp.md §6.1).
 *
 * A loop is a *facet* of the agent, not a mount: it shares the .adf file, the
 * identity, the credentials, the mesh registration and the tool instances. What
 * it does NOT share is the cognition stream, the config it runs under, or the
 * authority that config carries. Three things make that real:
 *
 *   - `workspace.forLoop(name)` — every read/write the loop makes lands in its
 *     own `adf_loop` stream and is stamped with its name.
 *   - `deriveLoopConfig(host, loop)` — the attenuated config: allow-listed
 *     tools, the side-loop `code_execution` profile, only the triggers that
 *     name this loop, no nested loops.
 *   - a per-loop `AdfCallHandler` built from BOTH of the above. Handing a loop
 *     the host's handler would undo the other two in one line (review D2).
 *
 * Everything else — the trigger evaluator, MCP, adapters, taps, stream
 * bindings, the `SystemScopeHandler` — stays main's, because side loops make no
 * system lambdas (§2.3) and the agent has exactly one face to the mesh.
 */

import type { AgentExecutionEvent } from '../../shared/types/ipc.types'
import type { AgentConfig, LoopConfig, ToolDeclaration } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'
import {
  createDispatch,
  createEvent,
  type AdfBatchDispatch,
  type AdfEventDispatch,
  type ChatEventData,
} from '../../shared/types/adf-event.types'
import type { LLMProvider } from '../providers/provider.interface'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { ToolRegistry } from '../tools/tool-registry'
import type { McpClientManager } from '../services/mcp-client-manager'
import type { CodeSandboxService } from './code-sandbox'
import { AgentExecutor } from './agent-executor'
import { AgentSession } from './agent-session'
import type { AdfCallHandler } from './adf-call-handler'
import {
  MAIN_LOOP,
  LOOP_ESSENTIAL_TOOLS,
  deriveLoopConfig,
  validateLoopToolList,
  listAvailableLoopTools,
} from '../adf/derive-loop-config'
import { MAX_SIDE_LOOPS } from '../adf/adf-schema'
import type {
  LoopCreateResult,
  LoopDeleteResult,
  LoopInfo,
  LoopPoolApi,
  LoopSendResult,
  LoopStatus,
} from '../adf/loop-pool.types'
import { LoopSendTool, LoopListTool, ShellTool, SysCodeTool, SysLambdaTool } from '../tools/built-in'

export { MAIN_LOOP }

/** Provenance stamp on every inter-loop message. Audit-only — see §2.4. */
function stampContent(fromLoop: string, content: string): ContentBlock[] {
  return [{ type: 'text', text: `[from loop:${fromLoop}] ${content}` }]
}

/**
 * Main's tool exposure is declaration-driven end to end: the executor's tool
 * snapshot filters `config.tools`, and the call handler rejects names that are
 * not declared. Registering `loop_send`/`loop_list` in main's registry
 * therefore exposes nothing on its own — main needs declarations too.
 *
 * They are injected here and NEVER persisted: `DEFAULT_TOOLS` deliberately
 * omits them (they are structural machinery, not owner-toggled features), and
 * writing them into the .adf would make every loops-touched file diverge.
 *
 * Only when the agent actually has a side loop. An agent with no loops must
 * behave exactly as it did before loops existed, down to the tool schema it
 * ships to the provider.
 */
export function withLoopEssentialDeclarations(config: AgentConfig): AgentConfig {
  if ((config.loops ?? []).length === 0) return config
  const declared = new Set((config.tools ?? []).map(t => t.name))
  const missing: ToolDeclaration[] = LOOP_ESSENTIAL_TOOLS
    .filter(name => !declared.has(name))
    .map(name => ({ name, enabled: true, visible: true }))
  if (missing.length === 0) return config
  return { ...config, tools: [...(config.tools ?? []), ...missing] }
}

/**
 * `metadata.loop_name` is a derived-config-only marker. An imported or
 * hand-edited .adf can carry one, which would bind MAIN's executor to a side
 * loop's stream and hand it the side-loop guards. Strip it at load.
 */
export function stripLoopNameMarker(config: AgentConfig): void {
  if (config.metadata && 'loop_name' in config.metadata) {
    delete (config.metadata as { loop_name?: string }).loop_name
  }
}

/** Everything the pool needs from its host. Shared subsystems, not copies. */
export interface LoopPoolDeps {
  /** Root workspace. Every loop gets `workspace.forLoop(name)` off it. */
  workspace: AdfWorkspace
  /** Main's registry. Per-loop registries copy it and rebind what is bound. */
  registry: ToolRegistry
  /** Main's provider. A loop's `model` override goes through the call handler's
   *  provider factory when the host wired one; otherwise it shares this. */
  provider: LLMProvider
  basePrompt: string
  toolPrompts: Record<string, string>
  compactionPrompt?: string
  /** Main's call handler — the template every loop handler is forked from. */
  adfCallHandler: AdfCallHandler | null
  codeSandboxService: CodeSandboxService | null
  mcpManager: McpClientManager | null
  /** The live RAW host config (never a derived one). */
  getHostConfig: () => AgentConfig
  /** Persist a changed host config through the host's own save path, so Studio
   *  and every other config consumer see loop changes like any other edit. */
  saveConfig: (config: AgentConfig) => void
  /** Executor events from a loop, already stamped with `loop`. */
  onLoopEvent: (event: AgentExecutionEvent) => void
  /** `adf_call` events from a loop's code (mirrors the host's onAdfEvent). */
  onLoopAdfEvent?: (event: { type: string; payload: unknown; timestamp: number }) => void
  /**
   * Main, as the pool sees it. Main is a peer in `loop_send` — any loop may
   * address any other and main is not a bus (§7.2) — but its executor belongs
   * to the assembled lifecycle, so the pool reaches it through these rather
   * than owning a runtime for it.
   */
  main: {
    session: AgentSession
    isBusy: () => boolean
    dispatch: (value: AdfEventDispatch | AdfBatchDispatch) => Promise<void>
    /** Main's lifecycle state. `suspended`/`off`/`stopped` cascade to every
     *  loop (§6.3): a suspended agent is a suspended organism, not a quiet
     *  face with minds still turning behind it. */
    getState: () => string
  }
}

/** One side loop: its own mind, on the agent's body. */
export class LoopRuntime {
  readonly name: string
  config: LoopConfig
  derived: AgentConfig
  readonly workspace: AdfWorkspace
  readonly session: AgentSession
  readonly executor: AgentExecutor
  readonly registry: ToolRegistry
  readonly callHandler: AdfCallHandler | null

  /** Messages appended at send time whose wake had to wait for a turn boundary. */
  private pendingWakes: Array<{ blocks: ContentBlock[]; seq?: number }> = []
  private inFlight = new Set<Promise<void>>()
  private disposed = false
  lastActivityAt = Date.now()
  /** Set when a reconcile wants this runtime gone but a turn is still running. */
  disposeAfterTurn = false
  /**
   * Turn-boundary hook, from the pool. Two paths call it, deliberately: the
   * executor's own `onTurnSettled` (which sees re-entrant successor turns the
   * pool never dispatched) and this runtime's dispatch settling (which sees a
   * turn that ended without the executor's counter, e.g. a rejected dispatch).
   * Draining is idempotent — it takes at most one pending wake and re-checks
   * busy — so the overlap is redundancy, not double delivery.
   */
  onTurnBoundary?: () => void

  constructor(params: {
    name: string
    config: LoopConfig
    derived: AgentConfig
    workspace: AdfWorkspace
    session: AgentSession
    executor: AgentExecutor
    registry: ToolRegistry
    callHandler: AdfCallHandler | null
  }) {
    this.name = params.name
    this.config = params.config
    this.derived = params.derived
    this.workspace = params.workspace
    this.session = params.session
    this.executor = params.executor
    this.registry = params.registry
    this.callHandler = params.callHandler
  }

  get enabled(): boolean {
    return this.config.enabled !== false
  }

  /** Running = a turn is executing, or an accepted dispatch has not settled.
   *  Both halves matter: the executor reports 'idle' through the pre-thinking
   *  awaits inside an accepted dispatch. */
  isBusy(): boolean {
    return this.executor.isTurnActive() || this.inFlight.size > 0
  }

  status(): LoopStatus {
    return this.isBusy() ? 'running' : 'idle'
  }

  /** Rehydrate + run a turn on this loop. Mirrors the lifecycle dispatch choke
   *  point in assembleAgent: an idle-swept session must never start a turn with
   *  an empty history while the stream holds the real one. */
  dispatch(value: AdfEventDispatch | AdfBatchDispatch): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(`Loop "${this.name}" is no longer running`))
    this.lastActivityAt = Date.now()
    const operation = (async () => {
      if (value.scope !== 'system' && this.session.getMessages().length === 0) {
        const existing = this.workspace.getLoop()
        if (existing.length > 0) {
          this.session.restoreMessages(existing.map(entry => ({
            role: entry.role,
            content: entry.content_json,
            created_at: entry.created_at,
            seq: entry.seq,
          })))
        }
      }
      await this.executor.executeTurn(value)
    })()
    this.inFlight.add(operation)
    const settle = (): void => {
      this.inFlight.delete(operation)
      if (this.inFlight.size === 0 && !this.executor.isTurnActive()) {
        try { this.onTurnBoundary?.() } catch (error) {
          console.error(`[LoopPool] Turn-boundary hook for loop "${this.name}" threw:`, error)
        }
      }
    }
    void operation.then(settle, settle)
    return operation
  }

  queueWake(blocks: ContentBlock[], seq?: number): void {
    this.pendingWakes.push({ blocks, seq })
  }

  hasPendingWake(): boolean {
    return this.pendingWakes.length > 0
  }

  takePendingWake(): { blocks: ContentBlock[]; seq?: number } | undefined {
    return this.pendingWakes.shift()
  }

  /** True while this loop holds state a session release would destroy. */
  holdsUnflushedState(): boolean {
    return this.session.hasPendingWrites() || this.session.hasPendingContextInjections()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingWakes = []
    this.onTurnBoundary = undefined
    try { this.session.flushToLoop() } catch { /* best-effort durability */ }
    try { this.executor.abort() } catch { /* continue teardown */ }
    this.executor.onTurnSettled = undefined
    this.executor.onTaskCompleted = undefined
    try { this.executor.removeAllListeners() } catch { /* continue teardown */ }
    if (this.callHandler) {
      this.callHandler.onEvent = undefined
      this.callHandler.onTaskCompleted = undefined
      this.callHandler.onLambdaToolEndTurn = undefined
    }
  }
}

/**
 * Wrap an internal failure in a sentence that is safe to hand a model.
 *
 * The loop tools surface `error.message` verbatim as an `isError` result, so a
 * raw better-sqlite3 / driver message would put SQL text, file paths and stack
 * frames straight into the context window. Every public method funnels through
 * here (LoopPoolApi: "Errors are wrapped").
 */
function poolError(action: string, error: unknown): Error {
  if (error instanceof LoopPoolError) return error
  console.error(`[LoopPool] ${action} failed:`, error)
  return new Error(`${action} failed for an internal reason. The agent file may be busy — try again, or check the agent's logs.`)
}

/** A deliberate, model-facing failure — passes through poolError untouched. */
class LoopPoolError extends Error {}

function refuse(message: string): never {
  throw new LoopPoolError(message)
}

export class LoopPool implements LoopPoolApi {
  private runtimes = new Map<string, LoopRuntime>()
  private deps: LoopPoolDeps
  private disposed = false

  constructor(deps: LoopPoolDeps) {
    this.deps = deps
    this.reconcile(deps.getHostConfig())
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  private declaredLoops(): LoopConfig[] {
    return this.deps.getHostConfig().loops ?? []
  }

  listLoops(): LoopInfo[] {
    const host = this.deps.getHostConfig()
    const main: LoopInfo = {
      name: MAIN_LOOP,
      goal: host.instructions ?? '',
      status: this.deps.main.isBusy() ? 'running' : 'idle',
      enabled: true,
      isMain: true,
    }
    const side = (host.loops ?? []).map<LoopInfo>(loop => ({
      name: loop.name,
      goal: loop.goal,
      status: this.runtimes.get(loop.name)?.status() ?? 'idle',
      enabled: loop.enabled !== false,
      isMain: false,
    }))
    return [main, ...side]
  }

  hasLoop(name: string): boolean {
    if (name === MAIN_LOOP) return true
    return this.declaredLoops().some(l => l.name === name)
  }

  getLoop(name: string): LoopConfig | undefined {
    if (name === MAIN_LOOP) return undefined
    return this.declaredLoops().find(l => l.name === name)
  }

  /** Live runtimes, for the idle sweep and lifecycle paths. */
  getRuntimes(): LoopRuntime[] {
    return Array.from(this.runtimes.values())
  }

  getRuntime(name: string): LoopRuntime | undefined {
    return this.runtimes.get(name)
  }

  /** True when ANY side loop is mid-turn — the derived rollup of §6.3. Never
   *  the agent's state: `idle` means MAIN is idle, not that the organism is. */
  anyLoopRunning(): boolean {
    for (const runtime of this.runtimes.values()) if (runtime.isBusy()) return true
    return false
  }

  // ===========================================================================
  // Dispatch routing (§6.2 — the uniform router lives in front of dispatch)
  // ===========================================================================

  /**
   * Route an agent-scope dispatch to a loop's executor.
   *
   * Returns a reason string when the dispatch could NOT be delivered, so the
   * caller decides: an interactive invoke surfaces it as an error, a trigger or
   * timer drops it and logs. Never falls back to main — an orphaned dispatch
   * running with main's authority is exactly the escalation §2.3 exists to
   * prevent.
   */
  dispatchToLoop(name: string, value: AdfEventDispatch | AdfBatchDispatch): { ok: true; done: Promise<void> } | { ok: false; reason: string } {
    const runtime = this.runtimes.get(name)
    if (!runtime) {
      const declared = this.getLoop(name)
      if (!declared) return { ok: false, reason: `no loop named "${name}" on this agent` }
      return { ok: false, reason: `loop "${name}" is disabled` }
    }
    if (!runtime.enabled) return { ok: false, reason: `loop "${name}" is disabled` }
    // Already condemned by a reconcile and only alive until its turn ends —
    // starting another turn on it would keep it alive indefinitely.
    if (runtime.disposeAfterTurn) return { ok: false, reason: `loop "${name}" is shutting down` }
    // suspend/off cascade (§6.3). Trigger-borne dispatches are already gated by
    // the evaluator's shouldFire (which reads main's display state), but a
    // loop_send wake and a direct invoke are not — and a suspended agent whose
    // side loops keep thinking is not suspended.
    const mainState = this.deps.main.getState()
    if (mainState === 'suspended' || mainState === 'off' || mainState === 'stopped') {
      return { ok: false, reason: `the agent is ${mainState}` }
    }
    return { ok: true, done: runtime.dispatch(value) }
  }

  // ===========================================================================
  // Delivery (RT-F6)
  // ===========================================================================

  async sendToLoop(fromLoop: string, toLoop: string, content: string, wake: boolean): Promise<LoopSendResult> {
    try {
      // `fromLoop` ends up in the provenance stamp, so it is validated against
      // the live loop set rather than trusted — the tools derive it from
      // workspace.getLoopName(), but the pool is reachable from elsewhere.
      if (!this.hasLoop(fromLoop)) refuse(`Unknown sender loop "${fromLoop}".`)
      if (!this.hasLoop(toLoop)) refuse(`No loop named "${toLoop}" on this agent.`)
      if (fromLoop === toLoop) refuse(`Cannot send to "${toLoop}" — that is the sending loop.`)

      const blocks = stampContent(fromLoop, content)
      const target = this.deps.workspace.forLoop(toLoop)

      // Append-at-send (RT-F6): the row exists whether or not a wake runs, so
      // "it will read this on its next run" is literally true, and the wake
      // carries this seq instead of a second copy of the content.
      const seq = target.appendToLoop('user', blocks)

      const runtime = toLoop === MAIN_LOOP ? undefined : this.runtimes.get(toLoop)
      const disabled = toLoop !== MAIN_LOOP && (this.getLoop(toLoop)?.enabled === false || !runtime)

      if (disabled) {
        return { delivered: true, woke: false, reason: 'loop disabled' }
      }

      if (!wake) {
        // No wake, but the row must still reach the target's CONTEXT, not just
        // its table: a live session does not re-read the stream, so without
        // this the message would be invisible until the session was released
        // and rehydrated. skipLoop at drain time keeps it a single row.
        this.injectWithoutWake(toLoop, blocks, seq)
        return { delivered: true, woke: false }
      }

      if (toLoop === MAIN_LOOP) {
        // Main is a peer, not a bus: a loop may wake it. Its executor belongs
        // to the assembled lifecycle, so the dispatch goes back out through the
        // host rather than through a runtime the pool owns.
        if (this.deps.main.isBusy()) {
          // Mid-turn: the injection lands at main's next model boundary, which
          // is inside the turn already running — sooner than a queued wake.
          this.injectWithoutWake(toLoop, blocks, seq)
          return { delivered: true, woke: false, reason: 'main is mid-turn; it reads this before its next model call' }
        }
        const value = createDispatch(this.wakeEvent(blocks, seq, fromLoop), { scope: 'agent', loop: MAIN_LOOP })
        void this.deps.main.dispatch(value).catch(error => {
          console.error('[LoopPool] Wake turn on main failed:', error)
        })
        return { delivered: true, woke: true }
      }

      if (runtime!.isBusy()) {
        // Pending-wake, consumed at the turn boundary. NOT a "skip if running"
        // check: the executor self-schedules successor turns, so reading the
        // flag at send time races the boundary and drops the wake.
        runtime!.queueWake(blocks, seq)
        return {
          delivered: true,
          woke: false,
          reason: 'that loop is mid-turn; it wakes on this message when the turn ends',
        }
      }

      const woken = this.wakeWith(runtime!, blocks, seq, fromLoop)
      if (!woken.woke) this.injectWithoutWake(toLoop, blocks, seq)
      return { delivered: true, woke: woken.woke, ...(woken.reason ? { reason: woken.reason } : {}) }
    } catch (error) {
      throw poolError('loop_send', error)
    }
  }

  /** Put an already-persisted row into a live session without a second row. */
  private injectWithoutWake(loopName: string, blocks: ContentBlock[], seq: number): void {
    const session = loopName === MAIN_LOOP
      ? this.deps.main.session
      : this.runtimes.get(loopName)?.session
    if (!session) return
    // Only when the session is live. An empty (released) session rehydrates
    // from the stream on its next dispatch and would then hold BOTH the row and
    // this injection.
    if (session.getMessages().length === 0) return
    const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('')
    session.queueContextInjection({ role: 'user', text, category: 'loop', origin: `loop:${loopName}`, seq })
  }

  /**
   * The RT-F6 wake event: `skip_loop_append` + `loop_seq` tell the executor the
   * content is ALREADY a row in this stream, so it inlines it into the session
   * (keeping its [S<seq>] marker) instead of writing a duplicate.
   */
  private wakeEvent(blocks: ContentBlock[], seq: number | undefined, fromLoop: string) {
    return createEvent({
      type: 'chat' as const,
      source: `loop:${fromLoop}`,
      data: {
        message: { seq: seq ?? 0, role: 'user' as const, content_json: blocks, created_at: Date.now() },
        loop_seq: seq,
        skip_loop_append: true,
      } as unknown as ChatEventData,
    })
  }

  /** Dispatch a turn carrying a row that is ALREADY in the target's stream.
   *  Returns false when the router refused (disabled loop, suspended agent) —
   *  the row is already durable either way. */
  private wakeWith(runtime: LoopRuntime, blocks: ContentBlock[], seq: number | undefined, fromLoop = 'main'): { woke: boolean; reason?: string } {
    const value = createDispatch(this.wakeEvent(blocks, seq, fromLoop), { scope: 'agent', loop: runtime.name })
    const routed = this.dispatchToLoop(runtime.name, value)
    if (!routed.ok) return { woke: false, reason: routed.reason }
    void routed.done.catch(error => {
      console.error(`[LoopPool] Wake turn on loop "${runtime.name}" failed:`, error)
      this.logLoop('error', 'loop_wake_failed', runtime.name, `Wake turn failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return { woke: true }
  }

  /** Turn-boundary hook: drain ONE pending wake. The next one rides the next
   *  boundary, so two queued messages never interrupt each other's turn. */
  private consumePendingWake(runtime: LoopRuntime): void {
    if (this.disposed) return
    if (runtime.disposeAfterTurn) {
      this.disposeRuntime(runtime.name)
      return
    }
    if (!runtime.hasPendingWake() || !runtime.enabled) return
    // Out of the executor's finally block before dispatching: a turn must never
    // start inside the teardown of its predecessor.
    setImmediate(() => {
      if (this.disposed || runtime.isBusy() || !runtime.enabled) return
      const pending = runtime.takePendingWake()
      if (!pending) return
      this.wakeWith(runtime, pending.blocks, pending.seq)
    })
  }

  // ===========================================================================
  // Mutation
  // ===========================================================================

  async createLoop(config: LoopConfig): Promise<LoopCreateResult> {
    try {
      const host = this.deps.getHostConfig()
      if (config.name === MAIN_LOOP) refuse('"main" is the implicit host loop and cannot be created.')
      // The pool decides duplicates, not the tool: the tool's hasLoop() check
      // is TOCTOU by construction.
      if (this.hasLoop(config.name)) refuse(`A loop named "${config.name}" already exists.`)
      const existing = host.loops ?? []
      if (existing.length >= MAX_SIDE_LOOPS) {
        refuse(`This agent already has ${existing.length} side loops, the maximum (${MAX_SIDE_LOOPS}).`)
      }
      this.assertToolsGrantable(host, config.tools ?? [])

      // Config write FIRST, Map second (LoopPoolApi contract): a crash between
      // the two leaves a declared loop with no runtime, which the next assemble
      // reconciles. The reverse order would leave a runtime nothing owns.
      this.writeLoops(host, [...existing, config])

      const runtime = this.runtimes.get(config.name)
      const derived = runtime?.derived ?? deriveLoopConfig(this.deps.getHostConfig(), config)
      return { effectiveTools: derived.tools.filter(t => t.enabled).map(t => t.name) }
    } catch (error) {
      throw poolError('loop create', error)
    }
  }

  async updateLoop(name: string, patch: Partial<LoopConfig>): Promise<void> {
    try {
      if (name === MAIN_LOOP) refuse('main is the implicit host loop and is not managed here.')
      // Re-read live: a caller's stale snapshot must not resurrect a field that
      // changed under it.
      const host = this.deps.getHostConfig()
      const loops = host.loops ?? []
      const index = loops.findIndex(l => l.name === name)
      if (index < 0) refuse(`No side loop named "${name}".`)

      const merged: LoopConfig = { ...loops[index], ...patch, name }
      this.assertToolsGrantable(host, merged.tools ?? [])

      const next = loops.slice()
      next[index] = merged
      // Re-derive binds in place. An in-flight turn keeps running under the
      // config it started with (the executor holds its own reference for the
      // duration of a model call), and `enabled: false` takes effect at the
      // boundary because dispatch is what reads it.
      this.writeLoops(host, next)
    } catch (error) {
      throw poolError('loop update', error)
    }
  }

  async deleteLoop(name: string): Promise<LoopDeleteResult> {
    try {
      if (name === MAIN_LOOP) refuse('main is the agent itself and cannot be deleted.')
      const host = this.deps.getHostConfig()
      const loops = host.loops ?? []
      if (!loops.some(l => l.name === name)) refuse(`No side loop named "${name}".`)

      const runtime = this.runtimes.get(name)
      if (runtime?.isBusy()) {
        refuse(
          `Loop "${name}" is running a turn right now. Deleting it would archive the stream out from under a live turn ` +
          'and lose its writes. Try again once it goes idle.'
        )
      }

      // Archive BEFORE dropping: the loop's stream is history and history is
      // not garbage. forceAudit because this wipe is unrecoverable — an
      // ordinary clear can be reconstructed from the stream's future, a deleted
      // loop has none.
      const view = this.deps.workspace.forLoop(name)
      const { archivedEntries } = await view.clearLoop({ forceAudit: true })

      this.dropLoopTimers(name)
      this.disposeRuntime(name)
      this.writeLoops(host, loops.filter(l => l.name !== name))

      return { archivedEntries }
    } catch (error) {
      throw poolError('loop delete', error)
    }
  }

  /**
   * Timers of a deleted loop are dropped and logged, never re-pointed at main:
   * an orphan that fell back to main would run its schedule with main's
   * unattenuated authority (review B3).
   */
  private dropLoopTimers(name: string): void {
    let dropped = 0
    try {
      for (const timer of this.deps.workspace.getTimers()) {
        if ((timer.loop ?? MAIN_LOOP) !== name) continue
        this.deps.workspace.deleteTimer(timer.id)
        dropped++
      }
    } catch (error) {
      console.error(`[LoopPool] Failed to drop timers for loop "${name}":`, error)
    }
    if (dropped > 0) {
      this.logLoop('info', 'loop_timers_dropped', name,
        `Dropped ${dropped} timer(s) belonging to deleted loop "${name}" — orphaned timers are never re-pointed at main`)
    }
  }

  private assertToolsGrantable(host: AgentConfig, tools: string[]): void {
    if (tools.length === 0) return
    // deriveTools subtracts silently, which is fail-safe, not enforcement —
    // this is the enforcement, and every non-tool caller crosses it too.
    const { unknown, prohibited } = validateLoopToolList(host, tools)
    if (unknown.length === 0 && prohibited.length === 0) return
    const parts: string[] = []
    if (unknown.length > 0) parts.push(`not available on this agent: ${unknown.join(', ')}`)
    if (prohibited.length > 0) parts.push(`never grantable to a loop: ${prohibited.join(', ')}`)
    refuse(
      `Cannot grant those tools — ${parts.join('; ')}. ` +
      `Available: ${listAvailableLoopTools(host).join(', ') || '(none)'}.`
    )
  }

  /**
   * Persist `loops` through the host's own save path and fan the change out.
   * `metadata.updated_at` is bumped because it keys the executor's tool
   * snapshot cache — without it a re-derived loop would keep serving the old
   * tool schema.
   */
  private writeLoops(host: AgentConfig, loops: LoopConfig[]): void {
    const next: AgentConfig = {
      ...host,
      loops,
      metadata: { ...host.metadata, updated_at: new Date().toISOString() },
    }
    this.deps.saveConfig(next)
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Bring the Map in line with `config.loops`: build runtimes for enabled
   * loops, re-derive the ones that already exist, and drop the rest. Called at
   * construction and from the single config-change choke point, so a loop
   * declared by a hand-edited .adf, by `loop_manage`, or by Studio all arrive
   * the same way.
   */
  reconcile(host: AgentConfig): void {
    if (this.disposed) return
    const declared = host.loops ?? []
    const names = new Set(declared.map(l => l.name))

    for (const [name, runtime] of this.runtimes) {
      if (names.has(name)) continue
      if (runtime.isBusy()) { runtime.disposeAfterTurn = true; continue }
      this.disposeRuntime(name)
    }

    for (const loop of declared) {
      const runtime = this.runtimes.get(loop.name)
      const enabled = loop.enabled !== false
      if (!runtime) {
        if (enabled) this.createRuntime(host, loop)
        continue
      }
      runtime.config = loop
      if (!enabled) {
        // A disabled loop is a real, addressable loop — its stream still takes
        // appends. It just has no mind running: drop the runtime once its
        // in-flight turn finishes.
        if (runtime.isBusy()) runtime.disposeAfterTurn = true
        else this.disposeRuntime(loop.name)
        continue
      }
      this.rederive(host, runtime)
    }
  }

  private rederive(host: AgentConfig, runtime: LoopRuntime): void {
    try {
      const derived = deriveLoopConfig(host, runtime.config)
      const modelChanged = derived.model?.model_id !== runtime.derived.model?.model_id
      runtime.derived = derived
      // A changed model override needs a provider for the new id, or the loop
      // would keep calling the old model while its config claims otherwise.
      if (modelChanged) runtime.executor.updateProvider(this.providerFor(derived))
      // The DERIVED config, never the raw host config: handing a loop
      // executor the host config is total attenuation loss (review D6b).
      runtime.executor.updateConfig(derived)
      runtime.callHandler?.updateConfig(derived)
      this.syncLoopRegistry(runtime)
    } catch (error) {
      console.error(`[LoopPool] Failed to re-derive loop "${runtime.name}":`, error)
    }
  }

  private createRuntime(host: AgentConfig, loop: LoopConfig): LoopRuntime | null {
    try {
      const derived = deriveLoopConfig(host, loop)
      const workspace = this.deps.workspace.forLoop(loop.name)
      const session = new AgentSession(workspace)
      const existing = workspace.getLoop()
      if (existing.length > 0) {
        session.restoreMessages(existing.map(entry => ({
          role: entry.role,
          content: entry.content_json,
          created_at: entry.created_at,
          seq: entry.seq,
        })))
      }

      // A copy of main's registry: the tool INSTANCES are shared (they take the
      // workspace per call, and the shared ones carry host wiring a loop must
      // not lose — sys_fetch's daemon-port guard, the mesh tools' registration).
      // The instances that bind a workspace, a config or the call handler at
      // CONSTRUCTION are rebound below; sharing those would hand the loop
      // main's stream and main's authority.
      const registry = new ToolRegistry()
      for (const tool of this.deps.registry.getAll()) registry.register(tool)

      const callHandler = this.deps.adfCallHandler?.forLoop(workspace, derived, registry) ?? null

      const provider = this.providerFor(derived)
      const executor = new AgentExecutor(
        derived,
        provider,
        registry,
        session,
        this.deps.basePrompt,
        this.deps.toolPrompts,
        this.deps.compactionPrompt,
      )
      callHandler?.attachSession(session)

      const runtime = new LoopRuntime({
        name: loop.name, config: loop, derived, workspace, session, executor, registry, callHandler,
      })

      this.rebindBoundTools(runtime)

      // Events carry their loop so the renderer can key its store by loop; the
      // executor's own emit signature is untouched (contract A1).
      executor.on('event', (event: AgentExecutionEvent) => {
        this.deps.onLoopEvent({ ...event, loop: loop.name })
      })
      executor.onTurnSettled = () => this.consumePendingWake(runtime)
      runtime.onTurnBoundary = () => this.consumePendingWake(runtime)
      // A loop's own end-of-turn state transitions apply to ITS executor. The
      // trigger evaluator is deliberately NOT wired: only main feeds
      // setDisplayState (RT-F4), and a side loop's tool calls must not re-enter
      // the agent's trigger fabric in the MVP.
      executor.onTaskCompleted = (_taskId, tool, status, result, _error, sideEffects) => {
        if (!sideEffects?.endTurn || status !== 'completed' || !result) return
        if (tool !== 'sys_set_state' && tool !== 'adf_shell') return
        try {
          const parsed = JSON.parse(result) as { target_state?: string }
          if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* invalid tool result; the executor already surfaced it */ }
      }
      if (callHandler) {
        callHandler.onEvent = (event) => this.deps.onLoopAdfEvent?.(event)
        callHandler.onLambdaToolEndTurn = (tool, resultContent) => {
          if (tool !== 'sys_set_state' && tool !== 'adf_shell') return
          try {
            const parsed = JSON.parse(resultContent) as { target_state?: string }
            if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
          } catch { /* invalid tool result */ }
        }
        // requestProtectionApproval and onHilApproved are deliberately UNSET:
        // a side loop has no approval channel, and the call handler fails those
        // closed with a message that says so.
      }

      this.runtimes.set(loop.name, runtime)
      return runtime
    } catch (error) {
      console.error(`[LoopPool] Failed to build runtime for loop "${loop.name}":`, error)
      this.logLoop('error', 'loop_start_failed', loop.name,
        `Could not start loop "${loop.name}": ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * A loop's `model` override needs a provider for that model id. The host's
   * provider factory rides on the call handler, so a host that wired one gets
   * per-loop models for free; one that did not shares main's provider (the
   * loop still runs, on the agent's model).
   */
  private providerFor(derived: AgentConfig): LLMProvider {
    const modelId = derived.model?.model_id
    const hostModelId = this.deps.getHostConfig().model?.model_id
    if (!modelId || modelId === hostModelId) return this.deps.provider
    return this.deps.adfCallHandler?.providerForModel(modelId) ?? this.deps.provider
  }

  /**
   * Replace the registry entries that bind a workspace, a config or the call
   * handler at construction. Everything else is shared with main.
   */
  private rebindBoundTools(runtime: LoopRuntime): void {
    const granted = new Set(runtime.derived.tools.filter(t => t.enabled).map(t => t.name))
    const filePath = this.deps.workspace.getFilePath()
    const timeout = runtime.derived.limits?.execution_timeout_ms

    // The essentials: hardwired into every loop registry, host flags ignored.
    runtime.registry.register(new LoopSendTool(() => this))
    runtime.registry.register(new LoopListTool(() => this))
    // loop_manage is main-only and is never registered here (loops do not nest).
    runtime.registry.unregister('loop_manage')

    if (granted.has('adf_shell')) {
      // Main's shell holds MAIN's workspace and gates on MAIN's config — and
      // the shell can call tools by name, so sharing it would hand the loop
      // main's stream and main's toolset in one step.
      const shell = new ShellTool(
        runtime.registry,
        runtime.workspace,
        () => runtime.executor.getConfig(),
        this.deps.mcpManager,
      )
      // No approval callbacks: a side loop has no HIL channel, so a shell
      // command that needs one is refused rather than parked.
      runtime.registry.register(shell)
    } else {
      runtime.registry.unregister('adf_shell')
    }

    const sandbox = this.deps.codeSandboxService
    if (granted.has('sys_code') && sandbox) {
      runtime.registry.register(new SysCodeTool(sandbox, filePath, runtime.callHandler ?? undefined, timeout))
    } else if (!granted.has('sys_code')) {
      runtime.registry.unregister('sys_code')
    }
    if (granted.has('sys_lambda') && sandbox && runtime.callHandler) {
      runtime.registry.register(new SysLambdaTool(sandbox, runtime.callHandler, filePath, timeout))
    } else if (!granted.has('sys_lambda')) {
      runtime.registry.unregister('sys_lambda')
    }
  }

  /** Re-apply the bound-tool rebinding after a re-derive changed the toolset. */
  private syncLoopRegistry(runtime: LoopRuntime): void {
    // Pick up instances main gained since this runtime was built (an MCP server
    // connecting registers its mcp_* tools into the host registry at runtime).
    // New names only — the loop's own rebound shell/sys_code/sys_lambda must not
    // be overwritten by main's.
    for (const tool of this.deps.registry.getAll()) {
      if (!runtime.registry.get(tool.name)) runtime.registry.register(tool)
    }
    this.rebindBoundTools(runtime)
    runtime.registry.clearCache()
  }

  private disposeRuntime(name: string): void {
    const runtime = this.runtimes.get(name)
    if (!runtime) return
    this.runtimes.delete(name)
    runtime.dispose()
  }

  /**
   * Idle sweep, per loop (RT-F9). Each runtime is gated on its OWN state, so a
   * ticking side loop never shields main's session from release, and a sweep
   * never resets a mid-turn loop out from under its own executor.
   */
  sweepIdle(idleMs: number, minMessages = 50): number {
    const now = Date.now()
    let released = 0
    for (const runtime of this.runtimes.values()) {
      if (now - runtime.lastActivityAt < idleMs) continue
      const state = runtime.executor.getState()
      if (state !== 'idle' && state !== 'stopped' && state !== 'error') continue
      if (runtime.isBusy()) continue
      if (runtime.session.hasPendingContextInjections()) continue
      if (runtime.hasPendingWake()) continue
      const count = runtime.session.getMessages().length
      if (count <= minMessages) continue
      runtime.session.flushToLoop()
      // A failed flush keeps its buffer by contract; reset() would drop it and
      // the rows with it.
      if (runtime.session.hasPendingWrites()) continue
      runtime.session.reset()
      released++
      this.logLoop('info', 'session_released', runtime.name,
        `Idle sweep released ${count} in-memory messages from loop "${runtime.name}"; its stream retains the full history`)
    }
    return released
  }

  /** Stop every loop. The agent's suspend/off cascade and teardown both land here. */
  stopAll(): void {
    for (const name of Array.from(this.runtimes.keys())) this.disposeRuntime(name)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopAll()
  }

  private logLoop(level: string, event: string, target: string | null, message: string): void {
    try { this.deps.workspace.insertLog(level, 'loop', event, target, message) } catch { /* observability is never fatal */ }
  }
}
