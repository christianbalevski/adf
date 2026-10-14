/**
 * File-level operations on agent files for the daemon API (W1-E): Studio's
 * FILE_DELETE, FILE_RENAME, FILE_CLONE, FILE_SHARE_*, the accept-relocate
 * step (persistAcceptedAgent) and the transfers remote mode needs (export,
 * import, a daemon-side folder browser). Routes: routes/file-routes.ts.
 *
 * Path rules. Every agent file argument is an absolute path ending in `.adf`
 * (no NUL), canonicalized (realpath) before use; nothing here reads or
 * writes a host file that is not an `.adf` or its own `-wal`/`-shm`
 * sidecars and `.partial` work files. New names are validated as file names
 * (no separators), so a rename or import stays in the directory it names.
 * The token already lets a caller load any `.adf` (POST /agents/load), so
 * any `.adf` path is accepted; imports land only in tracked folders or the
 * agents folder; /fs/browse is confined to its roots (browseRoots).
 *
 * Path → id rule (design D2 note in channel-map.ts): a daemon-mode client
 * resolves a file path with GET /files/agent. When the file is loaded here
 * it gets the agent id and uses the /agents/:id routes; when it is not, it
 * uses the path-addressed /files/agent/* routes (path-agent-ops.ts) or, once
 * W2-A/W2-B land, holds the file as a document.
 */

import { createReadStream, createWriteStream, existsSync, type ReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AdfDatabase } from '../adf/adf-database'
import { AdfWorkspace } from '../adf/adf-workspace'
import { cloneAdfFile } from '../adf/clone-fixup'
import { isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { ensureWorkspaceIdentity } from '../runtime/identity-provisioner'
import { canonicalizePath, containsPath, isSameOrSubPath } from '../utils/tracked-paths'
import type { RuntimeAgentSummary, RuntimeLiveAgent, RuntimeService } from '../runtime/runtime-service'
import type { DaemonIdentity } from './daemon-identity'
import type { TrackedDirWatcher } from './dir-watcher'
import { forgetTrackedFile, maxDepthOf, peekBootStatusCached, storedDirs, type TrackedDirsSettings } from './tracked-dirs'

/** Caller-visible failure; `statusCode` is the HTTP status to answer with. */
export class FileOpError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 413 | 415 | 500 | 503,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FileOpError'
  }
}

export interface FileOpsSettings extends TrackedDirsSettings {
  set?(key: string, value: unknown): void
}

/**
 * W1-A: `RuntimeService.rekeyAgentPath(oldPath, newPath)` moves a runtime's
 * path indexes and the agent lease to a file's new path. Called after every
 * move made here (rename, relocate).
 * TODO(W1-A): once rekeyAgentPath is on RuntimeService, type the runtime with
 * it and drop this structural check.
 */
export interface AgentPathRekeyer {
  rekeyAgentPath(oldPath: string, newPath: string): unknown
}

function rekeyerOf(runtime: unknown): AgentPathRekeyer | null {
  const candidate = runtime as Partial<AgentPathRekeyer> | null
  return candidate && typeof candidate.rekeyAgentPath === 'function' ? candidate as AgentPathRekeyer : null
}

export type FileOpsRuntime = Pick<RuntimeService,
  'listAgents' | 'listLiveAgents' | 'getAgent' | 'getAgentConfig' | 'setAgentConfig' | 'unloadAgent' | 'scanAdfFiles'>

export interface FileOpsDeps {
  runtime: FileOpsRuntime
  settings?: FileOpsSettings
  /** Owner identity: clone provisions a fresh agent identity with it. Absent: the workspace identity hooks. */
  identity?: Pick<DaemonIdentity, 'isReady' | 'status' | 'service'>
  /** Push source (tracked_dirs, file_renamed) and the tracked-roots view. */
  events: Pick<TrackedDirWatcher, 'sync' | 'notifyPathChanged' | 'notifyRenamed'>
  /** The agents folder (default: resolveAgentsFolder over settings). Tests inject one outside the user's Documents. */
  agentsFolder?: () => Promise<string>
}

// --- Names and paths -------------------------------------------------------------

/** Characters not allowed in file names on Windows (superset of POSIX). Same rule as Studio's rename. */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

export function isValidAgentFileName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !INVALID_FILENAME_CHARS.test(name) &&
    !name.endsWith('.') && !name.endsWith(' ') && name !== '.' && name !== '..'
}

/** An absolute `.adf` path from caller input, canonicalized; 400/404 otherwise. */
export async function requireAdfPath(input: unknown, opts: { mustExist?: boolean; field?: string } = {}): Promise<string> {
  const field = opts.field ?? 'path'
  if (typeof input !== 'string' || input.trim() === '') throw new FileOpError(`${field} is required`, 400, 'bad_request')
  const raw = input.trim()
  if (raw.includes('\0')) throw new FileOpError(`${field} is not a valid path`, 400, 'bad_request')
  if (!isAbsolute(raw)) throw new FileOpError(`${field} must be an absolute path`, 400, 'bad_request')
  if (!raw.toLowerCase().endsWith('.adf')) throw new FileOpError(`${field} must name an .adf file`, 400, 'not_an_adf')
  let st: Awaited<ReturnType<typeof stat>> | null = null
  try { st = await stat(raw) } catch { st = null }
  if (!st) {
    if (opts.mustExist === false) return resolve(raw)
    throw new FileOpError(`No such agent file: ${raw}`, 404, 'not_found')
  }
  if (!st.isFile()) throw new FileOpError(`Not a file: ${raw}`, 400, 'not_an_adf')
  try { return canonicalizePath(raw) } catch { return resolve(raw) }
}

