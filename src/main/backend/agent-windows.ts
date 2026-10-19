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
 *   [{agentId, filePath, bounds}]}`. It holds the open windows plus the
 *   saved windows not reopened yet (`carried`): a launch whose restore has
 *   not run, an entry whose check failed for a reason other than "gone", and
 *   the windows macOS closed with the main window. So no write ever drops a
 *   window that is still to reopen. It is rewritten when a window opens,
 *   closes, moves or is resized; `freeze()` (quit) writes it once more and
 *   stops following closes.
 * - **Restore.** Each carried window whose agent is still there (same file,
 *   same agent id) reopens, without taking focus. One whose file is gone,
 *   is not an agent, or holds another agent is dropped. Any other failure
 *   keeps it saved and skips it this time. A list saved for another runtime
 *   (another connection) is not restored and not kept.
 * - **A window that never opened its agent** (the open failed and the owner
 *   did not retry) is not saved.
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

/** A saved agent at restore: `open`, `gone` (dropped), or `unknown` (kept, not opened this time). */
export type SavedAgentCheck = 'open' | 'gone' | 'unknown'

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
  /**
   * Make the window and open its client session. `closed` and `moved` are
   * its events; `restored`: a window the launch reopens, shown without
   * taking focus.
   */
  create(request: { filePath: string; agentId: string | null; name: string; bounds?: WindowBounds; restored: boolean }, events: { closed(): void; moved(): void }): AgentWindowHandle
  /** The agent the window shows now (its session's current file), or null before it opened one. */
  current(id: number): { filePath: string; agentId: string | null } | null
  samePath(a: string, b: string): boolean
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  /** The runtime the list is saved for (DaemonWindows.runtime). */
  runtime(): string
  /** Restore: is the saved agent still there? */
  check(entry: SavedAgentWindow): Promise<SavedAgentCheck>
  log?: Pick<Console, 'log' | 'warn'>
  /** Moves and resizes are saved after this pause (default 500 ms). */
  saveDelayMs?: number
}

/** The window title for an agent file: its name without `.adf` (either separator: remote paths). */
export function agentWindowName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.toLowerCase().endsWith('.adf') ? base.slice(0, -4) : base
}

/**
 * Restore's check of one saved agent through `read` (GET /files/agent/config):
 * `gone` only when the daemon says the file is missing or not an agent, or
 * it holds another agent; any other failure (the daemon away, a timeout, a
 * file it could not read) is `unknown`.
 */
export async function checkSavedAgent(entry: SavedAgentWindow, read: (filePath: string) => Promise<{ agentId: string | null }>): Promise<SavedAgentCheck> {
  try {
    const found = await read(entry.filePath)
    return !entry.agentId || found.agentId === entry.agentId ? 'open' : 'gone'
  } catch (err) {
    const code = (err as { body?: { code?: unknown } | null } | null)?.body?.code
    return code === 'not_found' || code === 'not_an_adf' ? 'gone' : 'unknown'
  }
}

/** Height of the title strip a window is dragged by. */
const TITLE_STRIP = 40
/** How much of the title strip must be on a display for saved bounds to be used. */
const VISIBLE_TITLE = 100

/**
 * Saved bounds are used only when at least 100 px (or the whole width, if
 * narrower) of the window's title strip lies on one display's work area, so
 * the window can be grabbed; otherwise the window opens at its saved size
 * where the system puts it.
 */
export function titleStripVisible(bounds: WindowBounds, workAreas: readonly WindowBounds[]): boolean {
  const need = Math.min(VISIBLE_TITLE, bounds.width)
  return workAreas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const h = Math.min(bounds.y + TITLE_STRIP, a.y + a.height) - Math.max(bounds.y, a.y)
    return w >= need && h >= TITLE_STRIP / 2
  })
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
  /** Its session has had the agent open at least once. */
  opened: boolean
  /** The open failed and was not retried: not saved. */
  failed: boolean
  /** Closed by closeAll: carried, not dropped. */
  keep: boolean
}

export class AgentWindows {
  private readonly windows = new Map<number, OpenWindow>()
  /** Saved windows still to reopen; null until first read from the settings. */
  private carriedList: SavedAgentWindow[] | null = null
  private frozen = false
  /** Bumped by closeAll and freeze: a restore in flight stops opening windows. */
  private restoreGeneration = 0
  private restoring: Promise<{ opened: number; skipped: number }> | null = null
  private restoringGeneration = -1
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly log: Pick<Console, 'log' | 'warn'>

  constructor(private readonly deps: AgentWindowsDeps) {
    this.log = deps.log ?? console
  }

  private get carried(): SavedAgentWindow[] {
    this.carriedList ??= parseSavedAgentWindows(this.deps.settings.get(AGENT_WINDOWS_KEY), this.deps.runtime())
    return this.carriedList
  }

  private matches(entry: { filePath: string; agentId: string | null }, filePath: string, agentId?: string | null): boolean {
    return (!!agentId && entry.agentId === agentId) || this.deps.samePath(entry.filePath, filePath)
  }

  /** The agent a window shows: its session's file once known, else what it was opened for. */
  private shown(w: OpenWindow): { filePath: string; agentId: string | null } {
    const current = this.deps.current(w.handle.id)
    if (current) {
      w.opened = true
      w.failed = false
      return { filePath: current.filePath, agentId: current.agentId ?? w.agentId }
    }
    return { filePath: w.filePath, agentId: w.agentId }
  }

  /** The window that shows this agent, or null. */
  find(filePath: string, agentId?: string | null): AgentWindowHandle | null {
    for (const w of this.windows.values()) {
      if (w.handle.isDestroyed()) continue
      if (this.matches(this.shown(w), filePath, agentId)) return w.handle
    }
    return null
  }

  /** Open in new window: focuses the agent's window when it has one. */
  open(request: AgentWindowRequest): { id: number; created: boolean } {
    return this.openWindow(request, false)
  }

  private openWindow(request: AgentWindowRequest, restored: boolean): { id: number; created: boolean } {
    const existing = this.find(request.filePath, request.agentId)
    if (existing) {
      if (!restored) {
        if (existing.isMinimized()) existing.restore()
        existing.focus()
      }
      return { id: existing.id, created: false }
    }
    const agentId = request.agentId ?? null
    // Opened now: it is no longer one to reopen.
    this.carriedList = this.carried.filter((e) => !this.matches(e, request.filePath, agentId))
    let id = -1
    const handle = this.deps.create(
      { filePath: request.filePath, agentId, name: request.name || agentWindowName(request.filePath), ...(request.bounds ? { bounds: request.bounds } : {}), restored },
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
    this.windows.set(id, { handle, filePath: request.filePath, agentId, opened: false, failed: false, keep: false })
    this.log.log(`[AgentWindows] Opened a window for ${request.filePath}`)
    this.save()
    return { id, created: true }
  }

  /** The window could not open its agent (WINDOW_OPEN_FAILED): it is not saved until it does. */
  openFailed(id: number): void {
    const w = this.windows.get(id)
    if (!w || w.opened) return
    w.failed = true
    this.save()
  }

  /** The open agent windows, as saved (a window whose open failed is left out). */
  list(): SavedAgentWindow[] {
    const out: SavedAgentWindow[] = []
    for (const w of this.windows.values()) {
      if (w.handle.isDestroyed()) continue
      const shown = this.shown(w)
      if (w.failed) continue
      out.push({ agentId: shown.agentId, filePath: shown.filePath, bounds: w.handle.getBounds() })
    }
    return out
  }

  /** The webContents id is an agent window's. */
  has(id: number): boolean {
    return this.windows.has(id)
  }

  /** How many agent windows are open. */
  get count(): number {
    return [...this.windows.values()].filter((w) => !w.handle.isDestroyed()).length
  }

  /** Write the list now: the open windows, then the ones still to reopen. Not after a quit started. */
  save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (this.frozen) return
    const open = this.list()
    const carried = this.carried.filter((e) => !open.some((o) => this.matches(o, e.filePath, e.agentId)))
    this.deps.settings.set(AGENT_WINDOWS_KEY, { runtime: this.deps.runtime(), windows: [...open, ...carried] } satisfies SavedAgentWindows)
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
    this.restoreGeneration++
  }

  /**
   * The main window closed and Studio stays open (macOS): every agent window
   * closes and is carried; a restore in flight stops. The main window
   * reopens them.
   */
  closeAll(): void {
    this.restoreGeneration++
    const open = this.list()
    this.carriedList = [...open, ...this.carried.filter((e) => !open.some((o) => this.matches(o, e.filePath, e.agentId)))]
    for (const w of this.windows.values()) {
      w.keep = true
      if (!w.handle.isDestroyed()) w.handle.close()
    }
    this.save()
  }

  /**
   * Reopen the carried windows: `open` ones reopen, `gone` ones are
   * dropped, `unknown` ones stay saved for the next time. Windows already
   * open are kept. Resolves with the counts.
   */
  restore(): Promise<{ opened: number; skipped: number }> {
    // One at a time; a restore that closeAll stopped is replaced by a new one.
    if (this.restoring && this.restoringGeneration === this.restoreGeneration) return this.restoring
    const run = this.restoreNow()
    this.restoring = run
    void run.finally(() => { if (this.restoring === run) this.restoring = null })
    return run
  }

  private async restoreNow(): Promise<{ opened: number; skipped: number }> {
    if (this.frozen) return { opened: 0, skipped: 0 }
    const generation = ++this.restoreGeneration
    this.restoringGeneration = generation
    const live = () => generation === this.restoreGeneration && !this.frozen
    let opened = 0
    let skipped = 0
    for (const entry of [...this.carried]) {
      if (!live()) break
      if (this.find(entry.filePath, entry.agentId)) {
        this.carriedList = this.carried.filter((e) => e !== entry)
        continue
      }
      let found: SavedAgentCheck = 'unknown'
      try { found = await this.deps.check(entry) } catch (err) {
        this.log.warn(`[AgentWindows] Could not check ${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!live()) break
      if (found === 'gone') {
        skipped++
        this.carriedList = this.carried.filter((e) => e !== entry)
        this.log.log(`[AgentWindows] Not reopening the window of ${entry.filePath}: the agent is no longer there`)
        continue
      }
      if (found === 'unknown') {
        skipped++
        this.log.log(`[AgentWindows] Not reopening the window of ${entry.filePath} this time: it could not be checked; it stays saved`)
        continue
      }
      this.openWindow({ filePath: entry.filePath, agentId: entry.agentId, ...(entry.bounds ? { bounds: entry.bounds } : {}) }, true)
      opened++
    }
    if (opened + skipped > 0) {
      this.log.log(`[AgentWindows] Restored ${opened} agent window(s), ${skipped} skipped`)
      this.save()
    }
    return { opened, skipped }
  }
}
