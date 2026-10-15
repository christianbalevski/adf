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
 */
import { ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { IPC } from '../../shared/constants/ipc-channels'
import { restrictToCurrentUserWindows } from '../daemon/local-access'

export interface RecoveryStash {
  /** The agent's .adf path; its file name (without .adf) names the folder. */
  agentFilePath: string
  /** The internal file path (`config.json` for the config panel). */
  path: string
  /** The user's text; null removes the copy. */
  content: string | null
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
}

const ARCHIVE = 'archive'
/** Archive retention: dismissals older than this, or beyond the newest MAX, are removed. */
export const ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const ARCHIVE_MAX_ENTRIES = 50
const HASH_SUFFIX = /-[0-9a-f]{8}$/

/**
 * The folder an agent's copies live in: its file name (readable, without
 * characters a folder name cannot hold) and the first 8 hex digits of the
 * sha256 of its full path (case-folded on Windows), so two files of one
 * name in different folders keep separate copies.
 */
export function agentFolder(agentFilePath: string, platform: NodeJS.Platform = process.platform): string {
  const name = basename(agentFilePath).replace(/\.adf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || '_'
  const full = resolve(agentFilePath)
  const hash = createHash('sha256').update(platform === 'win32' ? full.toLowerCase() : full).digest('hex').slice(0, 8)
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

/** `<root>/<agent>/<path>`, or null when `path` would leave the agent's folder. */
export function recoveryFile(root: string, agentFilePath: string, path: string): string | null {
  if (!path || path.includes('\0') || /^[a-zA-Z]:|^[\\/]/.test(path)) return null
  const folder = join(root, agentFolder(agentFilePath))
  const file = resolve(folder, path)
  return file.startsWith(folder + sep) ? file : null
}

/** Write or remove one copy. Answers whether it was done. */
export async function stashRecovery(root: string, stash: RecoveryStash): Promise<boolean> {
  const file = recoveryFile(root, stash.agentFilePath, stash.path)
  if (!file) return false
  if (stash.content === null) {
    await rm(file, { force: true })
    // An agent folder left empty goes too (never the root, never one with other copies).
    if (dirname(file) !== root) await rmdir(dirname(file)).catch(() => { /* not empty, or gone */ })
    return true
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
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
        out.push({ agent: rel[0].replace(HASH_SUFFIX, ''), folder: rel[0], path: rel.slice(1).join('/'), file: full, modifiedAt: (await stat(full)).mtimeMs })
      }
    }
  }
  await walk(root)
  return out.sort((a, b) => a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path))
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
