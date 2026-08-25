import { create } from 'zustand'
import { MCP_REGISTRY, BUNDLED_REGISTRY_UPDATED_AT } from '../../shared/constants/mcp-registry'
import type { McpRegistryEntry } from '../../shared/constants/mcp-registry'

/**
 * Curated MCP registry as the renderer currently knows it.
 *
 * Initialized SYNCHRONOUSLY from the bundled document so the quick-add grid
 * never flashes empty, then refreshed from the main process (which fetches
 * the live registry from GitHub raw with a cached fallback) when the MCP
 * settings surface mounts.
 */
interface McpRegistryState {
  entries: McpRegistryEntry[]
  source: 'remote' | 'cache' | 'bundled'
  /** The registry document's own `updatedAt` stamp. */
  updatedAt?: string

  /** Replace the bundled snapshot with the main process's remote-first view. */
  refresh: () => Promise<void>
}

export const useMcpRegistryStore = create<McpRegistryState>((set) => ({
  entries: MCP_REGISTRY,
  source: 'bundled',
  updatedAt: BUNDLED_REGISTRY_UPDATED_AT,

  refresh: async () => {
    try {
      const result = await window.adfApi?.getMcpRegistry?.()
      // An empty entry list never replaces a working one — the bundled copy
      // is always non-empty, so keep whatever we have on a degenerate result.
      if (result && result.entries.length > 0) {
        set({ entries: result.entries, source: result.source, updatedAt: result.updatedAt })
      }
    } catch {
      // Bundled/previous entries stay in place — refresh is best-effort.
    }
  }
}))
