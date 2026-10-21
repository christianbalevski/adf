/**
 * W3-F: recovery copies of unsaved text the "changed elsewhere" notice is
 * holding. While an editor tab (or the config panel) has a conflict, the
 * renderer keeps a copy of the user's version at
 * `<userData>/recovered/<agent>-<hash>/<path>` (the agent's file name, and
 * a hash of its full path so two `agent-1.adf` in different folders never
 * share one); resolving the conflict (Reload,
 * Keep mine, or discarding it on close or agent switch) removes it. So a
 * quit or a crash with the notice still up leaves the copy behind, and the
 * next launch lists it (a notice with Show folder and Dismiss; Dismiss moves
 * the copies under `recovered/archive/<time>/`). The archive keeps 30 days
 * and at most 50 dismissals; older ones are removed (logged).
 *
 * The copies are the user's text: folders 0700 and files 0600; on Windows
 * each file gets the current-user-only ACL W3-B uses for the local proof
 * (restrictToCurrentUserWindows), set before the text is written.
 *
 * `local` channels (design D2): Studio-side files, one implementation for
 * both backends, registered in main/index.ts outside registerAllIpcHandlers.
 *
 * Runtimes (multi-runtime.md §4.5): a copy of an agent on a runtime other
 * than the primary names it (`runtimeId`). Its folder hash covers the
 * runtime, and `<folder>.runtime` next to the folder holds the id, so the copy is
 * offered on its runtime. A copy without it is the primary runtime's, laid
 * out exactly as before.
 *
 * Hand-offs (multi-runtime.md §20 item 3): the copies a reconnect, a move or
 * Remove keeps (`kept`: the hand-off's stamp) go to a folder of their own,
 * `<agent>-<hash>~kept-<stamp>`, so a later notice on the same file, its
 * removal, and the next hand-off never write over or remove them.
 */
import { shell } from 'electron'
// Studio-scope channels refuse a runtime tag (docs/design/multi-runtime.md §4.2).
import { ipcMain } from './studio-ipc'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { IPC } from '../../shared/constants/ipc-channels'
import { restrictToCurrentUserWindows } from '../daemon/local-access'

export interface RecoveryStash {
  /** The agent's .adf path; its file name (without .adf) names the folder. */
  agentFilePath: string
  /** The internal file path (`config.json` for the config panel). */
  path: string
  /** The user's text; null removes the copy. */
  content: string | null
  /** The agent's runtime; omitted for the primary runtime. */
  runtimeId?: string
  /** A hand-off's stamp (letters, digits and `-`): the copy goes to that hand-off's own folder. Never removed this way. */
  kept?: string
}

export interface RecoveredFile {
  /** The agent's file name (without .adf). */
  agent: string
  /** Its folder under the root (`<agent>-<hash>`). */
  folder: string
  path: string
  /** Absolute path of the copy. */
  file: string
  modifiedAt: number
  /** The agent's runtime; omitted for the primary runtime. */
  runtimeId?: string
  /** Kept by a hand-off (a reconnect, a move, Remove), not by a notice. */
  kept?: boolean
}

const ARCHIVE = 'archive'
/** Archive retention: dismissals older than this, or beyond the newest MAX, are removed. */
export const ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const ARCHIVE_MAX_ENTRIES = 50
const HASH_SUFFIX = /-[0-9a-f]{8}$/
/** `<root>/<agent folder>.runtime`: the runtime id of an agent folder of another runtime. */
const RUNTIME_SUFFIX = '.runtime'
/** `<agent folder>~kept-<stamp>`: a hand-off's copies. */
const KEPT_SUFFIX = /~kept-[0-9A-Za-z-]+$/
const KEPT_STAMP = /^[0-9A-Za-z-]{1,64}$/

/** The folder of an agent's copies: the notice's, or a hand-off's (`kept`). */
function copiesFolder(stash: Pick<RecoveryStash, 'agentFilePath' | 'runtimeId' | 'kept'>): string {
  const folder = agentFolder(stash.agentFilePath, process.platform, stash.runtimeId)
  return stash.kept ? `${folder}~kept-${stash.kept}` : folder
}

/**
 * The folder an agent's copies live in: its file name (readable, without
 * characters a folder name cannot hold) and the first 8 hex digits of the
 * sha256 of its full path (case-folded on Windows), so two files of one
 * name in different folders keep separate copies.
 */
