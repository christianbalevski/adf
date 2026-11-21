/**
 * How a skill package becomes ONE atomic batch, for every host (Studio's
 * renderer and the terminal app): the read protocol and the plan.
 *
 * - Read: fetch every resource as exact bytes (any failure ends it), list the
 *   agent's files, read the revision of each path the package writes that
 *   already exists (a read-only file is not read: it refuses).
 * - Plan: a path that exists goes over the revision read, every other path
 *   must not exist yet; SKILL.md goes last.
 * - Slot: `skills/<name>/` is occupied when ANY file is under it, decided here
 *   from these fresh reads. An occupied slot always needs the human's explicit
 *   confirmation, listing the files replaced and the files kept, even when
 *   nothing is overwritten.
 *
 * Bounds and preconditions are decided by the batch itself
 * (validateAtomicBatch inside AdfWorkspace.writeFilesAtomic). The protocol
 * stops early on the batch's own bounds (batchBoundsProblem). Each window
 * starts a few independent reads and consumes them in input order. Hosts
 * inject their I/O; the renderer's `checkpoint` stops the protocol when the
 * view it started in is gone.
 */

import type { FileProtectionLevel } from '../types/adf-v02.types'
import type { InternalFileBatchInput } from '../types/file-batch.types'
import { batchBoundsProblem } from './file-batch'

/** The slot a file occupies: `skills/<name>/…` is in slot `name`. */
export const slotOf = (path: string): string | null => /^skills\/([^/]+)\//.exec(path)?.[1] ?? null

/** One prepared package file, package-relative, as exact bytes. */
export interface PreparedPackageFile {
  path: string
  contentBase64: string
  size: number
}

/** What the agent has at a path the package writes: its protection and the revision read. */
export interface ExistingPackageFile {
  protection: FileProtectionLevel
  /** Revision of a read of the file; absent when it could not be read. */
  revision?: number
}

export type PackageWritePlan =
  | {
      ok: true
      name: string
      /** Resources first, SKILL.md last. */
      files: InternalFileBatchInput[]
      /** Paths under skills/<name>/ this install replaces. */
      replaces: string[]
      /** Paths already under skills/<name>/ the package does not ship: left exactly as they are. */
      keeps: string[]
      /** Any file is already under skills/<name>/: the install needs explicit confirmation. */
      occupied: boolean
    }
  | { ok: false; error: string }

/**
 * The batch an install writes. Every path that exists already carries the
 * revision it was read at (a later change by anyone refuses the whole batch),
 * every other path `mustNotExist`. A read-only file or an unreadable revision
 * refuses before anything is sent.
 */
export function planPackageWrite(
  name: string,
  manifest: string,
  resources: PreparedPackageFile[],
  existing: ReadonlyMap<string, ExistingPackageFile>,
  installedPaths: Iterable<string>,
): PackageWritePlan {
  const directory = `skills/${name}/`
  const files: InternalFileBatchInput[] = []
  const replaces: string[] = []
  const precondition = (path: string): { baseRevision: number } | { mustNotExist: true } | { error: string } => {
    const now = existing.get(path)
    if (!now) return { mustNotExist: true }
    if (now.protection === 'read_only') return { error: `${path} is read-only. Nothing was written.` }
    if (typeof now.revision !== 'number') return { error: `${path} exists and its revision could not be read. Nothing was written.` }
    replaces.push(path)
    return { baseRevision: now.revision }
  }
  for (const resource of resources) {
    const path = `${directory}${resource.path}`
    const expect = precondition(path)
    if ('error' in expect) return { ok: false, error: expect.error }
    files.push({ path, contentBase64: resource.contentBase64, ...expect })
  }
  const manifestPath = `${directory}SKILL.md`
  const expect = precondition(manifestPath)
  if ('error' in expect) return { ok: false, error: expect.error }
  files.push({ path: manifestPath, content: manifest, ...expect })
  const written = new Set(files.map((file) => file.path))
  const inSlot = [...installedPaths].filter((path) => slotOf(path) === name)
  const keeps = inSlot.filter((path) => !written.has(path)).sort()
  return { ok: true, name, files, replaces, keeps, occupied: inSlot.length > 0 }
}

