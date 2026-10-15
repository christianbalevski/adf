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

import { constants as fsConstants, createReadStream, createWriteStream, existsSync, type Dirent, type ReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { agentFileNameProblem } from '../../shared/utils/agent-file-name'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { AdfDatabase } from '../adf/adf-database'
import { AdfWorkspace } from '../adf/adf-workspace'
import { cloneAdfFile } from '../adf/clone-fixup'
import { isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { ensureWorkspaceIdentity } from '../runtime/identity-provisioner'
import { canonicalizePath, containsPath, isSameOrSubPath } from '../utils/tracked-paths'
import type { RuntimeAgentSummary, RuntimeLiveAgent, RuntimeService } from '../runtime/runtime-service'
import {
  AGENT_LEASED_CODE,
  leaseHolderElsewhere,
  processAgentLeases,
  type AgentLeaseRegistry,
} from '../runtime/agent-lease'
import type { DaemonIdentity } from './daemon-identity'
import { runAsClientWrite } from './client-sessions'
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

export type FileOpsRuntime = Pick<RuntimeService,
  | 'listAgents' | 'listLiveAgents' | 'getAgent' | 'getAgentConfig' | 'setAgentConfig' | 'unloadAgent' | 'scanAdfFiles'
  | 'rekeyAgentPath' | 'syncAgentFileToName' | 'getPendingRename' | 'cancelPendingRename'>
  // Open documents (D4, W2-A): a file open for editing without a runtime.
  & Partial<Pick<RuntimeService, 'getOpenDocument' | 'getAgentWorkspaceByPath' | 'closeDocument' | 'withDocumentMoved'>>

export interface FileOpsDeps {
  runtime: FileOpsRuntime
  settings?: FileOpsSettings
  /** Owner identity: clone provisions a fresh agent identity with it. Absent: the workspace identity hooks. */
  identity?: Pick<DaemonIdentity, 'isReady' | 'status' | 'service'>
  /** Push source (tracked_dirs, file_renamed) and the tracked-roots view. */
  events: Pick<TrackedDirWatcher, 'sync' | 'notifyPathChanged' | 'notifyRenamed' | 'expectFile'>
  /** Agent leases (W0-C) checked before writing, moving or deleting a file. Default: the process registry; null disables the check. */
  leases?: AgentLeaseRegistry | null
  /** DELETE: how long to wait for a running agent to stop (default 15 s). */
  unloadDeadlineMs?: number
  /** The agents folder (default: resolveAgentsFolder over settings). Tests inject one outside the user's Documents. */
  agentsFolder?: () => Promise<string>
}

// --- Names and paths -------------------------------------------------------------

// A name a rename or import may give a file: embedded Studio's rule, plus no
// Windows device name (shared/utils/agent-file-name.ts agentFileNameProblem).

export interface AdfPathOptions {
  mustExist?: boolean
  field?: string
  /**
   * Delete, rename, move, overwrite: the path must already be canonical (no
   * symlink, junction, 8.3 short name or other alias anywhere in it), so the
   * operation acts on exactly the file the caller named.
   */
  destructive?: boolean
  /** Folders a UNC path may point into (the tracked folders). */
  uncRoots?: string[]
}

/** Windows reserved device names (with any extension). */
const RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
const BACKSLASH = '\\'
const UNC_PREFIX = BACKSLASH + BACKSLASH
const LONG_PREFIX = UNC_PREFIX + '?' + BACKSLASH
const DEVICE_PREFIX = UNC_PREFIX + '.' + BACKSLASH

function badPath(field: string, why: string, code = 'bad_path'): FileOpError {
  return new FileOpError(`${field} ${why}`, 400, code)
}

function samePathSpelling(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b
}

function stripLongPathPrefix(p: string): string {
  if (process.platform !== 'win32') return p
  if (p.startsWith(LONG_PREFIX + 'UNC' + BACKSLASH)) return UNC_PREFIX + p.slice(8)
  if (p.startsWith(LONG_PREFIX)) return p.slice(4)
  return p
}

/** Absolute form of `raw` with its existing part resolved through the filesystem (links, short names). */
async function canonicalOf(raw: string): Promise<string> {
  const abs = resolve(raw)
  try {
    return stripLongPathPrefix(await realpath(abs))
  } catch {
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(await canonicalOf(parent), basename(abs))
  }
}

/**
 * An agent file path from caller input: absolute, naming an `.adf` both as
 * given and after every link, short name and alias is resolved (so an 8.3
 * name cannot reach a `.adfx` file, and an `.adf` link to a `.txt` is
 * refused). Refused on Windows: alternate data streams, device paths
 * (`\\?\`, `\\.\`), reserved device names, and UNC paths outside the
 * tracked folders. Returns the canonical path.
 */
export async function requireAdfPath(input: unknown, opts: AdfPathOptions = {}): Promise<string> {
  const field = opts.field ?? 'path'
  if (typeof input !== 'string' || input.trim() === '') throw new FileOpError(`${field} is required`, 400, 'bad_request')
  const raw = input.trim()
  if (raw.includes('\0')) throw badPath(field, 'is not a valid path')
  if (process.platform === 'win32') {
    const slashed = raw.split('/').join(BACKSLASH)
    if (slashed.startsWith(LONG_PREFIX) || slashed.startsWith(DEVICE_PREFIX)) throw badPath(field, 'must not be a device path')
    // A drive letter is the only colon a file path has; any other names an alternate data stream.
    const colon = slashed.indexOf(':')
    if (colon !== -1 && (colon !== 1 || slashed.indexOf(':', 2) !== -1)) throw badPath(field, 'must not name an alternate data stream')
    for (const segment of slashed.split(BACKSLASH)) {
      const stem = segment.split('.')[0].trim()
      if (stem && RESERVED_NAME.test(stem)) throw badPath(field, `uses the reserved device name "${segment}"`)
    }
    if (slashed.startsWith(UNC_PREFIX)) {
      const roots = opts.uncRoots ?? []
      if (!roots.some(root => containsPath(resolve(root), resolve(raw)))) {
        throw new FileOpError(`${field} is a network (UNC) path outside the tracked folders`, 400, 'unc_not_allowed')
      }
    }
  }
  if (!isAbsolute(raw)) throw new FileOpError(`${field} must be an absolute path`, 400, 'bad_request')
  if (!raw.toLowerCase().endsWith('.adf')) throw new FileOpError(`${field} must name an .adf file`, 400, 'not_an_adf')
  const canonical = await canonicalOf(raw)
  if (!canonical.toLowerCase().endsWith('.adf')) {
    throw new FileOpError(`${field} resolves to ${canonical}, which is not an .adf file`, 400, 'not_an_adf')
  }
  let linked = false
  try { linked = (await lstat(raw)).isSymbolicLink() } catch { /* missing */ }
  if (opts.destructive && (linked || !samePathSpelling(canonical, resolve(raw)))) {
    throw new FileOpError(`${raw} is reached through a link or a short (8.3) name, and the daemon deletes and renames agent files only by their real path. Open ${canonical} instead and try again.`, 400, 'path_not_canonical', { canonical })
  }
  let st: Awaited<ReturnType<typeof stat>> | null = null
  try { st = await stat(canonical) } catch { st = null }
  if (!st) {
    if (opts.mustExist === false) return canonical
    throw new FileOpError(`No such agent file: ${raw}`, 404, 'not_found')
  }
  if (!st.isFile()) throw new FileOpError(`Not a file: ${raw}`, 400, 'not_an_adf')
  return canonical
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
    // Closed even when the checkpoint throws: an open handle keeps the .adf locked on Windows.
    try {
      ws.checkpoint()
    } finally {
      ws.close()
    }
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

/** The same file on disk (device + inode), whatever the spelling; false when either is missing. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

function isTempLocation(p: string): boolean {
  let candidate: string
  try { candidate = canonicalizePath(resolve(p)) } catch { candidate = resolve(p) }
  return [tmpdir(), '/tmp'].some(root => { try { return isSameOrSubPath(root, candidate) } catch { return false } })
}

// --- Agents folder ---------------------------------------------------------------

let documentsDirCache: Promise<string> | null = null
let documentsDirResolved: string | null = null

/**
 * The user's Documents folder as Electron's app.getPath('documents') finds it:
 * the shell folder from the registry on Windows (a OneDrive-redirected
 * Documents is the common case), XDG_DOCUMENTS_DIR on Linux, ~/Documents
 * elsewhere and as the fallback. Cached for the process.
 */
export function documentsDir(): Promise<string> {
  documentsDirCache ??= findDocumentsDir().then(dir => { documentsDirResolved = dir; return dir })
  return documentsDirCache
}

/** documentsDir() for synchronous callers: the resolved folder, or ~/Documents until the lookup (started here) finishes. */
export function documentsDirSync(): string {
  if (documentsDirResolved) return documentsDirResolved
  void documentsDir()
  return join(homedir(), 'Documents')
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
  documentsDirResolved = null
}

/**
 * Where reviewed agents from untracked places and quick creates go: the
 * `agentsFolder` setting (ignored when it points into the OS temp dir, as in
 * Studio), else <Documents>/adf-agents. Never created here.
 */
export async function resolveAgentsFolder(settings?: TrackedDirsSettings): Promise<{ path: string; source: 'setting' | 'default' }> {
  return configuredAgentsFolder(settings) ?? { path: join(await documentsDir(), 'adf-agents'), source: 'default' }
}

/** resolveAgentsFolder for synchronous callers (DaemonAgentFactory.defaultDirectory); see documentsDirSync. */
export function resolveAgentsFolderSync(settings?: TrackedDirsSettings): { path: string; source: 'setting' | 'default' } {
  return configuredAgentsFolder(settings) ?? { path: join(documentsDirSync(), 'adf-agents'), source: 'default' }
}

function configuredAgentsFolder(settings?: TrackedDirsSettings): { path: string; source: 'setting' } | null {
  const configured = settings?.get('agentsFolder')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const candidate = resolve(configured.trim())
    if (!isTempLocation(candidate)) return { path: candidate, source: 'setting' }
    console.warn(`[FileOps] agentsFolder setting points into the OS temp dir; ignoring it: ${candidate}`)
  }
  return null
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
 * Only those that exist, canonicalized, without duplicates. The tracked
 * folders and the agents folder stay listed as their own roots even inside
 * the home folder: the upload picker offers only those kinds. Among the
 * browse roots (home, configured) and among the upload roots (tracked,
 * agents), one inside another of its group is left out; a path that is both
 * keeps the upload kind.
 */
export async function browseRoots(settings?: TrackedDirsSettings): Promise<BrowseRoot[]> {
  const configured = process.env[BROWSE_ROOTS_ENV]
  const candidates: Array<{ path: string; kind: BrowseRoot['kind'] }> = configured === undefined ? [{ path: homedir(), kind: 'home' }] : []
  if (settings) for (const dir of storedDirs(settings)) candidates.push({ path: dir, kind: 'tracked' })
  candidates.push({ path: (await resolveAgentsFolder(settings)).path, kind: 'agents' })
  for (const dir of (configured ?? '').split(delimiter)) {
    if (dir.trim() && isAbsolute(dir.trim())) candidates.push({ path: dir.trim(), kind: 'configured' })
  }
  const upload = (kind: BrowseRoot['kind']) => kind === 'tracked' || kind === 'agents'
  const roots: BrowseRoot[] = []
  for (const candidate of candidates) {
    let canonical: string
    try {
      canonical = await realpath(candidate.path)
      if (!(await stat(canonical)).isDirectory()) continue
    } catch { continue }
    const same = roots.find(r => r.path === canonical)
    if (same) {
      if (upload(candidate.kind) && !upload(same.kind)) same.kind = candidate.kind
      continue
    }
    const group = upload(candidate.kind)
    if (roots.some(r => upload(r.kind) === group && containsPath(r.path, canonical))) continue
    // A new root that contains earlier ones of its group replaces them.
    for (let i = roots.length - 1; i >= 0; i--) if (upload(roots[i].kind) === group && containsPath(canonical, roots[i].path)) roots.splice(i, 1)
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
  // A root inside another root (the agents folder inside home) has that root's folder as its parent.
  const parent = dirname(real)
  return { path: real, parent: parent !== real && inRoot(parent) ? parent : null, roots, entries, truncated }
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
 * Identity rows an export without `includeSecrets` keeps although they are
 * stored plain: public or wrapped material only (the agent's public key,
 * envelope descriptors, KDF parameters). Every other plain row is a secret:
 * a legacy agent's `crypto:signing:private_key`, credential values.
 */
const EXPORT_KEPT_PLAIN = /^crypto:(signing:public_key$|envelope:|kdf:)/

/**
 * Remove the plain secrets from a snapshot copy (export without
 * `includeSecrets`): plain `crypto:*` key rows and plain credential rows.
 * Sealed rows stay (they open only with a key the receiver holds).
 * `secure_delete` zeroes the removed values, and a VACUUM rewrites the copy
 * so no freed page keeps an older value of any row. Returns how many rows
 * were removed.
 */
export function stripPlainSecrets(file: string): number {
  const db = new Database(file, { fileMustExist: true })
  try {
    db.pragma('journal_mode = DELETE')
    db.pragma('secure_delete = ON')
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'adf_identity'").get()) return 0
    const rows = db.prepare('SELECT purpose, encryption_algo FROM adf_identity').all() as Array<{ purpose: string; encryption_algo: string | null }>
    const drop = rows.filter((r) => (r.encryption_algo ?? 'plain') === 'plain' && !EXPORT_KEPT_PLAIN.test(r.purpose)).map((r) => r.purpose)
    const del = db.prepare('DELETE FROM adf_identity WHERE purpose = ?')
    db.transaction(() => { for (const purpose of drop) del.run(purpose) })()
    // Freed pages can still hold earlier versions of rows (an overwritten key, an older credential).
    db.exec('VACUUM')
    return drop.length
  } finally {
    try { db.close() } catch { /* closed */ }
  }
}

/**
 * A consistent copy of `filePath` in a fresh temp folder: `export` is the
 * whole file (SQLite online backup, safe while the agent runs and writes),
 * minus its plain secrets unless `includeSecrets` (stripPlainSecrets);
 * `share` is the identity-free copy Studio's Share and Save a copy… make
 * (AdfDatabase.snapshotForSend).
 */
export async function snapshotToTemp(filePath: string, mode: SnapshotMode, opts: { includeSecrets?: boolean } = {}): Promise<TempSnapshot & { secretsRemoved: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'adf-snapshot-'))
  const file = join(dir, basename(filePath))
  const cleanup = async () => {
    for (const p of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      try { await unlink(p) } catch { /* not there */ }
    }
    try { await rmdir(dir) } catch { /* not empty: leave it */ }
  }
  try {
    let secretsRemoved = 0
    if (mode === 'share') await AdfDatabase.snapshotForSend(filePath, file)
    else {
      await AdfDatabase.snapshotTo(filePath, file)
      if (!opts.includeSecrets) secretsRemoved = stripPlainSecrets(file)
    }
    return { file, size: (await stat(file)).size, cleanup, secretsRemoved }
  } catch (err) {
    await cleanup()
    throw err
  }
}

/** Snapshot folders older than this were left by a daemon that died mid-download (a download takes minutes at most). */
export const STALE_SNAPSHOT_MS = 60 * 60 * 1000
const SNAPSHOT_PREFIX = 'adf-snapshot-'

/**
 * Daemon boot: remove `adf-snapshot-*` folders in the temp dir that a
 * previous run left behind (killed while a snapshot streamed). Only folders
 * older than STALE_SNAPSHOT_MS (another daemon on this machine may be
 * streaming one now) that hold plain files only: anything else (a link, a
 * subfolder) is left alone and never followed. Returns the folders removed.
 */
export async function sweepStaleSnapshots(opts: { dir?: string; now?: number } = {}): Promise<string[]> {
  const root = opts.dir ?? tmpdir()
  const cutoff = (opts.now ?? Date.now()) - STALE_SNAPSHOT_MS
  const removed: string[] = []
  let names: string[]
  try { names = await readdir(root) } catch { return removed }
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue
    const dir = join(root, name)
    try {
      const st = await lstat(dir)
      if (!st.isDirectory() || st.isSymbolicLink() || st.mtimeMs > cutoff) continue
      const entries = await readdir(dir, { withFileTypes: true })
      if (!entries.every((e) => e.isFile())) continue
      for (const e of entries) await unlink(join(dir, e.name))
      await rmdir(dir)
      removed.push(dir)
    } catch (err) {
      console.warn(`[FileOps] Could not remove the leftover snapshot folder ${dir}:`, err instanceof Error ? err.message : err)
    }
  }
  return removed
}

/** A read stream of a temp snapshot that removes it once the stream closes. */
export function streamSnapshot(snapshot: TempSnapshot): ReadStream {
  const stream = createReadStream(snapshot.file)
  stream.once('close', () => { void snapshot.cleanup() })
  return stream
}

// --- Byte-capped bodies ------------------------------------------------------------

function tooLarge(maxBytes: number): FileOpError {
  return new FileOpError(`The body is larger than the ${Math.round(maxBytes / (1024 * 1024))} MiB this route accepts`, 413, 'too_large', { maxBytes })
}

function isReadable(value: unknown): value is Readable {
  return !!value && typeof (value as Readable).on === 'function' && typeof (value as Readable).pause === 'function'
}

function notOctetStream(): FileOpError {
  return new FileOpError('Send the file as the request body (Content-Type: application/octet-stream)', 415, 'unsupported_media_type')
}

/**
 * Read `body` chunk by chunk, handing each to `sink`. Past `maxBytes` the
 * stream is paused and left unread, and 413 too_large is thrown: the route
 * answers with Connection: close and destroys the request once the answer
 * is out (closeAfterResponse), so an oversized upload is never drained.
 */
function consumeCapped(body: Readable, maxBytes: number, sink: (chunk: Buffer) => boolean | void, onDrainNeeded?: (resume: () => void) => void): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    let total = 0
    const cleanup = () => {
      body.off('data', onData)
      body.off('end', onEnd)
      body.off('error', onError)
    }
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buf.length
      if (total > maxBytes) {
        cleanup()
        body.pause()
        reject(tooLarge(maxBytes))
        return
      }
      if (sink(buf) === false && onDrainNeeded) {
        body.pause()
        onDrainNeeded(() => body.resume())
      }
    }
    const onEnd = () => { cleanup(); resolvePromise(total) }
    const onError = (err: unknown) => { cleanup(); reject(err) }
    body.on('data', onData)
    body.once('end', onEnd)
    body.once('error', onError)
    body.resume()
  })
}