export function agentFolder(agentFilePath: string, platform: NodeJS.Platform = process.platform, runtimeId?: string): string {
  const path = platform === 'win32' ? win32 : posix
  const name = (runtimeId ? agentFilePath.split(/[\\/]/).pop() ?? '' : path.basename(agentFilePath)).replace(/\.adf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || '_'
  // Another runtime's path is that computer's: hashed as written, with the runtime id, never resolved here.
  const full = runtimeId ? `${runtimeId}\n${agentFilePath}` : path.resolve(agentFilePath)
  const hash = createHash('sha256').update(platform === 'win32' && !runtimeId ? full.toLowerCase() : full).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

/** Windows: the current-user-only ACL, without blocking the main process on icacls. */
async function restrictFile(file: string): Promise<void> {
  let done: Promise<void> = Promise.resolve()
  restrictToCurrentUserWindows(file, (cmd, args) => {
    done = new Promise((ok, fail) => execFile(cmd, args, { windowsHide: true }, (err) => (err ? fail(err) : ok())))
  })
  await done
}

/**
 * `<root>/<agent>/<path>`, or null when `path` would leave the agent's folder.
 * A `..` segment is refused with either separator on every platform: `\` is
 * a file name character on macOS and Linux, but a copy named `..\x` would
 * climb out wherever it is opened on Windows.
 */
export function recoveryFile(root: string, agentFilePath: string, path: string, runtimeId?: string, kept?: string): string | null {
  if (!path || path.includes('\0') || /^[a-zA-Z]:|^[\\/]/.test(path)) return null
  if (path.split(/[\\/]/).includes('..')) return null
  if (kept !== undefined && !KEPT_STAMP.test(kept)) return null
  const folder = join(root, copiesFolder({ agentFilePath, runtimeId, kept }))
  const file = resolve(folder, path)
  return file.startsWith(folder + sep) ? file : null
}

/** Write or remove one copy. Answers whether it was done. */
export async function stashRecovery(root: string, stash: RecoveryStash): Promise<boolean> {
  // A hand-off's copy is never removed by a stash: only Dismiss moves it.
  if (stash.kept !== undefined && stash.content === null) return false
  const file = recoveryFile(root, stash.agentFilePath, stash.path, stash.runtimeId, stash.kept)
  if (!file) return false
  const folder = join(root, copiesFolder(stash))
  if (stash.content === null) {
    await rm(file, { force: true })
    // An agent folder left empty goes too (never the root, never one with other copies).
    if (dirname(file) !== root) {
      const removed = await rmdir(dirname(file)).then(() => true, () => false /* not empty, or gone */)
      if (removed && stash.runtimeId && dirname(file) === folder) await rm(folder + RUNTIME_SUFFIX, { force: true })
    }
    return true
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  if (stash.runtimeId) await writeFile(folder + RUNTIME_SUFFIX, stash.runtimeId, { encoding: 'utf-8', mode: 0o600 })
  if (process.platform === 'win32') {
    // Protect first, write the text after (as the local proof).
    await writeFile(file, '', { mode: 0o600 })
    try {
      await restrictFile(file)
    } catch (err) {
      // Keeping the text under the profile's inherited ACL beats losing it.
      console.warn(`[Recovery] Could not restrict ${file} to the current user (icacls); the copy keeps the folder's permissions:`, err instanceof Error ? err.message : err)
    }
  }
  await writeFile(file, stash.content, { encoding: 'utf-8', mode: 0o600 })
  return true
}

/** Every copy outside the archive. */
export async function listRecovered(root: string): Promise<RecoveredFile[]> {
  const out: RecoveredFile[] = []
  const runtimes = new Map<string, string | null>()
  const runtimeOf = async (folder: string): Promise<string | null> => {
    if (!runtimes.has(folder)) {
      const marker = join(root, folder + RUNTIME_SUFFIX)
      const st = await lstat(marker).catch(() => null)
      runtimes.set(folder, st?.isFile() ? (await readFile(marker, 'utf-8').catch(() => '')).trim() || null : null)
    }
    return runtimes.get(folder) ?? null
  }
  const walk = async (dir: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // Links are never followed (junction safety); only plain files count.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (dir === root && entry.name === ARCHIVE) continue
        await walk(full)
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep)
        if (rel.length === 1 && rel[0].endsWith(RUNTIME_SUFFIX)) continue
        const runtimeId = rel.length > 1 ? await runtimeOf(rel[0]) : null
        const kept = KEPT_SUFFIX.test(rel[0])
        out.push({ agent: rel[0].replace(KEPT_SUFFIX, '').replace(HASH_SUFFIX, ''), folder: rel[0], path: rel.slice(1).join('/'), file: full, modifiedAt: (await stat(full)).mtimeMs, ...(runtimeId ? { runtimeId } : {}), ...(kept ? { kept } : {}) })
      }
    }
  }
  await walk(root)
  return out.sort((a, b) => a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path) || a.folder.localeCompare(b.folder))
}

