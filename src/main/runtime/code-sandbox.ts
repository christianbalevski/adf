import { getSandboxHost, readAllowlist, type RemoteWorker } from './sandbox-host'
import { cpus } from 'os'
import { randomUUID } from 'crypto'
import { AsyncResource } from 'node:async_hooks'
import { clampTimerDelay } from '../utils/timer-delay'
import { transformCode } from './code-transform'

export interface CodeResult {
  result?: string
  stdout: string
  error?: string
  errorCode?: string
}

export interface AdfCallResult {
  /** adf calls return either tool text or structured values passed through to the VM. */
  result?: unknown
  error?: string
  errorCode?: string
  /** When true, the proxy won't auto-parse the result as JSON (e.g. model_invoke returns raw text) */
  raw?: boolean
}

export interface ToolConfig {
  enabledTools: string[]
  hilTools: string[]
  isAuthorized: boolean
}

const DEFAULT_TIMEOUT = 10_000
/** The host-side worker guard fires this long after the in-worker timeout. */
const WORKER_GUARD_BUFFER_MS = 2000

/** One in-flight execute() call, registered on its worker so the message router
 *  can dispatch to it and so worker death can settle it. */
interface PendingExec {
  onAdfCall?: OnAdfCallFn
  /** Authorization the handler was built with — travels with the owner so an
   *  orphaned call can never be answered at a level its owner didn't have. */
  isAuthorized: boolean
  /** Resolves the execute() promise. Idempotent — first settle wins. */
  settle: (result: CodeResult) => void
}

/** A finished execution's handler, kept briefly. Sandboxes are persistent, so a
 *  helper stored by execution 1 and called during execution 2 still holds
 *  execution 1's `adf` proxy — its calls must reach its own handler, at its own
 *  authorization, rather than borrow whichever execution happens to be live. */
interface RetiredExec {
  onAdfCall?: OnAdfCallFn
  isAuthorized: boolean
}

/** How many finished executions keep their handler per worker. Bounded because
 *  each retained record pins the closures its handler captured. */
const RETAINED_EXECS = 12

const ORPHANED_CALL_ERROR =
  'This adf call came from a closure stored by an execution that has already finished, ' +
  'and this sandbox has run code at more than one authorization level — answering it ' +
  'could hand the call the wrong authorization. Call adf.* from the running execution ' +
  '(or re-create the helper inside it) instead of from a stored closure.'

interface WorkerEntry {
  worker: RemoteWorker
  /** Filesystem allowlist of the host process this worker lives in. */
  readKey: string
  ready: boolean
  /** Number of in-flight execute() calls using this worker */
  inflight: number
  /** Whether destroy() was called while executions were still in-flight */
  pendingDestroy: boolean
  /** In-flight executions by execId, in registration order */
  pending: Map<string, PendingExec>
  /** Recently finished executions by execId, oldest first (bounded) */
  retired: Map<string, RetiredExec>
  /** Every authorization level this worker has executed code at. One level
   *  means an unattributable call cannot be upgraded by answering it. */
  authLevels: Set<boolean>
  /** Per-invocation sandbox (cold lambda): counted against the churn cap and
   *  never kept resident. Persistent sandboxes are counted as warm residents. */
  ephemeral: boolean
  /** When the last execution on this worker finished — drives idle eviction. */
  lastUsed: number
  /** Its admission permit has been handed back. Guards double-release when both
   *  destroyWorker() and the exit event fire for the same worker. */
  released: boolean
}

/** Failure to obtain a worker, distinguished from a failure inside one so
 *  execute() can report the right errorCode instead of a bare throw. */
