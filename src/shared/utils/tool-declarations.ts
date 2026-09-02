/**
 * One shared reading of a config's `tools[]` array.
 *
 * Two enforcement points consume the same declarations — the executor (which
 * builds the LLM's tool schema and decides HIL) and `deriveLoopConfig` (which
 * decides what a side loop inherits). If they disagree about which declaration
 * a duplicated name resolves to, a config that declares a tool twice can make
 * derivation see "unrestricted" while the executor sees "restricted": the side
 * loop then gets the tool with no HIL while main is still gated. So the collapse
 * lives here, imported by both, and is never re-implemented.
 */

/** The subset of `ToolDeclaration` this collapse actually reads. */
export interface DedupableToolDeclaration {
  name: string
  restricted?: boolean
  locked?: boolean
}

/**
 * Collapse duplicate `tools[]` entries to exactly one declaration per name.
 *
 * Semantics: the FIRST declaration wins for every field, and `restricted` /
 * `locked` are sticky-true — a later duplicate may RAISE a guard but can never
 * lower one. A last-wins `new Map(decls.map(d => [d.name, d]))` would let a
 * config that appended `{ name: 'sys_update_config', restricted: false }`
 * shadow the restricted original: an agent editing its own config could
 * de-restrict itself. Configs with one declaration per name are unaffected.
 */
export function dedupeToolDeclarations<T extends DedupableToolDeclaration>(
  declarations: T[]
): { deduped: T[]; duplicateNames: string[] } {
  const byName = new Map<string, T>()
  const duplicateNames = new Set<string>()
  for (const decl of declarations) {
    const existing = byName.get(decl.name)
    if (!existing) {
      byName.set(decl.name, decl)
      continue
    }
    duplicateNames.add(decl.name)
    if (decl.restricted === true || decl.locked === true) {
      byName.set(decl.name, {
        ...existing,
        ...(decl.restricted === true ? { restricted: true } : {}),
        ...(decl.locked === true ? { locked: true } : {}),
      })
    }
  }
  return { deduped: [...byName.values()], duplicateNames: [...duplicateNames] }
}
