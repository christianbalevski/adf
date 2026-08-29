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
 *
 * Methods should reject with an `Error` whose message is safe to show the
 * model; the tools surface `error.message` verbatim as an `isError` result.
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
   */
  sendToLoop(
    fromLoop: string,
    toLoop: string,
    content: string,
    wake: boolean
  ): Promise<LoopSendResult>

  /** Validate + attenuate + persist + spin up a runtime for a new side loop. */
  createLoop(config: LoopConfig): Promise<void>

  /** Merge `patch` into the named side loop, re-derive, and rebuild its runtime. */
  updateLoop(name: string, patch: Partial<LoopConfig>): Promise<void>

  /** Archive the stream to `adf_audit`, then drop the config entry + runtime. */
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