/** Collect a request body into memory, refusing more than `maxBytes` (413 too_large). */
export async function readCapped(body: unknown, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw tooLarge(maxBytes)
    return body
  }
  if (!isReadable(body)) throw notOctetStream()
  const chunks: Buffer[] = []
  const total = await consumeCapped(body, maxBytes, chunk => { chunks.push(chunk) })
  return Buffer.concat(chunks, total)
}

/** Write a request body to a new file `dest`, refusing more than `maxBytes`. Removes `dest` on any failure. */
async function writeCapped(body: unknown, dest: string, maxBytes: number): Promise<number> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw tooLarge(maxBytes)
    await writeFile(dest, body, { flag: 'wx' })
    return body.length
  }
  if (!isReadable(body)) throw notOctetStream()
  const out = createWriteStream(dest, { flags: 'wx' })
  const opened = new Promise<void>((ok, fail) => { out.once('open', () => ok()); out.once('error', fail) })
  try {
    await opened
    let writeError: unknown = null
    out.on('error', err => { writeError = err })
    const total = await consumeCapped(body, maxBytes, chunk => out.write(chunk), resume => out.once('drain', resume))
    await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())))
    if (writeError) throw writeError
    return total
  } catch (err) {
    if (!out.closed) {
      const closed = new Promise(r => out.once('close', r))
      out.destroy()
      await closed
    }
    try { await unlink(dest) } catch { /* not created */ }
    throw err
  }
}

