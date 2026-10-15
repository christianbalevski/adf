import { BrowserWindow, clipboard, dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { DaemonHandlerTable, DaemonInvokeHandler, DaemonModeContext } from '../context'
import { createAndOpen } from '../documents/file-handlers'
import { daemonStatus, errorMessage } from '../documents/open-file'
import { DAEMON_MODE_HANDLERS } from '../handlers'
import { hasLocalOpenGrant, unsafeLocalPath } from '../../local-open-grants'
import type { RemoteServices } from './services'
import { REMOTE_OWNER_IDENTITY_SENTENCE } from '../../../../shared/constants/remote-owner-identity'

/**
 * Remote-mode handlers (design §9.3, tracker W4-B): the `remote-variant`
 * channels whose local-mode handler would act on this computer (a native
 * dialog picks a laptop path; a folder is revealed in this computer's file
 * manager), and the `remote-unsupported` channels whose answer is a sentence
 * that names the reason and the command to run on the server.
 *
 * Registration (index.ts) takes these before DAEMON_MODE_HANDLERS in remote
 * mode only; every other channel works as in local mode. Paths here are on
 * the daemon's machine, except the one this computer's OS hands Studio
 * (a double-clicked file), which FILE_OPEN offers to upload.
 */

export { REMOTE_OWNER_IDENTITY_SENTENCE } from '../../../../shared/constants/remote-owner-identity'

function remote(ctx: DaemonModeContext): RemoteServices {
  if (!ctx.remote) throw new Error('Remote mode is not set up in this Studio session.')
  return ctx.remote
}

function windowFor(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

/** C0/C1 controls and bidirectional overrides: a daemon-sent path with them could hide what it says or run as a command when pasted. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** A path as text for a dialog: control characters shown as \uXXXX. */
export function displayPath(path: string): string {
  return path.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * A message box with the path as text and a Copy button: the path is on the
 * daemon's machine. A path with control characters is shown escaped and has
 * no Copy button (W4-B review).
 */
async function showRemotePath(message: string, detail: string, path: string): Promise<void> {
  const win = windowFor()
  const copyable = displayPath(path) === path
  const options = {
    type: 'info',
    message,
    detail: copyable ? detail : `${detail}\n\nThe path contains control characters, so Studio does not copy it.`,
    buttons: copyable ? ['OK', 'Copy path'] : ['OK'],
    defaultId: 0,
    cancelId: 0,
  } as Electron.MessageBoxOptions
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (copyable && response === 1) clipboard.writeText(path)
}

/** A plain message box on the focused window. */
export async function showMessage(type: 'info' | 'warning' | 'error', message: string, detail: string): Promise<void> {
  const win = windowFor()
  const options = { type, message, detail, buttons: ['OK'], defaultId: 0 } as Electron.MessageBoxOptions
  if (win) await dialog.showMessageBox(win, options)
  else await dialog.showMessageBox(options)
}

const base = (channel: keyof typeof DAEMON_MODE_HANDLERS): DaemonInvokeHandler => {
  const handler = DAEMON_MODE_HANDLERS[channel]
  if (!handler) throw new Error(`no daemon-mode handler for ${channel}`)
  return handler
}

type Location = { where: 'daemon' } | { where: 'local' } | { where: 'nowhere'; why: string; lookedHere: boolean }

/**
 * Where an agent file named by path lives: the daemon has it (GET
 * /files/agent answers), else this computer has it, else neither. This
 * computer's disk is looked at only for a path main itself handed to the
 * renderer (an OS open or Open Recent: local-open-grants.ts), and never for
 * a network or device path: every other path may come from the daemon
 * (W4-B review), and a UNC path would make Windows send NTLM credentials.
 */
async function locate(ctx: DaemonModeContext, filePath: string): Promise<Location> {
  const client = await ctx.ready()
  try {
    await client.request('GET', '/files/agent', { query: { path: filePath } })
    return { where: 'daemon' }
  } catch (err) {
    const status = daemonStatus(err)
    if (status !== 404 && status !== 400) throw err
    const why = errorMessage(err)
    const unsafe = unsafeLocalPath(filePath)
    if (unsafe) return { where: 'nowhere', why, lookedHere: false }
    if (!hasLocalOpenGrant(filePath)) return { where: 'nowhere', why, lookedHere: false }
    try {
      if ((await stat(filePath)).isFile() && filePath.toLowerCase().endsWith('.adf')) return { where: 'local' }
    } catch { /* not here either */ }
    return { where: 'nowhere', why, lookedHere: true }
  }
}

/** Upload progress on every window's task-bar entry (-1 clears it). */
function setProgress(value: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.setProgressBar(value) } catch { /* window going away */ }
  }
}

/**
 * Upload a copy of an `.adf` of this computer into a daemon folder the user
 * picks (POST /files/import, streamed). Asks first; nothing travels without
 * the user's choice. Resolves with the copy's daemon path, or null.
 */
async function offerUpload(ctx: DaemonModeContext, localPath: string): Promise<{ filePath: string } | { cancelled: true } | { error: string }> {
  const r = remote(ctx)
  const host = r.host()
  const name = basename(localPath)
  const win = windowFor()
  const options = {
    type: 'question',
    message: `${name} is on this computer, not on ${host}.`,
    detail: `${displayPath(localPath)}\n\nAgents run on the ADF daemon at ${host}, so it can only open files there. Studio can upload a copy of this file into a tracked folder or the agents folder on ${host}. The copy is a separate agent: it needs review before it runs, and the file on this computer stays as it is.`,
    buttons: ['Upload a copy…', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  } as Electron.MessageBoxOptions
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (response !== 0) return { cancelled: true }
  // Only folders the daemon imports into: tracked folders and the agents folder.
  const picked = await r.picker.pick('folder', `Upload ${name} to a folder on ${host}`, { within: 'import' })
  if (!picked || !('path' in picked)) return { cancelled: true }
  const client = await ctx.ready()
  ctx.log.log(`[Remote] Uploading ${localPath} to ${picked.path} on ${host}`)
  let res: Response
  setProgress(0)
  try {
    res = await r.upload(client, '/files/import', { directory: picked.path, name: basename(localPath, '.adf').replace(/\.adf$/i, ''), unique: 'true' }, localPath,
      (sent, total) => setProgress(total > 0 ? Math.min(1, sent / total) : 2))
  } catch (err) {
    return { error: `Uploading ${name} to ${host} failed: ${errorMessage(err)}` }
  } finally {
    setProgress(-1)
  }
  const text = await res.text().catch(() => '')
  let body: { filePath?: unknown; error?: unknown; idReassigned?: { reason?: unknown } } | null = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  if (!res.ok || typeof body?.filePath !== 'string') {
    const why = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
    ctx.log.warn(`[Remote] Upload of ${name} to ${host} refused: ${why}`)
    return { error: `${host} did not take the copy of ${name}: ${why}` }
  }
  const reassigned = body.idReassigned ? ` It already knew this agent (${String(body.idReassigned.reason)}), so the copy got a new id without the original's identity.` : ''
  ctx.log.log(`[Remote] Uploaded ${name} to ${body.filePath}.${reassigned}`)
  return { filePath: body.filePath }
}

export const REMOTE_MODE_HANDLERS: DaemonHandlerTable = {
  // Open: the daemon-side picker without a path; with a path, the daemon's
  // file, or the upload of this computer's file.
  [IPC.FILE_OPEN]: async (ctx, event, args?: { filePath?: string }) => {
    const open = base(IPC.FILE_OPEN)
    try {
      let filePath = args?.filePath
      if (!filePath) {
        const r = remote(ctx)
        const picked = await r.picker.pick('open-adf', `Open an agent on ${r.host()}`)
        if (!picked || !('path' in picked)) return { success: false, error: 'Cancelled' }
        filePath = picked.path
      } else {
        const location = await locate(ctx, filePath)
        if (location.where === 'local') {
          const uploaded = await offerUpload(ctx, filePath)
          if ('cancelled' in uploaded) return { success: false, error: 'Cancelled' }
          if ('error' in uploaded) return { success: false, error: uploaded.error }
          filePath = uploaded.filePath
        } else if (location.where === 'nowhere') {
          // Say only what is known: this computer was looked at only for a path it handed over itself.
          return { success: false, error: location.lookedHere
            ? `No agent file at ${filePath} on ${remote(ctx).host()} (${location.why}), and none on this computer.`
            : `No agent file at ${filePath} on ${remote(ctx).host()} (${location.why}). To upload a file of this computer, open it from the file manager or Open Recent.` }
        }
      }
      return await open(ctx, event, { ...(args ?? {}), filePath })
    } catch (error) {
      ctx.log.error('[Backend] FILE_OPEN error:', error)
      return { success: false, error: errorMessage(error) }
    }
  },

  // New agent: a folder on the daemon host and a name, then the create.
  [IPC.FILE_CREATE]: async (ctx, _event, args: { name: string }) => {
    const r = remote(ctx)
    const picked = await r.picker.pick('save-adf', `New agent on ${r.host()}`, { defaultName: args?.name || 'Untitled' })
    if (!picked || !('directory' in picked)) return { success: false, error: 'Cancelled' }
    const made = await createAndOpen(ctx, { name: picked.name, directory: picked.directory, ...(picked.replace ? { replace: true } : {}) })
    if (!made.ok) return made.result
    return { success: true, filePath: made.created.filePath }
  },

  [IPC.DIALOG_PICK_DIRECTORY]: async (ctx) => {
    const r = remote(ctx)
    const picked = await r.picker.pick('folder', `Choose a folder on ${r.host()}`)
    return { path: picked && 'path' in picked ? picked.path : null }
  },

  [IPC.TRACKED_DIRS_ADD]: async (ctx) => {
    const r = remote(ctx)
    const client = await ctx.ready()
    const list = async () => (await client.request<{ directories: Array<{ path: string }> }>('GET', '/tracked-dirs')).directories.map((d) => d.path)
    const picked = await r.picker.pick('folder', `Track a folder on ${r.host()}`)
    if (!picked || !('path' in picked)) return { directories: await list() }
    try {
      const tracked = await client.request<{ directories: string[] }>('POST', '/tracked-dirs', { body: { path: picked.path }, timeoutMs: 120_000 })
      return { directories: tracked.directories }
    } catch (err) {
      // Already covered by a tracked folder: the list as it is (as local mode).
      if (daemonStatus(err) === 409) return { directories: await list() }
      throw err
    }
  },

  [IPC.MCP_PICK_ADF_FILE]: async (ctx) => {
    const r = remote(ctx)
    const picked = await r.picker.pick('open-adf', `Choose an agent on ${r.host()}`)
    if (!picked || !('path' in picked)) return { filePath: null }
    return { filePath: picked.path, fileName: basename(picked.path.replace(/\\/g, '/')) }
  },

  // --- remote-unsupported: the sentence, never a raw error -------------------

  [IPC.FILE_REVEAL]: async (ctx, _event, args: { filePath: string }) => {
    const host = remote(ctx).host()
    const path = typeof args?.filePath === 'string' ? args.filePath : ''
    await showRemotePath(`This file is on ${host}.`, `Studio cannot show it in a folder on this computer. Its path on ${host}:\n\n${displayPath(path)}`, path)
  },

  [IPC.TEMPLATE_REVEAL]: async (ctx) => {
    const host = remote(ctx).host()
    let folder: string
    try {
      folder = (await (await ctx.ready()).request<{ folder: string }>('GET', '/templates')).folder
    } catch (err) {
      ctx.log.warn(`[Remote] Could not read the templates folder of ${host}: ${errorMessage(err)}`)
      await showMessage('warning', `The templates folder is on ${host}.`, `Studio cannot show it here, and could not ask ${host} where it is: ${errorMessage(err)}`)
      return
    }
    await showRemotePath(`The templates folder is on ${host}.`, `Studio cannot show it in a folder on this computer. Its path on ${host}:\n\n${displayPath(folder)}`, folder)
  },

  // The phrase never goes to another machine; the daemon would refuse it anyway (local-only routes).
  [IPC.IDENTITY_OWNER_IMPORT]: async () => ({ success: false, error: REMOTE_OWNER_IDENTITY_SENTENCE }),
  [IPC.IDENTITY_OWNER_CONFIRM_BACKUP]: async () => ({ success: false, error: REMOTE_OWNER_IDENTITY_SENTENCE }),
}
