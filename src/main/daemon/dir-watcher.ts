/**
 * Tracked-directory watcher and file push source for the daemon (design
 * daemon-backend.md §6 last row, W1-E). Studio's chokidar watcher
 * (ipc/index.ts startDirWatcher) without a window:
 *
 * - watches every tracked folder for `.adf` files appearing or vanishing and
 *   emits `tracked_dirs` {dirPath} for the tracked root they are under, which
 *   the client event stream (W2-B) turns into TRACKED_DIRS_CHANGED;
 * - autostarts a new file when its config says so, through the same gates as
 *   the boot scan (reviewed, not password-protected, not running here, not
 *   leased by another runtime: autostartTrackedFile);
 * - carries the file pushes the file routes raise (`tracked_dirs` after a
 *   create, clone, import or rename; `file_renamed`).
 *
 * Storm guards for large trees: the walk stops at maxDirectoryScanDepth and
 * skips dot folders and node_modules (as the autostart scan does); non-.adf
 * files are ignored; `tracked_dirs` is sent at most once per root per
 * debounce window; autostart runs a bounded queue with bounded concurrency,
 * and new files past the queue cap are not started (logged and announced as
 * `autostart_overflow`, never silent).
 *
 * Events (all synchronous EventEmitter events):
 * - `tracked_dirs`      TrackedDirsPush
 * - `file_renamed`      FileRenamedPush
 * - `autostart`         WatcherAutostartNotice (every outcome, including leased_elsewhere)
 * - `autostart_overflow` { dropped: number, queueLimit: number }
 */

import { EventEmitter } from 'node:events'
import { basename, resolve } from 'node:path'
import { watch as chokidarWatch, type ChokidarOptions } from 'chokidar'
import { canonicalizePath, containsPath } from '../utils/tracked-paths'
import { RuntimeGate } from '../runtime/runtime-gate'
import type { RuntimeService } from '../runtime/runtime-service'
import { autostartTrackedFile, maxDepthOf, storedDirs, type TrackedDirsSettings, type TrackedFileAutostart } from './tracked-dirs'

export interface TrackedDirsPush {
  /** The tracked root (as stored in settings) whose listing changed. */
  dirPath: string
}

export interface FileRenamedPush {
  oldPath: string
  newPath: string
}

export type WatcherAutostartNotice = TrackedFileAutostart & { source: 'watcher' }

/** The parts of a chokidar watcher this module uses (a fake in tests). */
export interface DirWatchHandle {
  on(event: 'add' | 'unlink', listener: (path: string) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  close(): Promise<void> | void
}

export type DirWatchFactory = (paths: string[], options: ChokidarOptions) => DirWatchHandle

export interface TrackedDirWatcherOptions {
  runtime: Pick<RuntimeService, 'listAgents' | 'loadAgent' | 'startAgent'>
  settings: TrackedDirsSettings
  /** Tell the live daemon about a changed tracked list (mesh tracked roots). */
  onTrackedDirectoriesChanged?: (dirs: string[]) => void
  /** false: push source only, no filesystem watch and no autostart (tests, bare servers). Default true. */
  watch?: boolean
  /** Injected watcher (tests). Default: chokidar. */
  watchFactory?: DirWatchFactory
  /** One `tracked_dirs` per root per window. Default 250 ms. */
  debounceMs?: number
  /** chokidar awaitWriteFinish stability threshold. Default 500 ms (Studio's). */
  stabilityMs?: number
  /** New files waiting for an autostart decision; more are dropped (announced). Default 100. */
  autostartQueueLimit?: number
  /** Autostart decisions in parallel. Default 2. */
  autostartConcurrency?: number
  /** Skip files a client holds open (open documents, W2-A). */
  isHeld?: (filePath: string) => boolean
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_STABILITY_MS = 500
const DEFAULT_QUEUE_LIMIT = 100
const DEFAULT_CONCURRENCY = 2

export class TrackedDirWatcher extends EventEmitter {
  private readonly opts: TrackedDirWatcherOptions
  private watcher: DirWatchHandle | null = null
  /** Tracked roots, as stored, with their canonical form. */
  private roots: Array<{ stored: string; canonical: string }> = []
  private rootsKey = ''
  private watchedDepth = -1
  /** Re-watches closing the old watch or opening the new one. */
  private watchPending = 0
  private readonly pendingRoots = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private active = 0
  private dropped = 0
  private closed = false
  private idleWaiters: Array<() => void> = []

  constructor(opts: TrackedDirWatcherOptions) {
    super()
    this.opts = opts
  }

  /** Begin watching the tracked folders in settings (idempotent). */
  start(): void {
    this.closed = false
    this.sync()
  }

  /** True while a filesystem watch is running. */
  isWatching(): boolean {
    return this.watcher !== null
  }

