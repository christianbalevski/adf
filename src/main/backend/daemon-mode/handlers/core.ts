import { dialog } from 'electron'
import { basename } from 'node:path'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { AgentStatus, ChatHistory } from '../../../../shared/daemon-client'
import { resolveStartInState, type AgentConfig } from '../../../../shared/types/adf-v02.types'
import { MAX_INLINE_BINARY_BYTES } from '../../../../shared/utils/image-files'
import type { FleetPendingInteraction } from '../../../../shared/types/ipc.types'
import { DaemonModeUnavailableError } from '../errors'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { samePath } from '../session'
import { TURN_WAIT_TIMEOUT_MS } from '../event-bridge'
import { isAgentGone, onOpenFile, requireOpenAgent } from '../documents/open-file'

/**
 * The daemon-mode handlers of the core flow: open a file, read it, start the
 * agent, chat with it, stop it (the three parity scenarios, tracker W0-F).
 * Results have the embedded handlers' shapes (src/main/ipc/index.ts); W3-A's
 * handlers for the rest of FILE_*, DOC_*, AGENT_* (documents/) build on the
 * same session.
 *
 * The open file's agent is the document the client session holds (W2-B,
 * W2-A's open documents) or the agent already running at that path. With
 * the interim GET /events adapter, which holds nothing, a file that is open
 * but not running is refused visibly (W2-B); it is never read another way.
 */

/** Same window as embedded DOC_GET_BATCH / DOC_GET_CHAT. */
const LOOP_DISPLAY_LIMIT = 200

