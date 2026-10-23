import { nanoid } from 'nanoid'
import { basename, join } from 'node:path'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { AgentStatus, AgentSummary, DaemonClient } from '../../../../shared/daemon-client'
import type { BackgroundAgentStatus } from '../../../../shared/types/ipc.types'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { samePath } from '../session'
import { killCount } from '../kill-epoch'
import { KILL_IN_PROGRESS_ERROR } from '../../../runtime/runtime-gate'
import { daemonCode, daemonStatus, errorMessage, errorString, isAgentGone } from './open-file'

/**
 * Agent runtime actions on the open file's agent (AGENT_*), on background
 * agents by path (BACKGROUND_AGENT_*) and on a folder (DIRECTORY_*), as the
 * embedded handlers answer them (src/main/ipc/index.ts).
 *
 * Foreground and background (design D3) are client state: the open file's
 * agent is the foreground one, every other agent running in the daemon is a
 * background agent. Embedded's background manager never holds the open
 * file's agent, so a BACKGROUND_* call that names the open file answers as
 * embedded does for an agent it does not hold.
 */

const NOT_RUNNING = { success: false, error: 'Agent not running' } as const
const BACKGROUND_NOT_FOUND = { success: false, error: 'Background agent not found' } as const
const REVIEW_REQUIRED = 'Agent must be reviewed before starting. Open it in the foreground first.'

/** Embedded BAM's bounded parallelism for DIRECTORY_START_ALL. */
const DIRECTORY_START_CONCURRENCY = 5

/**
 * Run a runtime action on the open file's agent. Embedded answers
 * "Agent not running" without a running foreground executor; the daemon
 * answers 409 `agent_not_running` for an open document that is not running
 * and 404 for an agent that is gone.
 */
async function onRunningOpenAgent<T>(ctx: DaemonModeContext, fn: (client: DaemonClient, agentId: string) => Promise<T>): Promise<T | typeof NOT_RUNNING> {
  const agentId = ctx.session.filePath ? ctx.session.agentId : null
  if (!agentId) return NOT_RUNNING
  const client = await ctx.ready()
  try {
    return await fn(client, agentId)
  } catch (err) {
    if (notRunning(err, agentId)) return NOT_RUNNING
    throw err
  }
}

function notRunning(err: unknown, agentId: string): boolean {
  return daemonCode(err) === 'agent_not_running' || isAgentGone(err, agentId)
}

/**
 * A request for a HIL item that is not pending any more (answered elsewhere,
 * or swept): embedded's executor ignores it and answers success. The same
 * here, with a log line instead of silence.
 */
/** An approval answered after it ended (decided elsewhere, timed out, drained). */
const STALE_APPROVAL = { success: false, error: 'This approval is no longer pending' } as const

function staleRequest(err: unknown): boolean {
  const status = daemonStatus(err)
  return (status === 404 || status === 409) && daemonCode(err) !== 'agent_not_running'
}

/** The running background agent at `filePath`: null when nothing runs there or it is the open file's agent. */
async function backgroundAgentAt(ctx: DaemonModeContext, filePath: string): Promise<string | null> {
  if (samePath(filePath, ctx.session.filePath, ctx.mode === 'remote')) return null
  return ctx.runningAgentAt(filePath)
}

/**
 * The `.adf` files directly in `dirPath` (not recursive). Local: spelled as
 * embedded's readdir + join spells them. Remote: the daemon's own paths
 * (`entries[].path`), since its OS may join differently from Studio's.
 */
async function adfFilesIn(ctx: DaemonModeContext, client: DaemonClient, dirPath: string): Promise<string[]> {
  const listing = await client.request<{ entries: Array<{ name: string; path?: string; kind: string }> }>('GET', '/fs/browse', { query: { path: dirPath, showHidden: 'true' } })
  return listing.entries
    .filter((e) => e.kind === 'adf' && e.name.endsWith('.adf'))
    .map((e) => (ctx.mode === 'remote' && e.path ? e.path : join(dirPath, e.name)))
}