  /** The tracked roots this watcher knows, as stored in settings. */
  watchedRoots(): string[] {
    return this.roots.map(r => r.stored)
  }

  /**
   * Re-read settings.trackedDirectories. When the list changed: re-watch,
   * tell the live daemon (onTrackedDirectoriesChanged) and emit
   * `tracked_dirs` for each newly tracked root (Studio's notifyAdfFileCreated
   * does both when a create auto-tracks a folder). Cheap when nothing changed.
   * `announce: false` re-watches only: for changes whose writer already told
   * the daemon (POST/DELETE /tracked-dirs).
   */
  sync(opts: { announce?: boolean } = {}): string[] {
    const dirs = storedDirs(this.opts.settings)
    const roots = dirs.map(stored => {
      let canonical = resolve(stored)
      try { canonical = canonicalizePath(stored) } catch { /* keep resolved */ }
      return { stored, canonical }
    })
    const key = roots.map(r => r.canonical).join('\0')
    const depth = maxDepthOf(this.opts.settings)
    if (key === this.rootsKey && depth === this.watchedDepth && (this.watcher || this.watchPending > 0 || this.opts.watch === false || roots.length === 0 || this.closed)) {
      return dirs
    }
    const firstSync = this.watchedDepth === -1
    const before = new Set(this.roots.map(r => r.canonical))
    const listChanged = key !== this.rootsKey
    this.roots = roots
    this.rootsKey = key
    this.watchedDepth = depth
    if (!firstSync && listChanged && opts.announce !== false) {
      this.opts.onTrackedDirectoriesChanged?.(dirs)
      for (const root of roots) if (!before.has(root.canonical)) this.emitRoot(root.stored)
    }
    if (!this.closed) void this.rewatch(depth)
    return dirs
  }

  /**
   * Announce that the listing under `path`'s tracked root changed (a file
   * operation here, or the watcher). Coalesced per root. Paths outside every
   * tracked root are ignored, as in Studio.
   */
  notifyPathChanged(path: string): void {
    const root = this.rootFor(path)
    if (root) this.scheduleRoot(root)
  }

  /** `file_renamed` push (rename, accept-relocate). */
  notifyRenamed(oldPath: string, newPath: string): void {
    this.emit('file_renamed', { oldPath, newPath } satisfies FileRenamedPush)
  }

  /** Resolves when the autostart queue is empty and nothing is running (tests). */
  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.active === 0) return Promise.resolve()
    return new Promise(r => this.idleWaiters.push(r))
  }

  async close(): Promise<void> {
    this.closed = true
    for (const timer of this.pendingRoots.values()) clearTimeout(timer)
    this.pendingRoots.clear()
    this.queue.length = 0
    this.queued.clear()
    const watcher = this.watcher
    this.watcher = null
    this.watchedDepth = -1
    this.rootsKey = ''
    if (watcher) await watcher.close()
  }

  // --- internals ---------------------------------------------------------------

  private async rewatch(depth: number): Promise<void> {
    this.watchPending++
    try {
      await this.doRewatch(depth)
    } finally {
      this.watchPending--
    }
  }

  private async doRewatch(depth: number): Promise<void> {
    const previous = this.watcher
    this.watcher = null
    if (previous) {
      try { await previous.close() } catch (err) { console.warn('[DirWatcher] Closing the previous watch failed:', err) }
    }
    if (this.opts.watch === false || this.closed || this.roots.length === 0) return
    const factory = this.opts.watchFactory ?? ((paths, options) => chokidarWatch(paths, options) as unknown as DirWatchHandle)
    const paths = this.roots.map(r => r.canonical)
    let handle: DirWatchHandle
    try {
      handle = factory(paths, {
        ignoreInitial: true,
        // Same walk as the autostart scan: maxDirectoryScanDepth levels below the root.
        depth,
        // A new .adf is a SQLite file written in several steps; autostart peeks into it.
        awaitWriteFinish: { stabilityThreshold: this.opts.stabilityMs ?? DEFAULT_STABILITY_MS, pollInterval: 100 },
        ignored: (path: string, stats?: { isFile(): boolean }) => {
          const base = basename(path)
          if (base.startsWith('.') && base !== '.') return true
          if (base === 'node_modules') return true
          // Directories stay traversable; files other than .adf are never reported.
          return !!stats?.isFile() && !path.toLowerCase().endsWith('.adf')
        },
      })
    } catch (err) {
      console.error('[DirWatcher] Could not watch the tracked folders:', err)
      return
    }
    // A sync() during the await above started a newer watch: keep that one.
    if (this.closed || this.watcher) {
      try { await handle.close() } catch { /* ignore */ }
      return
    }
    this.watcher = handle
    handle.on('add', path => this.onAdd(path))
    handle.on('unlink', path => this.onUnlink(path))
    handle.on('error', err => console.warn('[DirWatcher] Watch error:', err))
    console.log(`[DirWatcher] Watching ${paths.length} tracked folder(s), depth ${depth}`)
  }

