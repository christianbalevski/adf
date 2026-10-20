import { LOCAL_RUNTIME, type RuntimeId } from '../runtime-tag'

/**
 * An agent of one runtime (docs/design/multi-runtime.md §1.3, §5.2): the
 * runtime it lives on, its id when known, and its file path on that runtime.
 *
 * Shared by main and the renderer; no Electron, no Node.
 */
export interface AgentRef {
  runtimeId: RuntimeId
  agentId: string | null
  filePath: string
}

/** The runtime of a ref-like value: `local` when it names none. */
export function refRuntime(ref: { runtimeId?: RuntimeId | null } | null | undefined): RuntimeId {
  return ref?.runtimeId || LOCAL_RUNTIME
}

/** The separator of a key of another runtime. A runtime id and a file path never hold a newline. */
const KEY_SEPARATOR = '\n'

/**
 * The key of an agent in a map or list that was keyed by file path
 * (§5.2): the path itself on This computer, so every local map, saved list
 * and client key keeps its bytes; `<runtime id>\n<path>` on any other
 * runtime, so equal paths on two runtimes never share a key. A path is
 * compared only within its runtime.
 */
export function agentKey(ref: { runtimeId?: RuntimeId | null; filePath: string }): string {
  const runtimeId = refRuntime(ref)
  return runtimeId === LOCAL_RUNTIME ? ref.filePath : `${runtimeId}${KEY_SEPARATOR}${ref.filePath}`
}

/** The runtime and path of an agent key (agentKey's inverse). */
export function parseAgentKey(key: string): { runtimeId: RuntimeId; filePath: string } {
  const at = key.indexOf(KEY_SEPARATOR)
  return at < 0 ? { runtimeId: LOCAL_RUNTIME, filePath: key } : { runtimeId: key.slice(0, at), filePath: key.slice(at + 1) }
}

/** The key names an agent of a runtime other than This computer. */
export function isRemoteAgentKey(key: string): boolean {
  return key.includes(KEY_SEPARATOR)
}

/**
 * §1.3: two refs name the same agent when their runtimes are equal and their
 * agent ids are equal; when either id is null, when their paths are equal
 * under that runtime's rule (`samePath`).
 */
export function sameAgent(
  a: { runtimeId?: RuntimeId | null; agentId?: string | null; filePath: string },
  b: { runtimeId?: RuntimeId | null; agentId?: string | null; filePath: string },
  samePath: (x: string, y: string, runtimeId: RuntimeId) => boolean = (x, y) => x === y,
): boolean {
  const runtimeId = refRuntime(a)
  if (runtimeId !== refRuntime(b)) return false
  if (a.agentId && b.agentId) return a.agentId === b.agentId
  return samePath(a.filePath, b.filePath, runtimeId)
}
