import { hasLoopGoal, type LoopConfig } from '../../shared/types/adf-v02.types'

/**
 * The loop-strip tab menu's items for one inner loop, decided here so the
 * goal and enabled rules are tested apart from the component. There is no
 * Rename: a loop's stream is keyed by its name (adf_loop.loop), so a renamed
 * loop starts on an empty stream while the old one is archived or left behind
 * (loop_manage refuses renames for that reason).
 */
export interface LoopMenuState {
  toggleEnabled: { label: string; enabled: boolean }
  toggleAutostart: { label: string; autostart: boolean; disabledReason: string | null }
}

export function loopMenuState(loop: Pick<LoopConfig, 'enabled' | 'autostart' | 'goal'>): LoopMenuState {
  const autostart = loop.autostart === true
  // Turning autostart ON needs a goal (the schema refuses the pair) and an
  // enabled loop (the config card greys the box out otherwise). Turning it
  // OFF is always allowed, so a config written past the schema can be fixed.
  const disabledReason = autostart
    ? null
    : !loop.enabled
      ? 'Enable the loop first'
      : !hasLoopGoal(loop)
        ? 'Add a goal first'
        : null
  return {
    toggleEnabled: { label: loop.enabled ? 'Disable' : 'Enable', enabled: !loop.enabled },
    toggleAutostart: { label: autostart ? 'Turn autostart off' : 'Turn autostart on', autostart: !autostart, disabledReason },
  }
}

/**
 * What deleting `name` does to its stream. A config edit that drops a loop is
 * torn down by the running agent's loop pool (stop, archive to adf_audit as
 * `loop:<name>`, drop timers), exactly as `loop_manage delete`. With no agent
 * running there is no pool: the config entry goes and the stream rows stay in
 * adf_loop under that name, where a loop added later with the same name
 * reads them again.
 */
export function deleteLoopConsequence(name: string, agentRunning: boolean): string {
  return agentRunning
    ? `The loop stops and its stream is archived to the audit log as loop:${name}.`
    : `The agent is not running, so the stream is not archived. It stays in the agent file, and a loop added later as ${name} shows it again.`
}

/** `loops` with `name` patched; untouched when no loop has that name. */
export function patchLoopByName(loops: readonly LoopConfig[] | undefined, name: string, patch: Partial<LoopConfig>): LoopConfig[] {
  return (loops ?? []).map((l) => (l.name === name ? { ...l, ...patch, name } : l))
}

/** `loops` without `name`. */
export function removeLoopByName(loops: readonly LoopConfig[] | undefined, name: string): LoopConfig[] {
  return (loops ?? []).filter((l) => l.name !== name)
}