/**
 * Move `src` to `dest` only if `dest` does not exist, atomically: a hard
 * link fails with EEXIST instead of replacing a file that appeared in the
 * meantime (a check-then-rename would overwrite it). Volumes without hard
 * links fall back to an exclusive copy (COPYFILE_EXCL).
 */
async function moveNoClobber(src: string, dest: string, what: string): Promise<void> {
  try {
    await link(src, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new FileOpError(`${what} already exists`, 409, 'name_taken')
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw err
    try {
      await copyFile(src, dest, fsConstants.COPYFILE_EXCL)
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') throw new FileOpError(`${what} already exists`, 409, 'name_taken')
      throw copyErr
    }
  }
  try { await unlink(src) } catch (err) { console.warn(`[FileOps] Work file ${basename(src)} was not removed:`, err) }
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

/** The .adf files under `dirs` (autostart scan rules), read asynchronously. */
async function scanAdfFilesAsync(dirs: string[], maxDepth: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.adf')) out.push(join(dir, e.name))
      else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(join(dir, e.name), depth + 1)
    }
  }
  for (const dir of dirs) await walk(dir, 0)
  return out
}

const yieldToLoop = () => new Promise<void>(r => setImmediate(r))

// --- Leases ------------------------------------------------------------------------

// leaseHolderElsewhere moved to runtime/agent-lease.ts (the boot envelope sweep of both modes uses it).
export { leaseHolderElsewhere }

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

