import {
  DEFAULT_NEW_LOOP_TOOLS,
  LOOP_PROHIBITED_TOOLS,
  MAX_SIDE_LOOPS,
  type LoopConfig,
  type ToolDeclaration
} from '../../shared/types/adf-v02.types'

/**
 * The first free `loop-N` name. `main` is always taken: it is the implicit
 * host loop and can never be declared.
 */
export function nextLoopName(taken: Iterable<string>): string {
  const names = new Set(taken)
  names.add('main')
  let n = 1
  while (names.has(`loop-${n}`)) n++
  return `loop-${n}`
}

/**
 * What a side loop can be granted from this host: enabled, not restricted
 * (HIL approval can't be routed to a side-loop executor), and not one of the
 * never-grantable names. Sorted, so the Loops card lists it stably.
 */
export function grantableLoopTools(tools: readonly ToolDeclaration[]): string[] {
  return tools
    .filter((t) => t.enabled && !t.restricted && !(LOOP_PROHIBITED_TOOLS as readonly string[]).includes(t.name))
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b))
}

/** Why no loop can be added right now, or null when one can. */
export function newLoopBlocker(loops: readonly LoopConfig[] | undefined): string | null {
  const count = loops?.length ?? 0
  return count >= MAX_SIDE_LOOPS
    ? `This agent has ${count} inner loops, the maximum (${MAX_SIDE_LOOPS}). Remove one to add another.`
    : null
}

/**
 * A blank loop, as both add controls create it: the next free name, enabled,
 * no goal, and autostart off (there is no goal to start on). Its tools are
 * the `DEFAULT_NEW_LOOP_TOOLS` seed, pre-ticked rather than implicit, filtered
 * by what the host can grant so the seed never names a tool the derive would
 * drop. Un-ticking them is how a mute loop is made.
 */
export function newLoop(loops: readonly LoopConfig[] | undefined, hostTools: readonly ToolDeclaration[]): LoopConfig {
  const grantable = grantableLoopTools(hostTools)
  const seeded = DEFAULT_NEW_LOOP_TOOLS.filter((t) => grantable.includes(t))
  return {
    name: nextLoopName((loops ?? []).map((l) => l.name)),
    enabled: true,
    autostart: false,
    ...(seeded.length > 0 && { tools: seeded })
  }
}
