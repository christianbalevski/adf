import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError } from '../../../../shared/daemon-client'
import type { RemoteBrowseResult } from '../../../../shared/types/backend.types'
import type { DaemonHandlerTable } from '../context'
import { errorMessage } from '../documents/open-file'

/**
 * The picker's own channels, in both daemon modes (the loop in index.ts
 * registers them; outside daemon mode backend-settings-ipc.ts answers).
 */
export const REMOTE_PICKER_HANDLERS: DaemonHandlerTable = {
  [IPC.REMOTE_PICKER_RESPOND]: async (ctx, _event, requestId: unknown, answer: unknown) => ctx.remote?.picker.respond(requestId, answer) ?? false,

  [IPC.REMOTE_FS_BROWSE]: async (ctx, _event, args?: { path?: unknown; showHidden?: unknown }): Promise<RemoteBrowseResult> => {
    const path = typeof args?.path === 'string' && args.path.trim() ? args.path : undefined
    try {
      const client = await ctx.ready()
      return await client.request('GET', '/fs/browse', { query: { path, showHidden: args?.showHidden === true ? 'true' : undefined } })
    } catch (err) {
      const body = err instanceof DaemonError ? err.body as { code?: unknown } | null : null
      return { error: errorMessage(err), ...(typeof body?.code === 'string' ? { code: body.code } : {}) }
    }
  },
}
