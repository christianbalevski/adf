import { BrowserWindow, dialog, shell } from '../platform'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DEFAULT_SHIPPED_TEMPLATE_ID, isShippedTemplateId } from '../../../../shared/constants/shipped-templates'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { AgentConfigSummary, AgentTemplateContents, AgentTemplateListResult, AgentTemplateSummary } from '../../../../shared/types/ipc.types'
import { enc, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { daemonCode, daemonStatus, errorMessage } from './open-file'
import { reviewSummaryKeys } from './file-handlers'

/**
 * Templates (Settings > Agent templates, the home composer's picker) in
 * daemon mode: the daemon's /templates routes over the same AgentTemplatesService
 * and the same `<userData>/templates` folder (daemon/template-routes.ts).
 * Each answer has the shape of the embedded handler's service call
 * (src/main/ipc/index.ts, adf/agent-templates.ts), refusals included: the
 * service's `{ success: false, error }` sentence travels as the route's
 * `error` and comes back as it was.
 *
 * As embedded, templates are listed and edited without the owner identity;
 * accepting a template's review needs it (409 identity_not_ready, its
 * sentence is the answer).
 */

type Fail = { success: false; error: string }
const fail = (err: unknown): Fail => ({ success: false, error: errorMessage(err) })

/** adf/agent-templates.ts isSafeId: a template id is a file stem in the templates folder. */
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.includes('..')
}

interface DaemonTemplateList {
  templates: AgentTemplateSummary[]
  defaultId: string
  folder: string
  migrated?: { id: string }
}

