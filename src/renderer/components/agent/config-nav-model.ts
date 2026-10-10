/**
 * The config panel's quick nav: which group each section sits in, and the
 * filtered, grouped list the jump menu shows. Sections are keyed by their
 * header title, the same key `pendingConfigSection` jumps by.
 */

export const CONFIG_NAV_GROUPS: ReadonlyArray<{ name: string; sections: readonly string[] }> = [
  { name: 'Base', sections: ['Identity', 'Model', 'Instructions', 'Context'] },
  { name: 'Capabilities', sections: ['Tools', 'Loops', 'Code Execution', 'Compute', 'MCP Servers'] },
  { name: 'Communication', sections: ['Channels', 'Messaging', 'Security', 'Serving', 'WebSocket Connections', 'Stream Bindings'] },
  { name: 'Automation', sections: ['Triggers', 'Hooks', 'Umbilical Taps'] },
  { name: 'Records', sections: ['Logging', 'Metadata', 'Meta Keys'] }
]

export function configNavGroupOf(title: string): string | null {
  return CONFIG_NAV_GROUPS.find((g) => g.sections.includes(title))?.name ?? null
}

export interface ConfigNavItem {
  title: string
  group: string
}

/**
 * The sections present on the page, in group order, narrowed by `query`.
 * A query matches a section's title or its group's name, case-insensitively,
 * so "comm" lists the whole Communication group. Sections without a group
 * are listed last under "Other" so a new section is never unreachable.
 */
export function configNavItems(present: readonly string[], query = ''): ConfigNavItem[] {
  const q = query.trim().toLowerCase()
  const has = new Set(present)
  const out: ConfigNavItem[] = []
  for (const g of CONFIG_NAV_GROUPS) {
    for (const title of g.sections) {
      if (has.has(title)) out.push({ title, group: g.name })
    }
  }
  for (const title of present) {
    if (!configNavGroupOf(title)) out.push({ title, group: 'Other' })
  }
  if (!q) return out
  return out.filter((i) => i.title.toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
}