/** Dismiss: move every copy listed now under `archive/<time>/`. Answers how many moved. */
export async function archiveRecovered(root: string, now = new Date()): Promise<number> {
  const files = await listRecovered(root)
  if (files.length === 0) return 0
  const target = join(root, ARCHIVE, now.toISOString().replace(/[:.]/g, '-'))
  for (const f of files) {
    const to = join(target, f.folder, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    await rename(f.file, to)
  }
  for (const folder of new Set(files.map((f) => f.folder))) {
    await rmdir(join(root, folder)).catch(() => { /* not empty: copies arrived meanwhile */ })
  }
  // Another runtime's folders: the archived copies keep their runtime; the marker stays only while copies remain.
  const remaining = new Set((await listRecovered(root)).map((f) => f.folder))
  for (const folder of new Set(files.filter((f) => f.runtimeId).map((f) => f.folder))) {
    const marker = join(root, folder + RUNTIME_SUFFIX)
    await writeFile(join(target, folder + RUNTIME_SUFFIX), await readFile(marker, 'utf-8').catch(() => ''), { encoding: 'utf-8', mode: 0o600 }).catch(() => {})
    if (!remaining.has(folder)) await rm(marker, { force: true })
  }
  await pruneArchive(root, now)
  return files.length
}

/**
 * Remove dismissals older than ARCHIVE_MAX_AGE_MS and all but the newest
 * ARCHIVE_MAX_ENTRIES (the folder name is the dismissal time). Only plain
 * folders are removed; a link is left alone (junction safety). Answers the
 * names removed.
 */
export async function pruneArchive(root: string, now = new Date()): Promise<string[]> {
  const archive = join(root, ARCHIVE)
  let names: string[]
  try { names = (await readdir(archive)).sort() } catch { return [] }
  const entries: Array<{ name: string; time: number }> = []
  for (const name of names) {
    const st = await lstat(join(archive, name)).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue
    entries.push({ name, time: st.mtimeMs })
  }
  const keep = new Set(entries.slice(-ARCHIVE_MAX_ENTRIES).filter((e) => now.getTime() - e.time <= ARCHIVE_MAX_AGE_MS).map((e) => e.name))
  const removed: string[] = []
  for (const e of entries) {
    if (keep.has(e.name)) continue
    await rm(join(archive, e.name), { recursive: true, force: true })
    removed.push(e.name)
  }
  if (removed.length) console.log(`[Recovery] Removed ${removed.length} dismissed recovery cop${removed.length === 1 ? 'y' : 'ies'} older than 30 days or beyond the newest ${ARCHIVE_MAX_ENTRIES}: ${removed.join(', ')}`)
  return removed
}

/** The recovery channels; `root` is `<userData>/recovered`. */
export function registerEditRecoveryHandlers(root: string): void {
  void pruneArchive(root).catch((err) => console.warn('[Recovery] Could not prune the archive:', err))
  ipcMain.handle(IPC.RECOVERY_STASH, async (_event, stash: RecoveryStash) => {
    if (!stash || typeof stash.agentFilePath !== 'string' || typeof stash.path !== 'string' || (stash.content !== null && typeof stash.content !== 'string')) return { success: false }
    if (stash.runtimeId !== undefined && (typeof stash.runtimeId !== 'string' || !stash.runtimeId || stash.runtimeId === 'local')) return { success: false }
    if (stash.kept !== undefined && (typeof stash.kept !== 'string' || typeof stash.content !== 'string')) return { success: false }
    try {
      return { success: await stashRecovery(root, stash) }
    } catch (err) {
      console.error('[Recovery] Could not keep a copy of unsaved text:', err)
      return { success: false }
    }
  })
  ipcMain.handle(IPC.RECOVERY_LIST, async () => ({ root, files: await listRecovered(root) }))
  ipcMain.handle(IPC.RECOVERY_ARCHIVE, async () => {
    const moved = await archiveRecovered(root)
    if (moved) console.log(`[Recovery] Moved ${moved} recovered cop${moved === 1 ? 'y' : 'ies'} under ${join(root, ARCHIVE)}`)
    return { moved }
  })
  ipcMain.handle(IPC.RECOVERY_REVEAL, async () => {
    await mkdir(root, { recursive: true })
    await shell.openPath(root)
    return { success: true }
  })
}
