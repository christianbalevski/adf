/**
 * The contract between the loop tools and the runtime loop pool.
 *
 * The pool itself is a `Map<loopName, LoopRuntime>` that hangs off
 * `AssembledAgent` (docs/design/agent-loops-mvp.md §6.1 — it must survive the
 * foreground/background handoff, so it cannot live on
 * `BackgroundManagedAgent`). This file deliberately knows nothing about
 * executors, sessions or `AdfCallHandler`: it is the *narrow* surface
 * `loop_send`, `loop_list` and `loop_manage` need, so the tools can be written,
 * type-checked and unit-tested before the runtime exists.
 *
 * Everything here is main-process-only and implementation-agnostic. Keep it
 * that way: if a tool starts needing an executor, the seam is wrong.
 *
 * See docs/design/agent-loops-mvp.md §7.2 (tools) and §6 (runtime).
 */

import type { LoopConfig } from '../../shared/types/adf-v02.types'

/** In-memory per-loop status. There is no `adf_loops` state table in the MVP. */
export type LoopStatus = 'idle' | 'running'

/**
 * What `loop_list` shows a loop about its siblings — discovery for `loop_send`.
 * Always includes the implicit `main` loop (goal = the agent's instructions,
 * `enabled: true`), which never appears in `AgentConfig.loops`.
 */
export interface LoopInfo {
  name: string
  goal: string
  status: LoopStatus
  enabled: boolean
  /** True for the implicit host loop. Not deletable, not declarable. */
  isMain: boolean
}

/** Outcome of a `loop_send`. */
export interface LoopSendResult {
  /** The row was appended to the target loop's `adf_loop` stream. */
  delivered: boolean
  /** A turn was dispatched on the target loop's executor. */
  woke: boolean
  /** Why a requested wake did not happen (loop disabled, already running, …). */
  reason?: string
}

/** Outcome of a `loop_manage` delete — the pool archives before it forgets. */
export interface LoopDeleteResult {
  /** `adf_loop` rows written to `adf_audit` under source `loop:<name>`. */
  archivedEntries: number
}

/** Outcome of a `loop_manage` create. */
export interface LoopCreateResult {
  /**
   * The tool names the new loop's executor actually got — the result of
   * `deriveTools`, not the request. The requested list is intersected with the
   * host's enabled/unrestricted set and then unioned with the essentials
   * (`loop_send`/`loop_list`) and, unless the host disabled or restricted them,
   * `loop_compact`/`loop_clear`. `loop_manage` reports THIS rather than
   * predicting, because the prediction is wrong in both directions.
   */
  effectiveTools: string[]
}

/**
 * The runtime surface the loop tools drive.
 *
 * Implementations own ALL of the following; the tools only marshal input and
 * format results:
 *
 * - **Delivery (RT-F6).** `sendToLoop` must append the stamped user row to the
 *   target's `adf_loop` stream *at send time*, then — when `wake` — dispatch
 *   the target's executor carrying that row's `loop_seq` and a `skipLoop`
 *   inline flag, exactly mirroring `deliverOwnerMessage`
 *   (`agent-executor.ts:1302`). Appending in one place and passing the content
 *   through the dispatch too makes the session and the DB diverge and the wake
 *   duplicate the message.
 * - **Attenuation.** `createLoop`/`updateLoop` re-run `deriveLoopConfig` and
 *   re-check the tool allow-list. The tool validates first for a good error
 *   message; the pool validates again because it is the only enforcement point
 *   a non-tool caller (config edit, IPC) also passes through.
 * - **Persistence.** `createLoop`/`updateLoop`/`deleteLoop` mutate
 *   `AgentConfig.loops` (via `workspace.setAgentConfig`) *and* the live
 *   `Map<loopName, LoopRuntime>`, and either both land or neither does.
 * - **Archival.** `deleteLoop` compresses the loop's stream into `adf_audit`
 *   under `loop:<name>` before dropping the config entry and disposing the
 *   runtime.
 * - **`main` is special.** It is always in `listLoops()`, `hasLoop('main')` is
 *   always true, and `deleteLoop('main')` must reject.
 * - **`fromLoop` is trusted-caller-supplied.** The tools derive it from
 *   `workspace.getLoopName()`, but the pool is also reachable from non-tool
 *   callers, so `sendToLoop` validates that `fromLoop` names an existing loop
 *   and rejects otherwise — the value ends up in the `[from loop:<name>]`
 *   provenance stamp and must never be free text.
 * - **`enabled: false` is a real, addressable loop, not a deleted one.**
 *   `listLoops()` includes it (with `enabled: false`), `hasLoop` is true,
 *   `getLoop` returns its config, `sendToLoop` APPENDS but never wakes and
 *   reports `reason: 'loop disabled'`, and `updateLoop({ enabled: false })` on
 *   a running loop takes effect at the turn boundary (the in-flight turn
 *   finishes; no successor is scheduled).
 * - **Errors are wrapped.** Every method wraps its internals so a
 *   better-sqlite3 / SQL / driver message never reaches the model verbatim:
 *   the tools surface `error.message` as an `isError` result, so the message
 *   must be a deliberate, model-facing sentence and must not leak file paths,
 *   SQL text or stack frames.
 *
 * Methods reject with an `Error` whose message is safe to show the model.
 */
