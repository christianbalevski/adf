/**
 * Lineage resolution (ADF_IDENTITY_SPEC D4).
 *
 * `adf_parent_did` stores whatever the parent's canonical reference was at
 * spawn time — a DID, or a config.id for files written before identity keys
 * became mandatory. Parents rotate DIDs (claim, regenerate, reset), so a raw
 * reference is resolved at read time through a cascade:
 *
 *   current DID  →  DID history  →  legacy config.id
 *
 * Child files are never rewritten when a parent rotates; this cascade is the
 * only resolution mechanism.
 */

export interface LineageAgentRef {
  filePath: string
  /** Current DID (adf_did), if provisioned */
  did?: string
  /** Prior DIDs (adf_did_history), oldest first */
  didHistory?: string[]
  /** Local runtime handle (config.id) — legacy lineage fallback only */
  agentId?: string
  /** Raw parent reference (adf_parent_did) */
  parentDid?: string
  /** adf_created_at — tie-breaker among same-DID holders and for cycle breaking */
  createdAt?: string
}

export interface ResolvedLineage {
  /** child filePath → parent filePath, for every resolvable parent reference */
  parents: Map<string, string>
  /** parent filePath → child filePaths, insertion-ordered */
  children: Map<string, string[]>
  /** filePaths with a parent reference that no live agent matches */
  orphaned: string[]
  /** filePaths with no parent (no reference, or unresolvable) — tree roots */
  roots: string[]
  /** DID → filePaths, for any DID presented as current by more than one live file */
  duplicateDids: Map<string, string[]>
}

/**
 * Resolve parent references across a set of live agents.
 *
 * Precedence within the cascade: a current-DID match always wins over a
 * history match, which wins over a config.id match — a rotated-away DID may
 * legitimately coexist with a clone that recorded it in history.
 *
 * Ambiguity (two files presenting the same current DID — a same-owner file
 * copy) is reported in `duplicateDids`; the reference resolves to the
 * first-seen file so the tree stays drawable, but callers should surface the
 * duplicate loudly. A file is never its own parent: a candidate that is the
 * referencing file itself is skipped in favour of the next one (another file
 * with the same current DID — a kept-identity clone's source — then history,
 * then config.id); with no alternative the reference is unresolvable.
 *
 * Among several holders of a referenced DID, one that does not itself point
 * at that DID wins (the source over its sibling clones), then the earliest
 * `createdAt`, then first-seen. Cycles that survive the cascade (degenerate
 * data) are broken by orphaning the youngest member.
 */
export function resolveLineage(agents: LineageAgentRef[]): ResolvedLineage {
  const byCurrentDid = new Map<string, string[]>()
  const byHistoryDid = new Map<string, string[]>()
  const byAgentId = new Map<string, string[]>()
  const duplicateDids = new Map<string, string[]>()

  const add = (index: Map<string, string[]>, key: string, filePath: string) => {
    const list = index.get(key)
    if (list) list.push(filePath)
    else index.set(key, [filePath])
  }

  for (const agent of agents) {
    if (agent.did) add(byCurrentDid, agent.did, agent.filePath)
    for (const oldDid of agent.didHistory ?? []) add(byHistoryDid, oldDid, agent.filePath)
    if (agent.agentId) add(byAgentId, agent.agentId, agent.filePath)
  }
  for (const [did, files] of byCurrentDid) {
    if (files.length > 1) duplicateDids.set(did, [...files])
  }

  const byPath = new Map(agents.map((a) => [a.filePath, a]))
  const createdAt = (filePath: string): string => byPath.get(filePath)?.createdAt ?? ''

  // Best holder of `ref` for `agent`: not the file itself; not another clone
  // pointing at the same DID when a non-clone holder exists; then earliest
  // createdAt; then first-seen (index order, so the incumbent wins ties).
  const pick = (holders: string[] | undefined, agent: LineageAgentRef): string | undefined => {
    let best: string | undefined
    for (const filePath of holders ?? []) {
      if (filePath === agent.filePath) continue
      if (best === undefined) {
        best = filePath
        continue
      }
      const bestIsClone = byPath.get(best)?.parentDid === agent.parentDid
      const isClone = byPath.get(filePath)?.parentDid === agent.parentDid
      if (bestIsClone !== isClone) {
        if (!isClone) best = filePath
      } else if (createdAt(filePath) < createdAt(best)) {
        best = filePath
      }
    }
    return best
  }

  const parents = new Map<string, string>()
  const children = new Map<string, string[]>()
  const orphaned: string[] = []
  const roots: string[] = []

  for (const agent of agents) {
    const ref = agent.parentDid
    if (!ref) {
      roots.push(agent.filePath)
      continue
    }
    let resolved: string | undefined
    for (const tier of [byCurrentDid, byHistoryDid, byAgentId]) {
      resolved = pick(tier.get(ref), agent)
      if (resolved !== undefined) break
    }
    if (resolved === undefined) {
      orphaned.push(agent.filePath)
      roots.push(agent.filePath)
      continue
    }
    parents.set(agent.filePath, resolved)
    const siblings = children.get(resolved) ?? []
    siblings.push(agent.filePath)
    children.set(resolved, siblings)
  }

  // Self-references fall through to history, which can close a loop in
  // degenerate data. Break each cycle by orphaning its youngest member
  // (latest createdAt, tie → last-seen); every node then reaches a root.
  const index = new Map(agents.map((a, i) => [a.filePath, i]))
  const orphan = (filePath: string) => {
    const parent = parents.get(filePath)!
    parents.delete(filePath)
    const siblings = children.get(parent)!.filter((f) => f !== filePath)
    if (siblings.length > 0) children.set(parent, siblings)
    else children.delete(parent)
    orphaned.push(filePath)
    roots.push(filePath)
  }
  const settled = new Set<string>()
  for (const agent of agents) {
    const path: string[] = []
    let cur: string | undefined = agent.filePath
    while (cur !== undefined && !settled.has(cur) && !path.includes(cur)) {
      path.push(cur)
      cur = parents.get(cur)
    }
    if (cur !== undefined && path.includes(cur)) {
      const victim = path.slice(path.indexOf(cur)).reduce((a, b) => {
        const ca = createdAt(a)
        const cb = createdAt(b)
        return cb > ca || (cb === ca && index.get(b)! > index.get(a)!) ? b : a
      })
      orphan(victim)
    }
    for (const p of path) settled.add(p)
  }

  return { parents, children, orphaned, roots, duplicateDids }
}
