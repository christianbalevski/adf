/**
 * Per-agent state behind file references (`file_ref` blocks, see
 * src/shared/utils/file-ref.ts): which paths the transcript references, the
 * live sessions that hold references in memory, and the loaded media bytes.
 *
 * One registry per .adf file, shared by every connection to it in this
 * process (the foreground workspace and a background agent can each hold one),
 * so a rename through one connection reaches the sessions of the other. An
 * in-memory database has its own registry.
 */

import type { ContentBlock } from '../../shared/types/provider.types'
import { isFileRefBlock, type FileRefChange } from '../../shared/utils/file-ref'

export type { FileRefChange } from '../../shared/utils/file-ref'

/** Something that keeps references in memory (a live AgentSession). */
export interface FileRefHolder {
  applyFileRefChanges(changes: readonly FileRefChange[]): void
}

/** A file's bytes as a request carries them. */
export interface MediaPayload {
  mime: string
  /** File size in bytes. */
  size: number
  /** `data:` URI (image, video) or bare base64 (audio). */
  payload: string
}

/**
 * Loaded media, least recently used first. Bounded by payload characters so
 * an agent with many large files cannot grow the heap without limit; a miss
 * costs one read of the file.
 */
export class MediaPayloadCache {
  private entries = new Map<string, MediaPayload>()
  private chars = 0

  constructor(private readonly maxChars: number) {}

  get(path: string): MediaPayload | undefined {
    const entry = this.entries.get(path)
    if (!entry) return undefined
    this.entries.delete(path)
    this.entries.set(path, entry)
    return entry
  }

  set(path: string, entry: MediaPayload): void {
    this.delete(path)
    if (entry.payload.length > this.maxChars) return
    this.entries.set(path, entry)
    this.chars += entry.payload.length
    for (const [oldest, value] of this.entries) {
      if (this.chars <= this.maxChars) break
      this.entries.delete(oldest)
      this.chars -= value.payload.length
    }
  }

  delete(path: string): void {
    const entry = this.entries.get(path)
    if (!entry) return
    this.entries.delete(path)
    this.chars -= entry.payload.length
  }

  clear(): void {
    this.entries.clear()
    this.chars = 0
  }

  get size(): number {
    return this.entries.size
  }
}

/** Characters of loaded media kept per agent (base64 is 4/3 of the bytes). */
export const MEDIA_CACHE_MAX_CHARS = 48 * 1024 * 1024

export class FileRefRegistry {
  /**
   * Paths some transcript row references. Null until first needed: built by
   * one scan of adf_loop, then kept current by every loop write. May hold
   * paths whose rows are gone (cleared, compacted); that only costs a scan.
   */
  referenced: Set<string> | null = null
  readonly media = new MediaPayloadCache(MEDIA_CACHE_MAX_CHARS)
  /** Bumped when a file a request has carried changes, so resolved requests rebuild. */
  generation = 0
  /** Paths a request has carried. */
  readonly resolved = new Set<string>()
  private holders = new Set<WeakRef<FileRefHolder>>()

  addHolder(holder: FileRefHolder): void {
    this.holders.add(new WeakRef(holder))
  }

  /** Record the references in a loop row just written. */
  noteContent(content: readonly ContentBlock[]): void {
    if (!this.referenced) return
    for (const block of content) {
      if (isFileRefBlock(block) && !block.file_ref.deleted) this.referenced.add(block.file_ref.path)
    }
  }

  /** Whether any of these changes names a referenced path (`referenced` must be built). */
  affects(changes: readonly FileRefChange[]): boolean {
    const referenced = this.referenced
    if (!referenced) return true
    return changes.some(change => referenced.has(change.op === 'rename' ? change.from : change.path))
  }

  /** Keep `referenced` current after the rows were rewritten. */
  noteChanges(changes: readonly FileRefChange[]): void {
    const referenced = this.referenced
    if (!referenced) return
    for (const change of changes) {
      if (change.op !== 'rename' || !referenced.has(change.from)) continue
      referenced.delete(change.from)
      referenced.add(change.to)
    }
  }

  /** Rewrite the references every live session holds. */
  notifyHolders(changes: readonly FileRefChange[]): void {
    for (const ref of this.holders) {
      const holder = ref.deref()
      if (!holder) {
        this.holders.delete(ref)
        continue
      }
      try {
        holder.applyFileRefChanges(changes)
      } catch (error) {
        console.error('[FileRefRegistry] A session could not apply a file change:', error)
      }
    }
  }

  /** A file was written, renamed or deleted: its loaded bytes are stale. */
  invalidate(path: string): void {
    this.media.delete(path)
    if (this.resolved.has(path)) this.generation++
  }
}

const byFile = new Map<string, FileRefRegistry>()
const byDatabase = new WeakMap<object, FileRefRegistry>()

/**
 * The registry of one database: shared by every connection to the same file
 * (`canonicalPath`), or private to `database` when it has no file (`null`).
 */
export function fileRefRegistry(database: object, canonicalPath: string | null): FileRefRegistry {
  if (canonicalPath === null) {
    let registry = byDatabase.get(database)
    if (!registry) {
      registry = new FileRefRegistry()
      byDatabase.set(database, registry)
    }
    return registry
  }
  let registry = byFile.get(canonicalPath)
  if (!registry) {
    registry = new FileRefRegistry()
    byFile.set(canonicalPath, registry)
  }
  return registry
}
