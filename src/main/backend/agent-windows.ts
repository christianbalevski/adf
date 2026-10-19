/**
 * Agent windows (#149 step 1, docs/design/agent-windows.md): one window per
 * agent, saved on quit and reopened at the next launch.
 *
 * This file keeps the list and the rules; main/index.ts makes the
 * BrowserWindow and opens its client session (DaemonWindows.open). Daemon
 * mode only: Inside Studio stays one window.
 *
 * - **One window per agent.** Opening an agent that has a window focuses it.
 *   A window is matched by agent id, else by the file it shows now (its
 *   session's current file, which follows renames).
 * - **Saved list.** The client key `agentWindows`: `{runtime, windows:
 *   [{agentId, filePath, bounds}]}`, rewritten when a window opens, closes,
 *   moves or is resized. `freeze()` (quit) writes it once more and stops
 *   following closes, so the windows the quit closes stay in it.
 * - **Restore.** Each saved window whose agent still exists (same file,
 *   same agent id) reopens; the others are dropped. A list saved for another
 *   runtime (another connection) is not restored.
 */

export const AGENT_WINDOWS_KEY = 'agentWindows'

export interface WindowBounds { x: number; y: number; width: number; height: number }

export interface SavedAgentWindow {
  agentId: string | null
  filePath: string
  bounds?: WindowBounds
}

export interface SavedAgentWindows {
  runtime: string
  windows: SavedAgentWindow[]
}

/** The window as this file uses it (a BrowserWindow in main/index.ts; a fake in tests). */
export interface AgentWindowHandle {
  /** The window's webContents id. */
  readonly id: number
  focus(): void
  isMinimized(): boolean
  restore(): void
  isDestroyed(): boolean
  getBounds(): WindowBounds
  close(): void
}

export interface AgentWindowRequest {
  filePath: string
  agentId?: string | null
  /** The window title; default the file name without `.adf`. */
  name?: string
  bounds?: WindowBounds
}

export interface AgentWindowsDeps {
  /** Make the window and open its client session. `closed` and `moved` are its events. */
  create(request: { filePath: string; agentId: string | null; name: string; bounds?: WindowBounds }, events: { closed(): void; moved(): void }): AgentWindowHandle
  /** The agent the window shows now (its session's current file), or null before it opened one. */
  current(id: number): { filePath: string; agentId: string | null } | null
  samePath(a: string, b: string): boolean
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  /** The runtime the list is saved for (DaemonWindows.runtime). */
  runtime(): string
  /** Restore: the saved agent still exists. */
  exists(entry: SavedAgentWindow): Promise<boolean>
  log?: Pick<Console, 'log' | 'warn'>
  /** Moves and resizes are saved after this pause (default 500 ms). */
  saveDelayMs?: number
}

/** The window title for an agent file: its name without `.adf` (either separator: remote paths). */
export function agentWindowName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.toLowerCase().endsWith('.adf') ? base.slice(0, -4) : base
}

function isBounds(value: unknown): value is WindowBounds {
  const b = value as Partial<WindowBounds> | null
  return !!b && typeof b === 'object' && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n)) && b.width! > 0 && b.height! > 0
}

/** The saved windows for `runtime`; anything malformed, or saved for another runtime, is dropped. */
export function parseSavedAgentWindows(raw: unknown, runtime: string): SavedAgentWindow[] {
  const saved = raw as Partial<SavedAgentWindows> | null
  if (!saved || typeof saved !== 'object' || saved.runtime !== runtime || !Array.isArray(saved.windows)) return []
  const out: SavedAgentWindow[] = []
  for (const w of saved.windows as unknown[]) {
    const entry = w as Partial<SavedAgentWindow> | null
    if (!entry || typeof entry.filePath !== 'string' || !entry.filePath) continue
    out.push({
      agentId: typeof entry.agentId === 'string' ? entry.agentId : null,
      filePath: entry.filePath,
      ...(isBounds(entry.bounds) ? { bounds: { x: entry.bounds.x, y: entry.bounds.y, width: entry.bounds.width, height: entry.bounds.height } } : {}),
    })
  }
  return out
}

interface OpenWindow {
  handle: AgentWindowHandle
  /** As opened; `current` replaces them once the window's session has the file. */
  filePath: string
  agentId: string | null
  /** Closed by closeAll: stays in the saved list. */
  keep: boolean
}

export class AgentWindows {
  private readonly windows = new Map<number, OpenWindow>()
  private frozen = false
  private restoring = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly log: Pick<Console, 'log' | 'warn'>