/** Why an upload's identity was replaced: its config id or DID matched an agent known here. */
export type ImportCollision = 'reviewed' | 'loaded' | 'tracked'

export interface ImportResult {
  success: true
  filePath: string
  name: string
  agentId: string
  /** Always false: an imported file runs only after the owner reviews it here. */
  reviewed: false
  /**
   * The upload's config id or DID is already known here (reviewed, loaded, or
   * a file in a tracked folder): it got a fresh id and its identity was
   * stripped (as a registry agent brought home), so it is neither a twin of
   * that agent nor covered by its review. Claiming it mints a new DID.
   */
  idReassigned?: { previousId: string; reason: ImportCollision; identityStripped: true }
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
  /** Not loaded: whether its config id is in reviewedAgents (Studio's background-start review gate). */
  reviewed?: boolean
  /** Not loaded: the file has a legacy whole-file password (Studio's background-start password gate). */
  passwordProtected?: boolean
  error?: string
}

/** How long DELETE waits for a running agent to stop before it gives up (the stop goes on). */
const DELETE_UNLOAD_DEADLINE_MS = 15_000

export class AgentFileOps {
  constructor(private readonly deps: FileOpsDeps) {}

  private get runtime(): FileOpsRuntime { return this.deps.runtime }

  private get leases(): AgentLeaseRegistry | null {
    return this.deps.leases === undefined ? processAgentLeases() : this.deps.leases
  }