async function pathExists(p: string): Promise<boolean> {
  try { await lstat(p); return true } catch { return false }
}

/** First free "name.adf" / "name (2).adf" / … in `dir`. */
export async function availableAdfPath(dir: string, baseName: string): Promise<string> {
  let candidate = join(dir, `${baseName}.adf`)
  for (let n = 2; await pathExists(candidate); n++) candidate = join(dir, `${baseName} (${n}).adf`)
  return candidate
}

/** Delete an agent file and its WAL sidecars (Studio's deleteAdfFile). Missing files are fine. */
export async function removeAdfFiles(filePath: string): Promise<void> {
  for (const p of [filePath, `${filePath}-shm`, `${filePath}-wal`]) {
    try {
      await unlink(p)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw new FileOpError(`${basename(p)} is in use by another process and cannot be deleted: ${(err as Error).message}`, 409, 'file_busy')
      }
      throw err
    }
  }
}

function hasSidecars(filePath: string): boolean {
  return existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)
}

/**
 * Fold WAL frames into the main file before it moves. Sidecars that survive
 * mean another connection holds the file: moving the base away from a live
 * WAL would lose frames, so the caller must abort.
 */
function checkpointBeforeMove(filePath: string): boolean {
  if (!hasSidecars(filePath)) return true
  try {
    const ws = AdfWorkspace.open(filePath)
    ws.checkpoint()
    ws.close()
  } catch (err) {
    console.warn(`[FileOps] Pre-move checkpoint of ${basename(filePath)} failed:`, err)
  }
  return !hasSidecars(filePath)
}

/** Rename, falling back to copy + verify + delete across volumes (EXDEV). */
async function moveFileWithFallback(src: string, dest: string): Promise<'moved' | 'copied-source-remains'> {
  try {
    await rename(src, dest)
    return 'moved'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  try {
    await copyFile(src, dest)
    if ((await stat(dest)).size !== (await stat(src)).size) throw new Error(`Copy size mismatch for ${basename(src)}`)
  } catch (copyErr) {
    try { await unlink(dest) } catch { /* partial copy cleanup is best effort */ }
    throw copyErr
  }
  try {
    await unlink(src)
    return 'moved'
  } catch (unlinkErr) {
    console.warn(`[FileOps] Source not removed after copy (${basename(src)}):`, unlinkErr)
    return 'copied-source-remains'
  }
}

function sameFile(a: string, b: string): boolean {
  try { return canonicalizePath(a) === canonicalizePath(b) } catch { return resolve(a) === resolve(b) }
}

function isTempLocation(p: string): boolean {
  let candidate: string
  try { candidate = canonicalizePath(resolve(p)) } catch { candidate = resolve(p) }
  return [tmpdir(), '/tmp'].some(root => { try { return isSameOrSubPath(root, candidate) } catch { return false } })
}

// --- Agents folder ---------------------------------------------------------------

let documentsDirCache: Promise<string> | null = null

/**
 * The user's Documents folder as Electron's app.getPath('documents') finds it:
 * the shell folder from the registry on Windows (a OneDrive-redirected
 * Documents is the common case), XDG_DOCUMENTS_DIR on Linux, ~/Documents
 * elsewhere and as the fallback. Cached for the process.
 */
export function documentsDir(): Promise<string> {
  documentsDirCache ??= findDocumentsDir()
  return documentsDirCache
}

async function findDocumentsDir(): Promise<string> {
  const fallback = join(homedir(), 'Documents')
  if (process.platform === 'win32') {
    const value = await new Promise<string | null>((done) => {
      execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
        { windowsHide: true, timeout: 3000 }, (err, stdout) => {
          if (err) return done(null)
          const match = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(stdout)
          done(match ? match[1].trim() : null)
        })
    })
    if (!value) return fallback
    const expanded = value.replace(/%([^%]+)%/g, (whole, name: string) => {
      const key = Object.keys(process.env).find(k => k.toLowerCase() === name.toLowerCase())
      return key ? process.env[key] ?? whole : whole
    })
    return isAbsolute(expanded) && !expanded.includes('%') ? expanded : fallback
  }
  if (process.platform === 'linux') {
    try {
      const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
      const text = await readFile(join(configHome, 'user-dirs.dirs'), 'utf-8')
      const match = /^XDG_DOCUMENTS_DIR="(.*)"$/m.exec(text)
      if (match) {
        const dir = match[1].replace(/^\$HOME/, homedir())
        if (isAbsolute(dir) && resolve(dir) !== resolve(homedir())) return dir
      }
    } catch { /* no user-dirs file */ }
  }
  return fallback
}