/** Embedded DOC_READ_INTERNAL_FILE's text extensions (ipc/index.ts). */
const TEXT_EXTS = new Set(['md', 'txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'log', 'sql', 'env', 'cfg', 'ini', 'jsx', 'tsx'])

function mapChat(history: ChatHistory['chatHistory']): { version: number; uiLog: unknown[]; llmMessages: unknown[]; earlierCount: number } {
  // The daemon answers null for an empty loop; embedded answers an empty view.
  if (!history) return { version: 1, uiLog: [], llmMessages: [], earlierCount: 0 }
  return { version: history.version, uiLog: history.uiLog, llmMessages: history.llmMessages, earlierCount: history.earlierCount }
}

/** GET /agents/:id/status: answers an open document too (`running: false`). */
type TargetStatus = AgentStatus & { running?: boolean; sessionId?: string }

/** The agent's status while it runs in the daemon; null for an open document that is not running, or an unknown id. */
async function agentStatus(ctx: DaemonModeContext, agentId: string | null): Promise<TargetStatus | null> {
  if (!agentId) return null
  const client = await ctx.ready()
  try {
    const status = await client.request<TargetStatus>('GET', `/agents/${enc(agentId)}/status`)
    return status.running === false ? null : status
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** The password gate (design §6.1 row 27): the file has a legacy password and the daemon holds no key for it. */
async function passwordLocked(ctx: DaemonModeContext, agentId: string): Promise<boolean> {
  const client = await ctx.ready()
  const pw = await client.request<{ needsPassword: boolean; unlocked: boolean }>('GET', `/agents/${enc(agentId)}/identity/password`)
  return pw.needsPassword && !pw.unlocked
}

/** GET /agents/:id/header (document-routes.ts). */
interface AgentHeader { agentId: string; document: string; agentConfig: AgentConfig; statusText: string }
/** GET /agents/:id/batch: the header, the token figures and main's last 200 display entries. */
interface AgentBatch extends AgentHeader {
  lastTokens?: unknown
  contextBaseline: unknown
  chat: { version: number; uiLog: unknown[]; llmMessages: unknown[]; earlierCount: number; total: number }
}

export const CORE_HANDLERS: DaemonHandlerTable = {
  [IPC.FILE_OPEN]: async (ctx, _event, args?: { filePath?: string }) => {
    try {
      let filePath = args?.filePath
      if (!filePath) {
        if (ctx.mode === 'remote') throw new DaemonModeUnavailableError('Opening a file with the native dialog in remote mode', 'W4-B', 'daemon-side picker')
        const result = await dialog.showOpenDialog({
          filters: [{ name: 'Agent Document Format', extensions: ['adf'] }],
          properties: ['openFile'],
        })
        if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Cancelled' }
        filePath = result.filePaths[0]
      }
      await ctx.ready()
      ctx.recordRecentFile(filePath)
      const opened = await ctx.session.openFile(filePath, (p) => ctx.runningAgentAt(p))
      const status = await agentStatus(ctx, opened.agentId)
      const agentWasRunning = status !== null
      // Prompt on open, before any start, as embedded (useAdfFile opens the
      // dialog on needsPassword): the held document, or the running agent,
      // reports whether the daemon holds the file's key.
      if (opened.agentId && await passwordLocked(ctx, opened.agentId)) {
        ctx.session.forgetUnlocked(filePath)
        return { success: true, filePath, needsPassword: true }
      }
      return { success: true, filePath, agentWasRunning }
    } catch (error) {
      if (error instanceof DaemonModeUnavailableError) throw error
      ctx.log.error('[Backend] FILE_OPEN error:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  [IPC.FILE_CLOSE]: async (ctx) => {
    await ctx.session.closeFile()
    return { success: true }
  },

  // Session resync for a fresh renderer, as embedded: the open file, and whether its agent runs.
  [IPC.FILE_GET_CURRENT]: async (ctx) => {
    const filePath = ctx.session.filePath
    if (!filePath) return { filePath: null, agentRunning: false }
    const status = await agentStatus(ctx, ctx.session.agentId)
    return { filePath, agentRunning: status !== null }
  },

  // W2-A's one-call reads (document-routes.ts), each the embedded handler's body.
  [IPC.DOC_GET_BATCH]: async (ctx) => {
    return onOpenFile<unknown>(ctx, 'Reading the open agent', { document: '', agentConfig: null, chat: null }, async (client, id) => {
      const b = await client.request<AgentBatch>('GET', `/agents/${enc(id)}/batch`)
      return {
        document: b.document,
        agentConfig: b.agentConfig,
        lastTokens: b.lastTokens,
        contextBaseline: b.contextBaseline,
        statusText: b.statusText,
        chat: { version: b.chat.version, uiLog: b.chat.uiLog, llmMessages: b.chat.llmMessages, earlierCount: b.chat.earlierCount },
      }
    })
  },

  [IPC.DOC_GET_HEADER]: async (ctx) => {
    return onOpenFile<unknown>(ctx, 'Reading the open agent', { document: '', agentConfig: null, statusText: '' }, async (client, id) => {
      const h = await client.request<AgentHeader>('GET', `/agents/${enc(id)}/header`)
      return { document: h.document, agentConfig: h.agentConfig, statusText: h.statusText }
    })
  },

  [IPC.DOC_GET_CHAT]: async (ctx, _event, args?: { loop?: string }) => {
    return onOpenFile<unknown>(ctx, 'Reading the open agent\'s chat', { chatHistory: null }, async (client, id) => {
      const chat = await client.request<ChatHistory>('GET', `/agents/${enc(id)}/chat`, { query: { limit: LOOP_DISPLAY_LIMIT, loop: args?.loop } })
      return { chatHistory: mapChat(chat.chatHistory) }
    })
  },

  /**
   * W1-E's metadata and raw routes: a binary file the caller only flags as
   * binary is never downloaded, and an inline binary is capped by the daemon
   * (maxBytes) rather than downloaded to be thrown away.
   */
  [IPC.DOC_READ_INTERNAL_FILE]: async (ctx, _event, args: { path: string; binaryContent?: boolean }) => {
    if (!ctx.session.filePath) return { content: null, binary: false }
    const client = await ctx.ready()
    const agentId = requireOpenAgent(ctx, 'Reading a file of the open agent')
    let meta: { mime_type: string | null; size: number }
    try {
      meta = await client.request<{ mime_type: string | null; size: number }>('GET', `/agents/${enc(agentId)}/files/meta`, { query: { path: args.path } })
    } catch (err) {
      if (!isNotFound(err)) throw err
      // Unknown file, or the agent stopped and nothing holds its document: tell them apart.
      if (isAgentGone(err, agentId)) {
        throw new DaemonModeUnavailableError('Reading a file of the open agent', 'W2-B', `${ctx.session.filePath} is no longer running in the daemon, and holding it open needs a client session`)
      }
      return { content: null, binary: false }
    }
    const ext = args.path.split('.').pop()?.toLowerCase() ?? ''
    const text = TEXT_EXTS.has(ext)
    if (!text && !args.binaryContent) return { content: '', binary: true, mimeType: meta.mime_type, size: meta.size }
    if (!text && meta.size > MAX_INLINE_BINARY_BYTES) return { content: '', binary: true, tooLarge: true, mimeType: meta.mime_type, size: meta.size }
    const res = await ctx.raw(`/agents/${enc(agentId)}/files/raw`, { path: args.path, ...(text ? {} : { maxBytes: MAX_INLINE_BINARY_BYTES }) })
    if (res.status === 404) return { content: null, binary: false }
    if (res.status === 413) return { content: '', binary: true, tooLarge: true, mimeType: meta.mime_type, size: meta.size }
    if (!res.ok) throw new Error(`The ADF daemon answered ${res.status} for ${args.path}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const info = { mimeType: meta.mime_type, size: buf.length }
    if (text) return { content: buf.toString('utf-8'), binary: false, ...info }
    return { content: buf.toString('base64'), binary: true, ...info }
  },

  [IPC.AGENT_STATUS]: async (ctx) => {
    const status = await agentStatus(ctx, ctx.session.agentId)
    return status ? { running: true, state: status.runtimeState } : { running: false, state: 'stopped' }
  },

  [IPC.AGENT_START]: async (ctx, _event, args?: { filePath?: string; hasUserMessage?: boolean }) => {
    const filePath = ctx.session.filePath
    if (!filePath) return { success: false, error: 'No file open' }
    if (args?.filePath && !samePath(args.filePath, filePath)) {
      return { success: false, error: 'Agent file changed since start was requested' }
    }
    const client = await ctx.ready()
    let running = await agentStatus(ctx, ctx.session.agentId ?? await ctx.runningAgentAt(filePath))
    if (running && (running.runtimeState === 'stopped' || running.runtimeState === 'error')) {
      // Embedded rebuilds an executor in error or stopped state instead of
      // re-attaching it: the daemon's equivalent is a stop and a fresh start.
      ctx.log.log(`[Backend] AGENT_START: ${filePath} is "${running.runtimeState}" in the daemon; restarting it`)
      await client.request('POST', `/agents/${enc(running.id)}/stop`, { timeoutMs: 60_000 })
      running = null
    }
    if (running) {
      // Reuse path, as embedded re-attaches the running executor: its display
      // state, its session id, and main's pending approvals and asks.
      ctx.session.noteAgent(filePath, running.id)
      const agentPath = running.filePath ?? filePath
      // Side reads: a failed one never fails the re-attach (embedded reads them from the live executor).
      const sideRead = <T,>(what: string, fallback: T) => (err: unknown): T => {
        ctx.log.warn(`[Backend] AGENT_START: could not read ${what} of ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
        return fallback
      }
      const [triggers, interactions] = await Promise.all([
        client.request<{ displayState: string | null }>('GET', `/agents/${enc(running.id)}/triggers`).catch(sideRead('the display state', { displayState: null })),
        client.request<FleetPendingInteraction[]>('GET', '/approvals/interactions').catch(sideRead('the pending approvals and asks', [] as FleetPendingInteraction[])),
      ])
      const mine = interactions.filter((i) => samePath(i.filePath, agentPath))
      return {
        success: true,
        sessionId: running.sessionId,
        agentState: triggers.displayState ?? running.runtimeState,
        pendingApprovals: mine.filter((i) => i.type === 'approval').map((i) => ({
          requestId: i.requestId,
          name: i.toolName,
          input: i.input,
          ...(i.reason !== undefined ? { reason: i.reason } : {}),
          ...(i.protection !== undefined ? { protection: i.protection } : {}),
          ...(i.canAlwaysApprove !== undefined ? { canAlwaysApprove: i.canAlwaysApprove } : {}),
          ...(i.alwaysApproveBlockedReason !== undefined ? { alwaysApproveBlockedReason: i.alwaysApproveBlockedReason } : {}),
        })),
        pendingAsks: mine.filter((i) => i.type === 'ask').map((i) => ({ requestId: i.requestId, question: i.question })),
      }
    }
    // Prompt before start (design §6.1 row 27): FILE_OPEN already asked for
    // the password of a held document; one whose key the daemon still lacks
    // is not started with a locked provider. The renderer opens the password
    // dialog on this code (utils/start-agent.ts).
    const documentId = ctx.session.current?.held ? ctx.session.agentId : null
    if (documentId && !ctx.session.isUnlocked(filePath) && await passwordLocked(ctx, documentId)) {
      return { success: false, error: `${basename(filePath, '.adf')} is password-protected. Enter its password to start it.`, code: 'credentials_locked' }
    }
    // Fresh start: W1-A's start route, with Studio's provider gate
    // (`preflight`: provider_missing / provider_unconfigured), the startup
    // turn (on the held document's workspace, W2-A) and `hasUserMessage`.
    const release = ctx.bridge.holdForeground(filePath)
    try {
      const started = await client.request<{ agent?: AgentStatus & { id: string }; sessionId?: string; preflight?: { code: string; message: string } }>(
        'POST', `/agents/${enc(documentId ?? filePath)}/start`, { query: { preflight: 1, ...(args?.hasUserMessage ? { hasUserMessage: 1 } : {}) }, timeoutMs: 120_000 })
      const agentId = started.agent?.id ?? await ctx.runningAgentAt(filePath)
      if (agentId) ctx.session.noteAgent(filePath, agentId)
      const config = agentId ? (await client.request<{ config: AgentConfig }>('GET', `/agents/${enc(agentId)}/config`)).config : null
      const answer = { success: true, sessionId: started.sessionId, agentState: config ? resolveStartInState(config) : started.agent?.runtimeState }
      if (started.preflight) ctx.log.warn(`[Backend] AGENT_START: ${started.preflight.message}`)
      // The key was locked after the open (another client, a wipe): the agent
      // runs with a provider that refuses every call until it is unlocked.
      if (started.preflight?.code === 'credentials_locked') return { ...answer, code: 'credentials_locked' }
      return answer
    } catch (err) {
      const body = (err as { body?: { code?: unknown } }).body
      return { success: false, error: err instanceof Error ? err.message : String(err), ...(typeof body?.code === 'string' ? { code: body.code } : {}) }
    } finally {
      // After the reply reaches the renderer (the next macrotask), as embedded orders it.
      setImmediate(release)
    }
  },

  [IPC.AGENT_STOP]: async (ctx) => {
    const agentId = ctx.session.agentId
    if (!agentId) return { success: true }
    const client = await ctx.ready()
    // Embedded detaches the foreground host before it disposes the agent:
    // the renderer sees none of the teardown's events.
    ctx.bridge.detach(agentId)
    try {
      await client.request('POST', `/agents/${enc(agentId)}/stop`, { timeoutMs: 60_000 })
    } catch (err) {
      if (!isNotFound(err)) {
        ctx.bridge.attach(agentId)
        throw err
      }
    }
    return { success: true }
  },

  [IPC.AGENT_INVOKE]: async (ctx, _event, args: { userMessage?: string; filePath?: string; content?: Array<{ type: string }>; loop?: string }) => {
    const client = await ctx.ready()
    const target = args?.filePath ?? ctx.session.filePath
    if (!target) return { success: false, error: 'Agent not running' }
    const agentId = samePath(target, ctx.session.filePath) && ctx.session.agentId ? ctx.session.agentId : await ctx.runningAgentAt(target)
    if (!agentId || !(await agentStatus(ctx, agentId))) return { success: false, error: 'Agent not running' }
    // Content blocks (images, files) go as they are, as embedded's content_json.
    const blocks = Array.isArray(args?.content) && args.content.length > 0 ? args.content : null
    const body = blocks ? { content: blocks } : { text: args?.userMessage ?? '' }
    try {
      // `echoed`: the renderer already shows the message, as embedded's dispatch marks it.
      const { turnId } = await client.request<{ turnId: string }>('POST', `/agents/${enc(agentId)}/chat`, { body: { ...body, ...(args?.loop ? { loop: args.loop } : {}), echoed: true } })
      // Embedded resolves once the dispatched turn has run; so does this.
      const outcome = await ctx.bridge.waitForTurn(agentId, turnId, args?.loop ?? 'main')
      if (outcome === 'disconnected') return { success: false, error: 'The connection to the ADF daemon was lost while the message waited for its turn; the chat shows what arrived.' }
      if (outcome === 'timeout') return { success: false, error: `No end of the turn arrived from the ADF daemon within ${TURN_WAIT_TIMEOUT_MS / 60_000} minutes.` }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  },
}
