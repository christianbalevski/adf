/**
 * Agent Registry
 *
 * Runtime-only mapping of agent IDs to filesystem paths.
 * Enables stable message addressing when agents move/rename.
 *
 * The registry is maintained by the runtime, not stored in ADFs.
 */

import type { AgentState, MessagingMode } from '../../shared/types/adf-v02.types'

// =============================================================================
// Types
// =============================================================================

export interface AgentRegistryEntry {
  /** 12-char unique agent ID */
  id: string
  /** Human-friendly name */
  name: string
  /** Filesystem path to the .adf file */
  filePath: string
  /** Agent description */
  description: string
  /** Agent power state */
  state: AgentState
  /** Messaging mode */
  mode: MessagingMode
}

export interface AgentDirectoryEntry {
  id: string
  name: string
  description: string
  /** false if mode is 'listen_only' */
  can_respond: boolean
}

// =============================================================================
// AgentRegistry Class
// =============================================================================

export class AgentRegistry {
  /** id -> entry */
  private entries: Map<string, AgentRegistryEntry> = new Map()
  /** filePath -> id */
  private pathIndex: Map<string, string> = new Map()
  /** name -> Set<id> (names can collide) */
  private nameIndex: Map<string, Set<string>> = new Map()

  // ===========================================================================
  // Registration
  // ===========================================================================

  /**
   * Register an agent in the registry.
   * Call when an ADF is opened or discovered.
   */
  register(entry: AgentRegistryEntry): void {
    // Unregister existing entry if ID already exists
    if (this.entries.has(entry.id)) {
      this.unregister(entry.id)
    }

    // Store entry
    this.entries.set(entry.id, entry)
    this.pathIndex.set(entry.filePath, entry.id)

    // Index by name
    const nameLower = entry.name.toLowerCase()
    if (!this.nameIndex.has(nameLower)) {
      this.nameIndex.set(nameLower, new Set())
    }
    this.nameIndex.get(nameLower)!.add(entry.id)
  }

  /**
   * Unregister an agent from the registry.
   * Call when an ADF is closed or deleted.
   */
  unregister(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return

    // Remove from path index
    this.pathIndex.delete(entry.filePath)

    // Remove from name index
    const nameLower = entry.name.toLowerCase()
    const nameSet = this.nameIndex.get(nameLower)
    if (nameSet) {
      nameSet.delete(id)
      if (nameSet.size === 0) {
        this.nameIndex.delete(nameLower)
      }
    }

    // Remove entry
    this.entries.delete(id)
  }

  /**
   * Update an existing entry (e.g., when config changes).
   */
  update(id: string, updates: Partial<Omit<AgentRegistryEntry, 'id'>>): void {
    const entry = this.entries.get(id)
    if (!entry) return

    // Handle name change
    if (updates.name && updates.name !== entry.name) {
      // Remove from old name index
      const oldNameLower = entry.name.toLowerCase()
      const oldSet = this.nameIndex.get(oldNameLower)
      if (oldSet) {
        oldSet.delete(id)
        if (oldSet.size === 0) {
          this.nameIndex.delete(oldNameLower)
        }
      }

      // Add to new name index
      const newNameLower = updates.name.toLowerCase()
      if (!this.nameIndex.has(newNameLower)) {
        this.nameIndex.set(newNameLower, new Set())
      }
      this.nameIndex.get(newNameLower)!.add(id)
    }

    // Handle path change
    if (updates.filePath && updates.filePath !== entry.filePath) {
      this.pathIndex.delete(entry.filePath)
      this.pathIndex.set(updates.filePath, id)
    }

    // Apply updates
    Object.assign(entry, updates)
  }

  // ===========================================================================
  // Resolution
  // ===========================================================================

  /**
   * Resolve a name or ID to an agent ID.
   *
   * Resolution rules (from spec):
   * - If input is 12 chars matching ID format, use it directly
   * - Otherwise, look up name (case-insensitive)
   * - If multiple agents have same name, returns first match
   * - Returns null if not found
   */
  resolveId(idOrName: string): string | null {
    // Check if it's already an ID (12 chars)
    if (idOrName.length === 12 && this.entries.has(idOrName)) {
      return idOrName
    }

    // Look up by name
    const nameLower = idOrName.toLowerCase()
    const ids = this.nameIndex.get(nameLower)
    if (ids && ids.size > 0) {
      // Return first match
      return ids.values().next().value!
    }

    return null
  }

  /**
   * Resolve an agent ID to its filesystem path.
   */
  resolvePath(id: string): string | null {
    return this.entries.get(id)?.filePath ?? null
  }

  /**
   * Get agent entry by filesystem path.
   */
  getByPath(filePath: string): AgentRegistryEntry | null {
    const id = this.pathIndex.get(filePath)
    if (!id) return null
    return this.entries.get(id) ?? null
  }

  /**
   * Get agent entry by ID.
   */
  getById(id: string): AgentRegistryEntry | null {
    return this.entries.get(id) ?? null
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get all registered agents.
   */
  getAll(): AgentRegistryEntry[] {
    return Array.from(this.entries.values())
  }

  /**
   * Get agent directory for list_agents tool output.
   */
  getDirectory(excludeId?: string): AgentDirectoryEntry[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.id !== excludeId)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        can_respond: entry.mode !== 'listen_only'
      }))
  }

  /**
   * Check if an ID is registered.
   */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * Get the number of registered agents.
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear()
    this.pathIndex.clear()
    this.nameIndex.clear()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/** Global agent registry instance */
export const agentRegistry = new AgentRegistry()