export interface LoopPoolApi {
  /** Every loop including `main`, in config order with `main` first. */
  listLoops(): LoopInfo[]

  /** True for `main` and for every declared side loop, enabled or not. */
  hasLoop(name: string): boolean

  /** The declaration for a side loop. `undefined` for `main` (it has none). */
  getLoop(name: string): LoopConfig | undefined

  /**
   * Peer-to-peer inter-loop message. Appends `[from loop:<fromLoop>] <content>`
   * to `toLoop`'s stream; when `wake`, also dispatches a turn there. See the
   * RT-F6 note above — the delivery pattern is the pool's job, not the tool's.
   *
   * Contract:
   * - `fromLoop` is validated against the live loop set (see above).
   * - **Wake-while-running is never a dropped message.** If the target is
   *   mid-turn, the pool sets a *pending-wake* flag that the target's executor
   *   consumes at turn end, and reports `woke: false` with a reason. It must
   *   NOT be a naive "is it running? then skip" check: the executor
   *   self-schedules successor turns, so that read races the turn boundary and
   *   makes delivery nondeterministic. The row is appended at send time either
   *   way, so the tool's "it will read this on its next run" is literally true.
   * - A disabled target appends and never wakes, with
   *   `reason: 'loop disabled'` — the message waits for re-enablement.
   */
  sendToLoop(
    fromLoop: string,
    toLoop: string,
    content: string,
    wake: boolean
  ): Promise<LoopSendResult>

  /**
   * Validate + attenuate + persist + spin up a runtime for a new side loop.
   *
   * Contract:
   * - **The pool rejects duplicates itself.** `loop_manage`'s `hasLoop` check
   *   is a nicety for the error message and is TOCTOU by construction; this is
   *   the check that decides. Same for the tool allow-list: `createLoop` runs
   *   `validateLoopToolList` and REJECTS unknown/prohibited names — the silent
   *   subtraction in `deriveTools` is fail-safe, not enforcement.
   * - **Ordering: config write first, `Map` mutation second.** A crash between
   *   the two leaves a config-declared loop with no runtime, which the next
   *   assemble reconciles by spinning it up. The reverse order would leave a
   *   live runtime nothing owns.
   * - Returns the EFFECTIVE tool set (see `LoopCreateResult`).
   */
  createLoop(config: LoopConfig): Promise<LoopCreateResult>

  /**
   * Merge `patch` into the named side loop, re-derive, and rebuild its runtime.
   *
   * Contract:
   * - `patch` is a partial: absent keys are left as they are, present keys
   *   replace wholesale (`tools` and `model` are replaced, never merged
   *   element-wise). The pool re-reads the live config before merging, so a
   *   caller's stale snapshot cannot resurrect a concurrently-changed field.
   * - **An in-flight turn is not interrupted.** A loop that is mid-turn keeps
   *   running under the config it started with; the re-derived config binds at
   *   the turn boundary. (Refusing outright is the other acceptable
   *   implementation — what is NOT acceptable is swapping the config under a
   *   running turn.)
   * - Same write ordering and same re-validation as `createLoop`.
   */
  updateLoop(name: string, patch: Partial<LoopConfig>): Promise<void>

  /**
   * Archive the stream to `adf_audit`, then drop the config entry + runtime.
   *
   * Contract:
   * - **Refuses while the loop is running** (`status === 'running'`) with a
   *   message telling the caller to retry after the turn ends or abort it
   *   first. Archiving a stream out from under a live executor loses the turn's
   *   writes and leaves the executor writing into a dropped loop.
   * - Archive first, then drop: config entry and `Map` entry go together, and
   *   the loop's timers are dropped-and-logged, never re-pointed at `main`
   *   (re-pointing is a privilege escalation — an orphan runs with main's
   *   authority).
   * - The loop's `adf_logs` / `adf_tasks` rows are KEPT, still stamped with the
   *   dead loop's name — they are history, and history is not garbage.
   */
  deleteLoop(name: string): Promise<LoopDeleteResult>
}

/**
 * How the tools receive the pool.
 *
 * Lazy on purpose: the tools are constructed while the `AssembledAgent` (and
 * therefore the pool) is still being built, and the pool instance is replaced
 * across the foreground/background handoff. Returning `null`/`undefined` is a
 * supported state — an agent with no loops registers the tools nowhere, but a
 * mid-teardown call must degrade to a clear tool error, never a throw.
 */
export type LoopPoolAccessor = () => LoopPoolApi | null | undefined

/** Shared "the pool isn't there" message, so all three tools read alike. */
export const LOOP_POOL_UNAVAILABLE =
  'Loop runtime is unavailable — this agent has no loop pool attached. ' +
  'Loops may be disabled, or the agent may be reloading.'

/** Resolve an accessor, or return null. Never throws. */
export function resolveLoopPool(accessor: LoopPoolAccessor | undefined): LoopPoolApi | null {
  if (!accessor) return null
  try {
    return accessor() ?? null
  } catch {
    return null
  }
}