/** Test hook. */
export function resetDocumentsDirCache(): void {
  documentsDirCache = null
}

/**
 * Where reviewed agents from untracked places and quick creates go: the
 * `agentsFolder` setting (ignored when it points into the OS temp dir, as in
 * Studio), else <Documents>/adf-agents. Never created here.
 */
export async function resolveAgentsFolder(settings?: TrackedDirsSettings): Promise<{ path: string; source: 'setting' | 'default' }> {
  const configured = settings?.get('agentsFolder')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const candidate = resolve(configured.trim())
    if (!isTempLocation(candidate)) return { path: candidate, source: 'setting' }
    console.warn(`[FileOps] agentsFolder setting points into the OS temp dir; ignoring it: ${candidate}`)
  }
  return { path: join(await documentsDir(), 'adf-agents'), source: 'default' }
}

// --- Browse ----------------------------------------------------------------------

export interface BrowseRoot {
  /** Canonical path. */
  path: string
  kind: 'home' | 'tracked' | 'agents' | 'configured'
}

export interface BrowseEntry {
  name: string
  path: string
  kind: 'directory' | 'adf'
  size?: number
  mtimeMs?: number
}

export interface BrowseResult {
  /** The listed folder (canonical); null for the roots listing. */
  path: string | null
  /** Its parent while that is still inside a root; null at a root. */
  parent: string | null
  roots: BrowseRoot[]
  entries: BrowseEntry[]
  truncated: boolean
}

/**
 * Browse roots instead of the home folder (path-list separated). Set, even
 * empty, it replaces the home folder: an operator can confine the picker to
 * the tracked folders and the agents folder, or name other folders.
 */
export const BROWSE_ROOTS_ENV = 'ADF_DAEMON_BROWSE_ROOTS'
const BROWSE_ENTRY_LIMIT = 2000

/**
 * What GET /fs/browse may list: the OS user's home folder (or, when set,
 * the folders in ADF_DAEMON_BROWSE_ROOTS instead), the tracked folders and
 * the agents folder.
 * Only those that exist, canonicalized, without duplicates.
 */
export async function browseRoots(settings?: TrackedDirsSettings): Promise<BrowseRoot[]> {
  const configured = process.env[BROWSE_ROOTS_ENV]
  const candidates: Array<{ path: string; kind: BrowseRoot['kind'] }> = configured === undefined ? [{ path: homedir(), kind: 'home' }] : []
  if (settings) for (const dir of storedDirs(settings)) candidates.push({ path: dir, kind: 'tracked' })
  candidates.push({ path: (await resolveAgentsFolder(settings)).path, kind: 'agents' })
  for (const dir of (configured ?? '').split(delimiter)) {
    if (dir.trim() && isAbsolute(dir.trim())) candidates.push({ path: dir.trim(), kind: 'configured' })
  }
  const roots: BrowseRoot[] = []
  for (const candidate of candidates) {
    let canonical: string
    try {
      canonical = await realpath(candidate.path)
      if (!(await stat(canonical)).isDirectory()) continue
    } catch { continue }
    if (roots.some(r => containsPath(r.path, canonical))) continue
    // A new root that contains earlier ones replaces them.
    for (let i = roots.length - 1; i >= 0; i--) if (containsPath(canonical, roots[i].path)) roots.splice(i, 1)
    roots.push({ path: canonical, kind: candidate.kind })
  }
  return roots
}

/**
 * List one folder for a daemon-side picker: subfolders and `.adf` files
 * only, never other files. The folder (after resolving links) must be inside
 * a browse root; a link inside it that resolves outside every root is left
 * out, so links cannot be used to escape.
 */
