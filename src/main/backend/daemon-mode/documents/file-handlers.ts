import { app, dialog, nativeImage, shell } from 'electron'
import { createWriteStream, rmSync } from 'node:fs'
import { mkdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { DaemonClient } from '../../../../shared/daemon-client'
import { scratchRootPath } from '../../../utils/scratch-dir'
import { containsPath, dedupeTrackedDirectories } from '../../../utils/tracked-paths'
import { CHANNEL_MAP } from '../../channel-map'
import type { DaemonHandlerTable, DaemonModeContext, DaemonSendHandlerTable } from '../context'
import { enc } from '../context'
import { DaemonModeUnavailableError } from '../errors'
import { samePath } from '../session'
import { daemonCode, daemonStatus, errorMessage, errorString, onOpenFile } from './open-file'

/**
 * W3-A: file-level operations (FILE_*), review of the open file, identity
 * drafts, tracked directories and the directory picker, in daemon mode.
 * Every answer has the embedded handler's shape (src/main/ipc/index.ts),
 * error answers included; the work is the daemon's (W1-E `/files*`,
 * `/tracked-dirs*`, W2-A review and checkpoint, W1-D identity drafts).
 *
 * Native dialogs stay in Studio main. They pick a path on this machine, so
 * in remote mode the picker steps refuse with the W4-B hook (daemon-side
 * picker, §9.3), as FILE_OPEN does.
 */

// --- helpers ----------------------------------------------------------------

/** Embedded FILE_RENAME / FILE_CREATE_QUICK name rule (ipc/index.ts isValidAgentFileName). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
function isValidAgentFileName(name: string): boolean {
  return name.length > 0 && !INVALID_FILENAME_CHARS.test(name) && !name.endsWith('.') && !name.endsWith(' ')
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

async function canonical(p: string): Promise<string> {
  try { return await realpath(resolve(p)) } catch { return resolve(p) }
}

/** Embedded isTempLocation: inside the OS temp dir (canonical paths). Local mode only: the folder is on this machine. */
async function isTempLocation(p: string): Promise<boolean> {
  const candidate = await canonical(p)
  const roots = new Set<string>()
  for (const t of [app.getPath('temp'), tmpdir(), '/tmp']) roots.add(await canonical(t))
  for (const r of roots) if (containsPath(r, candidate, { caseInsensitive: CASE_INSENSITIVE })) return true
  return false
}

function sameCanonical(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

/** The remote-mode refusal of a native picker: the daemon-side picker is W4-B's (§9.3). */
function remotePicker(ctx: DaemonModeContext, what: string): void {
  if (ctx.mode === 'remote') throw new DaemonModeUnavailableError(what, 'W4-B', 'daemon-side picker')
}

/** Download a daemon octet-stream answer to `dest` without buffering it in memory. */
async function download(ctx: DaemonModeContext, path: string, query: Record<string, string>, dest: string): Promise<void> {
  const res = await ctx.raw(path, query)
  if (!res.ok) {
    let body: { error?: unknown; code?: unknown } | null
    try { body = await res.json() as { error?: unknown; code?: unknown } | null } catch { body = null }
    const message = typeof body?.error === 'string' ? body.error : `The ADF daemon answered ${res.status}`
    throw Object.assign(new Error(message), { status: res.status, code: typeof body?.code === 'string' ? body.code : undefined })
  }
  if (!res.body) throw new Error('The ADF daemon sent no snapshot')
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(dest, { mode: 0o600 }))
}

async function removeSidecars(base: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    try { await unlink(`${base}${suffix}`) } catch { /* none */ }
  }
}

/** The local-mode existence check embedded runs before a share (`existsSync`); remote: the daemon's 404 answers it. */
async function shareable(ctx: DaemonModeContext, fp: unknown): Promise<boolean> {
  if (typeof fp !== 'string' || !fp.toLowerCase().endsWith('.adf')) return false
  return ctx.mode === 'remote' ? true : exists(fp)
}

/** A snapshot the daemon refused because the file is not there (or not an .adf): embedded's sentence. */
function notAnAdf(err: unknown): boolean {
  const status = (err as { status?: number }).status
  return status === 404 || status === 400
}

// --- share by drag (Studio-side snapshot files, as embedded) ---------------------

