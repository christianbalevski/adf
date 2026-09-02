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
import type { AgentConfig, LoopConfig } from '../../shared/types/adf-v02.types'
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
import { LOOP_AUTOSTART_MESSAGE } from '../adf/loop-pool.types'
import { LoopSendTool, LoopListTool, ShellTool, SysCodeTool, SysLambdaTool } from '../tools/built-in'

export { MAIN_LOOP }

/** Provenance stamp on every inter-loop message. Audit-only — see §2.4. */
function stampContent(fromLoop: string, content: string): ContentBlock[] {
  return [{ type: 'text', text: `[from loop:${fromLoop}] ${content}` }]
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
  /**
   * Main's provider, read LIVE. A loop with no model override shares whatever
   * main is running right now, so this must be an accessor: a reference
   * captured at assembly keeps every loop on the old model after the owner
   * changes the agent's (review M4d). A loop's own `model` override goes
   * through the call handler's provider factory when the host wired one.
   */
  getProvider: () => LLMProvider
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

/**
 * A kick queued at send time for a wake:true delivery that arrived mid-turn.
 * `injected` records whether the mid-turn context injection was actually made
 * (false in the rare empty-but-busy race); `blocks` only matter for an
 * un-injected entry, whose row is in neither the session nor the injection
 * queue and so must be inlined by the kick itself.
 */
type PendingWake = { blocks: ContentBlock[]; seq?: number; injected: boolean; fromLoop?: string }

/** Bound on queued kicks per target. A kick is owed per target, not per
 *  message, so anything past a handful is wake-spam (review C3/P2). */
const PENDING_WAKE_CAP = 16

/** Queue a kick, deduplicating: an injected entry is redundant once ANY entry
 *  is queued (one boundary turn drains every pending injection), so only an
 *  un-injected entry — which carries blocks the kick must inline — always
 *  queues. Returns the (possibly unchanged) queue. */
function enqueueKick(queue: PendingWake[], entry: PendingWake): void {
  if (entry.injected && queue.length > 0) return
  if (queue.length >= PENDING_WAKE_CAP) return
  queue.push(entry)
}

/**
 * Which queued kick, if any, must fire at a turn boundary.
 * - An un-injected entry must fire and must carry its own blocks.
 * - Otherwise fire iff a wake injection is still pending (the turn ended before
 *   draining it); the blocks are irrelevant — the kick adds nothing and the
 *   drain delivers (C1). Every injection already drained ⇒ no kick at all.
 */
/** How long a stop waits for an aborted turn to settle before proceeding. */
const STOP_SETTLE_TIMEOUT_MS = 30_000
const STOP_POLL_MS = 25

function pickKickRepresentative(entries: PendingWake[], session: AgentSession): PendingWake | null {
  const uninjected = entries.find(e => !e.injected)
  if (uninjected) return uninjected
  if (session.hasPendingWakeInjection()) return entries[0] ?? null
  return null
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

  /** Kicks queued at send time for a wake:true delivery that arrived mid-turn.
   *  `injected` records whether the mid-turn context injection was actually made
   *  (false in the rare empty-but-busy race); the pool uses it to decide whether
   *  a boundary kick is still needed. */
  private pendingWakes: PendingWake[] = []
  private inFlight = new Set<Promise<void>>()
  private disposed = false
  /** `stop()` already aborted the executor; `dispose()` must not abort twice. */
  private aborted = false
  lastActivityAt = Date.now()
  /**
   * Set the moment main decides this loop stops (delete, disable, config-edit
   * removal). New dispatches are refused from then on — the router and
   * `dispatch()` both check it — and the value is the reason they are told.
   * Set BEFORE the abort and BEFORE any archive: `clearLoop` is multi-second
   * and a turn started inside it would have its writes wiped by the archive it
   * raced.
   */
  condemned: string | null = null
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
    if (this.condemned) return Promise.reject(new Error(`Loop "${this.name}" is ${this.condemned}`))
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

  queueWake(blocks: ContentBlock[], seq: number | undefined, injected: boolean): void {
    enqueueKick(this.pendingWakes, { blocks, seq, injected })
  }

  hasPendingWake(): boolean {
    return this.pendingWakes.length > 0
  }

  /** Take EVERY queued kick and clear the queue. The pool drains the whole
   *  queue at each boundary — a kick is owed per target, not per message, and
   *  a stale entry left behind pinned the session against the idle sweep and
   *  blocked later genuine wakes behind it (review C3/P1/S3). */
  takeAllPendingWakes(): PendingWake[] {
    return this.pendingWakes.splice(0)
  }

  /** Put a taken wake back at the FRONT — the router refused it (host suspended
   *  between the turn boundary and the drain), and a discarded wake is a lost
   *  message even though the row is durable: nothing else would ever wake the
   *  loop on it. */
  returnPendingWake(pending: PendingWake): void {
    if (this.disposed) return
    this.pendingWakes.unshift(pending)
  }

  /** True while this loop holds state a session release would destroy. */
  holdsUnflushedState(): boolean {
    return this.session.hasPendingWrites() || this.session.hasPendingContextInjections()
  }

  /**
   * Stop this loop NOW, on main's authority. Condemns it (no new turns), aborts
   * whatever turn is in flight, and waits for that turn to settle so its
   * finally-block bookkeeping — the loop flush above all — has run before the
   * caller archives or drops anything. Nothing the loop wrote is lost: the
   * session writes through to the stream on every step, the abort flushes the
   * retry buffer, and the settled turn flushes it again.
   *
   * Returns whether a turn was interrupted, and whether it settled inside
   * `timeoutMs`. A tool that ignores its abort signal can hold the turn open;
   * the executor is already `stopped` by then, so the caller proceeds — a
   * late tool-result row lands in the stream, which the archive may miss but
   * the DB keeps.
   */
  async stop(reason: string, timeoutMs = STOP_SETTLE_TIMEOUT_MS): Promise<{ interrupted: boolean; settled: boolean }> {
    if (!this.condemned) this.condemned = reason
    if (this.disposed) return { interrupted: false, settled: true }
    if (!this.isBusy()) return { interrupted: false, settled: true }
    this.aborted = true
    try { this.executor.abort() } catch (error) {
      console.error(`[LoopPool] abort() threw while stopping loop "${this.name}":`, error)
    }
    const deadline = Date.now() + timeoutMs
    // The tracked dispatches first (they settle when executeTurn returns), then
    // any re-entrant successor the executor claimed itself — abort() emptied
    // its trigger queue, so this only waits for the one already running.
    await Promise.race([
      Promise.allSettled(Array.from(this.inFlight)),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ])
    while (this.isBusy() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS))
    }
    return { interrupted: true, settled: !this.isBusy() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingWakes = []
    this.onTurnBoundary = undefined
    try { this.session.flushToLoop() } catch { /* best-effort durability */ }
    if (!this.aborted) {
      this.aborted = true
      try { this.executor.abort() } catch { /* continue teardown */ }
    }
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

/** Main's goal as a roster entry: the first ~200 chars, flattened. */
const MAIN_GOAL_SUMMARY_CHARS = 200
function summarizeMainGoal(instructions: string): string {
  const flat = instructions.replace(/\s+/g, ' ').trim()
  if (flat.length <= MAIN_GOAL_SUMMARY_CHARS) return flat
  return `${flat.slice(0, MAIN_GOAL_SUMMARY_CHARS - 1).trimEnd()}…`
}

export class LoopPool implements LoopPoolApi {
  private runtimes = new Map<string, LoopRuntime>()
  private deps: LoopPoolDeps
  private disposed = false
  /** Loops already warned about an unhonourable model override — once each. */
  private modelFallbackWarned = new Set<string>()
  /**
   * The loop names the LAST reconcile saw declared. A loop dropped from the
   * config must have its timers dropped too, and a loop that was disabled (so
   * has no runtime) is invisible to the runtime map — this is what makes the
   * removal detectable in both cases.
   */
  private declaredNames = new Set<string>()
  /**
   * Loops mid-stop (delete / disable / config-edit removal), by name → why.
   * Set the tick the decision is made, lifted by `finishStop` once the stop
   * (and, for a removal, the archive) is over. The router refuses these by
   * reason, and reconcile does not rebuild one until it is lifted.
   */
  private stopping = new Map<string, string>()

  /**
   * Main's equivalent of a LoopRuntime's `pendingWakes`. A `loop_send` to main
   * with `wake: true` that arrives while main is mid-turn queues here and is
   * drained at main's turn boundary — symmetric with a busy side loop, which
   * self-schedules a successor turn rather than only injecting mid-turn. Main
   * has no LoopRuntime, so the queue lives on the pool and is consumed through
   * `consumeMainWake`, wired to main's `executor.onTurnSettled` in assemble.
   */
  private mainPendingWakes: PendingWake[] = []

  /** A8: max stream rows a DISABLED loop may accumulate before sendToLoop
   *  refuses. Bounds the invisible dead-drop a sender can pile into an
   *  unwatched, session-less loop; re-enabling drains it. */
  private static readonly DISABLED_LOOP_ROW_CAP = 100

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
      // A summary, not the charter: any loop granted loop_list reads this, and
      // main's full instructions are otherwise absent from a loop's context
      // (its derived config replaces them). Keep it a map entry (review S10).
      goal: summarizeMainGoal(host.instructions ?? ''),
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
    // Stopping (delete / disable / config-edit removal): its turn is being
    // aborted and, for a delete, its stream archived — a turn started now would
    // have its writes wiped by that archive.
    const stopping = this.stopping.get(name)
    if (stopping) return { ok: false, reason: `loop "${name}" is ${stopping}` }
    const runtime = this.runtimes.get(name)
    if (!runtime) {
      const declared = this.getLoop(name)
      if (!declared) return { ok: false, reason: `no loop named "${name}" on this agent` }
      return { ok: false, reason: `loop "${name}" is disabled` }
    }
    if (!runtime.enabled) return { ok: false, reason: `loop "${name}" is disabled` }
    // Condemned but still in the Map (a test-driven stop, or a bypassed router).
    if (runtime.condemned) return { ok: false, reason: `loop "${name}" is ${runtime.condemned}` }
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

      const runtime = toLoop === MAIN_LOOP ? undefined : this.runtimes.get(toLoop)
      const disabled = toLoop !== MAIN_LOOP && (this.getLoop(toLoop)?.enabled === false || !runtime)

      if (disabled) {
        // A8: a disabled loop has no live session, so an appended row is an
        // invisible dead-drop that surfaces only if the loop is re-enabled.
        // Hard-cap the stream length BEFORE appending so sys_code can't drive
        // thousands of 48KB rows into an unwatched tab. Existing rows (real
        // history from when it was enabled) count toward the cap; past it we
        // refuse the send rather than append.
        const buffered = target.getLoopCount()
        if (buffered >= LoopPool.DISABLED_LOOP_ROW_CAP) {
          refuse(
            `Loop "${toLoop}" is disabled and its buffer is full (${buffered} rows). ` +
            `Re-enable it to drain the backlog before sending more.`
          )
        }
        target.appendToLoop('user', blocks)
        return { delivered: true, woke: false, reason: 'loop disabled' }
      }

      // Append-at-send (RT-F6): the row exists whether or not a wake runs, so
      // "it will read this on its next run" is literally true, and the wake
      // carries this seq instead of a second copy of the content.
      const seq = target.appendToLoop('user', blocks)

      if (!wake) {
        // No wake, but the row must still reach the target's CONTEXT, not just
        // its table: a live session does not re-read the stream, so without
        // this the message would be invisible until the session was released
        // and rehydrated. skipLoop at drain time keeps it a single row.
        //
        // The injection then pins the session against the idle sweep until it
        // is delivered (hasPendingContextInjections). That is bounded rather
        // than unbounded: because the row was appended above, the sweep may
        // drop THIS injection and release anyway — a rehydrate replays the row
        // as an ordinary user message (see sweepIdle).
        this.injectWithoutWake(toLoop, fromLoop, blocks, seq)
        return { delivered: true, woke: false }
      }

      if (toLoop === MAIN_LOOP) {
        // Main is a peer, not a bus: a loop may wake it. Its executor belongs
        // to the assembled lifecycle, so the dispatch goes back out through the
        // host rather than through a runtime the pool owns.
        if (this.deps.main.isBusy()) {
          // Inject for mid-turn pickup — main reads it at its next model boundary
          // (≈ next tool step) if the turn continues — AND queue a kick so that
          // if the turn ends before that boundary, `consumeMainWake` runs one
          // more turn to drain it. The kick fires only if the injection is still
          // pending at the boundary (drained mid-turn ⇒ already read ⇒ no kick).
          const injected = this.injectWithoutWake(MAIN_LOOP, fromLoop, blocks, seq, true)
          enqueueKick(this.mainPendingWakes, { blocks, seq, fromLoop, injected })
          return { delivered: true, woke: false, reason: 'main is mid-turn; it reads this at its next step, or on a kick turn if the turn ends first' }
        }
        const value = createDispatch(this.wakeEvent(blocks, seq, fromLoop), { scope: 'agent', loop: MAIN_LOOP })
        void this.deps.main.dispatch(value).catch(error => {
          console.error('[LoopPool] Wake turn on main failed:', error)
        })
        return { delivered: true, woke: true }
      }

      if (runtime!.isBusy()) {
        // Inject for mid-turn pickup (read at the loop's next model boundary if
        // the turn continues) AND queue a kick, consumed at the turn boundary,
        // for the case where the turn ends first. NOT a "skip if running" check:
        // the executor self-schedules successor turns, so reading busy at send
        // time races the boundary and drops the kick.
        const injected = this.injectWithoutWake(toLoop, fromLoop, blocks, seq, true)
        runtime!.queueWake(blocks, seq, injected)
        return {
          delivered: true,
          woke: false,
          reason: 'that loop is mid-turn; it reads this at its next step, or on a kick turn if the turn ends first',
        }
      }

      const woken = this.wakeWith(runtime!, blocks, seq, fromLoop)
      if (!woken.woke) this.injectWithoutWake(toLoop, fromLoop, blocks, seq)
      return { delivered: true, woke: woken.woke, ...(woken.reason ? { reason: woken.reason } : {}) }
    } catch (error) {
      throw poolError('loop_send', error)
    }
  }

  /** Put an already-persisted row into a live session without a second row.
   *  `loopName` is the TARGET (which session the row lands in); `fromLoop` is the
   *  SENDER and is what the provenance origin must carry (A9). */
  private injectWithoutWake(loopName: string, fromLoop: string, blocks: ContentBlock[], seq: number, wake = false): boolean {
    const session = loopName === MAIN_LOOP
      ? this.deps.main.session
      : this.runtimes.get(loopName)?.session
    if (!session) return false
    const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('')
    // Render FIRST, regardless of whether the live session takes the injection.
    // The chat panel renders live from events, not from the stream, so without
    // this a delivery is invisible in the target's tab until a reload — and a
    // kick turn emits no trigger_message of its own, so this is the delivery's
    // only live render. Emitting the SAME stamped text the row holds makes both
    // paths render identically (the renderer reads the `[from loop:…]` stamp
    // off the content in either case). Unconditional so the empty-but-busy
    // race below does not swallow the card (review C5).
    this.deps.onLoopEvent({
      type: 'context_injected',
      payload: { category: 'loop', origin: `loop:${fromLoop}`, content: text, delivery: 'next_boundary' },
      timestamp: Date.now(),
      loop: loopName,
    })
    // Inject only when the session is live. An empty (released) session
    // rehydrates from the stream on its next dispatch and would then hold BOTH
    // the row and this injection. Returns false so a busy-path caller knows the
    // mid-turn pickup did NOT happen (empty-but-busy race) and must keep a kick
    // that inlines the row itself.
    if (session.getMessages().length === 0) return false
    // `wake` marks a wake:true delivery: read at the next model boundary if the
    // turn continues, else the pool runs one more turn at the boundary to drain
    // it (see consumePendingWake / consumeMainWake).
    session.queueContextInjection({ role: 'user', text, category: 'loop', origin: `loop:${fromLoop}`, seq, ...(wake ? { wake: true } : {}) })
    return true
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
    if (!runtime.hasPendingWake() || !runtime.enabled || runtime.condemned) return
    // Out of the executor's finally block before dispatching: a turn must never
    // start inside the teardown of its predecessor.
    setImmediate(() => {
      if (this.disposed || runtime.isBusy() || !runtime.enabled) return
      // Drain the WHOLE queue at every boundary — a kick is owed per target, not
      // per message, and one turn drains every pending injection. Then fire at
      // most one kick: a skip_loop_append wake whose trigger message is
      // suppressed while the injection is pending (C1), so it adds nothing and
      // the drain delivers exactly once.
      const entries = runtime.takeAllPendingWakes()
      if (entries.length === 0) return
      const rep = pickKickRepresentative(entries, runtime.session)
      if (!rep) return   // every injection already drained mid-turn — nothing left to deliver
      // The router decides AFTER the take (the agent can be suspended between
      // the turn boundary and this tick), so a refusal must put the wake back —
      // dropping it here loses the only thing that would ever wake the loop on
      // that row.
      const woken = this.wakeWith(runtime, rep.blocks, rep.seq)
      if (!woken.woke) runtime.returnPendingWake(rep)
    })
  }

  /**
   * Main's turn-boundary hook, wired to `executor.onTurnSettled` in assemble.
   * Drains ONE pending wake into a successor turn — the mirror of
   * `consumePendingWake` for the loop that has no LoopRuntime. Idempotent and
   * self-gating: it re-checks busy/lifecycle on the next tick and puts the wake
   * back on refusal, so a suspended agent keeps the wake (the row is durable and
   * main reads it on resume regardless).
   */
  consumeMainWake(): void {
    if (this.disposed) return
    if (this.mainPendingWakes.length === 0) return
    // Out of the executor's finally block before dispatching: a turn must never
    // start inside the teardown of its predecessor.
    setImmediate(() => {
      if (this.disposed || this.deps.main.isBusy()) return
      const state = this.deps.main.getState()
      // Suspended/off cascade (§6.3): don't wake a stilled organism — leave the
      // wake queued for when it runs again.
      if (state === 'suspended' || state === 'off' || state === 'stopped') return
      // Drain the WHOLE queue at every boundary (a kick is owed per target, not
      // per message) and fire at most one kick — a skip_loop_append wake whose
      // trigger message is suppressed while the injection is pending (C1), so
      // it adds nothing and the drain delivers exactly once. Every injection
      // already drained mid-turn ⇒ no kick.
      const entries = this.mainPendingWakes.splice(0)
      if (entries.length === 0) return
      const rep = pickKickRepresentative(entries, this.deps.main.session)
      if (!rep) return
      const value = createDispatch(
        this.wakeEvent(rep.blocks, rep.seq, rep.fromLoop ?? MAIN_LOOP),
        { scope: 'agent', loop: MAIN_LOOP }
      )
      void this.deps.main.dispatch(value).catch(error => {
        console.error('[LoopPool] Queued wake turn on main failed:', error)
        this.mainPendingWakes.unshift(rep)
      })
    })
  }

  /**
   * The loop-level counterpart of the agent's `autostart`: every enabled loop
   * with `autostart: true` gets the kickoff message with a wake, so it runs a
   * first turn on its goal without waiting to be addressed. Called once per
   * agent start from `dispatchStartup` (so a hibernating or idle-started agent
   * does not spin its loops up); `loop_manage create` kicks a new loop the
   * same way at create time. One loop's failure does not stop the others.
   *
   * Returns the names actually woken.
   */
  async autostartLoops(): Promise<string[]> {
    if (this.disposed) return []
    const woken: string[] = []
    for (const loop of this.declaredLoops()) {
      if (!loop.autostart || loop.enabled === false) continue
      if (!this.runtimes.has(loop.name)) continue
      try {
        const result = await this.sendToLoop(MAIN_LOOP, loop.name, LOOP_AUTOSTART_MESSAGE, true)
        if (result.woke) woken.push(loop.name)
        else console.warn(`[LoopPool] Autostart of loop "${loop.name}" delivered but did not wake: ${result.reason ?? 'unknown'}`)
      } catch (error) {
        console.error(`[LoopPool] Autostart of loop "${loop.name}" failed:`, error)
      }
    }
    return woken
  }

  // ===========================================================================
  // Mutation
  // ===========================================================================

  async createLoop(config: LoopConfig): Promise<LoopCreateResult> {
    try {
      const host = this.deps.getHostConfig()
      this.assertLoopsNotLocked(host)
      if (config.name === MAIN_LOOP) refuse('"main" is the implicit host loop and cannot be created.')
      // The pool decides duplicates, not the tool: the tool's hasLoop() check
      // is TOCTOU by construction.
      if (this.hasLoop(config.name)) refuse(`A loop named "${config.name}" already exists.`)
      const existing = host.loops ?? []
      if (existing.length >= MAX_SIDE_LOOPS) {
        refuse(`This agent already has ${existing.length} inner loops, the maximum (${MAX_SIDE_LOOPS}).`)
      }
      this.assertToolsGrantable(host, config.tools ?? [])
      this.assertModelGrantable(host, config)

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
      this.assertLoopsNotLocked(host)
      const loops = host.loops ?? []
      const index = loops.findIndex(l => l.name === name)
      if (index < 0) refuse(`No inner loop named "${name}".`)

      const merged: LoopConfig = { ...loops[index], ...patch, name }
      this.assertToolsGrantable(host, merged.tools ?? [])
      this.assertModelGrantable(host, merged)

      const next = loops.slice()
      next[index] = merged
      // Re-derive binds IMMEDIATELY, not at the turn boundary: the executor
      // re-reads its tool snapshot before every model call, so a revocation
      // bites mid-turn — the fail-safe direction, and the one the owner means
      // when they take a tool away. What a running turn keeps is only the
      // config for the model call already in flight. `enabled: false` stops
      // the loop outright — reconcile aborts its in-flight turn.
      this.writeLoops(host, next)
    } catch (error) {
      throw poolError('loop update', error)
    }
  }

  /**
   * Main has full authority over its loops: a delete lands whenever main says
   * so, mid-turn included. A running loop is stopped first (`stopRuntime`:
   * condemn → abort → wait for the turn to settle and flush), THEN its stream
   * is archived, then the config entry goes. Nothing is refused for being
   * busy, and nothing the loop wrote is lost — the stream is write-through
   * and the settled turn has flushed its retry buffer before the archive
   * reads the rows.
   */
  async deleteLoop(name: string): Promise<LoopDeleteResult> {
    let stopped = false
    try {
      if (name === MAIN_LOOP) refuse('main is the agent itself and cannot be deleted.')
      this.assertLoopsNotLocked(this.deps.getHostConfig())
      if (!(this.deps.getHostConfig().loops ?? []).some(l => l.name === name)) {
        refuse(`No inner loop named "${name}".`)
      }

      // Stop BEFORE the archive. Condemning happens synchronously inside, so
      // from this line on no timer, wake or invoke can start a turn whose
      // writes the multi-second `clearLoop` below would wipe.
      const { interrupted } = await this.stopRuntime(name, 'being deleted')
      stopped = true

      // Archive BEFORE dropping: the loop's stream is history and history is
      // not garbage. forceAudit because this wipe is unrecoverable — an
      // ordinary clear can be reconstructed from the stream's future, a deleted
      // loop has none.
      const archivedEntries = await this.archiveStream(name, 'delete')

      // Re-read the host config AFTER the awaits: the snapshot taken before
      // them is stale by however long the stop and archive took, and writing it
      // back would silently revert every config change made in that window.
      const freshHost = this.deps.getHostConfig()
      // Already torn down here — the reconcile that `writeLoops` triggers must
      // not tear it down a second time.
      this.declaredNames.delete(name)
      this.dropLoopTimers(name)
      this.writeLoops(freshHost, (freshHost.loops ?? []).filter(l => l.name !== name))

      return { archivedEntries, interruptedTurn: interrupted }
    } catch (error) {
      throw poolError('loop delete', error)
    } finally {
      // Config written (or the delete failed): lift the stopping mark. On
      // failure the live config still declares the loop, so this rebuilds its
      // runtime — a failed delete must not leave a loop unable to take work.
      if (stopped) this.finishStop(name)
    }
  }

  /**
   * Stop a running loop on main's authority and drop its runtime. The Map
   * entry goes synchronously (before the first await) so the router refuses
   * new work from the very tick the decision is made; the stop then aborts and
   * waits for the in-flight turn to settle so every write has flushed.
   */
  private async stopRuntime(name: string, reason: string): Promise<{ interrupted: boolean }> {
    const runtime = this.runtimes.get(name)
    if (!runtime) return { interrupted: false }
    runtime.condemned = reason
    // Out of the Map and into `stopping` in the same tick: the router answers
    // "is being deleted" (not "is disabled") for the whole stop + archive, and
    // reconcile knows not to rebuild it until the caller says the stop is over.
    this.runtimes.delete(name)
    this.stopping.set(name, reason)
    const { interrupted, settled } = await runtime.stop(reason)
    if (interrupted) {
      this.logLoop(settled ? 'info' : 'warn', settled ? 'loop_turn_aborted' : 'loop_turn_abort_timeout', name,
        settled
          ? `Loop "${name}" was ${reason} mid-turn; its turn was aborted and its writes flushed`
          : `Loop "${name}" was ${reason} mid-turn; its turn did not settle within ${STOP_SETTLE_TIMEOUT_MS / 1000}s of the abort — proceeding, its executor is already stopped`)
    }
    runtime.dispose()
    return { interrupted }
  }

  /**
   * The stop is over: lift the `stopping` mark and, if the live config still
   * (or again) declares the loop enabled with no runtime behind it — the owner
   * re-enabled or re-added it while the stop ran — rebuild it. A delete calls
   * this only after its config write, so it never resurrects the loop it just
   * removed.
   */
  private finishStop(name: string): void {
    this.stopping.delete(name)
    if (this.disposed || this.runtimes.has(name)) return
    const host = this.deps.getHostConfig()
    const declared = (host.loops ?? []).find(l => l.name === name)
    if (declared && declared.enabled !== false) this.createRuntime(host, declared)
  }

  /**
   * Archive a loop's stream into `adf_audit` under `loop:<name>` and clear it.
   * Every teardown crosses this — `loop_manage delete` and a config-edit
   * removal alike — so the history of a loop that no longer exists is never
   * silently dropped and never silently inherited by a later loop of the same
   * name. Forced regardless of the `audit.loop` setting: that flag governs
   * recoverable clears and compactions; a teardown has no future to
   * reconstruct from.
   */
  private async archiveStream(name: string, via: 'delete' | 'config'): Promise<number> {
    const view = this.deps.workspace.forLoop(name)
    const { archivedEntries } = await view.clearLoop({ forceAudit: true })
    this.logLoop('info', 'loop_torn_down', name,
      archivedEntries > 0
        ? `Loop "${name}" removed via ${via}; ${archivedEntries} stream ${archivedEntries === 1 ? 'entry' : 'entries'} archived to adf_audit under "loop:${name}"`
        : `Loop "${name}" removed via ${via}; its stream was empty, nothing to archive`)
    return archivedEntries
  }

  /**
   * A loop removed by a config edit (Studio, hand edit, sys_update_config) gets
   * the same teardown as a `loop_manage delete`: stop, archive, drop timers.
   * Reconcile is synchronous, so the stop's async tail runs here; the runtime
   * is already out of the Map by the time reconcile returns.
   */
  private async teardownRemoved(name: string): Promise<void> {
    try {
      await this.stopRuntime(name, 'being removed')
      if (this.disposed) return
      await this.archiveStream(name, 'config')
    } catch (error) {
      console.error(`[LoopPool] Teardown of removed loop "${name}" failed:`, error)
      this.logLoop('error', 'loop_teardown_failed', name,
        `Teardown of removed loop "${name}" failed; its stream may still be in adf_loop: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.finishStop(name)
    }
  }

  /** `enabled: false` on a running loop: stop it now, then let a re-enable
   *  that landed meanwhile rebuild it. */
  private async disableRuntime(name: string): Promise<void> {
    try {
      await this.stopRuntime(name, 'being disabled')
    } catch (error) {
      console.error(`[LoopPool] Disabling loop "${name}" failed:`, error)
    } finally {
      this.finishStop(name)
    }
  }

  /**
   * Timers of a deleted loop are dropped and logged, never re-pointed at main:
   * an orphan that fell back to main would run its schedule with main's
   * unattenuated authority (review B3).
   */
  private dropLoopTimers(name: string): void {
    let dropped = 0
    let kept = 0
    try {
      for (const timer of this.deps.workspace.getTimers()) {
        if ((timer.loop ?? MAIN_LOOP) !== name) continue
        // A lock is a human-only assertion: no agent path may delete a locked
        // timer, and deleting the loop it targets is not a loophole (review S2).
        // It stays (inert, since its loop is gone) until a human unlocks it.
        if (timer.locked) { kept++; continue }
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
    if (kept > 0) {
      this.logLoop('warn', 'loop_timers_locked_kept', name,
        `Kept ${kept} locked timer(s) belonging to deleted loop "${name}" — a lock is human-only and survives the loop; unlock or delete them in Studio`)
    }
  }

  /**
   * The enforcement (deriveTools subtracts silently, which is fail-safe, not
   * enforcement) — and every non-tool caller crosses it too.
   *
   * Two buckets refuse and one does not: an UNKNOWN name is a typo worth
   * failing on, a PROHIBITED name is the security boundary, but a name the
   * owner merely switched off is a preference. The loop is created carrying it,
   * ungranted, and gains it if the owner ever turns it back on.
   */
  /**
   * `loop_manage` writes `config.loops` without passing through
   * `sys_update_config`, so it must honor the owner's hard lock on that path
   * itself — the same `locked_fields` sentence, or the lock is enforced at one
   * door and silently ignored at the other (review I1).
   */
  private assertLoopsNotLocked(host: AgentConfig): void {
    const locked = host.locked_fields ?? []
    if (locked.includes('loops') || locked.some(f => f.startsWith('loops.'))) {
      refuse("'loops' is locked.")
    }
  }

  private assertToolsGrantable(host: AgentConfig, tools: string[]): void {
    if (tools.length === 0) return
    const { unknown, prohibited } = validateLoopToolList(host, tools)
    if (unknown.length === 0 && prohibited.length === 0) return
    const parts: string[] = []
    if (unknown.length > 0) parts.push(`no such tool on this agent: ${unknown.join(', ')}`)
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

    // A loop removed by a config edit gets the same treatment as one removed by
    // loop_manage: its timers are dropped and logged, never left behind. A
    // surviving schedule is not merely litter — it re-points at main the moment
    // the router can't find its loop (review B3), and a loop later recreated
    // under the same name would silently inherit a stranger's wake times.
    // Tracked by NAME, not by runtime: a disabled loop has no runtime but can
    // still own timers from when it ran.
    for (const name of this.declaredNames) {
      if (names.has(name)) continue
      this.dropLoopTimers(name)
      this.modelFallbackWarned.delete(name)
      // Same teardown as loop_manage delete: stop now (mid-turn included),
      // archive the stream to adf_audit, and only then forget it.
      void this.teardownRemoved(name)
    }
    this.declaredNames = names

    // A runtime with no declaration at all (never in declaredNames — e.g. a
    // pool built against a config that lost the loop before its first
    // reconcile) is stopped the same way.
    for (const name of Array.from(this.runtimes.keys())) {
      if (names.has(name)) continue
      void this.teardownRemoved(name)
    }

    for (const loop of declared) {
      const runtime = this.runtimes.get(loop.name)
      const enabled = loop.enabled !== false
      if (!runtime) {
        // A loop mid-stop is rebuilt by finishStop once the stop is over, not
        // here — its old executor may still be settling on the same stream.
        if (enabled && !this.stopping.has(loop.name)) this.createRuntime(host, loop)
        continue
      }
      runtime.config = loop
      if (!enabled) {
        // A disabled loop is a real, addressable loop — its stream still takes
        // appends. It just has no mind running: main said stop, so the
        // in-flight turn (if any) is aborted now, not finished first. The
        // stream keeps everything the turn wrote up to the abort.
        void this.disableRuntime(loop.name)
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
      if (modelChanged) runtime.executor.updateProvider(this.providerFor(derived, runtime.name))
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
      // A1: NO eager stream hydration here. Loading every loop's full transcript
      // at assemble is a ~1.5-4.5s boot freeze + ~500MB at 50x6 and is redundant:
      // dispatch() and injectWithoutWake() both lazily rehydrate a cold session
      // (session.messages.length === 0) from the DB before their first turn. The
      // session starts empty and is filled on first use.

      // A copy of main's registry: the tool INSTANCES are shared (they take the
      // workspace per call, and the shared ones carry host wiring a loop must
      // not lose — sys_fetch's daemon-port guard, the mesh tools' registration).
      // The instances that bind a workspace, a config or the call handler at
      // CONSTRUCTION are rebound below; sharing those would hand the loop
      // main's stream and main's authority.
      const registry = new ToolRegistry()
      for (const tool of this.deps.registry.getAll()) registry.register(tool)

      const callHandler = this.deps.adfCallHandler?.forLoop(workspace, derived, registry) ?? null

      const provider = this.providerFor(derived, loop.name)
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
   * A loop's `model` override needs a provider for that model id.
   *
   * The host's provider factory rides on the call handler, so a host that wired
   * one (sys_code/sys_lambda enabled) gets per-loop models. A host that did NOT
   * falls back to main's provider — the loop still runs, but on the agent's
   * model while its system prompt claims the override, so the fallback is
   * logged once per loop instead of happening silently (review M4a/M4b).
   *
   * MVP scope: the override must name the HOST's provider (enforced at
   * create/update). Cross-provider loop models are F3 — the factory reuses the
   * host's credentials, so honouring a different `provider` here would
   * cross-wire them.
   *
   * `getProvider()` is read on every call, never captured: a host model change
   * must reach every non-overriding loop (review M4d).
   */
  private providerFor(derived: AgentConfig, loopName: string): LLMProvider {
    const hostProvider = this.deps.getProvider()
    const modelId = derived.model?.model_id
    const hostModelId = this.deps.getHostConfig().model?.model_id
    if (!modelId || modelId === hostModelId) return hostProvider
    const forModel = this.deps.adfCallHandler?.providerForModel(modelId)
    if (forModel) return forModel
    if (!this.modelFallbackWarned.has(loopName)) {
      this.modelFallbackWarned.add(loopName)
      this.logLoop('warn', 'loop_model_override_ignored', loopName,
        `Loop "${loopName}" declares model "${modelId}" but this agent has no model factory ` +
        '(sys_code/sys_lambda are not enabled), so it runs on the agent\'s model instead. ' +
        'Enable code execution or drop the loop\'s model override.')
    }
    return hostProvider
  }

  /**
   * A loop's `model` override may change the model, never the provider.
   *
   * `providerForModel` builds the new provider from the HOST's provider config
   * and credentials, so a `provider: 'openai'` override on an Anthropic host
   * would silently produce an Anthropic client for an OpenAI model id — a
   * cross-wiring the loop's config claims is not happening. Reject it at the
   * only two write paths instead of pretending (F3 lifts this).
   */
  private assertModelGrantable(host: AgentConfig, loop: LoopConfig): void {
    const loopProvider = loop.model?.provider
    if (!loopProvider) return
    const hostProvider = host.model?.provider
    if (!hostProvider || loopProvider === hostProvider) return
    refuse(
      `Loop "${loop.name}" cannot use provider "${loopProvider}": a loop's model override may change the model, ` +
      `not the provider — this agent runs on "${hostProvider}", and a loop shares its credentials. ` +
      `Pick a "${hostProvider}" model, or change the agent's provider.`
    )
  }

  /**
   * Replace the registry entries that bind a workspace, a config or the call
   * handler at construction. Everything else is shared with main.
   */
  private rebindBoundTools(runtime: LoopRuntime): void {
    const granted = new Set(runtime.derived.tools.filter(t => t.enabled).map(t => t.name))
    const filePath = this.deps.workspace.getFilePath()
    const timeout = runtime.derived.limits?.execution_timeout_ms

    // Inter-loop tools: granted like any other tool now (host-enabled AND in
    // this loop's allow-list), so the registration follows `granted`. The
    // unregister branch is not cosmetic — the copied registry starts out
    // holding MAIN's instances, and a mute loop must not find one there.
    if (granted.has('loop_send')) {
      runtime.registry.register(new LoopSendTool(() => this))
    } else {
      runtime.registry.unregister('loop_send')
    }
    if (granted.has('loop_list')) {
      runtime.registry.register(new LoopListTool(() => this))
    } else {
      runtime.registry.unregister('loop_list')
    }
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

    // The fallback is an UNCONDITIONAL unregister, not `else if (!granted)`:
    // the copied registry starts out holding MAIN's instances, which are bound
    // to main's call handler and main's workspace. When the loop is granted the
    // tool but the pool cannot rebuild it (no sandbox, no per-loop handler), an
    // `else if` would leave main's handler-bound instance sitting in the loop's
    // registry — the exact authority leak the rebinding exists to close.
    const sandbox = this.deps.codeSandboxService
    if (granted.has('sys_code') && sandbox) {
      runtime.registry.register(new SysCodeTool(sandbox, filePath, runtime.callHandler ?? undefined, timeout))
    } else {
      runtime.registry.unregister('sys_code')
    }
    if (granted.has('sys_lambda') && sandbox && runtime.callHandler) {
      runtime.registry.register(new SysLambdaTool(sandbox, runtime.callHandler, filePath, timeout))
    } else {
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
      if (!this.pendingInjectionsAreReplayable(runtime)) continue
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

  /**
   * True when releasing this loop's session would lose nothing that is queued.
   *
   * A pending context injection normally pins a session open forever: an
   * unkeyed `loop_inject` notice exists ONLY in that queue (its loop row is
   * audit-only and deliberately never replayed), so releasing would drop it.
   * A `wake: false` loop_send is the exception — `sendToLoop` appends the row to
   * the stream BEFORE queueing the injection, so the content is durable and a
   * rehydrate restores it as an ordinary user message. Those may be dropped,
   * which is what keeps `wake: false` from pinning a quiet loop's session in
   * memory indefinitely (review m11).
   *
   * Conservative by construction: one non-loop injection in the queue and the
   * whole session stays.
   */
  private pendingInjectionsAreReplayable(runtime: LoopRuntime): boolean {
    const pending = runtime.session.peekPendingContextInjections()
    if (pending.length === 0) return true
    // A wake:true injection whose boundary kick is still owed is NOT
    // replayable: releasing would silently downgrade that wake to
    // read-on-next-run. It is pending only briefly (until the next boundary).
    return pending.every(injection =>
      injection.category === 'loop' && typeof injection.seq === 'number' && injection.wake !== true)
  }

  /** Stop every loop. The agent's suspend/off cascade and teardown both land here. */
  stopAll(): void {
    for (const name of Array.from(this.runtimes.keys())) this.disposeRuntime(name)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mainPendingWakes = []
    this.stopping.clear()
    this.stopAll()
  }

  private logLoop(level: string, event: string, target: string | null, message: string): void {
    try { this.deps.workspace.insertLog(level, 'loop', event, target, message) } catch { /* observability is never fatal */ }
  }
}
