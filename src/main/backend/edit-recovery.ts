/**
 * W3-F: recovery copies of unsaved text the "changed elsewhere" notice is
 * holding. While an editor tab (or the config panel) has a conflict, the
 * renderer keeps a copy of the user's version at
 * `<userData>/recovered/<agent>/<path>`; resolving the conflict (Reload,
 * Keep mine, or discarding it on close or agent switch) removes it. So a
 * quit or a crash with the notice still up leaves the copy behind, and the
 * next launch lists it (a notice with Show folder and Dismiss; Dismiss moves
 * the copies under `recovered/archive/<time>/`, nothing is deleted).
 *
 * `local` channels (design D2): Studio-side files, one implementation for
 * both backends, registered in main/index.ts outside registerAllIpcHandlers.
 */
import { ipcMain, shell } from 'electron'
import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { IPC } from '../../shared/constants/ipc-channels'

export interface RecoveryStash {
  /** The agent's .adf path; its file name (without .adf) names the folder. */
  agentFilePath: string
  /** The internal file path (`config.json` for the config panel). */
  path: string
  /** The user's text; null removes the copy. */
  content: string | null
}

export interface RecoveredFile {
  agent: string
  path: string
  /** Absolute path of the copy. */
  file: string
  modifiedAt: number
}

const ARCHIVE = 'archive'

/** The folder an agent's copies live in: its file name, without characters a folder name cannot hold. */
function agentFolder(agentFilePath: string): string {
  const name = basename(agentFilePath).replace(/\.adf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return !name || name === ARCHIVE || name === '.' || name === '..' ? `_${name}` : name
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
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, stash.content, 'utf-8')
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
        out.push({ agent: rel[0], path: rel.slice(1).join('/'), file: full, modifiedAt: (await stat(full)).mtimeMs })
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
    const to = join(target, f.agent, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await rename(f.file, to)
  }
  for (const agent of new Set(files.map((f) => f.agent))) {
    await rmdir(join(root, agent)).catch(() => { /* not empty: copies arrived meanwhile */ })
  }
  return files.length
}

/** The recovery channels; `root` is `<userData>/recovered`. */
export function registerEditRecoveryHandlers(root: string): void {
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