export async function browse(settings: TrackedDirsSettings | undefined, input: unknown, opts: { showHidden?: boolean } = {}): Promise<BrowseResult> {
  const roots = await browseRoots(settings)
  if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) {
    return {
      path: null,
      parent: null,
      roots,
      entries: roots.map(r => ({ name: r.path, path: r.path, kind: 'directory' as const })),
      truncated: false,
    }
  }
  if (typeof input !== 'string' || input.includes('\0') || !isAbsolute(input.trim())) {
    throw new FileOpError('path must be an absolute path', 400, 'bad_request')
  }
  let real: string
  try { real = await realpath(input.trim()) } catch { throw new FileOpError(`No such folder: ${input.trim()}`, 404, 'not_found') }
  const inRoot = (p: string) => roots.some(r => containsPath(r.path, p))
  if (!inRoot(real)) {
    throw new FileOpError(`Outside the folders this daemon lists (home, tracked folders, agents folder, ${BROWSE_ROOTS_ENV}): ${input.trim()}`, 403, 'outside_roots')
  }
  if (!(await stat(real)).isDirectory()) throw new FileOpError(`Not a folder: ${real}`, 400, 'not_a_directory')

  const dirents = await readdir(real, { withFileTypes: true })
  const entries: BrowseEntry[] = []
  let truncated = false
  for (const dirent of dirents) {
    if (!opts.showHidden && dirent.name.startsWith('.')) continue
    const full = join(real, dirent.name)
    let isDir = dirent.isDirectory()
    let isFile = dirent.isFile()
    if (dirent.isSymbolicLink()) {
      try {
        const target = await realpath(full)
        if (!inRoot(target)) continue
        const st = await stat(target)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch { continue }
    }
    if (isDir) {
      entries.push({ name: dirent.name, path: full, kind: 'directory' })
    } else if (isFile && dirent.name.toLowerCase().endsWith('.adf')) {
      try {
        const st = await stat(full)
        entries.push({ name: dirent.name, path: full, kind: 'adf', size: st.size, mtimeMs: st.mtimeMs })
      } catch { continue }
    } else {
      continue
    }
    if (entries.length >= BROWSE_ENTRY_LIMIT) { truncated = true; break }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
  const atRoot = roots.some(r => r.path === real)
  const parent = atRoot ? null : dirname(real)
  return { path: real, parent: parent && inRoot(parent) ? parent : null, roots, entries, truncated }
}

// --- Snapshots ---------------------------------------------------------------------

export type SnapshotMode = 'export' | 'share'

export interface TempSnapshot {
  file: string
  size: number
  /** Removes the snapshot and its folder; never follows links (the folder holds one plain file). */
  cleanup(): Promise<void>
}

/**
 * A consistent copy of `filePath` in a fresh temp folder: `export` is the
 * whole file (SQLite online backup, safe while the agent runs and writes);
 * `share` is the identity-free copy Studio's Share and Save a copy… make
 * (AdfDatabase.snapshotForSend).
 */
export async function snapshotToTemp(filePath: string, mode: SnapshotMode): Promise<TempSnapshot> {
  const dir = await mkdtemp(join(tmpdir(), 'adf-snapshot-'))
  const file = join(dir, basename(filePath))
  const cleanup = async () => {
    for (const p of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      try { await unlink(p) } catch { /* not there */ }
    }
    try { await rmdir(dir) } catch { /* not empty: leave it */ }
  }
  try {
    if (mode === 'share') await AdfDatabase.snapshotForSend(filePath, file)
    else await AdfDatabase.snapshotTo(filePath, file)
    return { file, size: (await stat(file)).size, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

/** A read stream of a temp snapshot that removes it once the stream closes. */
export function streamSnapshot(snapshot: TempSnapshot): ReadStream {
  const stream = createReadStream(snapshot.file)
  stream.once('close', () => { void snapshot.cleanup() })
  return stream
}

// --- Byte-capped bodies ------------------------------------------------------------

/** Collect a request body into memory, refusing more than `maxBytes` (413 too_large). */
export async function readCapped(body: unknown, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw tooLarge(maxBytes)
    return body
  }
  if (!isReadable(body)) throw new FileOpError('Send the file as the request body (Content-Type: application/octet-stream)', 415, 'unsupported_media_type')
  const chunks: Buffer[] = []
  let total = 0
  let over = false
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    // Past the cap: keep draining (so the 413 reaches the client) but keep nothing.
    if (total > maxBytes) { over = true; chunks.length = 0; continue }
    chunks.push(buf)
  }
  if (over) throw tooLarge(maxBytes)
  return Buffer.concat(chunks, total)
}

function tooLarge(maxBytes: number): FileOpError {
  return new FileOpError(`The body is larger than the ${Math.round(maxBytes / (1024 * 1024))} MiB this route accepts`, 413, 'too_large', { maxBytes })
}

function isReadable(value: unknown): value is Readable {
  return !!value && typeof (value as Readable).pipe === 'function' && typeof (value as Readable)[Symbol.asyncIterator] === 'function'
}

/** Write a request body to `dest`, refusing more than `maxBytes`. Removes `dest` on any failure. */
async function writeCapped(body: unknown, dest: string, maxBytes: number): Promise<number> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw tooLarge(maxBytes)
  } else if (!isReadable(body)) {
    throw new FileOpError('Send the file as the request body (Content-Type: application/octet-stream)', 415, 'unsupported_media_type')
  }
  let total = 0
  let over = false
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length
      if (total > maxBytes) { over = true; done(); return } // drain, write nothing more
      done(null, chunk)
    },
  })
  const source = Buffer.isBuffer(body) ? (async function* () { yield body })() : body as Readable
  try {
    await pipeline(source, counter, createWriteStream(dest, { flags: 'wx' }))
  } catch (err) {
    try { await unlink(dest) } catch { /* not created */ }
    throw err
  }
  if (over) {
    try { await unlink(dest) } catch { /* ignore */ }
    throw tooLarge(maxBytes)
  }
  return total
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

// --- Operations ---------------------------------------------------------------------

export interface RenameResult {
  success: true
  filePath: string
  /** The agent is running: its name changed now, the file moves when it stops (Studio's behaviour). */
  renameDeferred: boolean
  agentId?: string
}

export interface CloneResult {
  success: true
  filePath: string
  name: string
  agentId: string
  identity: 'fresh' | 'kept'
  warnings: string[]
}

export interface DeleteResult {
  success: true
  filePath: string
  /** The agent was loaded here and was stopped first. */
  stopped: boolean
  agentId?: string
}