  constructor(private readonly deps: AgentWindowsDeps) {
    this.log = deps.log ?? console
  }

  /** The agent a window shows: its session's file once known, else what it was opened for. */
  private shown(w: OpenWindow): { filePath: string; agentId: string | null } {
    const current = this.deps.current(w.handle.id)
    return current ? { filePath: current.filePath, agentId: current.agentId ?? w.agentId } : { filePath: w.filePath, agentId: w.agentId }
  }

  /** The window that shows this agent, or null. */
  find(filePath: string, agentId?: string | null): AgentWindowHandle | null {
    for (const w of this.windows.values()) {
      if (w.handle.isDestroyed()) continue
      const shown = this.shown(w)
      if ((agentId && shown.agentId === agentId) || this.deps.samePath(shown.filePath, filePath)) return w.handle
    }
    return null
  }

  /** Open in new window: focuses the agent's window when it has one. */
  open(request: AgentWindowRequest): { id: number; created: boolean } {
    const existing = this.find(request.filePath, request.agentId)
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return { id: existing.id, created: false }
    }
    const agentId = request.agentId ?? null
    let id = -1
    const handle = this.deps.create(
      { filePath: request.filePath, agentId, name: request.name || agentWindowName(request.filePath), ...(request.bounds ? { bounds: request.bounds } : {}) },
      {
        closed: () => {
          const w = this.windows.get(id)
          this.windows.delete(id)
          if (w && !w.keep) this.save()
        },
        moved: () => this.saveSoon(),
      },
    )
    id = handle.id
    this.windows.set(id, { handle, filePath: request.filePath, agentId, keep: false })
    this.log.log(`[AgentWindows] Opened a window for ${request.filePath}`)
    this.save()
    return { id, created: true }
  }

  /** The open agent windows, as saved. */
  list(): SavedAgentWindow[] {
    const out: SavedAgentWindow[] = []
    for (const w of this.windows.values()) {
      if (w.handle.isDestroyed()) continue
      const shown = this.shown(w)
      out.push({ agentId: shown.agentId, filePath: shown.filePath, bounds: w.handle.getBounds() })
    }
    return out
  }

  /** Write the list now (not while frozen or restoring). */
  save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (this.frozen || this.restoring) return
    this.deps.settings.set(AGENT_WINDOWS_KEY, { runtime: this.deps.runtime(), windows: this.list() } satisfies SavedAgentWindows)
  }

  private saveSoon(): void {
    if (this.frozen || this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save() }, this.deps.saveDelayMs ?? 500)
    this.saveTimer.unref?.()
  }

  /** Quit: the list as it is now is the one the next launch reopens. */
  freeze(): void {
    this.save()
    this.frozen = true
  }

  /**
   * The main window closed and Studio stays open (macOS): every agent window
   * closes and stays in the saved list; the main window reopens them.
   */
  closeAll(): void {
    this.save()
    for (const w of this.windows.values()) {
      w.keep = true
      if (!w.handle.isDestroyed()) w.handle.close()
    }
  }

  /**
   * Reopen the saved windows whose agent still exists; drop the others.
   * Windows already open are kept. Resolves with the counts.
   */
  async restore(): Promise<{ opened: number; skipped: number }> {
    if (this.frozen || this.restoring) return { opened: 0, skipped: 0 }
    const saved = parseSavedAgentWindows(this.deps.settings.get(AGENT_WINDOWS_KEY), this.deps.runtime())
    let opened = 0
    let skipped = 0
    this.restoring = true
    try {
      for (const entry of saved) {
        if (this.frozen) break
        if (this.find(entry.filePath, entry.agentId)) continue
        let exists = false
        try { exists = await this.deps.exists(entry) } catch (err) {
          this.log.warn(`[AgentWindows] Could not check ${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!exists) {
          skipped++
          this.log.log(`[AgentWindows] Not reopening the window of ${entry.filePath}: the agent no longer exists`)
          continue
        }
        if (this.frozen) break
        this.open({ filePath: entry.filePath, agentId: entry.agentId, ...(entry.bounds ? { bounds: entry.bounds } : {}) })
        opened++
      }
    } finally {
      this.restoring = false
    }
    if (saved.length > 0) {
      this.log.log(`[AgentWindows] Restored ${opened} agent window(s), ${skipped} skipped`)
      this.save()
    }
    return { opened, skipped }
  }
}