  private onAdd(path: string): void {
    if (!path.toLowerCase().endsWith('.adf')) return
    this.notifyPathChanged(path)
    this.enqueueAutostart(path)
  }

  private onUnlink(path: string): void {
    if (!path.toLowerCase().endsWith('.adf')) return
    this.notifyPathChanged(path)
  }

  /** The longest tracked root containing `path` (no filesystem calls: event paths are under the canonical roots). */
  private rootFor(path: string): string | null {
    const abs = resolve(path)
    const hit = this.longestRoot(abs)
    if (hit) return hit
    // A caller path spelled differently (symlink, 8.3 name, case): canonicalize and retry.
    try { return this.longestRoot(canonicalizePath(abs)) } catch { return null }
  }

  private longestRoot(abs: string): string | null {
    let best: { stored: string; canonical: string } | null = null
    for (const root of this.roots) {
      if (!containsPath(root.canonical, abs)) continue
      if (!best || root.canonical.length > best.canonical.length) best = root
    }
    return best?.stored ?? null
  }

  private scheduleRoot(root: string): void {
    if (this.pendingRoots.has(root)) return
    const timer = setTimeout(() => {
      this.pendingRoots.delete(root)
      this.emitRoot(root)
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    timer.unref?.()
    this.pendingRoots.set(root, timer)
  }

  private emitRoot(root: string): void {
    this.emit('tracked_dirs', { dirPath: root } satisfies TrackedDirsPush)
  }

  private enqueueAutostart(path: string): void {
    const key = resolve(path)
    if (this.queued.has(key)) return
    const limit = this.opts.autostartQueueLimit ?? DEFAULT_QUEUE_LIMIT
    if (this.queue.length >= limit) {
      this.dropped++
      if (this.dropped === 1) {
        // Once per burst; the count is reported when the queue drains.
        console.warn(`[DirWatcher] More than ${limit} new agent files arrived at once; autostart is skipped for the rest of this burst. Start them from the fleet, or with POST /agents/autostart.`)
      }
      return
    }
    this.queued.add(key)
    this.queue.push(key)
    this.pump()
  }

  private pump(): void {
    const concurrency = this.opts.autostartConcurrency ?? DEFAULT_CONCURRENCY
    while (this.active < concurrency && this.queue.length > 0 && !this.closed) {
      const filePath = this.queue.shift()!
      this.queued.delete(filePath)
      this.active++
      void this.autostartOne(filePath).finally(() => {
        this.active--
        this.pump()
      })
    }
    if (this.queue.length === 0 && this.active === 0) {
      if (this.dropped > 0) {
        const dropped = this.dropped
        this.dropped = 0
        console.warn(`[DirWatcher] Autostart skipped for ${dropped} new agent file(s) past the queue limit.`)
        this.emit('autostart_overflow', { dropped, queueLimit: this.opts.autostartQueueLimit ?? DEFAULT_QUEUE_LIMIT })
      }
      const waiters = this.idleWaiters.splice(0)
      for (const w of waiters) w()
    }
  }

  private async autostartOne(filePath: string): Promise<void> {
    if (this.opts.isHeld?.(filePath)) return
    if (RuntimeGate.stopped) {
      console.log(`[DirWatcher] ${basename(filePath)} appeared while the runtime is stopped (emergency stop); not autostarted.`)
      return
    }
    let result: TrackedFileAutostart
    try {
      result = await autostartTrackedFile(this.opts.runtime, this.opts.settings, filePath)
    } catch (err) {
      console.warn(`[DirWatcher] Autostart of ${basename(filePath)} failed:`, err)
      return
    }
    if (result.outcome === 'started') console.log(`[DirWatcher] Autostarted ${result.name} (${filePath})`)
    else if (result.outcome === 'failed') console.warn(`[DirWatcher] Autostart of ${result.name} failed: ${result.error}`)
    else if (result.reason === 'leased_elsewhere') console.warn(`[DirWatcher] Not autostarted: ${result.message}`)
    else if (result.reason !== 'not_autostart' && result.reason !== 'already_loaded') {
      console.log(`[DirWatcher] ${result.name} not autostarted: ${result.reason}`)
    }
    this.emit('autostart', { ...result, source: 'watcher' } satisfies WatcherAutostartNotice)
    // The fleet shows the outcome (a load error, leased elsewhere) on its next listing.
    if (result.outcome !== 'skipped' || result.reason === 'leased_elsewhere') this.notifyPathChanged(filePath)
  }
}