export interface RelocateResult {
  /** Where the file now is, when it moved. */
  movedTo?: string
  /** Why it did not move (the accept still succeeded), or what to clean up. */
  moveError?: string
}

export interface ImportResult {
  success: true
  filePath: string
  name: string
  agentId: string
  /** Reviewed here already (same config id and content as a reviewed file); otherwise it needs review before it runs. */
  reviewed: boolean
  size: number
}

export interface PathAgentInfo {
  filePath: string
  /** config.id: the id the /agents/:id routes take once it is loaded. */
  agentId: string | null
  name: string
  /** Loaded in this daemon (the /agents/:id routes work now). */
  loaded: boolean
  /** Under a tracked folder (GET /tracked-dirs/agents/all lists it). */
  tracked: boolean
  /** A rename waiting for the agent to stop. */
  pendingName?: string
  error?: string
}

export class AgentFileOps {
  /** Canonical path → the name the file takes when its agent stops. */
  private readonly pendingRenames = new Map<string, string>()

  constructor(private readonly deps: FileOpsDeps) {}

  private get runtime(): FileOpsRuntime { return this.deps.runtime }

  private async agentsFolder(): Promise<string> {
    return this.deps.agentsFolder ? this.deps.agentsFolder() : (await resolveAgentsFolder(this.deps.settings)).path
  }

  pendingName(filePath: string): string | undefined {
    return this.pendingRenames.get(keyOf(filePath))
  }

  /** The agent loaded from `filePath` here, if any. */
  loadedAt(filePath: string): RuntimeAgentSummary | undefined {
    const key = keyOf(filePath)
    return this.runtime.listAgents().find(a => a.filePath && keyOf(a.filePath) === key)
  }

  liveAgent(filePath: string): RuntimeLiveAgent | undefined {
    const key = keyOf(filePath)
    return this.runtime.listLiveAgents().find(a => keyOf(a.filePath) === key)
  }

  /** GET /files/agent: the path → id rule. */
  async describe(input: unknown): Promise<PathAgentInfo> {
    const filePath = await requireAdfPath(input)
    const loaded = this.loadedAt(filePath)
    const tracked = this.isTracked(filePath)
    const pendingName = this.pendingName(filePath)
    if (loaded) return { filePath, agentId: loaded.id, name: loaded.name, loaded: true, tracked, ...(pendingName ? { pendingName } : {}) }
    const peek = peekBootStatusCached(filePath)
    return {
      filePath,
      agentId: peek.status?.agentId ?? null,
      name: peek.status?.agentName || basename(filePath, '.adf'),
      loaded: false,
      tracked,
      ...(pendingName ? { pendingName } : {}),
      ...(peek.status ? {} : { error: peek.error ? `Not a readable .adf: ${peek.error}` : 'Not a readable .adf.' }),
    }
  }

  isTracked(filePath: string): boolean {
    const dir = dirname(filePath)
    return storedDirs(this.deps.settings ?? { get: () => undefined }).some(d => { try { return isSameOrSubPath(d, dir) } catch { return false } })
  }

  /**
   * FILE_DELETE, as Studio does it: an agent running here is stopped first
   * (unloadAgent; the daemon's unload listener unregisters it from the
   * mesh and the lease is released), then the file and its sidecars go.
   * A file that is already gone is not an error.
   */
  async delete(input: unknown): Promise<DeleteResult> {
    const filePath = await requireAdfPath(input, { mustExist: false })
    // Before the unload: the unload listener must not apply a pending rename to a file being deleted.
    this.pendingRenames.delete(keyOf(filePath))
    const loaded = this.loadedAt(filePath)
    if (loaded) {
      console.log(`[FileOps] Stopping ${loaded.name} before deleting ${filePath}`)
      await this.runtime.unloadAgent(loaded.id)
    }
    await removeAdfFiles(filePath)
    forgetTrackedFile(filePath)
    console.log(`[FileOps] Deleted ${filePath}`)
    this.deps.events.notifyPathChanged(filePath)
    return { success: true, filePath, stopped: !!loaded, ...(loaded ? { agentId: loaded.id } : {}) }
  }

  /**
   * FILE_RENAME. A stopped agent's file is renamed now (sidecars folded in
   * first) and its config.name set to match. A running agent keeps running
   * under its file, its lease and its mesh registration: its name changes
   * now and the file moves when it stops (Studio's deferred rename: SQLite
   * files cannot move under an open handle on Windows).
   */
  async rename(input: unknown, newNameInput: unknown): Promise<RenameResult> {
    const filePath = await requireAdfPath(input)
    const newName = typeof newNameInput === 'string' ? newNameInput.trim() : ''
    if (!isValidAgentFileName(newName)) {
      throw new FileOpError('Name contains characters not allowed in file names.', 400, 'invalid_name')
    }
    const newPath = join(dirname(filePath), `${newName}.adf`)
    if (!sameFile(newPath, filePath) && await pathExists(newPath)) {
      throw new FileOpError(`A file named "${newName}.adf" already exists.`, 409, 'name_taken')
    }
    const loaded = this.loadedAt(filePath)
    if (loaded) {
      const { config } = this.runtime.getAgentConfig(loaded.id)
      if (config.name !== newName) await this.runtime.setAgentConfig(loaded.id, { ...config, name: newName })
      if (basename(filePath, '.adf') === newName) {
        this.pendingRenames.delete(keyOf(filePath))
        return { success: true, filePath, renameDeferred: false, agentId: loaded.id }
      }
      this.pendingRenames.set(keyOf(filePath), newName)
      console.log(`[FileOps] ${loaded.name} is running: renamed to "${newName}" now; ${basename(filePath)} becomes ${newName}.adf when it stops`)
      this.deps.events.notifyPathChanged(filePath)
      return { success: true, filePath, renameDeferred: true, agentId: loaded.id }
    }
    return this.performRename(filePath, newName)
  }

