import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { AgentConfig } from '../../../../shared/types/adf-v02.types'
import type { ContextBreakdown } from '../../../../shared/types/ipc.types'
import { DaemonError } from '../../../../shared/daemon-client'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { samePath } from '../session'

/**
 * Daemon-mode handlers for token usage, token counts, the context
 * breakdown and the home dashboard's slices (tracker W3-D). Results have
 * the embedded handlers' shapes (src/main/ipc/index.ts). Token usage is the
 * daemon's: its runtime records every turn.
 */

/** The model a count defaults to: the open agent's (embedded reads `currentWorkspace`), else anthropic. */
async function countDefaults(ctx: DaemonModeContext, provider?: string, model?: string): Promise<{ provider: string; model: string }> {
  let config: AgentConfig | null = null
  const agentId = ctx.session.agentId
  if ((!provider || !model) && agentId) {
    const client = await ctx.ready()
    try {
      config = (await client.request<{ config: AgentConfig }>('GET', `/agents/${enc(agentId)}/config`)).config
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }
  return {
    provider: provider || config?.model?.provider || 'anthropic',
    model: model || config?.model?.model_id || '',
  }
}

export const USAGE_HANDLERS: DaemonHandlerTable = {
  // --- token usage --------------------------------------------------------------------
  [IPC.TOKEN_USAGE_GET]: async (ctx) => {
    const client = await ctx.ready()
    // The route aggregates; `usage` is the raw date → provider → model record embedded returns.
    return (await client.request<{ usage: unknown }>('GET', '/runtime/usage')).usage
  },

  [IPC.TOKEN_USAGE_CLEAR]: async (ctx) => {
    const client = await ctx.ready()
    await client.request('DELETE', '/runtime/usage')
    return { success: true }
  },

  // Electron-local: the save dialog on this computer, the JSON the renderer passes.
  [IPC.TOKEN_USAGE_EXPORT]: async (_ctx, _event, json: string) => {
    if (typeof json !== 'string') return { success: false }
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showSaveDialog({
      ...(win ? { window: win } : {}),
      defaultPath: `adf-token-usage-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    } as Electron.SaveDialogOptions)
    if (result.canceled || !result.filePath) return { success: false }
    await writeFile(result.filePath, json, 'utf8')
    return { success: true, path: result.filePath }
  },

  [IPC.TOKEN_COUNT]: async (ctx, _event, args: { text: string; provider?: string; model?: string }) => {
    const client = await ctx.ready()
    const defaults = await countDefaults(ctx, args?.provider, args?.model)
    const answer = await client.request<{ count: number }>('POST', '/runtime/token-count', { body: { text: args?.text, ...defaults } })
    return { count: answer.count }
  },

  [IPC.TOKEN_COUNT_BATCH]: async (ctx, _event, args: { texts: string[]; provider?: string; model?: string }) => {
    const client = await ctx.ready()
    const defaults = await countDefaults(ctx, args?.provider, args?.model)
    const answer = await client.request<{ counts: number[] }>('POST', '/runtime/token-count/batch', { body: { texts: args?.texts, ...defaults }, timeoutMs: 120_000 })
    return { counts: answer.counts }
  },

  /**
   * One loop's breakdown from the executor that runs it, or null when the
   * file does not run in the daemon or the loop has no live runtime (the
   * renderer shows "this loop has not run").
   */
  [IPC.CONTEXT_BREAKDOWN_GET]: async (ctx, _event, args: { filePath: string; loop?: string }): Promise<ContextBreakdown | null> => {
    const filePath = args?.filePath
    if (!filePath) return null
    const agentId = samePath(filePath, ctx.session.filePath, ctx.mode === 'remote') && ctx.session.agentId ? ctx.session.agentId : await ctx.runningAgentAt(filePath)
    if (!agentId) return null
    const client = await ctx.ready()
    try {
      const answer = await client.request<{ breakdown: ContextBreakdown | null }>('GET', `/agents/${enc(agentId)}/context`, {
        query: { loop: args.loop || undefined, items: 0 },
      })
      return answer.breakdown ?? null
    } catch (err) {
      // Unknown agent (stopped meanwhile) or loop: nothing to measure.
      if (err instanceof DaemonError && (err.status === 404 || err.status === 409)) return null
      throw err
    }
  },

  // --- home dashboard (each tile loads on its own) ------------------------------------
  [IPC.DASHBOARD_QUICK_STATS]: async (ctx) => {
    const client = await ctx.ready()
    return client.request('GET', '/dashboard/quick-stats')
  },

  [IPC.DASHBOARD_PROVIDER_TESTS]: async (ctx) => {
    const client = await ctx.ready()
    return client.request('GET', '/dashboard/provider-tests', { timeoutMs: 60_000 })
  },

  [IPC.DASHBOARD_AGENT_STATS]: async (ctx) => {
    const client = await ctx.ready()
    return client.request('GET', '/dashboard/agent-stats', { timeoutMs: 120_000 })
  },
}
