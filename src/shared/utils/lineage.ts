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
    // Cascade, first-seen within each tier, never the file itself.
    let resolved: string | undefined
    for (const tier of [byCurrentDid, byHistoryDid, byAgentId]) {
      resolved = tier.get(ref)?.find((filePath) => filePath !== agent.filePath)
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

  return { parents, children, orphaned, roots, duplicateDids }
}
