import type { AdfWorkspace } from '../adf/adf-workspace'
import type { ToolResult } from '../../shared/types/tool.types'

/** The `on_task_complete` feed both task runners report to. */
export type TaskCompletedFn = (
  taskId: string, tool: string, status: string, result?: string, error?: string, sideEffects?: { endTurn?: boolean },
) => void

/**
 * Run an `adf_tasks` row's tool call to its end — the one path every `_async`
 * run takes. Marks the task running, hands `run` the signal cancelTask aborts,
 * then writes and reports the outcome exactly once. A cancelled task keeps its
 * `cancelled` row and reports `cancelled`, whatever the run returned; a run
 * stopped with its agent reports nothing.
 *
 * `run` returns null when it parked the task itself (a protection denial now
 * awaiting approval): nothing is written or reported. Nothing runs when the
 * task could not start (cancelled before it ran). Read the row for the outcome.
 *
 * `report` is called at the end, so pass a thunk that reads the owner's
 * current callback: teardown clears it to silence runs that settle later.
 */
export async function runTask(
  workspace: AdfWorkspace,
  taskId: string,
  tool: string,
  report: TaskCompletedFn,
  run: (signal: AbortSignal) => Promise<ToolResult | null>,
): Promise<void> {
  const signal = workspace.startTaskRun(taskId)
  if (!signal) return
  let result: ToolResult | null
  let tracked = false
  try {
    result = await run(signal)
  } catch (err) {
    result = { content: err instanceof Error ? err.message : String(err), isError: true }
  } finally {
    tracked = workspace.endTaskRun(taskId, signal)
  }
  if (!signal.aborted) {
    if (result === null) return
    const [status, value, error] = result.isError
      ? ['failed', undefined, result.content] as const
      : ['completed', result.content, undefined] as const
    // Refused when the row was cancelled meanwhile: cancelled is final.
    if (workspace.updateTaskStatus(taskId, status, value, error)) {
      report(taskId, tool, status, value, error, result.endTurn ? { endTurn: true } : undefined)
      return
    }
  }
  // Aborted. A cancel keeps the run tracked; the agent stopping
  // (abortTaskRuns) drops it and has already written the row, and with the
  // agent off there is nothing to report to.
  if (tracked) report(taskId, tool, 'cancelled')
}