/** The I/O a host gives the read protocol. */
export interface PackageIo {
  fetchBytes(url: string): Promise<{ ok: true; contentBase64: string; size: number } | { ok: false; error: string }>
  listFiles(): Promise<Array<{ path: string; protection: FileProtectionLevel }>>
  readRevision(path: string): Promise<number | undefined>
  /** Called after every await; a non-null answer stops the protocol with that error (nothing was written). */
  checkpoint?(): string | null
}

/** A resource to install: fetched from `raw_url`, or already in hand (a local package). */
export type PackageResource = { path: string; raw_url: string } | { path: string; contentBase64: string; size: number }

const READ_CONCURRENCY = 4

/** Start a bounded window and yield in order so failures and limits stay deterministic. */
async function* readPackageItems<Item, Value>(items: Item[], read: (item: Item) => Value | Promise<Value>) {
  for (let offset = 0; offset < items.length; offset += READ_CONCURRENCY) {
    const pending = items.slice(offset, offset + READ_CONCURRENCY).map(async (item) => {
      try {
        return { ok: true as const, item, value: await read(item) }
      } catch (error) {
        // A caller can stop partway through a window. Capture every rejection
        // immediately and report it only when its turn arrives.
        return { ok: false as const, error }
      }
    })
    for (const reading of pending) {
      const result = await reading
      if (!result.ok) throw result.error
      yield result
    }
  }
}

/** The read protocol, once: fetch, list, read revisions, plan. Nothing is written. */
export async function preparePackageWrite(io: PackageIo, name: string, manifest: string, resources: PackageResource[]): Promise<PackageWritePlan> {
  const stop = () => io.checkpoint?.() ?? null
  const tooLarge = (problem: string): PackageWritePlan => ({ ok: false, error: `The package is past what one install writes: ${problem}. Nothing was written.` })
  let total = new TextEncoder().encode(manifest).length
  const initialBounds = batchBoundsProblem(resources.length + 1, total)
  if (initialBounds) return tooLarge(initialBounds)

  const prepared: PreparedPackageFile[] = []
  const resourceReads = readPackageItems(resources, (resource) => (
    'raw_url' in resource ? io.fetchBytes(resource.raw_url) : { ok: true as const, ...resource }
  ))
  for await (const { item: resource, value: fetched } of resourceReads) {
    const stopped = stop()
    if (stopped) return { ok: false, error: stopped }
    if (!fetched.ok) return { ok: false, error: `${resource.path}: ${fetched.error || 'fetch failed'}. Nothing was written.` }
    total += fetched.size
    const over = batchBoundsProblem(0, total)
    if (over) return tooLarge(over)
    prepared.push({ path: resource.path, contentBase64: fetched.contentBase64, size: fetched.size })
  }
  const listed = await io.listFiles()
  const listStopped = stop()
  if (listStopped) return { ok: false, error: listStopped }
  const directory = `skills/${name}/`
  const targets = new Set([...prepared.map((r) => `${directory}${r.path}`), `${directory}SKILL.md`])
  const existing = new Map<string, ExistingPackageFile>()
  const revisionReads = readPackageItems(listed.filter((file) => targets.has(file.path)), (file) => (
    file.protection === 'read_only' ? undefined : io.readRevision(file.path)
  ))
  for await (const { item: file, value: revision } of revisionReads) {
    const stopped = stop()
    if (stopped) return { ok: false, error: stopped }
    existing.set(file.path, { protection: file.protection, ...(typeof revision === 'number' ? { revision } : {}) })
  }
  return planPackageWrite(name, manifest, prepared, existing, listed.map((f) => f.path))
}