/** Same values as embedded (ipc/index.ts SHARE_SNAPSHOT_TTL_MS, MAX_LIVE_SHARE_SNAPSHOTS; not exported there). */
const SHARE_SNAPSHOT_TTL_MS = 5 * 60 * 1000
const MAX_LIVE_SHARE_SNAPSHOTS = 8
const shareSnapshots = new Map<string, { path: string; dir: string; icon: Electron.NativeImage; timer: NodeJS.Timeout; used: boolean }>()
let quitHookArmed = false

/**
 * Delete a snapshot's private dir (it holds the one snapshot file Studio
 * wrote, no links). Asynchronous while Studio runs; synchronous at quit, as
 * embedded's rmSync, because the process may exit before an async delete runs.
 */
function discardShareSnapshot(token: string, opts: { sync?: boolean } = {}): void {
  const snap = shareSnapshots.get(token)
  if (!snap) return
  shareSnapshots.delete(token)
  clearTimeout(snap.timer)
  if (opts.sync) {
    try { rmSync(snap.dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    return
  }
  void rm(snap.dir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
}

function armQuitCleanup(): void {
  if (quitHookArmed) return
  quitHookArmed = true
  app.once?.('will-quit', () => {
    for (const token of [...shareSnapshots.keys()]) discardShareSnapshot(token, { sync: true })
  })
}

// --- create (FILE_CREATE, FILE_CREATE_QUICK) -----------------------------------

interface CreateAnswer { agentId: string; name: string; filePath: string; did: string; warnings?: string[] }

/**
 * Embedded studioCreateDeps + runFileCreateTransition: the file is written
 * first (template, default provider, identity or the composer's draft,
 * reviewed mark, its folder tracked; POST /agents/create with load: false),
 * and only then does the open file change, so a refused template leaves the
 * current file as it was. The new file becomes the open file, not running.
 */
async function createAndOpen(ctx: DaemonModeContext, body: Record<string, unknown>): Promise<{ ok: true; created: CreateAnswer } | { ok: false; result: { success: false; error: string; code?: string } }> {
  const client = await ctx.ready()
  let created: CreateAnswer
  try {
    created = await client.request<CreateAnswer>('POST', '/agents/create', { body: { ...body, load: false }, timeoutMs: 60_000 })
  } catch (err) {
    const code = daemonCode(err)
    // A refused template carries its code through (FileCreateRefusedError).
    return { ok: false, result: { success: false, ...(code && code.startsWith('template_') ? { code } : {}), error: errorMessage(err) } }
  }
  try {
    await ctx.session.openFile(created.filePath, (p) => ctx.runningAgentAt(p))
  } catch (err) {
    // Embedded's post-install bookkeeping never turns a made file into a failure;
    // a failed switch does, with the file kept (file-create-handler.ts).
    ctx.log.error('[Backend] File create: opening the new file failed:', err)
    return { ok: false, result: { success: false, error: `${errorMessage(err)}\n\nThe newly created file was preserved at:\n${created.filePath}` } }
  }
  ctx.recordRecentFile(created.filePath)
  // Embedded logs these (identity provisioning, an expired draft) and goes on.
  for (const warning of created.warnings ?? []) ctx.log.warn(`[Backend] File create: ${warning}`)
  return { ok: true, created }
}

// --- review of the open file ----------------------------------------------------

/** Embedded's claim refusal names a template (ipc/index.ts FILE_REVIEW_ACCEPT); the daemon's names the agent. */
const CLAIM_KEYS_UNAVAILABLE = 'Owner and runtime encryption keys are unavailable (keystore locked?), so the template cannot be claimed securely.'

/** Re-key the client key recentFiles and the session after the open file moved (embedded persistAcceptedAgent). */
function noteMoved(ctx: DaemonModeContext, oldPath: string, newPath: string): void {
  ctx.session.rekey(oldPath, newPath)
  const recent = ctx.clientSettings.get('recentFiles')
  if (Array.isArray(recent) && recent.includes(oldPath)) {
    ctx.clientSettings.set('recentFiles', recent.map((p) => (p === oldPath ? newPath : p)))
  }
  ctx.recordRecentFile(newPath)
}

// --- tracked directories -----------------------------------------------------------

async function trackedList(client: DaemonClient): Promise<string[]> {
  const list = await client.request<{ directories: Array<{ path: string }> }>('GET', '/tracked-dirs')
  return list.directories.map((d) => d.path)
}

export const FILE_HANDLERS: DaemonHandlerTable = {
  // --- file operations ---------------------------------------------------------------

  // SQLite persists by itself; save folds the WAL in (POST /agents/:id/checkpoint).
  [IPC.FILE_SAVE]: async (ctx) => {
    try {
      return await onOpenFile<{ success: boolean; error?: string }>(ctx, 'Saving the open agent', { success: false, error: 'No file open' }, async (client, id) => {
        await client.request('POST', `/agents/${enc(id)}/checkpoint`)
        return { success: true }
      })
    } catch (error) {
      if (error instanceof DaemonModeUnavailableError) throw error
      return { success: false, error: errorString(error) }
    }
  },

  [IPC.FILE_CREATE]: async (ctx, _event, args: { name: string }) => {
    let picked: { canceled: boolean; filePath?: string }
    try {
      remotePicker(ctx, 'Creating an agent with the save dialog in remote mode')
      ctx.log.log(`[IPC] FILE_CREATE called with name: ${args?.name}`)
      picked = await dialog.showSaveDialog({
        defaultPath: `${args?.name}.adf`,
        filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
      })
    } catch (error) {
      if (error instanceof DaemonModeUnavailableError) throw error
      return { success: false, error: errorMessage(error) }
    }
    if (picked.canceled || !picked.filePath) return { success: false, error: 'Cancelled' }
    const filePath = picked.filePath
    const agentName = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.adf$/i, '') || args?.name
    // The save dialog asked before it returned an existing file: replace it, as embedded writes over it.
    const made = await createAndOpen(ctx, { name: agentName, directory: dirname(filePath), replace: true })
    if (!made.ok) return made.result
    return { success: true, filePath: made.created.filePath }
  },

  [IPC.AGENTS_FOLDER_DEFAULT_GET]: async (ctx) => {
    const client = await ctx.ready()
    const folder = await client.request<{ path: string }>('GET', '/files/agents-folder')
    return { path: folder.path }
  },

  [IPC.IDENTITY_DRAFT_MINT]: async (ctx) => {
    const client = await ctx.ready()
    return client.request<{ draftId: string; did: string }>('POST', '/identity/drafts')
  },

  [IPC.IDENTITY_DRAFT_DISCARD]: async (ctx, _event, draftId: unknown) => {
    if (typeof draftId !== 'string') return false
    const client = await ctx.ready()
    const answer = await client.request<{ discarded: boolean }>('DELETE', `/identity/drafts/${enc(draftId)}`)
    return answer.discarded
  },

  [IPC.FILE_CREATE_QUICK]: async (ctx, _event, args?: { providerId?: string; modelId?: string; folder?: string; name?: string; templateId?: string; identityDraftId?: string }) => {
    try {
      let directory: string | undefined
      if (typeof args?.folder === 'string' && args.folder.trim() !== '') {
        const wanted = resolve(args.folder.trim())
        // Local mode: the folder is on this machine, checked as embedded does.
        // Remote mode: the daemon's own refusal (directory does not exist) answers.
        if (ctx.mode !== 'remote') {
          if (!(await isDirectory(wanted))) return { success: false, error: 'That folder does not exist' }
          if (await isTempLocation(wanted)) return { success: false, error: 'Pick a folder outside the temporary directory' }
        }
        directory = wanted
      }
      const typed = typeof args?.name === 'string' ? args.name.trim() : ''
      const proposed = typed && typed.length <= 64 && isValidAgentFileName(typed) ? typed : null
      const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
      const body = {
        ...(proposed ? { name: proposed } : {}),
        ...(directory ? { directory } : {}),
        ...(str(args?.providerId) ? { provider: args!.providerId } : {}),
        ...(str(args?.modelId) ? { model: args!.modelId } : {}),
        ...(str(args?.templateId) ? { template: args!.templateId } : {}),
        ...(str(args?.identityDraftId) ? { identityDraftId: args!.identityDraftId } : {}),
      }
      const client = await ctx.ready()
      const made = await createAndOpen(ctx, body)
      if (!made.ok) {
        // A proposed name that is already a file is refused, not suffixed (embedded's sentence names the folder).
        if (proposed && made.result.error.startsWith(`An agent named "${proposed}" already exists`)) {
          const folder = directory ?? (await client.request<{ path: string }>('GET', '/files/agents-folder')).path
          return { success: false, code: 'name_taken', error: `An agent named "${proposed}" already exists in ${basename(folder)}.` }
        }
        if (/^directory does not exist/.test(made.result.error)) return { success: false, error: 'That folder does not exist' }
        return made.result
      }
      const { filePath, did } = made.created
      // The new file is the open file now, so embedded answers its DID.
      return { success: true, filePath, name: basename(filePath, '.adf'), did: did ?? undefined }
    } catch (error) {
      if (error instanceof DaemonModeUnavailableError) throw error
      ctx.log.error('[IPC] FILE_CREATE_QUICK error:', error)
      return { success: false, error: errorMessage(error) }
    }
  },

  [IPC.FILE_DELETE]: async (ctx, _event, args: { filePath: string }) => {
    try {
      const { filePath } = args
      // The open file first, as embedded: its document is released before the file goes.
      if (samePath(filePath, ctx.session.filePath)) await ctx.session.closeFile()
      const client = await ctx.ready()
      // Stops a running agent first (W1-E), closes the open document for every client.
      await client.request('DELETE', '/files', { query: { path: filePath }, timeoutMs: 60_000 })
      return { success: true }
    } catch (error) {
      if (error instanceof DaemonModeUnavailableError) throw error
      return { success: false, error: errorString(error) }
    }
  },

  [IPC.FILE_REVEAL]: async (ctx, _event, args: { filePath: string }) => {
    if (ctx.mode === 'remote') throw new DaemonModeUnavailableError('Revealing an agent file in its folder', 'W4-B', CHANNEL_MAP[IPC.FILE_REVEAL].remote)
    // Local mode: the daemon's path is on this machine.
    shell.showItemInFolder(args.filePath)
  },

  [IPC.FILE_LIST_TABLES]: async (ctx, _event, args: { filePath: string }) => {
    try {
      const client = await ctx.ready()
      const answer = await client.request<{ tables: Array<{ name: string; row_count: number }> }>('GET', '/files/agent/tables', { query: { path: args.filePath } })
      return { tables: answer.tables }
    } catch (error) {
      return { tables: [], error: errorString(error) }
    }
  },

  [IPC.FILE_CLONE]: async (ctx, _event, args: { filePath: string; selectedTables: string[] }) => {
    try {
      const client = await ctx.ready()
      // Fresh identity, clone-fixup, reviewed mark and the folder tracked (W1-E).
      const cloned = await client.request<{ filePath: string; warnings: string[] }>('POST', '/files/clone', {
        body: { path: args.filePath, selectedTables: args.selectedTables },
        timeoutMs: 120_000,
      })
      return { success: true, filePath: cloned.filePath, warnings: cloned.warnings }
    } catch (error) {
      return { success: false, error: errorString(error) }
    }
  },

  [IPC.FILE_RENAME]: async (ctx, _event, args: { filePath: string; newName: string }) => {
    try {
      const { filePath } = args
      const newName = args.newName.trim()
      if (!isValidAgentFileName(newName)) return { success: false, error: 'Name contains characters not allowed in file names.' }
      const client = await ctx.ready()
      // Embedded answers a running agent's (deferred) rename with renameDeferred, a done one without it.
      const running = await ctx.runningAgentAt(filePath)
      let renamed: { filePath: string; renameDeferred: boolean }
      try {
        renamed = await client.request('POST', '/files/rename', { body: { path: filePath, newName }, timeoutMs: 60_000 })
      } catch (err) {
        // FileOpError refusals (invalid_name, name_taken, file_busy, conflict) carry embedded's plain sentences.
        if (daemonCode(err) && daemonStatus(err) !== 500) return { success: false, error: errorMessage(err) }
        throw err
      }
      if (renamed.filePath !== filePath) ctx.session.rekey(filePath, renamed.filePath)
      if (running) return { success: true, filePath: renamed.filePath, renameDeferred: renamed.renameDeferred }
      return { success: true, filePath: renamed.filePath }
    } catch (error) {
      if (error instanceof DaemonModeUnavailableError) throw error
      return { success: false, error: errorString(error) }
    }
  },

  // --- share by drag and "Save a copy…" (identity-free snapshot, GET /files/snapshot) ---

  [IPC.FILE_SHARE_PREPARE]: async (ctx, _event, args: { filePath: string }) => {
    const fp = args?.filePath
    if (!(await shareable(ctx, fp))) return { success: false, error: 'Not an .adf file' }
    const source = fp as string
    // Oldest-first cap, as embedded.
    while (shareSnapshots.size >= MAX_LIVE_SHARE_SNAPSHOTS) {
      const oldest = shareSnapshots.keys().next()
      if (oldest.done) break
      discardShareSnapshot(oldest.value)
    }
    const dir = join(scratchRootPath(), 'share', randomUUID())
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const snapshot = join(dir, basename(source))
      await download(ctx, '/files/snapshot', { path: source, mode: 'share' }, snapshot)
      let icon: Electron.NativeImage
      try {
        icon = await app.getFileIcon(snapshot, { size: 'normal' })
      } catch {
        icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icons', 'png', '64x64.png'))
      }
      const token = randomUUID()
      const timer = setTimeout(() => discardShareSnapshot(token), SHARE_SNAPSHOT_TTL_MS)
      timer.unref?.()
      shareSnapshots.set(token, { path: snapshot, dir, icon, timer, used: false })
      armQuitCleanup()
      return { success: true, token }
    } catch (error) {
      try { await rm(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
      if (notAnAdf(error)) return { success: false, error: 'Not an .adf file' }
      return { success: false, error: errorMessage(error) }
    }
  },

  [IPC.FILE_SHARE_DISCARD]: async (_ctx, _event, args: { token: string }) => {
    if (typeof args?.token === 'string') discardShareSnapshot(args.token)
  },

  // The save dialog and the write stay here: in remote mode the copy lands on this machine.
  [IPC.FILE_SHARE_SAVE_AS]: async (ctx, _event, args: { filePath: string }) => {
    const fp = args?.filePath
    if (!(await shareable(ctx, fp))) return { success: false, error: 'Not an .adf file' }
    const source = fp as string
    const result = await dialog.showSaveDialog({
      defaultPath: basename(source),
      filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' }
    const dest = result.filePath
    // Saving over the agent itself would replace it with its own identity-stripped copy.
    if (ctx.mode !== 'remote' && sameCanonical(await canonical(dest), await canonical(source))) {
      return { success: false, error: 'Choose a different file — a shared copy cannot overwrite the agent it came from' }
    }
    const partial = `${dest}.partial`
    try {
      await removeSidecars(partial)
      await download(ctx, '/files/snapshot', { path: source, mode: 'share' }, partial)
      if (await exists(dest)) await unlink(dest)
      await rename(partial, dest)
      return { success: true, filePath: dest }
    } catch (error) {
      await removeSidecars(partial)
      if (notAnAdf(error)) return { success: false, error: 'Not an .adf file' }
      return { success: false, error: errorMessage(error) }
    }
  },

  // --- review of the open file (W2-A review routes) -----------------------------------

  [IPC.FILE_CHECK_REVIEW]: async (ctx) => {
    const filePath = ctx.session.filePath
    if (!filePath) return { needsReview: false }
    try {
      const client = await ctx.ready()
      const review = await client.request<{ reviewed: boolean; summary: unknown }>('GET', '/agents/review', { query: { filePath } })
      if (review.reviewed) return { needsReview: false }
      return { needsReview: true, configSummary: review.summary }
    } catch (err) {
      ctx.log.warn('[IPC] FILE_CHECK_REVIEW error:', err)
      return { needsReview: false }
    }
  },

  [IPC.FILE_REVIEW_ACCEPT]: async (ctx, _event, args?: { claim?: boolean; expectedPath?: string; model?: { provider: string; model_id: string } }) => {
    const filePath = ctx.session.filePath
    if (!filePath) return { success: false, error: 'No workspace open' }
    // The verdict is bound to the file the dialog reviewed.
    if (!args?.expectedPath || !samePath(args.expectedPath, filePath)) {
      return { success: false, error: 'The open file changed while the review dialog was up — review the current file again' }
    }
    const client = await ctx.ready()
    let accepted: { filePath: string }
    try {
      accepted = await client.request('POST', '/agents/review/accept', {
        body: { filePath, ...(args.claim ? { claim: true } : {}), ...(args.model ? { model: args.model } : {}) },
        timeoutMs: 60_000,
      })
    } catch (err) {
      const code = daemonCode(err)
      if (code === 'identity_not_ready' && args.claim) return { success: false, error: CLAIM_KEYS_UNAVAILABLE }
      // Embedded's own refusals answer the plain sentence; anything thrown answers String(err).
      if (code === 'provider_unknown' || code === 'password_required') return { success: false, error: errorMessage(err) }
      ctx.log.warn('[IPC] FILE_REVIEW_ACCEPT error:', err)
      return { success: false, error: errorString(err) }
    }
    // An accepted agent must survive restart: an untracked file moves into the agents folder.
    const at = accepted.filePath ?? filePath
    try {
      const moved = await client.request<{ movedTo?: string; moveError?: string }>('POST', '/files/relocate', { body: { path: at }, timeoutMs: 60_000 })
      if (moved.movedTo) noteMoved(ctx, filePath, moved.movedTo)
      return { success: true, ...(moved.movedTo ? { movedTo: moved.movedTo } : {}), ...(moved.moveError ? { moveError: moved.moveError } : {}) }
    } catch (err) {
      // The accept stands; the move is best-effort (persistAcceptedAgent).
      ctx.log.warn('[Review] Moving the accepted agent into the agents folder failed:', err)
      return { success: true }
    }
  },

  // --- tracked directories -------------------------------------------------------------

  [IPC.TRACKED_DIRS_GET]: async (ctx) => {
    const client = await ctx.ready()
    const stored = await trackedList(client)
    if (ctx.mode === 'remote') return { directories: stored }
    // Collapse duplicates and nested entries, as embedded, and persist the cleaned list.
    const directories = dedupeTrackedDirectories(stored)
    if (directories.length !== stored.length) {
      await client.request('PATCH', '/settings', { body: { trackedDirectories: directories } })
    }
    return { directories }
  },

  // A path with no side effects (settings fields such as agentsFolder, the composer's folder).
  [IPC.DIALOG_PICK_DIRECTORY]: async (ctx) => {
    remotePicker(ctx, 'Picking a folder in remote mode')
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] }
  },

  [IPC.TRACKED_DIRS_ADD]: async (ctx) => {
    remotePicker(ctx, 'Tracking a folder picked with the native dialog in remote mode')
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const client = await ctx.ready()
    if (result.canceled || result.filePaths.length === 0) return { directories: await trackedList(client) }
    try {
      const tracked = await client.request<{ directories: string[] }>('POST', '/tracked-dirs', { body: { path: result.filePaths[0] }, timeoutMs: 120_000 })
      return { directories: tracked.directories }
    } catch (err) {
      // Already covered by a tracked folder (itself or a parent): the list as it is.
      if (daemonStatus(err) === 409) return { directories: await trackedList(client) }
      throw err
    }
  },

  [IPC.TRACKED_DIRS_REMOVE]: async (ctx, _event, args: { dirPath: string }) => {
    const client = await ctx.ready()
    try {
      const removed = await client.request<{ directories: string[] }>('DELETE', '/tracked-dirs', { query: { path: args.dirPath } })
      return { directories: removed.directories }
    } catch (err) {
      // Not tracked: embedded filters nothing out and answers the list.
      if (daemonStatus(err) === 404) return { directories: await trackedList(client) }
      throw err
    }
  },

  [IPC.TRACKED_DIRS_SCAN]: async (ctx, _event, args: { dirPath: string }) => {
    try {
      const client = await ctx.ready()
      const tree = await client.request<{ files: unknown[] }>('GET', '/tracked-dirs/tree', { query: { path: args.dirPath } })
      return { files: tree.files }
    } catch {
      return { files: [] }
    }
  },
}

export const FILE_SEND_HANDLERS: DaemonSendHandlerTable = {
  // The drag of the snapshot FILE_SHARE_PREPARE wrote. Single-use token, as embedded.
  [IPC.FILE_SHARE_DRAG_START]: (_ctx, event, args: { token: string }) => {
    const snap = typeof args?.token === 'string' ? shareSnapshots.get(args.token) : undefined
    if (!snap || snap.used) return
    snap.used = true
    try {
      event.sender.startDrag({ file: snap.path, icon: snap.icon })
    } catch (err) {
      console.warn('[Share] startDrag failed:', err)
    }
  },
}

/** Tests: the live share snapshots. */
export function _shareSnapshotCount(): number {
  return shareSnapshots.size
}
