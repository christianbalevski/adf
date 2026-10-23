import type { AgentConfig } from '../../shared/types/adf-v02.types'
import { MAIN_LOOP } from './derive-loop-config'
import type { AdfWorkspace } from './adf-workspace'

/**
 * Drop the timers that target a deleted loop, keeping locked ones.
 *
 * Never re-pointed at main: an orphan that fell back to main would run its
 * schedule with main's unattenuated authority (review B3). A lock is a
 * human-only assertion, so a locked timer stays (inert, since its loop is
 * gone) until a human unlocks it (review S2).
 */
export function dropTimersForLoop(workspace: AdfWorkspace, name: string): { dropped: number; kept: number } {
  let dropped = 0
  let kept = 0
  for (const timer of workspace.getTimers()) {
    if ((timer.loop ?? MAIN_LOOP) !== name) continue
    if (timer.locked) { kept++; continue }
    workspace.deleteTimer(timer.id)
    dropped++
  }
  return { dropped, kept }
}

/**
 * The teardown a running loop pool gives a loop removed by a config edit,
 * for a save that lands while no pool exists (the agent is stopped).
 *
 * Without it the removed loop's stream stayed in `adf_loop` under its name,
 * and the next loop created with that name (the + button reuses freed names)
 * inherited it. Same outcome as the pool's path: the stream is archived to
 * `adf_audit` under `loop:<name>` (forced, regardless of `audit.loop`) and
 * the loop's timers are dropped. A rename on the config card is a remove plus
 * an add, so it archives the old name's stream here too, exactly as it does
 * with the agent running.
 *
 * Callers must only use this when no pool is live for the workspace; with a
 * pool, reconcile owns the teardown and stops the loop before archiving.
 */
export async function teardownRemovedLoopsOffline(
  workspace: AdfWorkspace,
  previous: Pick<AgentConfig, 'loops'>,
  next: Pick<AgentConfig, 'loops'>
): Promise<string[]> {
  const kept = new Set((next.loops ?? []).map(l => l.name))
  const removed = (previous.loops ?? []).map(l => l.name).filter(name => name !== MAIN_LOOP && !kept.has(name))
  for (const name of removed) {
    const log = (level: string, event: string, message: string): void => {
      try { workspace.insertLog(level, 'loop', event, name, message) } catch { /* observability is never fatal */ }
    }
    try {
      const { archivedEntries } = await workspace.forLoop(name).clearLoop({ forceAudit: true })
      log('info', 'loop_torn_down', archivedEntries > 0
        ? `Loop "${name}" removed via config while the agent was stopped; ${archivedEntries} stream ${archivedEntries === 1 ? 'entry' : 'entries'} archived to adf_audit under "loop:${name}"`
        : `Loop "${name}" removed via config while the agent was stopped; its stream was empty, nothing to archive`)
      const timers = dropTimersForLoop(workspace, name)
      if (timers.dropped > 0) {
        log('info', 'loop_timers_dropped', `Dropped ${timers.dropped} timer(s) belonging to deleted loop "${name}" — orphaned timers are never re-pointed at main`)
      }
      if (timers.kept > 0) {
        log('warn', 'loop_timers_locked_kept', `Kept ${timers.kept} locked timer(s) belonging to deleted loop "${name}" — a lock is human-only and survives the loop; unlock or delete them in Studio`)
      }
    } catch (error) {
      console.error(`[LoopTeardown] Teardown of removed loop "${name}" failed:`, error)
      log('error', 'loop_teardown_failed',
        `Teardown of removed loop "${name}" failed; its stream may still be in adf_loop: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return removed
}
