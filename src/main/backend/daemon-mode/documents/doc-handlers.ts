import { BrowserWindow, dialog } from 'electron'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError, type DaemonClient } from '../../../../shared/daemon-client'
import type { AgentConfig, InboxMessage, OutboxMessage, TaskEntry, Timer } from '../../../../shared/types/adf-v02.types'
import { enc, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { errorString, isAgentGone, onOpenFile } from './open-file'

/**
 * Daemon-mode DOC_* handlers: the open file's document, config, chat pages,
 * inbox, outbox, timers, logs, tasks, internal files, meta and local tables.
 * Each answers what the embedded handler answers (src/main/ipc/index.ts,
 * "Document content" to "Local Tables"), built from the `/agents/:id/*`
 * resource routes, which serve the running agent and the open document
 * alike (W2-A). Without a file open each answers embedded's no-workspace
 * value.
 */

const MAIN_LOOP = 'main'
/** Same window as embedded DOC_GET_CHAT_OLDER. */
const LOOP_DISPLAY_LIMIT = 200
/** AdfDatabase.getLogs' default: embedded DOC_GET_LOGS passes no limit. */
const LOGS_DEFAULT_LIMIT = 500

type TimerMode = 'once_at' | 'once_delay' | 'interval' | 'cron'
interface TimerArgs {
  id?: number
  mode: TimerMode
  at?: number
  delay_ms?: number
  every_ms?: number
  start_at?: number
  end_at?: number
  max_runs?: number
  cron?: string
  scope: string[]
  lambda?: string
  warm?: boolean
  payload?: string
  locked?: boolean
  loop?: string
}

/**
 * Embedded's timer refusals, in its order and words. The daemon refuses the
 * same cases (buildTimerMutation) but as an HTTP error, and words a bad cron
 * expression differently; the handler answers embedded's sentence before
 * any request.
 */
async function timerRefusal(args: TimerArgs): Promise<string | null> {
  const now = Date.now()
  switch (args.mode) {
    case 'once_at':
      return !args.at || args.at <= now ? 'Timestamp must be in the future' : null
    case 'once_delay':
      return !args.delay_ms || args.delay_ms <= 0 ? 'Delay must be positive' : null
    case 'interval': {
      if (!args.every_ms || args.every_ms <= 0) return 'Interval must be positive'
      const next = args.start_at ?? (now + args.every_ms)
      return next <= now ? 'start_at must be in the future' : null
    }
    case 'cron': {
      if (!args.cron) return 'Cron expression required'
      const { CronExpressionParser } = await import('cron-parser')
      try {
        CronExpressionParser.parse(args.cron, { currentDate: new Date(now) })
        return null
      } catch (err) {
        return `Invalid cron: ${String(err)}`
      }
    }
    default:
      return 'Invalid mode'
  }
}

/** Whether the open file runs in the daemon (GET /files/agent `loaded`), as opposed to an open document. */
async function isRunning(ctx: DaemonModeContext): Promise<boolean> {
  const filePath = ctx.session.filePath
  return !!filePath && (await ctx.runningAgentAt(filePath)) !== null
}

/** Embedded's loop check for DOC_ADD_TIMER: a declared loop of the RUNNING agent (no assembled pool: main only). */
async function unknownLoop(ctx: DaemonModeContext, client: DaemonClient, agentId: string, loop: string): Promise<string | null> {
  let names = [MAIN_LOOP]
  if (await isRunning(ctx)) {
    const { loops } = await client.request<{ loops: Array<{ name: string }> }>('GET', `/agents/${enc(agentId)}/loops`)
    names = loops.map((l) => l.name)
  }
  return names.includes(loop) ? null : `Unknown loop "${loop}". Available: ${names.join(', ')}`
}

/** A daemon failure that is not "the agent is gone" (that one onOpenFile turns into notOpenError). */
function rethrowIfGone(err: unknown, agentId: string): void {
  if (isAgentGone(err, agentId)) throw err
}

/**
 * PUT /agents/:id/files/raw (octet-stream). The shared client speaks JSON
 * only, so the request is built from its URL and headers: the token goes to
 * the daemon's origin only, as every client request.
 */
async function putRaw(client: DaemonClient, agentId: string, query: { path: string; mimeType?: string; unique?: boolean }, bytes: Buffer): Promise<{ path: string }> {
  const url = client.url(`/agents/${enc(agentId)}/files/raw`, {
    path: query.path,
    ...(query.mimeType ? { mimeType: query.mimeType } : {}),
    ...(query.unique ? { unique: 'true' } : {}),
  })
  let res: Response
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: client.headers({ 'Content-Type': 'application/octet-stream' }),
      body: new Uint8Array(bytes),
      redirect: 'manual',
    })
  } catch (err) {
    throw new DaemonError(`Cannot reach daemon: ${err instanceof Error ? err.message : String(err)}`, null)
  }
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) {
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${res.status}`
    throw new DaemonError(message, res.status, body)
  }
  return body as { path: string }
}

/**
 * Embedded's import walk (DOC_IMPORT_PATHS, DOC_PICK_AND_IMPORT): a file
 * lands at `<prefix>/<name>`, a folder recurses under its own name. Studio
 * main reads the paths (they are on this machine) and uploads each file; the
 * daemon infers the MIME type from the path as `workspace.getMimeType` does.
 */
async function importPaths(client: DaemonClient, agentId: string, paths: string[]): Promise<{ success: boolean; count: number }> {
  let count = 0
  const importEntry = async (hostPath: string, vfsPrefix: string): Promise<void> => {
    const st = await stat(hostPath)
    if (st.isFile()) {
      const data = await readFile(hostPath)
      const name = basename(hostPath)
      await putRaw(client, agentId, { path: vfsPrefix ? `${vfsPrefix}/${name}` : name }, data)
      count++
    } else if (st.isDirectory()) {
      const dirName = basename(hostPath)
      const prefix = vfsPrefix ? `${vfsPrefix}/${dirName}` : dirName
      for (const entry of await readdir(hostPath, { withFileTypes: true })) {
        await importEntry(join(hostPath, entry.name), prefix)
      }
    }
  }
  try {
    for (const p of paths) await importEntry(p, '')
    return { success: true, count }
  } catch (err) {
    rethrowIfGone(err, agentId)
    console.error('[Backend] Import into the open agent failed:', err)
    return { success: false, count }
  }
}

/** Embedded's local-table names: `local_*` (and `adf_audit` for reads), word characters only. */
function invalidTable(table: string, allowAudit: boolean): boolean {
  return (!table.startsWith('local_') && !(allowAudit && table === 'adf_audit')) || /[^a-zA-Z0-9_]/.test(table)
}

export const DOC_HANDLERS: DaemonHandlerTable = {
  // --- Document and config ------------------------------------------------------

  [IPC.DOC_GET_DOCUMENT]: (ctx) => onOpenFile(ctx, 'Reading the open agent\'s document', { content: '' }, async (client, id) => {
    const { content } = await client.request<{ content: string }>('GET', `/agents/${enc(id)}/document`)
    return { content }
  }),

  // The daemon fires the running agent's document-edit trigger (setAgentDocument), as embedded does.
  [IPC.DOC_SET_DOCUMENT]: (ctx, _event, args: { content: string }) => onOpenFile(ctx, 'Writing the open agent\'s document', () => {
    ctx.log.error('[IPC] DOC_SET_DOCUMENT: No workspace open')
    return { success: false }
  }, async (client, id) => {
    await client.request('PUT', `/agents/${enc(id)}/document`, { body: { content: args.content } })
    return { success: true }
  }),

  [IPC.DOC_GET_AGENT_CONFIG]: (ctx) => onOpenFile<AgentConfig | null>(ctx, 'Reading the open agent\'s config', null, async (client, id) => {
    return (await client.request<{ config: AgentConfig }>('GET', `/agents/${enc(id)}/config`)).config
  }),

  /**
   * Embedded refuses another agent's config, saves, and reports where the
   * file went when the name changed: `filePath` (moved now) or
   * `renameDeferred` (the agent runs; the file moves when it stops). The
   * daemon reports both for an open document; for a running agent the move
   * is scheduled by its config-change hook, so the deferral is read back
   * from GET /files/agent `pendingName`.
   */
  [IPC.DOC_SET_AGENT_CONFIG]: (ctx, _event, config: AgentConfig) => onOpenFile(ctx, 'Saving the open agent\'s config', { success: false, error: 'No file open' }, async (client, id) => {
    const previous = (await client.request<{ config: AgentConfig }>('GET', `/agents/${enc(id)}/config`)).config
    if (config?.id && previous.id && config.id !== previous.id) {
      return { success: false, error: 'Save refused: config belongs to a different agent file' }
    }
    const saved = await client.request<{ filePath?: string; renameDeferred?: boolean }>('PUT', `/agents/${enc(id)}/config`, { body: config })
    const filePath = ctx.session.filePath
    if (!filePath || config.name === previous.name) return { success: true }
    if (saved.filePath) {
      ctx.session.rekey(filePath, saved.filePath)
      return { success: true, filePath: saved.filePath }
    }
    if (saved.renameDeferred) return { success: true, renameDeferred: true }
    const info = await client.request<{ pendingName?: string }>('GET', '/files/agent', { query: { path: filePath } })
    if (info.pendingName === config.name) return { success: true, renameDeferred: true }
    return { success: true }
  }),

  // --- Chat -----------------------------------------------------------------------

  // Keyset scroll-back (GET /agents/:id/chat?before=). Embedded answers an empty page on any failure.
  [IPC.DOC_GET_CHAT_OLDER]: (ctx, _event, args: { beforeSeq: number; limit?: number; loop?: string }) => onOpenFile(ctx, 'Reading the open agent\'s chat', { uiLog: [], earlierCount: 0 }, async (client, id) => {
    const limit = Math.min(Math.max(args?.limit ?? LOOP_DISPLAY_LIMIT, 1), 500)
    try {
      const page = await client.request<{ uiLog: unknown[]; earlierCount: number }>('GET', `/agents/${enc(id)}/chat`, {
        query: { before: args.beforeSeq, limit, loop: args?.loop ?? MAIN_LOOP },
      })
      return { uiLog: page.uiLog, earlierCount: page.earlierCount }
    } catch (err) {
      rethrowIfGone(err, id)
      ctx.log.error('[IPC] DOC_GET_CHAT_OLDER error:', err)
      return { uiLog: [], earlierCount: 0 }
    }
  }),

  /**
   * Absent `loop` clears main. Embedded clears a side loop only on a running
   * agent that has it; the daemon also clears a declared loop of an open
   * document, so the handler refuses that case first, in embedded's words.
   */
  [IPC.DOC_CLEAR_CHAT]: (ctx, _event, args?: { loop?: string }) => onOpenFile(ctx, 'Clearing the open agent\'s chat', { success: false }, async (client, id) => {
    const loop = args?.loop ?? MAIN_LOOP
    const refused = { success: false, error: `No loop named "${loop}"` }
    if (loop !== MAIN_LOOP && !(await isRunning(ctx))) return refused
    try {
      await client.request('DELETE', `/agents/${enc(id)}/chat`, { query: { loop } })
    } catch (err) {
      if (err instanceof DaemonError && err.status === 404 && err.message.startsWith('No loop named')) return refused
      throw err
    }
    return { success: true }
  }),

  // --- Inbox, outbox ------------------------------------------------------------------

  // Unread, read, archived, in that order (embedded's three reads).
  [IPC.DOC_GET_INBOX]: (ctx) => onOpenFile(ctx, 'Reading the open agent\'s inbox', { inbox: null } as { inbox: { version: number; messages: InboxMessage[] } | null }, async (client, id) => {
    const read = (status: string) => client.request<{ messages: InboxMessage[] }>('GET', `/agents/${enc(id)}/inbox`, { query: { status } })
    const pages = await Promise.all([read('unread'), read('read'), read('archived')])
    return { inbox: { version: 1, messages: pages.flatMap((p) => p.messages) } }
  }),

  /**
   * Embedded pushes INBOX_UPDATED with an empty inbox itself. The daemon
   * publishes that `inbox` push for DELETE /agents/:id/inbox to every
   * session, the writer included (origin dedup covers config_changed only,
   * D5.1), and the bridge forwards it for the open file. A push here as well
   * would reach the renderer twice.
   */
  [IPC.DOC_CLEAR_INBOX]: (ctx) => onOpenFile(ctx, 'Clearing the open agent\'s inbox', { success: false }, async (client, id) => {
    await client.request('DELETE', `/agents/${enc(id)}/inbox`)
    return { success: true }
  }),

  // Without the routing and payload columns, as embedded strips them.
  [IPC.DOC_GET_OUTBOX]: (ctx) => onOpenFile(ctx, 'Reading the open agent\'s outbox', { outbox: null } as { outbox: { messages: unknown[] } | null }, async (client, id) => {
    const { messages } = await client.request<{ messages: OutboxMessage[] }>('GET', `/agents/${enc(id)}/outbox`)
    return {
      outbox: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        messages: messages.map(({ original_message, address, network, attachments, meta, ...rest }) => rest),
      },
    }
  }),

  // --- Timers -----------------------------------------------------------------------

  [IPC.DOC_GET_TIMERS]: (ctx) => onOpenFile(ctx, 'Reading the open agent\'s timers', { timers: [] }, async (client, id) => {
    const { timers } = await client.request<{ timers: Timer[] }>('GET', `/agents/${enc(id)}/timers`)
    return { timers }
  }),

  /** The loop is kept only for an agent-scope timer (embedded's effectiveLoop). */
  [IPC.DOC_ADD_TIMER]: (ctx, _event, args: TimerArgs) => onOpenFile(ctx, 'Adding a timer to the open agent', { success: false, error: 'No workspace open' }, async (client, id) => {
    if (args.loop && args.loop !== MAIN_LOOP) {
      const unknown = await unknownLoop(ctx, client, id, args.loop)
      if (unknown) return { success: false, error: unknown }
    }
    const refusal = await timerRefusal(args)
    if (refusal) return { success: false, error: refusal }
    const { loop, ...rest } = args
    const effectiveLoop = args.scope?.includes('agent') ? loop : undefined
    try {
      const added = await client.request<{ id: number }>('POST', `/agents/${enc(id)}/timers`, { body: { ...rest, ...(effectiveLoop ? { loop: effectiveLoop } : {}) } })
      return { success: true, id: added.id }
    } catch (err) {
      rethrowIfGone(err, id)
      return { success: false, error: errorString(err) }
    }
  }),

  // Embedded's update never moves a timer to another loop: `loop` is not sent.
  [IPC.DOC_UPDATE_TIMER]: (ctx, _event, args: TimerArgs & { id: number }) => onOpenFile(ctx, 'Updating a timer of the open agent', { success: false, error: 'No workspace open' }, async (client, id) => {
    const refusal = await timerRefusal(args)
    if (refusal) return { success: false, error: refusal }
    const { id: timerId, loop: _loop, ...rest } = args
    try {
      const updated = await client.request<{ success: boolean }>('PUT', `/agents/${enc(id)}/timers/${enc(String(timerId))}`, { body: rest })
      return { success: updated.success }
    } catch (err) {
      rethrowIfGone(err, id)
      return { success: false, error: errorString(err) }
    }
  }),

  [IPC.DOC_DELETE_TIMER]: (ctx, _event, args: { id: number }) => onOpenFile(ctx, 'Deleting a timer of the open agent', { success: false }, async (client, id) => {
    const deleted = await client.request<{ success: boolean }>('DELETE', `/agents/${enc(id)}/timers/${enc(String(args.id))}`)
    return { success: deleted.success }
  }),

  // --- Logs, tasks ------------------------------------------------------------------

  [IPC.DOC_GET_LOGS]: (ctx, _event, args: { limit?: number } = {}) => onOpenFile(ctx, 'Reading the open agent\'s logs', { logs: [], count: 0 }, async (client, id) => {
    const { logs } = await client.request<{ logs: unknown[] }>('GET', `/agents/${enc(id)}/logs`, { query: { limit: args?.limit ?? LOGS_DEFAULT_LIMIT } })
    return { logs, count: logs.length }
  }),

  [IPC.DOC_GET_LOGS_AFTER]: (ctx, _event, args: { afterId: number }) => onOpenFile(ctx, 'Reading the open agent\'s logs', { logs: [] }, async (client, id) => {
    const { logs } = await client.request<{ logs: unknown[] }>('GET', `/agents/${enc(id)}/logs/after`, { query: { afterId: args.afterId } })
    return { logs }
  }),

  [IPC.DOC_CLEAR_LOGS]: (ctx) => onOpenFile(ctx, 'Clearing the open agent\'s logs', { success: false }, async (client, id) => {
    await client.request('DELETE', `/agents/${enc(id)}/logs`)
    return { success: true }
  }),

  // The task rows as stored: the daemon's "Always approve" affordance fields are not part of embedded's answer.
  [IPC.DOC_GET_TASKS]: (ctx, _event, args: { limit?: number } = {}) => onOpenFile(ctx, 'Reading the open agent\'s tasks', { tasks: [] }, async (client, id) => {
    const { tasks } = await client.request<{ tasks: Array<TaskEntry & { canAlwaysApprove?: boolean; alwaysApproveBlockedReason?: string }> }>(
      'GET', `/agents/${enc(id)}/tasks`, { query: { limit: args?.limit } })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return { tasks: tasks.map(({ canAlwaysApprove, alwaysApproveBlockedReason, ...task }) => task) }
  }),

  // --- Internal files -------------------------------------------------------------------

  [IPC.DOC_GET_FILES]: (ctx) => onOpenFile(ctx, 'Listing the open agent\'s files', { files: [] }, async (client, id) => {
    const { files } = await client.request<{ files: unknown[] }>('GET', `/agents/${enc(id)}/files`)
    return { files }
  }),

  // `unique` numbers the new file instead of replacing one; the daemon picks the free name.
  [IPC.DOC_UPLOAD_FILE]: (ctx, _event, args: { path: string; data: number[]; mimeType?: string; unique?: boolean }) => onOpenFile(ctx, 'Uploading a file to the open agent', { success: false } as { success: boolean; path?: string }, async (client, id) => {
    const saved = await putRaw(client, id, { path: args.path, mimeType: args.mimeType ?? 'application/octet-stream', unique: args.unique }, Buffer.from(new Uint8Array(args.data)))
    return { success: true, path: saved.path }
  }),

  [IPC.DOC_IMPORT_PATHS]: (ctx, _event, args: { paths: string[] }) => onOpenFile(ctx, 'Importing files into the open agent', { success: false, count: 0 }, (client, id) => importPaths(client, id, args.paths)),

  [IPC.DOC_PICK_AND_IMPORT]: (ctx) => onOpenFile(ctx, 'Importing files into the open agent', { success: false, count: 0 }, async (client, id) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog({
      ...(win ? { window: win } : {}),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    } as Electron.OpenDialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { success: false, count: 0 }
    return importPaths(client, id, result.filePaths)
  }),

  [IPC.DOC_DELETE_INTERNAL_FILE]: (ctx, _event, args: { path: string }) => onOpenFile(ctx, 'Deleting a file of the open agent', { success: false }, async (client, id) => {
    const deleted = await client.request<{ success: boolean }>('DELETE', `/agents/${enc(id)}/files/content`, { query: { path: args.path } })
    return { success: deleted.success }
  }),

  [IPC.DOC_RENAME_INTERNAL_FILE]: (ctx, _event, args: { oldPath: string; newPath: string }) => onOpenFile(ctx, 'Renaming a file of the open agent', { success: false }, async (client, id) => {
    try {
      const renamed = await client.request<{ success: boolean }>('POST', `/agents/${enc(id)}/files/rename`, { body: { oldPath: args.oldPath, newPath: args.newPath } })
      return { success: renamed.success }
    } catch (err) {
      rethrowIfGone(err, id)
      return { success: false, error: errorString(err) }
    }
  }),

  [IPC.DOC_RENAME_FOLDER]: (ctx, _event, args: { oldPrefix: string; newPrefix: string }) => onOpenFile(ctx, 'Renaming a folder of the open agent', { success: false, count: 0 }, async (client, id) => {
    try {
      const renamed = await client.request<{ count: number }>('POST', `/agents/${enc(id)}/files/rename-folder`, { body: { oldPrefix: args.oldPrefix, newPrefix: args.newPrefix } })
      return { success: true, count: renamed.count }
    } catch (err) {
      rethrowIfGone(err, id)
      return { success: false, count: 0, error: errorString(err) }
    }
  }),

  [IPC.DOC_SET_FILE_PROTECTION]: (ctx, _event, args: { path: string; protection: 'read_only' | 'no_delete' | 'none' }) => onOpenFile(ctx, 'Setting a file protection of the open agent', { success: false }, async (client, id) => {
    const set = await client.request<{ success: boolean }>('PATCH', `/agents/${enc(id)}/files/protection`, { body: { path: args.path, protection: args.protection } })
    return { success: set.success }
  }),

  [IPC.DOC_SET_FILE_AUTHORIZED]: (ctx, _event, args: { path: string; authorized: boolean }) => onOpenFile(ctx, 'Authorizing a file of the open agent', { success: false }, async (client, id) => {
    const set = await client.request<{ success: boolean }>('PATCH', `/agents/${enc(id)}/files/authorized`, { body: { path: args.path, authorized: args.authorized } })
    return { success: set.success }
  }),

  [IPC.DOC_WRITE_INTERNAL_FILE]: (ctx, _event, args: { path: string; content: string }) => onOpenFile(ctx, 'Writing a file of the open agent', { success: false }, async (client, id) => {
    await client.request('PUT', `/agents/${enc(id)}/files/content`, { query: { path: args.path }, body: { content: args.content } })
    return { success: true }
  }),

  // The bytes come from the daemon; the save dialog and the write stay in Studio main.
  [IPC.DOC_DOWNLOAD_INTERNAL_FILE]: (ctx, _event, args: { path: string }) => onOpenFile(ctx, 'Downloading a file of the open agent', { success: false }, async (_client, id) => {
    const res = await ctx.raw(`/agents/${enc(id)}/files/raw`, { path: args.path })
    if (res.status === 404) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      const err = new DaemonError(body?.error ?? 'HTTP 404', 404, body)
      rethrowIfGone(err, id)
      return { success: false, error: 'File not found' }
    }
    if (!res.ok) throw new Error(`The ADF daemon answered ${res.status} for ${args.path}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const fileName = args.path.includes('/') ? args.path.split('/').pop()! : args.path
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showSaveDialog({
      ...(win ? { window: win } : {}),
      defaultPath: fileName,
    } as Electron.SaveDialogOptions)
    if (result.canceled || !result.filePath) return { success: false }
    await writeFile(result.filePath, buf)
    return { success: true }
  }),

  // --- Meta ---------------------------------------------------------------------------

  [IPC.DOC_GET_ALL_META]: (ctx) => onOpenFile(ctx, 'Reading the open agent\'s meta', { entries: [] }, async (client, id) => {
    const { entries } = await client.request<{ entries: unknown[] }>('GET', `/agents/${enc(id)}/meta`)
    return { entries }
  }),

  [IPC.DOC_SET_META]: (ctx, _event, args: { key: string; value: string; protection?: string }) => onOpenFile(ctx, 'Writing the open agent\'s meta', { success: false }, async (client, id) => {
    await client.request('PUT', `/agents/${enc(id)}/meta/${enc(args.key)}`, { body: { value: args.value, ...(args.protection !== undefined ? { protection: args.protection } : {}) } })
    return { success: true }
  }),

  [IPC.DOC_DELETE_META]: (ctx, _event, args: { key: string }) => onOpenFile(ctx, 'Deleting the open agent\'s meta', { success: false }, async (client, id) => {
    const deleted = await client.request<{ success: boolean }>('DELETE', `/agents/${enc(id)}/meta/${enc(args.key)}`)
    return { success: deleted.success }
  }),

  [IPC.DOC_SET_META_PROTECTION]: (ctx, _event, args: { key: string; protection: string }) => onOpenFile(ctx, 'Setting a meta protection of the open agent', { success: false }, async (client, id) => {
    const set = await client.request<{ success: boolean }>('PATCH', `/agents/${enc(id)}/meta/${enc(args.key)}/protection`, { body: { protection: args.protection } })
    return { success: set.success }
  }),

  // --- Local tables -------------------------------------------------------------------

  [IPC.DOC_LIST_LOCAL_TABLES]: (ctx) => onOpenFile(ctx, 'Listing the open agent\'s tables', { tables: [] }, async (client, id) => {
    const { tables } = await client.request<{ tables: unknown[] }>('GET', `/agents/${enc(id)}/tables`)
    return { tables }
  }),

  [IPC.DOC_QUERY_LOCAL_TABLE]: (ctx, _event, args: { table: string; limit?: number; offset?: number }) => onOpenFile(ctx, 'Reading a table of the open agent', { columns: [], rows: [] }, async (client, id) => {
    if (invalidTable(args.table, true)) return { columns: [], rows: [], error: 'Invalid table name' }
    try {
      const page = await client.request<{ columns: string[]; rows: Record<string, unknown>[] }>('GET', `/agents/${enc(id)}/tables/${enc(args.table)}`, {
        query: { limit: args.limit ?? 100, offset: args.offset ?? 0 },
      })
      return { columns: page.columns, rows: page.rows }
    } catch (err) {
      rethrowIfGone(err, id)
      return { columns: [], rows: [], error: errorString(err) }
    }
  }),

  [IPC.DOC_DROP_LOCAL_TABLE]: (ctx, _event, args: { table: string }) => onOpenFile(ctx, 'Dropping a table of the open agent', { success: false }, async (client, id) => {
    if (invalidTable(args.table, false)) return { success: false, error: 'Invalid table name' }
    const dropped = await client.request<{ success: boolean }>('DELETE', `/agents/${enc(id)}/tables/${enc(args.table)}`)
    return { success: dropped.success }
  }),
}