class SandboxUnavailableError extends Error {
  constructor(message: string, readonly errorCode: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/** Options for a single execute(). Separate from ToolConfig because ToolConfig
 *  is shipped into the worker and these are main-thread-only concerns. */
export interface ExecuteOptions {
  /**
   * Authorization the `onAdfCall` handler is actually bound to. This is NOT
   * `toolConfig.isAuthorized`: every call site derives that from
   * `getAuthorizationContext()`, which prefers the caller's AsyncLocalStorage
   * value, so a handler hard-bound to `withAuthorization(false)` still reported
   * `true` when invoked from inside an authorized lambda — permanently poisoning
   * the worker's authLevels. Defaults to `toolConfig.isAuthorized`.
   */
  handlerAuthorized?: boolean
  /**
   * Agent that owns this sandbox, so destroyForAgent() can reap derived ids
   * from an explicit registry instead of matching string prefixes. Defaults to
   * the sandbox id.
   */
  agent?: string
  /** True for per-invocation sandboxes torn down right after (cold lambdas). */
  ephemeral?: boolean
  /** Abort signal for this execution. */
  signal?: AbortSignal
  /**
   * Terminate the worker when the signal aborts. This is deliberately opt-in:
   * vm execution has no per-execution interrupt, so termination cancels every
   * execution sharing the worker. Callers that opt in must use an isolated
   * sandbox id when collateral cancellation is unacceptable.
   */
  terminateOnAbort?: boolean
  /**
   * Make the code's top-level declarations and imports globals of the sandbox,
   * so the next execution on it can use them (sys_code, clear_state: false).
   * Off for lambdas: they re-run a whole file, often several files in one
   * sandbox, and a function left over from another file must not answer.
   */
  persist?: boolean
}

/**
 * Default ceiling on cold-lambda churn: the population that spawns a worker per
 * invocation. Worker creation is V8 isolate creation — process-wide it tops out
 * around 30/s regardless of what our script does — and measured cold-cycle
 * throughput peaks near half the core count and degrades past it (32-core box:
 * 38 cycles/s at C=16, 28/s at C=48 with 1.4s p50 and half-second event-loop
 * stalls). Clamped to [4, 32] so small machines still make progress and large
 * ones don't claim the whole box.
 */
function defaultMaxColdWorkers(): number {
  let cores = 8
  try { cores = cpus().length || 8 } catch { /* no /proc in some sandboxes */ }
  return Math.max(4, Math.min(32, Math.floor(cores / 2)))
}

/** Warm residents are idle most of their life, so they get a larger count cap
 *  than the cold concurrency cap — but a cap all the same: warm sandboxes are
 *  keyed per (agent, lambda target) and nothing evicted them, so residency
 *  scaled with triggers *declared* rather than with load. */
function warmCapFor(coldCap: number): number {
  return Math.max(16, coldCap * 3)
}

/** A warm resident idle this long is evicted. Re-spawn measured at ~16ms solo,
 *  so the trade is cheap; the parked module state is the only thing lost. */
const WARM_IDLE_TTL_MS = 5 * 60_000
/** Safety valve for a cold sandbox whose caller never destroyed it — without it
 *  a leaked worker would hold a churn permit forever. */
const COLD_IDLE_TTL_MS = 60_000
/** Longest an execution waits for a permit before failing. The per-lane dispatch
 *  queue owns drop policy; this gate blocks, and only gives up when waiting any
 *  longer would exceed the execution's own budget. */
const ADMISSION_MAX_WAIT_MS = 120_000
/** How long a worker gets to reach 'ready' before creation is failed. Generous:
 *  under a cold burst a spawn can queue behind ~30 others. */
const WORKER_BOOT_TIMEOUT_MS = 30_000
/** Throttle for the aggregate saturation warning. */
const SATURATION_LOG_INTERVAL_MS = 30_000

/** An execution parked on the admission gate. */
interface AdmissionWaiter {
  ephemeral: boolean
  resolve: () => void
  cleanup: () => void
}

interface WorkerCreation {
  promise: Promise<WorkerEntry>
  controller: AbortController
  callers: number
  /** destroy() landed while this creation was still starting. It is no longer
   *  joinable, its worker is never registered under the id, and that worker is
   *  terminated once the callers already waiting on it finish. */
  detached?: boolean
  /** The worker, once createWorker() has spawned it. */
  entry?: WorkerEntry
}

interface AdfCallMessage {
  type: 'adf_call'
  callId: string
  /** Execution that issued the call — the router uses it to pick the handler */
  execId?: string
  method: string
  args: unknown
}

interface ResultMessage {
  type: 'result'
  execId?: string
  value?: string
  stdout?: string
  error?: string
  errorCode?: string
}

type WorkerMessage = AdfCallMessage | ResultMessage | { type: 'ready' }

export type OnAdfCallFn = (method: string, args: unknown) => Promise<AdfCallResult>

/**
 * Manages Worker Threads with sandboxed vm.Contexts for code execution, keyed by
 * sandbox id. Workers are lazily created on first execute() and persist, so
 * variables and functions defined in one call carry over to the next call *on
 * the same sandbox id*.
 *
 * What shares a context is decided by the caller's id, not by the agent:
 *   `<agentId>`                       sys_code — one persistent sandbox per agent
 *   `<agentId>:loop:<name>`           sys_code in a side loop, one per loop
 *   `<agentId>:lambda:<file>`         warm trigger lambdas, per source file
 *   `<agentId>:lambda:<file>:<uuid>`  cold trigger lambdas, one per invocation
 *   `<agentId>:fn:<file>`             sys_lambda, per source file
 *   `<agentId>:task:<id>:<uuid>`      sys_code / sys_lambda run as a task (executeIsolated)
 *   `<agentId>:cmd:<file>:<id>:<uuid>`  owner commands, one per invocation (executeIsolated)
 *   `<agentId>:pre_llm_hook:<uuid>`   pre-LLM hook, one per request (executeIsolated)
 *   `<agentId>:mw` / `:api` / `:ws` / `:tap:<n>`   middleware, routes, taps
 * Warm lambdas and sys_lambda both partition per *file* so the two paths agree
 * about granularity: everything in one file shares module state, and a file is
 * also the unit of authorization, so no context ever mixes auth levels.
 *
 * Supports an RPC bridge for adf_call requests from sandbox code to the main thread,
 * enabling tools, model_invoke, and sys_lambda from within executed code.
 *
 * This service is a process-wide singleton, which makes it the only component
 * that sees every agent's sandbox demand — so it is where the global worker
 * ceiling lives (see admit()). Cold churn gets a concurrency cap, warm residents
 * get a count cap plus an idle TTL; the gate blocks with a deadline rather than
 * dropping, because the per-lane dispatch queue owns drop policy.
 */
export class CodeSandboxService {
  private workers: Map<string, WorkerEntry> = new Map()
  /** Workers destroy() detached while executions were in flight, by entry, so
   *  destroyAll() still reaches them before they finish on their own. */
  private detached: Map<WorkerEntry, string> = new Map()
  /** In-flight worker creations, so concurrent execute() calls share one worker
   *  instead of each building their own and the loser leaking. */
  private creating: Map<string, WorkerCreation> = new Map()
  private execCounter = 0
  private stdlibBasePath: string | null = null
  private stdlibModules: string[] = []
  private userPkgBasePath: string | null = null
  private userPkgModules: string[] | (() => string[]) = []
  /** Per-agent package lists, keyed by owning agent (see setAgentPackageSource). */
  private agentPackageSources: Map<string, () => string[]> = new Map()

  /** Sandbox ids each agent has created, so destroyForAgent() reaps exactly
   *  those. Prefix matching used to do this, but sandbox ids are absolute
   *  Windows paths — an agent whose `.adf` declares `id: "C"` made
   *  destroyForAgent('C') match the prefix `C:` and reap every path-keyed
   *  sandbox in the process. */
  private agentSandboxes: Map<string, Set<string>> = new Map()
  private sandboxOwners: Map<string, Set<string>> = new Map()

  // --- Global admission control ---
  private maxColdWorkers = defaultMaxColdWorkers()
  private maxWarmWorkers = warmCapFor(defaultMaxColdWorkers())
  /** Live + being-created workers of each population (their held permits). */
  private coldCount = 0
  private warmCount = 0
  private waiters: AdmissionWaiter[] = []
  private lastSaturationLog = 0
  private blockedSinceLastLog = 0

  /** Configure the standard library path and available module names for the sandbox. */
  setStdlib(basePath: string, modules: string[]): void {
    this.stdlibBasePath = basePath
    this.stdlibModules = modules
    this.recycleForAllowlist()
  }

  /**
   * Configure the installed-package path and the RUNTIME packages (Settings >
   * Packages), which every agent's sandboxes can import. Pass a reader to
   * follow the setting live; it runs at each execution. An agent's own
   * packages come on top of these, from setAgentPackageSource.
   */
  setUserPackages(basePath: string, modules: string[] | (() => string[])): void {
    this.userPkgBasePath = basePath
    this.userPkgModules = modules
    this.recycleForAllowlist()
  }

  /** The sandbox host's filesystem read allowlist: the package roots only. */
  private readPaths(): string[] {
    return readAllowlist([this.stdlibBasePath, this.userPkgBasePath])
  }

  /**
   * Package roots are fixed per host process (they are its --allow-fs-read
   * list). When they change, workers on a host with the old list could not
   * load packages from the new roots, so they are replaced: idle ones now,
   * busy ones as soon as their executions finish.
   */
  private recycleForAllowlist(): void {
    const key = this.readPaths().join('\n')
    for (const [id, entry] of Array.from(this.workers)) {
      if (entry.readKey !== key) this.destroy(id)
    }
  }

  private runtimePackageModules(): string[] {
    if (typeof this.userPkgModules !== 'function') return this.userPkgModules
    try { return this.userPkgModules() } catch { return [] }
  }

  /**
   * The packages one agent installed (its code_execution.packages), importable
   * only by sandboxes that agent owns. `read` runs at each execution, so a
   * package the agent just installed is importable on its next run with no
   * refresh step. `keys` are every id the agent's sandboxes are owned under —
   * the `agent` execute option, which is the file path for most callers and
   * the config id for some (mesh routes, middleware).
   */
  setAgentPackageSource(keys: string[], read: () => string[]): void {
    for (const key of keys) this.agentPackageSources.set(key, read)
  }

  clearAgentPackageSource(keys: string[], read?: () => string[]): void {
    for (const key of keys) {
      // A newer assembly of the same agent may already own the key.
      if (read && this.agentPackageSources.get(key) !== read) continue
      this.agentPackageSources.delete(key)
    }
  }

  /** Module names visible to `agent`'s sandboxes: runtime packages plus its own. */
  getUserPackageModules(agent?: string): string[] {
    const runtime = this.runtimePackageModules()
    const read = agent ? this.agentPackageSources.get(agent) : undefined
    if (!read) return [...runtime]
    let own: string[] = []
    try { own = read() } catch { /* an unreadable config hides only its own packages */ }
    return [...new Set([...runtime, ...own])]
  }

  /**
   * Set the global ceiling on concurrent cold-lambda workers (user setting —
   * it decides how much of the machine the app claims). Warm residency is
   * derived from it. Undefined / non-numeric restores the CPU-derived default.
   */
  setMaxWorkers(max: number | undefined | null): void {
    const parsed = typeof max === 'number' && Number.isFinite(max) && max >= 1
      ? Math.floor(max)
      : defaultMaxColdWorkers()
    this.maxColdWorkers = parsed
    this.maxWarmWorkers = warmCapFor(parsed)
    this.pumpWaiters()
  }

  /** Live worker accounting — used by the settings UI and by tests. */
  getResourceStats(): {
    cold: number; warm: number; waiting: number; maxCold: number; maxWarm: number
  } {
    return {
      cold: this.coldCount,
      warm: this.warmCount,
      waiting: this.waiters.length,
      maxCold: this.maxColdWorkers,
      maxWarm: this.maxWarmWorkers
    }
  }

  /**
   * Execute code in the agent's sandbox. Creates a worker on first call.
   * @param onAdfCall - Optional RPC handler for adf.* calls from sandbox code.
   * @param toolConfig - Optional tool availability config for fast-fail in proxy.
   * @param options - Handler authorization, owning agent, cold/warm hint.
   */
  async execute(
    agentId: string,
    code: string,
    timeout?: number,
    onAdfCall?: OnAdfCallFn,
    toolConfig?: ToolConfig,
    options?: ExecuteOptions
  ): Promise<CodeResult> {
    // No ceiling here: callers pass the agent's limits.execution_timeout_ms.
    // Only Node's timer range bounds it (the worker guard adds its buffer).
    const effectiveTimeout = clampTimerDelay(timeout ?? DEFAULT_TIMEOUT, WORKER_GUARD_BUFFER_MS)
    const ephemeral = options?.ephemeral ?? false
    // The worker's message router runs in the async context the worker was
    // spawned in, not this caller's: bind the handler here so adf.* calls run
    // in the context of the execution that made them (its task, its signal).
    onAdfCall = onAdfCall && AsyncResource.bind(onAdfCall)
    if (options?.signal?.aborted) {
      return { stdout: '', error: 'Execution cancelled', errorCode: 'ABORTED' }
    }

    const transformedCode = transformCode(code, options?.persist)

    if (options?.agent) this.registerSandbox(options.agent, agentId)

    let entry: WorkerEntry
    try {
      entry = await this.getOrCreateWorker(agentId, ephemeral, effectiveTimeout, options?.signal)
    } catch (err) {
      if (options?.signal?.aborted) {
        return { stdout: '', error: 'Execution cancelled', errorCode: 'ABORTED' }
      }
      return {
        stdout: '',
        error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof SandboxUnavailableError ? err.errorCode : 'SANDBOX_TERMINATED'
      }
    }

    // Send stdlib paths and user package paths. toolConfig rides along as the
    // worker's fallback for proxies with no execution of their own; the
    // authoritative per-execution copy travels on the 'execute' message.
    if (toolConfig || this.stdlibBasePath || this.userPkgBasePath) {
      entry.worker.postMessage({
        type: 'setup',
        toolConfig,
        stdlibBasePath: this.stdlibBasePath,
        stdlibModules: this.stdlibModules,
        userPkgBasePath: this.userPkgBasePath,
        // Per execution: a worker serves one owner, but the list must follow
        // that agent's installs and the runtime list as they change.
        userPkgModules: this.getUserPackageModules(options?.agent ?? agentId)
      })
    }

    const execId = `exec_${++this.execCounter}`
    // The authorization the handler is bound to, NOT toolConfig.isAuthorized —
    // see ExecuteOptions.handlerAuthorized for why those differ.
    const isAuthorized = options?.handlerAuthorized ?? toolConfig?.isAuthorized ?? false
    entry.authLevels.add(isAuthorized)

    const result = await new Promise<CodeResult>((resolve) => {
      let timer: NodeJS.Timeout
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settle({ stdout: '', error: 'Execution cancelled', errorCode: 'ABORTED' })
        if (options?.terminateOnAbort) this.destroyEntry(agentId, entry)
      }
      const settle = (r: CodeResult): void => {
        if (settled) return
        settled = true
        entry.pending.delete(execId)
        // Keep the handler reachable for calls this execution's stored closures
        // make later — see RetiredExec.
        this.retire(entry, execId, { onAdfCall, isAuthorized })
        clearTimeout(timer)
        options?.signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort()
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      // Worker-level timeout guard. Settle first, then terminate — otherwise the
      // exit handler would relabel this execution as SANDBOX_TERMINATED.
      timer = setTimeout(() => {
        console.warn(`[CodeSandbox] Worker timeout for agent ${agentId}, terminating worker`)
        settle({
          stdout: '',
          error: `Execution timed out after ${effectiveTimeout}ms; the sandbox was restarted, so anything earlier calls saved in it is gone`,
          errorCode: 'TIMEOUT'
        })
        this.destroyEntry(agentId, entry)
      }, effectiveTimeout + WORKER_GUARD_BUFFER_MS) // Extra buffer for async RPC round-trips

      // The worker can die while we await its creation — registering on a dead
      // one would wait out the guard timer for nothing. A detached worker is
      // not registered under the id but still runs what it was handed.
      if (entry.released) {
        settle({ stdout: '', error: 'Sandbox worker terminated', errorCode: 'SANDBOX_TERMINATED' })
        return
      }

      // The worker's message router (installed once in createWorker) dispatches
      // adf_call and result messages here by execId.
      entry.pending.set(execId, { onAdfCall, isAuthorized, settle })

      entry.worker.postMessage({
        type: 'execute',
        code: transformedCode,
        timeout: effectiveTimeout,
        execId,
        toolConfig
      })
    })

    // Decrement inflight count and destroy if deferred
    entry.inflight--
    entry.lastUsed = Date.now()
    // destroyEntry, not destroyWorker: a detached entry is no longer registered
    // under this id, and must not take its replacement down with it.
    if (entry.pendingDestroy && entry.inflight <= 0) {
      this.destroyEntry(agentId, entry)
    } else if (entry.inflight === 0 && !entry.ephemeral && this.waiters.length > 0) {
      this.pumpWaiters()
    }

    return result
  }

  /**
   * Execute in a sandbox of its own (`<baseId>:<uuid>`), torn down afterwards.
   * Nothing else shares the worker, so an abort terminates it outright — use
   * this whenever `options.signal` must stop code that ignores it. The worker
   * takes a warm permit unless `options.ephemeral` asks for a cold one; either
   * way the teardown hands it back. Warm suits long task runs (they must not
   * starve the small cold cap); at the warm cap one may evict an idle warm
   * resident, as any warm creation does. One-shot callers pass ephemeral.
   */
  async executeIsolated(
    baseId: string,
    code: string,
    timeout?: number,
    onAdfCall?: OnAdfCallFn,
    toolConfig?: ToolConfig,
    options?: Omit<ExecuteOptions, 'terminateOnAbort'>
  ): Promise<CodeResult> {
    const sandboxId = `${baseId}:${randomUUID()}`
    try {
      return await this.execute(sandboxId, code, timeout, onAdfCall, toolConfig, { ...options, terminateOnAbort: true })
    } finally {
      this.destroy(sandboxId)
    }
  }

  /**
   * Terminate a specific agent's worker. Called on agent stop.
   * A worker with executions in flight is detached now (the next execute() on
   * this id gets a new worker) and terminated once those executions finish.
   */
  destroy(agentId: string): void {
    const creation = this.creating.get(agentId)
    if (creation) {
      // These executions were accepted but their shared worker is still
      // starting. Detach it like a busy ready worker: they finish on it, it is
      // terminated after them, and the next execute() on this id starts fresh
      // instead of joining it (clear_state: true must not inherit a doomed
      // worker, and a clear_state: false call after it must not lose its state).
      creation.detached = true
      this.creating.delete(agentId)
      this.unregisterSandbox(agentId)
      const entry = creation.entry
      if (entry && this.workers.get(agentId) === entry) {
        entry.pendingDestroy = true
        this.workers.delete(agentId)
        this.detached.set(entry, agentId)
      }
      return
    }
    const entry = this.workers.get(agentId)
    if (entry && entry.inflight > 0) {
      entry.pendingDestroy = true
      this.workers.delete(agentId)
      this.unregisterSandbox(agentId)
      this.detached.set(entry, agentId)
      return
    }
    this.destroyWorker(agentId)
  }

  /** Whether a live worker exists for this sandbox id. */
  has(sandboxId: string): boolean {
    return this.workers.has(sandboxId)
  }

  /**
   * Terminate the agent's own sandbox plus every sandbox it derived
   * (`<agentId>:lambda:...`, `:mw`, `:fn:`, `:tap:`, `:ws`, ...). Cold lambdas
   * mint a fresh id per invocation, so agent teardown has to reap the derived
   * ids too or those workers outlive the agent. The ids come from an explicit
   * registry populated by execute() — never from string-prefix matching, which
   * an agent declaring `id: "C"` could aim at every `C:\...` sandbox.
   */
  destroyForAgent(agentId: string): void {
    const derived = this.agentSandboxes.get(agentId)
    const error = new SandboxUnavailableError('Sandbox worker terminated', 'SANDBOX_TERMINATED')
    const ids = new Set(derived)
    ids.add(agentId)
    for (const id of ids) {
      this.cancelCreation(id, error)
      this.destroy(id)
    }
    this.agentSandboxes.delete(agentId)
  }

  /**
   * Terminate all workers. Called on app shutdown or mesh disable.
   */
  destroyAll(): void {
    // Fail anything queued on the gate first: on shutdown or mesh disable it
    // would otherwise sit there until its own timeout for a worker that is
    // never coming.
    const error = new SandboxUnavailableError('Sandbox service shut down while waiting for a worker', 'SANDBOX_TERMINATED')
    for (const agentId of this.creating.keys()) this.cancelCreation(agentId, error)
    for (const agentId of Array.from(this.workers.keys())) {
      this.destroyWorker(agentId)
    }
    for (const [entry, agentId] of Array.from(this.detached)) this.destroyEntry(agentId, entry)
  }

  /** Record that `agent` owns sandbox id `sandboxId`. */
  private registerSandbox(agent: string, sandboxId: string): void {
    let set = this.agentSandboxes.get(agent)
    if (!set) {
      set = new Set()
      this.agentSandboxes.set(agent, set)
    }
    set.add(sandboxId)
    let owners = this.sandboxOwners.get(sandboxId)
    if (!owners) {
      owners = new Set()
      this.sandboxOwners.set(sandboxId, owners)
    }
    owners.add(agent)
  }

  /** Drop a destroyed sandbox from its owners' registries. */
  private unregisterSandbox(sandboxId: string): void {
    const owners = this.sandboxOwners.get(sandboxId)
    if (!owners) return
    this.sandboxOwners.delete(sandboxId)
    for (const agent of owners) {
      const set = this.agentSandboxes.get(agent)
      if (!set) continue
      set.delete(sandboxId)
      if (set.size === 0) this.agentSandboxes.delete(agent)
    }
  }

  // --- Global admission control -------------------------------------------
  // The process-wide singleton is the only component that sees every agent, so
  // the ceiling has to live here. Partitioning cold lambdas per invocation
  // removed an accidental bound (one worker per agent); measured, 20 concurrent
  // cold invocations went from 1 worker/+6.9MB to 20 workers/+88MB, and a
  // 10-agent x 3-lane x 4-concurrent burst reached 120 live workers / +585MB.

  /** Take a permit if one is free, evicting an idle warm resident if that is
   *  what it takes. Synchronous on purpose: an await between the check and the
   *  increment would let two admissions both see the last free slot. */
  private tryReserve(ephemeral: boolean): boolean {
    if (ephemeral) {
      if (this.coldCount < this.maxColdWorkers) {
        this.coldCount++
        return true
      }
      return false
    }
    if (this.warmCount < this.maxWarmWorkers) {
      this.warmCount++
      return true
    }
    if (this.evictLruWarm()) {
      this.warmCount++
      return true
    }
    return false
  }

  /** Hand a permit back. Idempotent — destroyWorker() and the exit event both
   *  land on the same entry. */
  private release(entry: WorkerEntry, pump = true): void {
    if (entry.released) return
    entry.released = true
    this.returnPermit(entry.ephemeral, pump)
  }

  private returnPermit(ephemeral: boolean, pump = true): void {
    if (ephemeral) this.coldCount--
    else this.warmCount--
    if (pump) this.pumpWaiters()
  }

  /** Wait for a permit, up to `waitMs`. Blocks rather than dropping: dropping
   *  here as well as in the dispatch queue would make loss un-attributable. */
  private admit(ephemeral: boolean, waitMs: number, signal: AbortSignal): Promise<void> {
    this.sweepIdle()
    if (this.tryReserve(ephemeral)) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        waiter.cleanup()
        reject(error)
      }
      const onAbort = () => remove(signal.reason)
      const timer = setTimeout(() => remove(new SandboxUnavailableError(
        `No sandbox worker available within ${waitMs}ms — the global worker ceiling ` +
        `(${ephemeral ? `${this.maxColdWorkers} concurrent lambda` : `${this.maxWarmWorkers} resident`} ` +
        'sandboxes) is saturated. Raise it in Settings › Packages if this is steady state.',
        'SANDBOX_BUSY'
      )), waitMs)
      const waiter: AdmissionWaiter = {
        ephemeral,
        resolve,
        cleanup: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }
      }
      this.waiters.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      this.noteSaturation()
    })
  }

  /** Hand freed permits to whoever is waiting. */
  private pumpWaiters(): void {
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i]
      if (this.tryReserve(waiter.ephemeral)) {
        this.waiters.splice(i, 1)
        waiter.cleanup()
        waiter.resolve()
      } else {
        i++
      }
    }
  }

  /** Reap idle sandboxes past their TTL. Lazy (called from admit) rather than
   *  on a timer so the service never holds the event loop open. */
  private sweepIdle(): void {
    const now = Date.now()
    for (const [id, entry] of Array.from(this.workers)) {
      if (entry.inflight > 0 || this.creating.has(id)) continue
      const ttl = entry.ephemeral ? COLD_IDLE_TTL_MS : WARM_IDLE_TTL_MS
      if (now - entry.lastUsed >= ttl) this.destroyWorker(id)
    }
  }

  /** Evict the least recently used idle warm resident. Returns false when every
   *  warm worker is busy — then the caller has to wait instead. */
  private evictLruWarm(): boolean {
    let oldestId: string | undefined
    let oldest = Infinity
    for (const [id, entry] of this.workers) {
      if (entry.ephemeral || entry.inflight > 0 || this.creating.has(id)) continue
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed
        oldestId = id
      }
    }
    if (oldestId === undefined) return false
    // The caller is taking this permit. Pumping here could reserve it for a
    // queued caller before tryReserve increments the count, even reentrantly.
    this.destroyWorker(oldestId, false)
    return true
  }

  /** One aggregate warning for the whole process. Per-agent warnings are what
   *  the old code produced: 50 agents each reporting a local timeout and none
   *  of them naming the shared cause. */
  private noteSaturation(): void {
    this.blockedSinceLastLog++
    const now = Date.now()
    if (now - this.lastSaturationLog < SATURATION_LOG_INTERVAL_MS) return
    this.lastSaturationLog = now
    console.warn(
      `[CodeSandbox] global worker ceiling is binding: ${this.coldCount}/${this.maxColdWorkers} cold, ` +
      `${this.warmCount}/${this.maxWarmWorkers} warm, ${this.waiters.length} execution(s) queued ` +
      `(${this.blockedSinceLastLog} blocked since the last report). Executions are waiting, not failing, ` +
      'until their own timeout expires.'
    )
    this.blockedSinceLastLog = 0
  }

  /**
   * Reuse the live worker, join an in-flight creation, or start one.
   *
   * Deliberately not `async`: the whole body up to `creating.set` must run in
   * one synchronous turn. Waiting for an admission permit is a suspension
   * point, and if the join entry were published after it, two concurrent first
   * executions would each build a worker — the loser silently overwritten in
   * `workers`, its permit never handed back.
   */
  private getOrCreateWorker(
    agentId: string,
    ephemeral: boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<WorkerEntry> {
    let creation = this.creating.get(agentId)
    if (!creation) {
      const existing = this.workers.get(agentId)
      if (existing) {
        existing.inflight++
        return Promise.resolve(existing)
      }

      const controller = new AbortController()
      const promise = this.admit(ephemeral, Math.min(timeoutMs, ADMISSION_MAX_WAIT_MS), controller.signal)
        .then(() => {
          if (controller.signal.aborted) {
            // Admission may have granted the slot in the same turn as the abort.
            this.returnPermit(ephemeral)
            throw controller.signal.reason
          }
          return this.createWorker(agentId, ephemeral, creation!)
        })
      creation = { promise, controller, callers: 0 }
      this.creating.set(agentId, creation)
    }
    return this.joinCreation(agentId, creation, signal)
  }

  private joinCreation(agentId: string, creation: WorkerCreation, signal?: AbortSignal): Promise<WorkerEntry> {
    creation.callers++
    return new Promise((resolve, reject) => {
      let waiting = true
      const leave = (): boolean => {
        if (!waiting) return false
        waiting = false
        creation.callers--
        signal?.removeEventListener('abort', onAbort)
        return true
      }
      const cleanup = () => {
        if (creation.callers !== 0 || this.creating.get(agentId) !== creation) return
        this.creating.delete(agentId)
        if (!this.workers.has(agentId)) this.unregisterSandbox(agentId)
      }
      const onAbort = () => {
        if (!leave()) return
        const error = new SandboxUnavailableError('Execution cancelled', 'ABORTED')
        if (creation.callers === 0 && this.creating.get(agentId) === creation) {
          this.cancelCreation(agentId, error)
          const entry = this.workers.get(agentId)
          if (entry?.inflight === 0) this.destroyWorker(agentId)
        } else if (creation.callers === 0 && creation.detached) {
          // Nobody is left to finish on the detached worker: stop it now.
          creation.controller.abort(error)
          if (creation.entry?.inflight === 0) this.destroyEntry(agentId, creation.entry)
        }
        reject(error)
      }
      void creation.promise.then(entry => {
        if (!leave()) return
        // Pin before clearing the creation record. Admission cannot evict
        // the worker between assignment and the execution's await resuming.
        entry.inflight++
        entry.pendingDestroy ||= creation.detached === true
        cleanup()
        resolve(entry)
      }, err => {
        if (!leave()) return
        cleanup()
        reject(err)
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  private cancelCreation(agentId: string, error: SandboxUnavailableError): void {
    const creation = this.creating.get(agentId)
    if (!creation) return
    this.creating.delete(agentId)
    if (!this.workers.has(agentId)) this.unregisterSandbox(agentId)
    creation.controller.abort(error)
  }

  private async createWorker(agentId: string, ephemeral: boolean, creation: WorkerCreation): Promise<WorkerEntry> {
    let readPaths: string[]
    let worker: RemoteWorker
    try {
      readPaths = this.readPaths()
      worker = getSandboxHost(readPaths).spawnWorker()
    } catch (err) {
      this.returnPermit(ephemeral)
      throw new SandboxUnavailableError(
        `Sandbox host unavailable: ${err instanceof Error ? err.message : String(err)}`,
        'SANDBOX_TERMINATED'
      )
    }

    const entry: WorkerEntry = {
      worker,
      readKey: readPaths.join('\n'),
      ready: false,
      inflight: 0,
      pendingDestroy: false,
      pending: new Map(),
      retired: new Map(),
      authLevels: new Set(),
      ephemeral,
      lastUsed: Date.now(),
      released: false
    }
    creation.entry = entry
    if (creation.detached) {
      entry.pendingDestroy = true
      this.detached.set(entry, agentId)
    } else {
      this.workers.set(agentId, entry)
    }

    // One router per worker, not one listener per execute() — N listeners both
    // tripped the MaxListeners warning and made every handler see every message.
    worker.on('message', (msg: WorkerMessage) => {
      void this.routeWorkerMessage(entry, msg)
    })

    // Boot outcome, settled by whichever lands first: 'ready', death, or the
    // timer. Registered BEFORE the ready wait — a worker that died mid-boot
    // (destroyAll() landing in the macrotask gap, ERR_WORKER_INIT_FAILED) used
    // to leave a promise that never settled, and `creating` cached it so every
    // later execute() on that id joined the dead promise permanently.
    let finishBoot: (err?: Error) => void = () => {}

    // Handle unexpected worker exit — remove from map so it gets recreated, and
    // settle whatever was running so it doesn't wait out its guard timer.
    worker.on('exit', () => {
      // Only evict our own entry: a dying old worker must not remove the newer
      // replacement already registered under the same id.
      if (this.workers.get(agentId) === entry) this.workers.delete(agentId)
      this.detached.delete(entry)
      this.release(entry)
      this.settleWorkerPending(entry, 'Sandbox worker terminated')
      finishBoot(new SandboxUnavailableError(
        'Sandbox worker terminated before it became ready',
        'SANDBOX_TERMINATED'
      ))
    })

    worker.on('error', (err: Error) => {
      if (this.workers.get(agentId) === entry) this.workers.delete(agentId)
      this.release(entry)
      this.settleWorkerPending(entry, `Worker error: ${err.message}`)
      finishBoot(new SandboxUnavailableError(
        `Sandbox worker failed to start: ${err.message}`,
        'SANDBOX_TERMINATED'
      ))
      void worker.terminate()
    })

    // Wait for the worker to signal ready
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout
      const onMessage = (msg: { type: string }): void => {
        if (msg.type === 'ready') finish()
      }
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.off('message', onMessage)
        if (!err) {
          entry.ready = true
          resolve()
          return
        }
        if (this.workers.get(agentId) === entry) this.workers.delete(agentId)
        this.release(entry)
        void worker.terminate()
        reject(err)
      }
      timer = setTimeout(() => {
        finish(new SandboxUnavailableError(
          `Sandbox worker did not become ready within ${WORKER_BOOT_TIMEOUT_MS}ms`,
          'SANDBOX_TERMINATED'
        ))
      }, WORKER_BOOT_TIMEOUT_MS)
      finishBoot = finish
      worker.on('message', onMessage)
    })

    return entry
  }

  /** Resolve every execution still registered on a dead/dying worker. */
  private settleWorkerPending(entry: WorkerEntry, error: string): void {
    for (const pending of Array.from(entry.pending.values())) {
      pending.settle({ stdout: '', error, errorCode: 'SANDBOX_TERMINATED' })
    }
    entry.pending.clear()
    // The context that held the stored closures died with the worker, so no
    // orphan can arrive again — dropping the retained handlers here is what
    // keeps them (and everything they capture) from outliving the worker.
    entry.retired.clear()
  }

  /** Retain a finished execution's handler, evicting the oldest past the cap. */
  private retire(entry: WorkerEntry, execId: string, rec: RetiredExec): void {
    entry.retired.set(execId, rec)
    while (entry.retired.size > RETAINED_EXECS) {
      const oldest = entry.retired.keys().next().value
      if (oldest === undefined) break
      entry.retired.delete(oldest)
    }
  }

  /**
   * Single message handler per worker. adf_call and result messages carry the
   * execId of the execution they belong to, so replies land on the right handler
   * even when several executions share a worker.
   */
  private async routeWorkerMessage(entry: WorkerEntry, msg: WorkerMessage): Promise<void> {
    const worker = entry.worker

    if (msg.type === 'adf_call') {
      const adfMsg = msg as AdfCallMessage
      // Calls whose owner already finished (stored closures, sys_lambda bodies
      // running in their own context) are answered by the owner's own retained
      // handler, so the call keeps its own authorization.
      const owner = adfMsg.execId
        ? entry.pending.get(adfMsg.execId) ?? entry.retired.get(adfMsg.execId)
        : undefined
      // Owner unrecoverable (retention evicted it, or it is the context-global
      // proxy). Borrowing the newest live handler is safe exactly when it cannot
      // upgrade the call: either the worker has only ever run one authorization
      // level, or the handler we would borrow is itself unauthorized — answering
      // through it can only downgrade. Deciding on authLevels alone refused
      // legitimate warm helpers in that second case.
      let target = owner
      if (!target) {
        const newest = this.newestPending(entry)
        if (newest && (entry.authLevels.size <= 1 || !newest.isAuthorized)) target = newest
      }
      const onAdfCall = target?.onAdfCall
      if (!onAdfCall) {
        const ambiguous = !owner && entry.authLevels.size > 1 && entry.pending.size > 0
        worker.postMessage({
          type: 'adf_result',
          callId: adfMsg.callId,
          error: ambiguous
            ? ORPHANED_CALL_ERROR
            : 'No adf handler configured — tools are not available in this sandbox',
          errorCode: ambiguous ? 'ORPHANED_CALL' : 'NOT_FOUND'
        })
        return
      }

      try {
        const result = await onAdfCall(adfMsg.method, adfMsg.args)
        worker.postMessage({
          type: 'adf_result',
          callId: adfMsg.callId,
          result: result.result,
          error: result.error,
          errorCode: result.errorCode,
          raw: result.raw || false
        })
      } catch (err) {
        worker.postMessage({
          type: 'adf_result',
          callId: adfMsg.callId,
          error: err instanceof Error ? err.message : String(err),
          errorCode: 'INTERNAL_ERROR'
        })
      }
      return
    }

    if (msg.type !== 'result') return

    const resultMsg = msg as ResultMessage
    const pending = resultMsg.execId ? entry.pending.get(resultMsg.execId) : undefined
    if (!pending) return

    if (resultMsg.error) {
      pending.settle({
        stdout: resultMsg.stdout ?? '',
        error: resultMsg.error,
        errorCode: resultMsg.errorCode
      })
    } else {
      pending.settle({ result: resultMsg.value, stdout: resultMsg.stdout ?? '' })
    }
  }

  /** Most recently registered in-flight execution (Map preserves insertion order). */
  private newestPending(entry: WorkerEntry): PendingExec | undefined {
    let last: PendingExec | undefined
    for (const pending of entry.pending.values()) last = pending
    return last
  }

  private destroyWorker(agentId: string, pump = true): void {
    const entry = this.workers.get(agentId)
    if (entry) this.destroyEntry(agentId, entry, pump)
  }

  /** Terminate one worker. Keyed by entry, not id: a detached worker must not
   *  remove the replacement registered under the same id since. */
  private destroyEntry(agentId: string, entry: WorkerEntry, pump = true): void {
    this.detached.delete(entry)
    if (this.workers.get(agentId) === entry) {
      this.workers.delete(agentId)
      this.unregisterSandbox(agentId)
    }
    // A released permit means the worker is already gone (exit, boot failure
    // or an earlier teardown).
    if (entry.released) return
    void entry.worker.terminate()
    // terminate() is async; settle now so nothing waits for the exit event,
    // and hand the admission permit back immediately so a queued execution
    // starts now rather than when the OS gets round to reaping the thread.
    this.release(entry, pump)
    this.settleWorkerPending(entry, 'Sandbox worker terminated')
  }
}