  private async agentsFolder(): Promise<string> {
    return this.deps.agentsFolder ? this.deps.agentsFolder() : (await resolveAgentsFolder(this.deps.settings)).path
  }

  /** requireAdfPath with the tracked folders as the allowed UNC roots. */
  adfPath(input: unknown, opts: Omit<AdfPathOptions, 'uncRoots'> = {}): Promise<string> {
    return requireAdfPath(input, { ...opts, uncRoots: storedDirs(this.deps.settings ?? { get: () => undefined }) })
  }

  /** 409 agent_leased when another runtime runs the agent of `filePath`. */
  async assertNotLeasedElsewhere(filePath: string): Promise<void> {
    const message = await leaseHolderElsewhere(this.leases, filePath)
    if (message) throw new FileOpError(message, 409, AGENT_LEASED_CODE)
  }

  /** The name a running agent's file takes when it stops (RuntimeService's deferred rename). */
  pendingName(filePath: string): string | undefined {
    return this.runtime.getPendingRename(filePath)
  }

  /** The agent loaded from `filePath` here, if any. */
  loadedAt(filePath: string): RuntimeAgentSummary | undefined {
    const key = keyOf(filePath)
    return this.runtime.listAgents().find(a => a.filePath && keyOf(a.filePath) === key)
  }

  /** The agent running from `filePath` here, else the open document of it (D4): its workspace is the one to act on. */
  liveAgent(filePath: string): RuntimeLiveAgent | undefined {
    const key = keyOf(filePath)
    const live = this.runtime.listLiveAgents().find(a => keyOf(a.filePath) === key)
    if (live) return live
    const open = this.runtime.getAgentWorkspaceByPath?.(filePath)
    if (!open?.filePath) return undefined
    return { agentId: open.agentId, filePath: open.filePath, executorState: 'stopped', workspace: open.workspace, getContextGauge: () => undefined }
  }

  /** The open document of `filePath` (D4), running or not. */
  openDocumentAt(filePath: string): { agentId: string; running: boolean } | undefined {
    const doc = this.runtime.getOpenDocument?.(filePath)
    return doc ? { agentId: doc.agentId, running: doc.running } : undefined
  }

