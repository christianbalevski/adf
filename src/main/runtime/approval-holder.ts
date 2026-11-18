/**
 * Which executor of an agent is waiting on a HIL request.
 *
 * An agent runs main plus one executor per running inner loop, and any of them
 * can park an approval. A request id is a task id (`task_<nanoid>`), unique
 * across the agent, so the executor whose pending map holds it is the only one
 * that can resume the call. Resolving on any other executor is a silent no-op,
 * which is why every resolve path looks the holder up here instead of assuming
 * main.
 */
import type { AgentExecutor } from './agent-executor'
import { MAIN_LOOP } from '../adf/derive-loop-config'
import type { LoopPool } from './loop-pool'

export interface ApprovalExecutor {
  loop: string
  executor: AgentExecutor
}

/** Main's executor plus every running inner loop's. */
export function approvalExecutors(main: AgentExecutor, pool: Pick<LoopPool, 'getRuntimes'> | null | undefined): ApprovalExecutor[] {
  const out: ApprovalExecutor[] = [{ loop: MAIN_LOOP, executor: main }]
  for (const runtime of pool?.getRuntimes() ?? []) out.push({ loop: runtime.name, executor: runtime.executor })
  return out
}

/** The executor holding `requestId`, or undefined when no executor waits on it. */
export function findApprovalHolder(
  main: AgentExecutor,
  pool: Pick<LoopPool, 'getRuntimes'> | null | undefined,
  requestId: string,
): ApprovalExecutor | undefined {
  return approvalExecutors(main, pool).find(entry => entry.executor.getPendingApprovalMeta(requestId) !== undefined)
}

/**
 * The executor holding ask `requestId`. Ask ids (`ask_<nanoid>`) are unique
 * across the agent; `loop`, when given, must name the asking loop (the daemon
 * REST body still accepts it).
 */
export function findAskHolder(
  main: AgentExecutor,
  pool: Pick<LoopPool, 'getRuntimes'> | null | undefined,
  requestId: string,
  loop?: string,
): ApprovalExecutor | undefined {
  return approvalExecutors(main, pool).find(entry =>
    (loop === undefined || entry.loop === loop) && entry.executor.getPendingAsks().some(ask => ask.requestId === requestId))
}