async function listTemplates(ctx: DaemonModeContext): Promise<DaemonTemplateList> {
  const client = await ctx.ready()
  return client.request<DaemonTemplateList>('GET', '/templates')
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

export const TEMPLATE_HANDLERS: DaemonHandlerTable = {
  // The migration notice shows once: `migrated` is dropped once the client key is set (§4.1).
  [IPC.TEMPLATES_LIST]: async (ctx): Promise<AgentTemplateListResult> => {
    const list = await listTemplates(ctx)
    // The service always sets these keys, possibly to undefined; JSON drops
    // undefined ones on the wire, and the renderer's row comparison counts keys.
    const templates = list.templates.map((t) => ({
      ...t,
      description: t.description,
      icon: t.icon,
      templateDescription: t.templateDescription,
      warning: t.warning,
      modelProvider: t.modelProvider,
      modelId: t.modelId,
    }))
    const result: AgentTemplateListResult = { templates, folder: list.folder, defaultId: list.defaultId }
    if (list.migrated && ctx.clientSettings.get('templatesMigrationSeen') !== true) result.migrated = list.migrated
    return result
  },

  [IPC.TEMPLATE_CREATE]: async (ctx, _event, args?: { name?: string; fromId?: string }) => {
    try {
      const client = await ctx.ready()
      const made = await client.request<{ id: string }>('POST', '/templates', {
        body: { name: typeof args?.name === 'string' ? args.name : '', ...(args?.fromId !== undefined ? { fromId: args.fromId } : {}) },
      })
      return { success: true, id: made.id }
    } catch (err) {
      return fail(err)
    }
  },

  /**
   * Local mode: into the OS trash, as embedded (shell.trashItem), so the file
   * is in the Recycle Bin / Trash and restores to the templates folder. The
   * daemon has no OS trash and moves a deleted template into
   * `<userData>/templates-trash`, so Studio trashes the file itself, on the
   * same machine, and resets the default when it was the deleted one (the
   * service's own tail). The daemon's templates-folder watcher then pushes
   * `templates`. Remote mode: the daemon's DELETE (its trash folder on the
   * server).
   */
  [IPC.TEMPLATE_DELETE]: async (ctx, _event, args?: { id?: string }) => {
    const id = args?.id
    if (!isSafeId(id)) return { success: false, error: 'Unknown template.' }
    try {
      const client = await ctx.ready()
      if (ctx.mode === 'remote') {
        await client.request('DELETE', `/templates/${enc(id)}`)
        return { success: true }
      }
      const list = await listTemplates(ctx)
      const path = join(list.folder, `${id}.adf`)
      if (!(await exists(path))) return { success: true }
      await shell.trashItem(path)
      ctx.log.log(`[Templates] Moved ${path} to the OS trash`)
      if (list.defaultId === id) await client.request('PATCH', '/settings', { body: { defaultTemplateId: DEFAULT_SHIPPED_TEMPLATE_ID } })
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  /**
   * The renderer passes the SHIPPED id (`standard`), which names the file only
   * until the owner renames it; the daemon's reset route takes the file's id,
   * so the marked file is found in the list first (the service's findShipped).
   */
  [IPC.TEMPLATE_RESET_SHIPPED]: async (ctx, _event, args?: { id?: string }) => {
    const id = String(args?.id ?? '')
    if (!isShippedTemplateId(id)) return { success: false, error: `"${id}" is not a shipped template.` }
    try {
      const list = await listTemplates(ctx)
      const marked = list.templates.find((t) => t.shipped === id)
      if (!marked && list.templates.some((t) => t.id === id)) {
        return { success: false, error: `${id}.adf in the templates folder is not the shipped template. Rename or remove it first.` }
      }
      const client = await ctx.ready()
      await client.request('POST', `/templates/${enc(marked?.id ?? id)}/reset`)
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  // Local mode: the folder is on this machine (shell, as embedded). Remote: the path as text.
  [IPC.TEMPLATE_REVEAL]: async (ctx, _event, args?: { id?: string }) => {
    const list = await listTemplates(ctx)
    if (ctx.mode === 'remote') {
      throw new Error(`The templates folder is on the daemon's machine, so Studio cannot show it here: ${list.folder}`)
    }
    const path = isSafeId(args?.id) ? join(list.folder, `${args!.id}.adf`) : ''
    if (path && (await exists(path))) shell.showItemInFolder(path)
    else void shell.openPath(list.folder)
  },

  [IPC.TEMPLATE_SET_DEFAULT]: async (ctx, _event, args?: { id?: string }) => {
    try {
      const client = await ctx.ready()
      await client.request('POST', `/templates/${enc(String(args?.id ?? ''))}/default`)
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  [IPC.TEMPLATE_RENAME]: async (ctx, _event, args?: { id?: string; name?: string }) => {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    try {
      const client = await ctx.ready()
      const renamed = await client.request<{ id: string }>('PATCH', `/templates/${enc(args!.id!)}`, { body: { name: typeof args?.name === 'string' ? args.name : '' } })
      return { success: true, id: renamed.id }
    } catch (err) {
      return fail(err)
    }
  },

  [IPC.TEMPLATE_SET_META]: async (ctx, _event, args?: { id?: string; description?: string; warning?: string }) => {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    try {
      const client = await ctx.ready()
      await client.request('PATCH', `/templates/${enc(args!.id!)}`, {
        body: {
          ...(args?.description !== undefined ? { description: args.description } : {}),
          ...(args?.warning !== undefined ? { warning: args.warning } : {}),
        },
      })
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  [IPC.TEMPLATE_GET_CONTENTS]: async (ctx, _event, args?: { id?: string }) => {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    try {
      const client = await ctx.ready()
      const got = await client.request<{ contents: AgentTemplateContents }>('GET', `/templates/${enc(args!.id!)}`)
      return { success: true, contents: got.contents }
    } catch (err) {
      return fail(err)
    }
  },

  [IPC.TEMPLATE_SET_CONFIG]: async (ctx, _event, args?: { id?: string; config?: AgentConfig }) => {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    try {
      const client = await ctx.ready()
      await client.request('PUT', `/templates/${enc(args!.id!)}/config`, { body: { config: args?.config } })
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  [IPC.TEMPLATE_SET_FILE]: async (ctx, _event, args?: { id?: string; path?: string; content?: string }) => {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    const file = (args?.path ?? '').trim()
    if (!file) return { success: false, error: 'Path is required.' }
    try {
      const client = await ctx.ready()
      await client.request('PUT', `/templates/${enc(args!.id!)}/files`, { body: { path: file, content: args?.content ?? '' } })
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  /**
   * The native multi-select picker and the reads stay in Studio main (the
   * files are on this machine in either mode); each picked file goes to the
   * daemon as raw bytes (PUT /templates/:id/files/raw), which names it as
   * embedded does (base name, numbered past a taken one). As embedded, every
   * file is checked before the first is written: not a file, or larger than
   * 25 MB, refuses the whole batch.
   */
  [IPC.TEMPLATE_ADD_FILES]: async (ctx, _event, args?: { id?: string }) => {
    const id = args?.id
    if (!isSafeId(id)) return { success: false, error: 'Unknown template.' }
    try {
      const client = await ctx.ready()
      // The template must exist before the picker opens (embedded checks the file first).
      await client.request('GET', `/templates/${enc(id)}`)
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const picked = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
      if (picked.canceled || picked.filePaths.length === 0) return { success: false, error: 'Cancelled' }

      // Whole batch or nothing, as embedded's addFiles: the daemon plans every
      // name (numbering, reserved seed names, size, non-files) before any upload.
      const items = await Promise.all(picked.filePaths.map(async (host) => {
        const name = basename(host)
        try {
          const info = await stat(host)
          return { name, isFile: info.isFile(), size: info.size }
        } catch (err) {
          return { name, statError: err instanceof Error ? err.message : String(err) }
        }
      }))
      const plan = await client.request<{ success: boolean; dests?: string[]; error?: string }>('POST', `/templates/${enc(id)}/files/plan`, { body: { files: items } })
      if (!plan.success) return { success: false, error: plan.error ?? 'The files were refused.' }

      const added: string[] = []
      for (const host of picked.filePaths) {
        const bytes = await readFile(host)
        const res = await fetchRaw(ctx, `/templates/${enc(id)}/files/raw`, { name: basename(host) }, bytes)
        if (!res.ok) return { success: false, error: res.error }
        added.push(res.path)
      }
      return { success: true, added }
    } catch (err) {
      return fail(err)
    }
  },

  [IPC.TEMPLATE_REMOVE_FILE]: async (ctx, _event, args?: { id?: string; path?: string }) => {
    if (!isSafeId(args?.id)) return { success: false, error: 'Unknown template.' }
    const file = (args?.path ?? '').trim()
    if (!file) return { success: false, error: 'Path is required.' }
    try {
      const client = await ctx.ready()
      await client.request('DELETE', `/templates/${enc(args!.id!)}/files`, { query: { path: file } })
      return { success: true }
    } catch (err) {
      return fail(err)
    }
  },

  // Embedded answers needsReview: false for a missing template and for any failure.
  [IPC.TEMPLATE_CHECK_REVIEW]: async (ctx, _event, args?: { id?: string }) => {
    if (!args?.id) return { needsReview: false }
    try {
      const client = await ctx.ready()
      const review = await client.request<{ needsReview: boolean; summary?: AgentConfigSummary }>('GET', `/templates/${enc(args.id)}/review`)
      return review.needsReview && review.summary ? { needsReview: true, configSummary: reviewSummaryKeys(review.summary) } : { needsReview: false }
    } catch (err) {
      ctx.log.warn('[Backend] TEMPLATE_CHECK_REVIEW error:', errorMessage(err))
      return { needsReview: false }
    }
  },

  [IPC.TEMPLATE_REVIEW_ACCEPT]: async (ctx, _event, args?: { id?: string; password?: string }) => {
    if (!args?.id) return { success: false, error: 'That template is not in the templates folder any more.' }
    try {
      const client = await ctx.ready()
      await client.request('POST', `/templates/${enc(args.id)}/review/accept`, { body: args.password !== undefined ? { password: args.password } : {} })
      return { success: true }
    } catch (err) {
      if (daemonStatus(err) === 404 && daemonCode(err) === 'template_missing') {
        return { success: false, error: 'That template is not in the templates folder any more.' }
      }
      return fail(err)
    }
  },
}

/**
 * One octet-stream upload; the route's `error` sentence on a refusal. The
 * shared client speaks JSON only, so the request is built from its URL and
 * headers: the token goes to the daemon's origin only.
 */
async function fetchRaw(ctx: DaemonModeContext, path: string, query: Record<string, string>, bytes: Buffer): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const client = await ctx.ready()
  const res = await fetch(client.url(path, query), {
    method: 'PUT',
    headers: client.headers({ 'Content-Type': 'application/octet-stream' }),
    body: new Uint8Array(bytes),
    redirect: 'manual',
  })
  const body = await res.json().catch(() => null) as { path?: unknown; error?: unknown } | null
  if (res.ok && typeof body?.path === 'string') return { ok: true, path: body.path }
  return { ok: false, error: typeof body?.error === 'string' ? body.error : `The ADF daemon answered ${res.status} for ${path}` }
}
