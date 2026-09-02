/**
 * Per-file async mutex, scoped per workspace (per agent) and per path.
 *
 * File edits/appends are read-modify-write, so two concurrent operations on the
 * same file (parallel loops, child agents, or a script + tool call) can clobber
 * each other. `withFileLock` serializes them: callers on the same
 * (workspace, path) run one at a time, in arrival order.
 *
 * Scope is keyed by the workspace instance via a WeakMap, so different agents'
 * files never share a lock and locks are GC'd with the workspace. NOT
 * re-entrant — never call withFileLock for the same (scope, path) inside its
 * own callback.
 *
 * A scope that exposes `getRoot()` is canonicalized through it first. Loops hand
 * tools a per-turn `AdfWorkspace.forLoop()` view — a distinct object over the
 * same .adf file — so keying by the raw instance would give every loop (and
 * every turn) its own lock and stop serializing writes to a shared file. The
 * root is one object per agent, which is exactly the intended scope.
 */
const locksByScope = new WeakMap<object, Map<string, Promise<unknown>>>()

/** Duck-typed so this module stays free of an adf/ import. */
function lockScopeKey(scope: object): object {
  const getRoot = (scope as { getRoot?: unknown }).getRoot
  if (typeof getRoot === 'function') {
    const root = (getRoot as () => unknown).call(scope)
    if (root && typeof root === 'object') return root as object
  }
  return scope
}

export async function withFileLock<T>(
  scope: object,
  path: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const key = lockScopeKey(scope)
  let locks = locksByScope.get(key)
  if (!locks) { locks = new Map(); locksByScope.set(key, locks) }

  const prior = locks.get(path) ?? Promise.resolve()
  // Run fn after the prior holder settles (regardless of its outcome).
  const run = prior.then(() => fn(), () => fn())
  // Next waiter chains on this run's completion; swallow the result/error here
  // so the chain never rejects (the real result/error flows through `run`).
  const tail = run.then(() => undefined, () => undefined)
  locks.set(path, tail)
  // Best-effort cleanup: when this is the last queued op, drop the map entry.
  void tail.then(() => { if (locks!.get(path) === tail) locks!.delete(path) })
  return run
}