  /** GET /files/agent: the path → id rule. */
  async describe(input: unknown): Promise<PathAgentInfo> {
    const filePath = await this.adfPath(input)
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
      ...(peek.status
        ? { reviewed: isConfigReviewed(this.deps.settings?.get('reviewedAgents'), peek.config), passwordProtected: peek.status.hasEncryptedIdentity }
        : { error: peek.error ? `Not a readable .adf: ${peek.error}` : 'Not a readable .adf.' }),
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
   * A file that is already gone is not an error. A file another runtime
   * runs is refused (409 agent_leased); so is a path through a link.
   */
  async delete(input: unknown): Promise<DeleteResult> {
    const filePath = await this.adfPath(input, { mustExist: false, destructive: true })
    const loaded = this.loadedAt(filePath)
    if (!loaded) await this.assertNotLeasedElsewhere(filePath)
    // Before the unload: a pending rename would move the file away from the delete.
    const pending = this.runtime.cancelPendingRename(filePath)
    if (loaded) {
      console.log(`[FileOps] Stopping ${loaded.name} before deleting ${filePath}`)
      const deadlineMs = this.deps.unloadDeadlineMs ?? DELETE_UNLOAD_DEADLINE_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const stopped = await Promise.race([
        this.runtime.unloadAgent(loaded.id).then(() => true),
        new Promise<false>(r => { timer = setTimeout(() => r(false), deadlineMs) }),
      ]).finally(() => clearTimeout(timer))
      if (!stopped) {
        if (pending) this.runtime.syncAgentFileToName(filePath, pending)
        console.warn(`[FileOps] ${loaded.name} did not stop within ${deadlineMs / 1000}s; ${filePath} was not deleted`)
        throw new FileOpError(`${loaded.name} did not stop within ${deadlineMs / 1000} s, so its file was not deleted. It is still stopping; try again.`, 409, 'stop_timeout')
      }
    }
    // The open document (D4) goes with the file, for every client holding it.
    if (this.runtime.closeDocument?.(filePath, 'deleted')) console.log(`[FileOps] Closed the open document ${filePath} before deleting it`)
    await removeAdfFiles(filePath)
    forgetTrackedFile(filePath)
    console.log(`[FileOps] Deleted ${filePath}`)
    this.deps.events.notifyPathChanged(filePath)
    return { success: true, filePath, stopped: !!loaded, ...(loaded ? { agentId: loaded.id } : {}) }
  }

  /**
   * FILE_RENAME. A running agent keeps running under its file, its lease and
   * its mesh registration: its name changes now and RuntimeService moves the
   * file when it stops (syncAgentFileToName; SQLite files cannot move under
   * an open handle on Windows), emitting 'agent-file-renamed'. A stopped
   * agent's file is renamed here, now: after the lease check, by inode (so a
   * case-only rename works on case-insensitive volumes), folded WAL first.
   */
  /**
   * `opts.origin`: the client session asking (X-ADF-Client-Session). A running
   * agent's live name change is that session's own write: its config_changed
   * echo skips that session (D5.1), as Studio's rename pushes nothing to the
   * window that renamed.
   */
  async rename(input: unknown, newNameInput: unknown, opts: { origin?: string } = {}): Promise<RenameResult> {
    const filePath = await this.adfPath(input, { destructive: true })
    const newName = typeof newNameInput === 'string' ? newNameInput.trim() : ''
    const problem = agentFileNameProblem(newName)
    if (problem) throw new FileOpError(problem, 400, 'invalid_name')
    const newPath = join(dirname(filePath), `${newName}.adf`)
    if (newPath !== filePath && await pathExists(newPath) && !(await sameFile(newPath, filePath))) {
      throw new FileOpError(`A file named "${newName}.adf" already exists.`, 409, 'name_taken')
    }
    const loaded = this.loadedAt(filePath)
    if (loaded) {
      const { config } = this.runtime.getAgentConfig(loaded.id)
      if (config.name !== newName) {
        const write = () => this.runtime.setAgentConfig(loaded.id, { ...config, name: newName })
        await (opts.origin ? runAsClientWrite(opts.origin, write) : write())
      }
      const sync = this.runtime.syncAgentFileToName(filePath, newName)
      if (sync.error) throw new FileOpError(sync.error, 409, 'conflict')
      if (!sync.deferred) return { success: true, filePath, renameDeferred: false, agentId: loaded.id }
      console.log(`[FileOps] ${loaded.name} is running: renamed to "${newName}" now; ${basename(filePath)} becomes ${newName}.adf when it stops`)
      this.deps.events.notifyPathChanged(filePath)
      return { success: true, filePath, renameDeferred: true, agentId: loaded.id }
    }
    await this.assertNotLeasedElsewhere(filePath)
    const open = this.openDocumentAt(filePath)
    if (open) {
      // Open here without a runtime: RuntimeService closes the document's
      // workspace, moves the file and reopens it, as Studio renames its open
      // file (performAdfRename); 'agent-file-renamed' feeds file_renamed.
      this.deps.events.expectFile(newPath)
      const sync = this.runtime.syncAgentFileToName(filePath, newName)
      if (sync.error) throw new FileOpError(sync.error, 409, 'conflict')
      const at = sync.filePath ?? filePath
      this.deps.events.notifyPathChanged(at)
      return { success: true, filePath: at, renameDeferred: false, agentId: open.agentId }
    }
    return this.performRename(filePath, newName)
  }

  private async performRename(filePath: string, newName: string): Promise<RenameResult> {
    const newPath = join(dirname(filePath), `${newName}.adf`)
    const moves = newPath !== filePath
    if (moves) {
      if (await pathExists(newPath) && !(await sameFile(newPath, filePath))) {
        throw new FileOpError(`A file named "${newName}.adf" already exists.`, 409, 'name_taken')
      }
      if (!checkpointBeforeMove(filePath)) {
        throw new FileOpError('WAL sidecars could not be checkpointed (another process has the file open); rename aborted to avoid losing unflushed data.', 409, 'file_busy')
      }
      // The move is the owner's, not a new agent: the watcher must not autostart it.
      this.deps.events.expectFile(newPath)
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
    if (moves) {
      forgetTrackedFile(filePath)
      console.log(`[FileOps] Renamed ${filePath} -> ${newPath}`)
      this.deps.events.notifyRenamed(filePath, newPath)
    }
    this.deps.events.notifyPathChanged(newPath)
    return { success: true, filePath: newPath, renameDeferred: false, agentId }
  }

  /** A file this module moved: re-key the runtime's path indexes and lease if it holds the path (W1-A). */
  private async rekey(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.runtime.rekeyAgentPath(oldPath, newPath)
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
    const filePath = await this.adfPath(input)
    if (!Array.isArray(selectedTables) || !selectedTables.every(t => typeof t === 'string')) {
      throw new FileOpError('selectedTables must be an array of table names', 400, 'bad_request')
    }
    const identity = this.deps.identity
    // Without the owner identity the clone is still made, as Studio makes it
    // (keys not sealed to an owner), said in the log and in `warnings`.
    const identityMissing = identity && !identity.isReady()
      ? `The owner identity is not set up yet, so the clone's identity is not sealed to an owner. ${identity.status().message ?? ''}`.trim()
      : null
    if (identityMissing) console.warn(`[FileOps] ${identityMissing}`)
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
      warnings: identityMissing ? [...result.fixup.warnings, identityMissing] : result.fixup.warnings,
    }
  }

  /**
   * Studio's "Save a copy…" on this host: the identity-free share snapshot
   * (AdfDatabase.snapshotForSend), never a full copy. A full copy keeps the
   * agent's config.id and DID, so in a tracked folder it would pass review
   * as the original and could autostart as its twin. Built on a .partial;
   * without `overwrite` an existing destination is never replaced, even one
   * that appears while the copy is written.
   */
  async saveAs(input: unknown, destInput: unknown, overwrite: boolean): Promise<{ success: true; filePath: string; size: number }> {
    const filePath = await this.adfPath(input)
    const dest = await this.adfPath(destInput, { mustExist: false, field: 'destPath', destructive: true })
    if (await sameFile(dest, filePath)) {
      throw new FileOpError('Choose a different file: a copy cannot overwrite the agent it came from', 409, 'same_file')
    }
    try {
      if (!(await stat(dirname(dest))).isDirectory()) throw new Error('not a folder')
    } catch {
      throw new FileOpError(`The folder does not exist: ${dirname(dest)}`, 400, 'bad_request')
    }
    const exists = await pathExists(dest)
    if (exists && !overwrite) throw new FileOpError(`${basename(dest)} already exists`, 409, 'name_taken')
    if (exists) {
      if (this.loadedAt(dest)) throw new FileOpError(`${basename(dest)} is a running agent`, 409, 'agent_running')
      await this.assertNotLeasedElsewhere(dest)
    }
    const partial = `${dest}.${randomUUID().slice(0, 8)}.partial`
    this.deps.events.expectFile(dest)
    try {
      await AdfDatabase.snapshotForSend(filePath, partial)
      if (overwrite) {
        for (const side of ['-wal', '-shm']) { try { await unlink(`${dest}${side}`) } catch { /* none */ } }
        await rename(partial, dest)
      } else {
        await moveNoClobber(partial, dest, basename(dest))
      }
    } catch (err) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { await unlink(`${partial}${suffix}`) } catch { /* none */ }
      }
      throw err
    }
    console.log(`[FileOps] Saved a shareable copy of ${filePath} to ${dest}`)
    this.deps.events.notifyPathChanged(dest)
    return { success: true, filePath: dest, size: (await stat(dest)).size }
  }

  /** GET /agents/:id/export: the file of a loaded agent, else of a tracked file with that config id (async scan). */
  async resolveAgentFile(agentId: string): Promise<string> {
    const ref = this.runtime.getAgent(agentId)
    if (ref) {
      if (!ref.filePath) throw new FileOpError(`Agent "${agentId}" has no file (in-memory agent)`, 409, 'not_file_backed')
      return ref.filePath
    }
    const settings = this.deps.settings
    if (settings) {
      for (const file of await scanAdfFilesAsync(storedDirs(settings), maxDepthOf(settings))) {
        if (peekBootStatusCached(file).status?.agentId === agentId) return file
        await yieldToLoop()
      }
    }
    throw new FileOpError(`Unknown agent "${agentId}"`, 404, 'not_found')
  }

  /**
   * POST /files/import: an .adf sent from another machine lands in a tracked
   * folder (or the agents folder, which is then tracked). It is never treated
   * as reviewed, and the watcher does not autostart it. Review and loading
   * are keyed on config.id, so an upload whose id or DID matches an agent
   * known here (reviewed, loaded, or a file in a tracked folder) gets a fresh
   * id and loses its identity (AdfDatabase.stripIdentity, as bring-home
   * does): it can be neither that agent's twin nor pass its review. It runs
   * only after the owner reviews (claims) it here.
   */
  async import(body: unknown, opts: { directory?: unknown; name?: unknown; unique?: boolean; maxBytes: number }): Promise<ImportResult> {
    const directory = await this.importDirectory(opts.directory)
    const rawName = typeof opts.name === 'string' ? opts.name.trim().replace(/\.adf$/i, '') : ''
    const problem = agentFileNameProblem(rawName)
    if (problem) throw new FileOpError(`name must be a file name: ${problem}`, 400, 'invalid_name')
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
    let idReassigned: ImportResult['idReassigned']
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
      const did = AdfDatabase.peekMessagingConfig(partial)?.did ?? null
      const reason = isConfigReviewed(this.deps.settings?.get('reviewedAgents'), peek.config) ? 'reviewed' : await this.knownAgent(agentId, did)
      if (reason) {
        const fresh = nanoid(12)
        AdfDatabase.stripIdentity(partial)
        reassignConfigId(partial, fresh)
        idReassigned = { previousId: agentId, reason, identityStripped: true }
        console.warn(`[FileOps] Import of ${rawName}: config id ${agentId}${did ? ` / ${did}` : ''} is already ${reason} here; the upload gets id ${fresh} without that identity and needs its own review`)
        agentId = fresh
      }
      this.deps.events.expectFile(target)
      await moveNoClobber(partial, target, basename(target))
    } catch (err) {
      await discard()
      throw err
    }
    console.log(`[FileOps] Imported ${basename(target)} (${size} bytes) into ${directory}; it needs review before it runs`)
    this.fileCreated(target)
    return { success: true, filePath: target, name: basename(target, '.adf'), agentId, reviewed: false, ...(idReassigned ? { idReassigned } : {}), size }
  }

  /** Is an agent with this config id or DID loaded here, or in a tracked folder? (async scan) */
  private async knownAgent(agentId: string, did: string | null): Promise<ImportCollision | null> {
    if (this.runtime.listAgents().some(a => a.id === agentId)) return 'loaded'
    if (did && this.runtime.listLiveAgents().some(a => { try { return a.workspace.getDid() === did } catch { return false } })) return 'loaded'
    const settings = this.deps.settings
    if (!settings) return null
    for (const file of await scanAdfFilesAsync(storedDirs(settings), maxDepthOf(settings))) {
      const peek = AdfDatabase.peekMessagingConfig(file)
      if (peek && (peek.id === agentId || (did && peek.did === did))) return 'tracked'
      await yieldToLoop()
    }
    return null
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
      real = stripLongPathPrefix(await realpath(dir))
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
    const filePath = await this.adfPath(input, { destructive: true })
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
    const holder = await leaseHolderElsewhere(this.leases, filePath)
    if (holder) return fallback(new Error(holder))
    let dest: string
    try {
      const folder = await this.agentsFolder()
      await mkdir(folder, { recursive: true })
      dest = await availableAdfPath(folder, basename(filePath, '.adf'))
    } catch (err) {
      return fallback(err)
    }
    const move = async (): Promise<'moved' | 'copied-source-remains' | { error: unknown }> => {
      if (!checkpointBeforeMove(filePath)) {
        return { error: new Error('WAL sidecars could not be checkpointed; move aborted to avoid losing unflushed data') }
      }
      this.deps.events.expectFile(dest)
      try { return await moveFileWithFallback(filePath, dest) } catch (err) { return { error: err } }
    }
    let result: Awaited<ReturnType<typeof move>>
    try {
      // An open document (D4) is closed for the move and reopened where the file went.
      result = this.runtime.withDocumentMoved
        ? await this.runtime.withDocumentMoved(filePath, async () => {
            const r = await move()
            return { value: r, movedTo: typeof r === 'string' ? dest : null }
          })
        : await move()
    } catch (err) {
      return fallback(err)
    }
    if (typeof result !== 'string') return fallback(result.error)
    const outcome = result
    await this.rekey(filePath, dest)
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
   * A new agent file exists (clone, import, relocate): the watcher does not
   * autostart it (the owner placed it; it starts when they start it); its
   * folder is tracked when no tracked folder covers it (Studio's
   * notifyAdfFileCreated), which re-syncs the watcher, tells the mesh and
   * pushes `tracked_dirs`; else `tracked_dirs` is pushed for the covering root.
   */
  fileCreated(filePath: string): void {
    this.deps.events.expectFile(filePath)
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

/** Give a closed .adf a new config.id in place (one plain connection, no migration). */
function reassignConfigId(filePath: string, id: string): void {
  const db = new Database(filePath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    db.prepare("UPDATE adf_config SET config_json = json_set(config_json, '$.id', ?) WHERE id = 1").run(id)
    try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function keyOf(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return resolve(filePath) }
}