  /** The agent loaded from `filePath` stopped: apply its pending rename. Never throws. */
  async onAgentUnloaded(filePath: string | null): Promise<void> {
    if (!filePath) return
    const newName = this.pendingRenames.get(keyOf(filePath))
    if (!newName) return
    if (this.loadedAt(filePath)) return
    try {
      const result = await this.performRename(filePath, newName)
      console.log(`[FileOps] Deferred rename applied: ${filePath} -> ${result.filePath}`)
    } catch (err) {
      this.pendingRenames.delete(keyOf(filePath))
      console.warn(`[FileOps] Deferred rename of ${basename(filePath)} to "${newName}.adf" failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async performRename(filePath: string, newName: string): Promise<RenameResult> {
    const newPath = join(dirname(filePath), `${newName}.adf`)
    const moves = newPath !== filePath
    if (moves) {
      if (!sameFile(newPath, filePath) && await pathExists(newPath)) {
        throw new FileOpError(`A file named "${newName}.adf" already exists.`, 409, 'name_taken')
      }
      if (!checkpointBeforeMove(filePath)) {
        throw new FileOpError('WAL sidecars could not be checkpointed (another process has the file open); rename aborted to avoid losing unflushed data.', 409, 'file_busy')
      }
      try {
        await rename(filePath, newPath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          throw new FileOpError(`${basename(filePath)} is in use by another process: ${(err as Error).message}`, 409, 'file_busy')
        }
        throw err
      }
      await this.rekey(filePath, newPath)
    }
    const ws = AdfWorkspace.open(newPath)
    let agentId: string
    try {
      const config = ws.getAgentConfig()
      agentId = config.id
      if (config.name !== newName) {
        config.name = newName
        ws.setAgentConfig(config)
      }
    } finally {
      ws.close()
    }
    this.pendingRenames.delete(keyOf(filePath))
    if (moves) {
      forgetTrackedFile(filePath)
      console.log(`[FileOps] Renamed ${filePath} -> ${newPath}`)
      this.deps.events.notifyRenamed(filePath, newPath)
    }
    this.deps.events.notifyPathChanged(newPath)
    return { success: true, filePath: newPath, renameDeferred: false, agentId }
  }

  private async rekey(oldPath: string, newPath: string): Promise<void> {
    const rekeyer = rekeyerOf(this.runtime)
    if (!rekeyer) return // TODO(W1-A): RuntimeService.rekeyAgentPath
    try {
      await rekeyer.rekeyAgentPath(oldPath, newPath)
    } catch (err) {
      console.warn(`[FileOps] Re-keying ${basename(oldPath)} after its move failed:`, err)
    }
  }

  /**
   * FILE_CLONE with clone-fixup: selected tables only, new config.id, fresh
   * identity unless adf_identity is kept, parented to the source. Marked
   * reviewed (the owner made it); the folder is tracked if it was not.
   */
  async clone(input: unknown, selectedTables: unknown): Promise<CloneResult> {
    const filePath = await requireAdfPath(input)
    if (!Array.isArray(selectedTables) || !selectedTables.every(t => typeof t === 'string')) {
      throw new FileOpError('selectedTables must be an array of table names', 400, 'bad_request')
    }
    const identity = this.deps.identity
    if (identity && !identity.isReady()) {
      throw new FileOpError(`Set up the owner identity first. ${identity.status().message ?? ''}`.trim(), 409, 'identity_not_ready')
    }
    const svc = identity?.service
    const ownerDid = svc?.getOwnerDid() ?? (this.deps.settings?.get('ownerDid') as string | undefined) ?? ''
    // A running source: fold its WAL into the file the clone copies.
    const live = this.liveAgent(filePath)
    if (live) {
      try { live.workspace.checkpoint() } catch (err) { console.warn(`[FileOps] Checkpoint before clone of ${basename(filePath)} failed:`, err) }
    }
    const result = cloneAdfFile(filePath, selectedTables as string[], {
      keys: {
        ownerDid,
        ownerPrivateKey: svc?.getOwnerSigningKey() ?? null,
        runtimeDid: svc?.getRuntimeDid() ?? undefined,
        runtimePrivateKey: svc?.getRuntimeSigningKey() ?? null,
      },
      provisionFreshIdentity: (ws) => {
        if (svc) svc.ensureWorkspaceIdentity(ws)
        else ensureWorkspaceIdentity(ws)
      },
      onCreated: (fp) => this.fileCreated(fp),
    })
    this.markReviewed(result.config)
    console.log(`[FileOps] Cloned ${filePath} -> ${result.filePath}`)
    return {
      success: true,
      filePath: result.filePath,
      name: result.name,
      agentId: result.config.id,
      identity: result.fixup.identity,
      warnings: result.fixup.warnings,
    }
  }

  /**
   * Write a snapshot of an agent file to another path on this host (Studio's
   * "Save a copy…" with mode share, or a full export). Built on a .partial
   * so a failure never leaves a half-written .adf.
   */
  async saveAs(input: unknown, destInput: unknown, mode: SnapshotMode, overwrite: boolean): Promise<{ success: true; filePath: string; size: number }> {
    const filePath = await requireAdfPath(input)
    const dest = await requireAdfPath(destInput, { mustExist: false, field: 'destPath' })
    if (sameFile(dest, filePath)) {
      throw new FileOpError('Choose a different file: a copy cannot overwrite the agent it came from', 409, 'same_file')
    }
    try {
      if (!(await stat(dirname(dest))).isDirectory()) throw new Error('not a folder')
    } catch {
      throw new FileOpError(`The folder does not exist: ${dirname(dest)}`, 400, 'bad_request')
    }
    if (!overwrite && await pathExists(dest)) throw new FileOpError(`${basename(dest)} already exists`, 409, 'name_taken')
    if (this.loadedAt(dest)) throw new FileOpError(`${basename(dest)} is a running agent`, 409, 'agent_running')
    const partial = `${dest}.${randomUUID().slice(0, 8)}.partial`
    try {
      if (mode === 'share') await AdfDatabase.snapshotForSend(filePath, partial)
      else await AdfDatabase.snapshotTo(filePath, partial)
      if (overwrite) await removeAdfFiles(dest)
      await rename(partial, dest)
    } catch (err) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { await unlink(`${partial}${suffix}`) } catch { /* none */ }
      }
      throw err
    }
    console.log(`[FileOps] Saved a ${mode === 'share' ? 'shareable copy' : 'copy'} of ${filePath} to ${dest}`)
    this.deps.events.notifyPathChanged(dest)
    return { success: true, filePath: dest, size: (await stat(dest)).size }
  }

  /** GET /agents/:id/export: the file of a loaded agent, else of a tracked file with that config id. */
  resolveAgentFile(agentId: string): string {
    const ref = this.runtime.getAgent(agentId)
    if (ref) {
      if (!ref.filePath) throw new FileOpError(`Agent "${agentId}" has no file (in-memory agent)`, 409, 'not_file_backed')
      return ref.filePath
    }
    const settings = this.deps.settings
    if (settings) {
      for (const file of this.runtime.scanAdfFiles(storedDirs(settings), maxDepthOf(settings))) {
        if (peekBootStatusCached(file).status?.agentId === agentId) return file
      }
    }
    throw new FileOpError(`Unknown agent "${agentId}"`, 404, 'not_found')
  }

  /**
   * POST /files/import: an .adf sent from another machine lands in a tracked
   * folder (or the agents folder, which is then tracked). It is not marked
   * reviewed: it runs only after the owner reviews it, as any received file.
   */
  async import(body: unknown, opts: { directory?: unknown; name?: unknown; unique?: boolean; maxBytes: number }): Promise<ImportResult> {
    const directory = await this.importDirectory(opts.directory)
    const rawName = typeof opts.name === 'string' ? opts.name.trim().replace(/\.adf$/i, '') : ''
    if (!isValidAgentFileName(rawName)) throw new FileOpError('name must be a file name (no path separators)', 400, 'invalid_name')
    let target = join(directory, `${rawName}.adf`)
    if (await pathExists(target)) {
      if (!opts.unique) throw new FileOpError(`An agent named "${rawName}" already exists in ${directory}.`, 409, 'name_taken')
      target = await availableAdfPath(directory, rawName)
    }
    // Not .adf: the watcher and autostart never see a half-written upload.
    const partial = `${target}.${randomUUID().slice(0, 8)}.partial`
    const size = await writeCapped(body, partial, opts.maxBytes)
    const discard = async () => {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { await unlink(`${partial}${suffix}`) } catch { /* none */ }
      }
    }
    let agentId: string
    let reviewed: boolean
    try {
      const head = Buffer.alloc(SQLITE_MAGIC.length)
      const fh = await open(partial, 'r')
      try { await fh.read(head, 0, head.length, 0) } finally { await fh.close() }
      if (!head.equals(SQLITE_MAGIC)) throw new FileOpError('The upload is not an .adf file (not a SQLite database)', 400, 'not_an_adf')
      const peek = AdfDatabase.peekBootStatusDetailed(partial)
      if (!peek.status || !peek.config) {
        throw new FileOpError(`The upload is not a readable .adf: ${peek.error ?? 'no agent config'}`, 400, 'not_an_adf')
      }
      agentId = peek.status.agentId
      reviewed = isConfigReviewed(this.deps.settings?.get('reviewedAgents'), peek.config)
      if (await pathExists(target)) throw new FileOpError(`${basename(target)} appeared while uploading`, 409, 'name_taken')
      await rename(partial, target)
    } catch (err) {
      await discard()
      throw err
    }
    console.log(`[FileOps] Imported ${basename(target)} (${size} bytes) into ${directory}${reviewed ? '' : '; it needs review before it runs'}`)
    this.fileCreated(target)
    return { success: true, filePath: target, name: basename(target, '.adf'), agentId, reviewed, size }
  }

  private async importDirectory(input: unknown): Promise<string> {
    const agentsFolder = await this.agentsFolder()
    let dir: string
    if (input === undefined || input === null || input === '') {
      await mkdir(agentsFolder, { recursive: true })
      dir = agentsFolder
    } else {
      if (typeof input !== 'string' || input.includes('\0') || !isAbsolute(input.trim())) {
        throw new FileOpError('directory must be an absolute path', 400, 'bad_request')
      }
      dir = input.trim()
    }
    let real: string
    try {
      real = await realpath(dir)
      if (!(await stat(real)).isDirectory()) throw new Error('not a folder')
    } catch {
      throw new FileOpError(`The folder does not exist: ${dir}`, 400, 'bad_request')
    }
    const allowed = [...storedDirs(this.deps.settings ?? { get: () => undefined }), agentsFolder]
    if (!allowed.some(d => { try { return isSameOrSubPath(d, real) } catch { return false } })) {
      throw new FileOpError(`Imports go into a tracked folder or the agents folder (${agentsFolder}); ${real} is neither.`, 403, 'outside_tracked')
    }
    return real
  }

  /**
   * The accept-relocate step (Studio's persistAcceptedAgent): a reviewed file
   * outside every tracked folder (a temp attachment, Downloads) moves into
   * the agents folder, which is tracked. A failed move never fails the
   * accept: the file's own folder is tracked instead, except an OS temp
   * folder, which is reported as moveError. The caller must have released
   * every handle on the file (open document) first.
   */
  async relocate(input: unknown): Promise<RelocateResult> {
    const filePath = await requireAdfPath(input)
    if (this.isTracked(filePath)) return {}
    const inTemp = isTempLocation(dirname(filePath))
    const fallback = (err: unknown): RelocateResult => {
      console.warn(`[FileOps] Could not move ${basename(filePath)} to the agents folder:`, err)
      if (inTemp) {
        return { moveError: `The agent file could not be moved out of the temporary folder and may be deleted by the OS: ${err instanceof Error ? err.message : String(err)}` }
      }
      this.fileCreated(filePath)
      return {}
    }
    if (this.loadedAt(filePath)) return fallback(new Error('agent is running'))
    let dest: string
    try {
      const folder = await this.agentsFolder()
      await mkdir(folder, { recursive: true })
      dest = await availableAdfPath(folder, basename(filePath, '.adf'))
    } catch (err) {
      return fallback(err)
    }
    if (!checkpointBeforeMove(filePath)) {
      return fallback(new Error('WAL sidecars could not be checkpointed; move aborted to avoid losing unflushed data'))
    }
    let outcome: 'moved' | 'copied-source-remains'
    try {
      outcome = await moveFileWithFallback(filePath, dest)
    } catch (err) {
      return fallback(err)
    }
    await this.rekey(filePath, dest)
    const pending = this.pendingRenames.get(keyOf(filePath))
    if (pending) {
      this.pendingRenames.delete(keyOf(filePath))
      this.pendingRenames.set(keyOf(dest), pending)
    }
    forgetTrackedFile(filePath)
    console.log(`[FileOps] Moved ${filePath} into the agents folder: ${dest}`)
    this.fileCreated(dest)
    this.deps.events.notifyRenamed(filePath, dest)
    if (outcome === 'copied-source-remains') {
      return { movedTo: dest, moveError: `Moved to ${dest}, but the original at ${filePath} could not be deleted; remove it to avoid a duplicate agent` }
    }
    return { movedTo: dest }
  }

  /**
   * A new agent file exists (clone, import, relocate): track its folder when
   * no tracked folder covers it (Studio's notifyAdfFileCreated), which
   * re-syncs the watcher, tells the mesh and pushes `tracked_dirs`; else push
   * `tracked_dirs` for the covering root.
   */
  fileCreated(filePath: string): void {
    const settings = this.deps.settings
    const dir = dirname(canonicalizePath(filePath))
    const existing = settings ? storedDirs(settings) : []
    const covered = existing.some(d => { try { return isSameOrSubPath(d, dir) } catch { return false } })
    if (!covered && settings?.set) {
      settings.set('trackedDirectories', [...existing, dir])
      console.log(`[FileOps] Tracking ${dir} (a new agent file was placed there)`)
      this.deps.events.sync()
      return
    }
    this.deps.events.notifyPathChanged(filePath)
  }

  private markReviewed(config: Parameters<typeof markConfigReviewed>[1]): void {
    const settings = this.deps.settings
    if (!settings?.set) return
    settings.set('reviewedAgents', markConfigReviewed(settings.get('reviewedAgents'), config))
  }
}

function keyOf(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return resolve(filePath) }
}