/** Bounded-parallel map with per-item results, as embedded's mapWithConcurrency. */
async function mapSettled<T>(items: readonly string[], limit: number, fn: (item: string) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      try { results[i] = { status: 'fulfilled', value: await fn(items[i]) } } catch (reason) { results[i] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Embedded BAM.startAgent: load the file and dispatch its startup turn
 * (POST /agents/load assembles without it; POST /agents/:id/start on the
 * loaded agent dispatches it). `requireReview` is the daemon's review gate.
 * `kills`: killCount when the caller's action began; a Kill sent since then
 * refuses the start, or stops what reached the daemon after the Kill did.
 */
async function startInBackground(ctx: DaemonModeContext, client: DaemonClient, filePath: string, requireReview: boolean, kills: number): Promise<string> {
  const killed = () => killCount(ctx) !== kills
  if (killed()) throw new Error(KILL_IN_PROGRESS_ERROR)
  const ref = await client.request<{ id: string }>('POST', '/agents/load', { body: { filePath, requireReview }, timeoutMs: 120_000 })
  if (!killed()) await client.request('POST', `/agents/${enc(ref.id)}/start`, { timeoutMs: 120_000 })
  if (killed()) {
    await client.request('POST', `/agents/${enc(ref.id)}/stop`, { timeoutMs: 60_000 }).catch(() => {})
    throw new Error(KILL_IN_PROGRESS_ERROR)
  }
  return ref.id
}

export const AGENT_HANDLERS: DaemonHandlerTable = {
  // --- the open file's agent -------------------------------------------------

  [IPC.AGENT_COMPACT]: async (ctx) => onRunningOpenAgent(ctx, async (client, agentId) => {
    try {
      await client.request('POST', `/agents/${enc(agentId)}/compact`, { timeoutMs: 300_000 })
      return { success: true }
    } catch (err) {
      if (notRunning(err, agentId)) throw err
      // The daemon answers compactNow's own refusal sentence (409 / 502).
      return { success: false, error: errorMessage(err) }
    }
  }),

  // The composer's Stop (and Esc): the daemon's interrupt, as the terminal app's Esc.
  [IPC.AGENT_INTERRUPT]: async (ctx, _event, args?: { filePath?: string; loop?: string }) => {
    const target = args?.filePath
    const agentId = target && !samePath(target, ctx.session.filePath, ctx.mode === 'remote')
      ? await ctx.runningAgentAt(target)
      : (ctx.session.filePath ? ctx.session.agentId : null)
    if (!agentId) return NOT_RUNNING
    const client = await ctx.ready()
    try {
      const result = await client.interrupt(agentId, args?.loop)
      return { success: true, interrupted: result.interrupted }
    } catch (err) {
      if (notRunning(err, agentId)) return NOT_RUNNING
      return { success: false, error: errorMessage(err) }
    }
  },

  [IPC.AGENT_RUN_COMMAND]: async (ctx, _event, args: { filePath?: string; loop?: string; name: string; args: string; authorize: boolean; requestId?: string }) => {
    const off = { success: false, error: `Agent is off. Start it, then run /${args?.name ?? ''} again.`, code: 'agent_not_running' }
    const target = args?.filePath
    const agentId = target && !samePath(target, ctx.session.filePath, ctx.mode === 'remote')
      ? await ctx.runningAgentAt(target)
      : (ctx.session.filePath ? ctx.session.agentId : null)
    if (!agentId) return off
    try {
      const client = await ctx.ready()
      const { name, args: commandArgs, loop, authorize } = args
      const requestId = args.requestId ?? nanoid()
      const wait = ctx.bridge.waitForOwnerCommand(agentId, requestId, loop || 'main')
      try {
        const result = await client.runCommand(agentId, name, { args: commandArgs, loop, authorize, requestId })
        if (!result.deferred && result.seq !== undefined) await wait.wait()
        return { success: true, ...result }
      } finally { wait.cancel() }
    } catch (err) {
      if (notRunning(err, agentId)) return off
      return { success: false, error: errorMessage(err), code: daemonCode(err) ?? undefined }
    }
  },

  [IPC.AGENT_TOOL_APPROVAL_RESPOND]: async (ctx, _event, args: { requestId: string; approved: boolean; feedback?: string }) =>
    onRunningOpenAgent(ctx, async (client, agentId) => {
      try {
        await client.request('POST', `/agents/${enc(agentId)}/tasks/${enc(args.requestId)}/resolve`, {
          body: { action: args.approved ? 'approve' : 'deny', ...(args.feedback !== undefined ? { reason: args.feedback } : {}) },
        })
      } catch (err) {
        if (!staleRequest(err)) throw err
        // The card must not vanish as if the decision landed: say it did not.
        ctx.log.warn(`[Backend] AGENT_TOOL_APPROVAL_RESPOND: ${args.requestId} is not pending any more (${errorMessage(err)})`)
        return STALE_APPROVAL
      }
      return { success: true }
    }),

  [IPC.AGENT_TOOL_ALWAYS_APPROVE]: async (ctx, _event, args: { requestId: string; toolName: string }) =>
    onRunningOpenAgent(ctx, async (client, agentId) => {
      try {
        await client.request('POST', `/agents/${enc(agentId)}/tasks/${enc(args.requestId)}/always-approve`)
        return { success: true }
      } catch (err) {
        if (notRunning(err, agentId)) throw err
        // 409 carries the blocked reason (protection override, locked declaration), as embedded answers it.
        return { success: false, error: errorMessage(err) }
      }
    }),

  // Main's gated approvals only, as embedded's foreground executor.
  [IPC.AGENT_TOOL_APPROVE_ALL_GATED]: async (ctx) => onRunningOpenAgent(ctx, async (client, agentId) => {
    const { approved, skippedProtection } = await client.request<{ approved: number; skippedProtection: number }>(
      'POST', `/agents/${enc(agentId)}/tasks/approve-all`, { body: { loop: 'main' } })
    return { success: true, approved, skippedProtection }
  }),

  [IPC.AGENT_ASK_RESPOND]: async (ctx, _event, args: { requestId: string; answer: string }) =>
    onRunningOpenAgent(ctx, async (client, agentId) => {
      try {
        await client.request('POST', `/agents/${enc(agentId)}/asks/${enc(args.requestId)}/respond`, { body: { answer: args.answer, loop: 'main' } })
      } catch (err) {
        if (!staleRequest(err)) throw err
        ctx.log.warn(`[Backend] AGENT_ASK_RESPOND: ${args.requestId} is not pending any more (${errorMessage(err)})`)
      }
      return { success: true }
    }),

  [IPC.AGENT_SUSPEND_RESPOND]: async (ctx, _event, args: { resume: boolean }) =>
    onRunningOpenAgent(ctx, async (client, agentId) => {
      try {
        await client.request('POST', `/agents/${enc(agentId)}/suspend/respond`, { body: { resume: args.resume === true } })
      } catch (err) {
        if (notRunning(err, agentId) || daemonStatus(err) === null) throw err
        // Embedded's resolveSuspend ignores a call with nothing pending.
        ctx.log.warn(`[Backend] AGENT_SUSPEND_RESPOND: ${errorMessage(err)}`)
      }
      return { success: true }
    }),

  // --- background agents (by path) ----------------------------------------------

  /** Embedded startBackgroundAgentGated: foreground, review and password gates, then the start. */
  [IPC.BACKGROUND_AGENT_START]: async (ctx, _event, args: { filePath: string }) => {
    const filePath = args?.filePath
    if (samePath(filePath, ctx.session.filePath, ctx.mode === 'remote')) return { success: false, error: 'Cannot start background agent for the foreground file' }
    const kills = killCount(ctx)
    const client = await ctx.ready()
    // GET /files/agent peeks a file that is not loaded: its review mark and its legacy file password.
    const info = await client.request<{ loaded: boolean; reviewed?: boolean; passwordProtected?: boolean }>('GET', '/files/agent', { query: { path: filePath } })
    if (info.loaded) return { success: true }
    if (info.reviewed === false) return { success: false, error: REVIEW_REQUIRED }
    // The daemon holds a file's key while the session that unlocked it holds its document (D4).
    if (info.passwordProtected && !ctx.session.isUnlocked(filePath)) {
      return { success: false, error: 'Agent is password-protected. Open it in the foreground and unlock first.' }
    }
    try {
      await startInBackground(ctx, client, filePath, true, kills)
      return { success: true }
    } catch (err) {
      const code = daemonCode(err)
      if (code === 'AGENT_REVIEW_REQUIRED') return { success: false, error: REVIEW_REQUIRED }
      return { success: false, error: errorMessage(err) || 'Failed to start agent', ...(code ? { code } : {}) }
    }
  },

  /**
   * The background list: every agent running in the daemon except the open
   * file's, in BackgroundAgentStatus form, plus the starts in flight. The
   * bridge learns them here too (`seed`), so the renderer's list and the
   * bridge's background bookkeeping agree from this answer on.
   */
  [IPC.BACKGROUND_AGENT_STATUS]: async (ctx) => {
    const client = await ctx.ready()
    const summaries = await client.request<AgentSummary[]>('GET', '/agents')
    const statuses = (await Promise.all(summaries.map((s) =>
      client.request<AgentStatus>('GET', `/agents/${enc(s.id)}/status`).catch((err) => {
        if (isNotFound(err)) return null
        throw err
      }))))
      .filter((s): s is AgentStatus => !!s && !!s.filePath)
    ctx.bridge.seed(statuses)
    const loaded = new Set(statuses.map((s) => s.id))
    const agents: BackgroundAgentStatus[] = []
    const starting: string[] = []
    for (const agent of ctx.bridge.runningAgents()) {
      if (ctx.session.isFocused(agent.agentId, agent.filePath)) continue
      if (!loaded.has(agent.agentId)) {
        // Announced (agent_starting) but not loaded yet: embedded's pending start.
        starting.push(agent.filePath)
        continue
      }
      const status = statuses.find((s) => s.id === agent.agentId)!
      // The renderer lists it from this answer: later stops reach it as background events.
      ctx.bridge.markListedInBackground(agent.agentId)
      agents.push({
        filePath: agent.filePath,
        handle: status.handle || agent.handle || basename(agent.filePath, '.adf'),
        state: agent.mapping.state,
        activeLoops: agent.mapping.activeLoops,
      })
    }
    return { agents, starting }
  },

  [IPC.BACKGROUND_AGENT_STOP]: async (ctx, _event, args: { filePath: string }) => {
    const agentId = await backgroundAgentAt(ctx, args?.filePath)
    if (!agentId) return { success: false }
    const client = await ctx.ready()
    try {
      await client.request('POST', `/agents/${enc(agentId)}/stop`, { timeoutMs: 60_000 })
      return { success: true }
    } catch (err) {
      if (isNotFound(err)) return { success: false }
      throw err
    }
  },

  [IPC.BACKGROUND_AGENT_ASK_RESPOND]: async (ctx, _event, args: { filePath: string; requestId: string; answer: string }) => {
    const agentId = await backgroundAgentAt(ctx, args?.filePath)
    if (!agentId) return BACKGROUND_NOT_FOUND
    const client = await ctx.ready()
    try {
      await client.request('POST', `/agents/${enc(agentId)}/asks/${enc(args.requestId)}/respond`, { body: { answer: args.answer, loop: 'main' } })
    } catch (err) {
      if (isAgentGone(err, agentId) || daemonCode(err) === 'agent_not_running') return BACKGROUND_NOT_FOUND
      if (!staleRequest(err)) throw err
      ctx.log.warn(`[Backend] BACKGROUND_AGENT_ASK_RESPOND: ${args.requestId} is not pending any more (${errorMessage(err)})`)
    }
    return { success: true }
  },

  [IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND]: async (ctx, _event, args: { filePath: string; requestId: string; approved: boolean; feedback?: string }) => {
    const agentId = await backgroundAgentAt(ctx, args?.filePath)
    if (!agentId) return BACKGROUND_NOT_FOUND
    const client = await ctx.ready()
    try {
      await client.request('POST', `/agents/${enc(agentId)}/tasks/${enc(args.requestId)}/resolve`, {
        body: { action: args.approved ? 'approve' : 'deny', ...(args.feedback !== undefined ? { reason: args.feedback } : {}) },
      })
    } catch (err) {
      if (isAgentGone(err, agentId) || daemonCode(err) === 'agent_not_running') return BACKGROUND_NOT_FOUND
      if (!staleRequest(err)) throw err
      ctx.log.warn(`[Backend] BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND: ${args.requestId} is not pending any more (${errorMessage(err)})`)
      return STALE_APPROVAL
    }
    return { success: true }
  },

  [IPC.BACKGROUND_AGENT_ALWAYS_APPROVE]: async (ctx, _event, args: { filePath: string; requestId: string; toolName: string }) => {
    const agentId = await backgroundAgentAt(ctx, args?.filePath)
    if (!agentId) return BACKGROUND_NOT_FOUND
    const client = await ctx.ready()
    try {
      await client.request('POST', `/agents/${enc(agentId)}/tasks/${enc(args.requestId)}/always-approve`)
      return { success: true }
    } catch (err) {
      if (isAgentGone(err, agentId) || daemonCode(err) === 'agent_not_running') return BACKGROUND_NOT_FOUND
      return { success: false, error: errorMessage(err) }
    }
  },

  // --- folders --------------------------------------------------------------------

  /**
   * Every `.adf` directly in the folder except the open file and the ones
   * already running, five at a time. A failed start is listed with
   * embedded's sentence; the daemon's reason goes to the log.
   */
  [IPC.DIRECTORY_START_ALL]: async (ctx, _event, args: { dirPath: string }) => {
    try {
      const kills = killCount(ctx)
      const client = await ctx.ready()
      const files = await adfFilesIn(ctx, client, args.dirPath)
      const settled = await mapSettled(files, DIRECTORY_START_CONCURRENCY, async (filePath) => {
        if (samePath(filePath, ctx.session.filePath, ctx.mode === 'remote')) return
        // Loaded already: running, or the open file held as a document (also when reached through a link).
        if (await ctx.runningAgentAt(filePath)) return
        try {
          await startInBackground(ctx, client, filePath, false, kills)
        } catch (err) {
          ctx.log.warn(`[Backend] DIRECTORY_START_ALL: ${filePath} did not start: ${errorMessage(err)}`)
          throw new Error('Failed to start agent')
        }
      })
      const failures: Array<{ file: string; error: string }> = []
      settled.forEach((result, i) => {
        if (result.status === 'rejected') failures.push({ file: files[i], error: errorMessage(result.reason) })
      })
      return failures.length > 0 ? { success: true, failures } : { success: true }
    } catch (error) {
      return { success: false, error: errorString(error) }
    }
  },

  [IPC.DIRECTORY_STOP_ALL]: async (ctx, _event, args: { dirPath: string }) => {
    try {
      const client = await ctx.ready()
      for (const filePath of await adfFilesIn(ctx, client, args.dirPath)) {
        if (samePath(filePath, ctx.session.filePath, ctx.mode === 'remote')) continue
        const agentId = await ctx.runningAgentAt(filePath)
        // The open file's agent, also when the folder was named through a link or another spelling than the open path.
        if (!agentId || agentId === ctx.session.agentId) continue
        try {
          await client.request('POST', `/agents/${enc(agentId)}/stop`, { timeoutMs: 60_000 })
        } catch (err) {
          if (!isNotFound(err)) throw err
        }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: errorString(error) }
    }
  },
}
