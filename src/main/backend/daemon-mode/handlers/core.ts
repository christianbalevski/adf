import { dialog } from 'electron'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { AgentStatus, ChatHistory } from '../../../../shared/daemon-client'
import { resolveStartInState, type AgentConfig } from '../../../../shared/types/adf-v02.types'
import { MAX_INLINE_BINARY_BYTES } from '../../../../shared/utils/image-files'
import { DaemonModeUnavailableError } from '../errors'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { samePath } from '../session'
import { TURN_WAIT_TIMEOUT_MS } from '../event-bridge'

/**
 * The daemon-mode handlers of the core flow: open a file, read it, start the
 * agent, chat with it, stop it (the three parity scenarios, tracker W0-F).
 * Results have the embedded handlers' shapes (src/main/ipc/index.ts); the
 * W3-A handlers for the rest of FILE_*, DOC_*, AGENT_* build on the same
 * session.
 *
 * The daemon's /agents/:id routes reach running agents and open documents
 * (W2-A), but a client opens a document only through its client session's
 * hold (W2-B). Until then a file's contents are reachable only while its
 * agent runs in the daemon. Reading a file that is open but not running
 * throws a DaemonModeUnavailableError naming W2-B; it never reads the file
 * another way.
 */

/** Same window as embedded DOC_GET_BATCH / DOC_GET_CHAT. */
const LOOP_DISPLAY_LIMIT = 200

/** Embedded DOC_READ_INTERNAL_FILE's text extensions (ipc/index.ts). */
const TEXT_EXTS = new Set(['md', 'txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'log', 'sql', 'env', 'cfg', 'ini', 'jsx', 'tsx'])

/** The open file's agent id, or a visible refusal when its agent does not run in the daemon. */
function requireOpenAgent(ctx: DaemonModeContext, what: string): string {
  const id = ctx.session.agentId
  if (id) return id
  throw new DaemonModeUnavailableError(what, 'W2-B', `${ctx.session.filePath} is not running in the daemon, and holding it open needs a client session`)
}

/** Reads of the open agent; a 404 means it stopped (a session's hold keeps the document open across a stop, W2-B). */
async function readOpenAgent<T>(ctx: DaemonModeContext, what: string, read: (agentId: string) => Promise<T>): Promise<T> {
  const agentId = requireOpenAgent(ctx, what)
  try {
    return await read(agentId)
  } catch (err) {
    if (isNotFound(err)) {
      throw new DaemonModeUnavailableError(what, 'W2-B', `${ctx.session.filePath} is no longer running in the daemon, and holding it open needs a client session`)
    }
    throw err
  }
}

function mapChat(history: ChatHistory['chatHistory']): { version: number; uiLog: unknown[]; llmMessages: unknown[]; earlierCount: number } {
  // The daemon answers null for an empty loop; embedded answers an empty view.
  if (!history) return { version: 1, uiLog: [], llmMessages: [], earlierCount: 0 }
  return { version: history.version, uiLog: history.uiLog, llmMessages: history.llmMessages, earlierCount: history.earlierCount }
}

async function agentStatus(ctx: DaemonModeContext, agentId: string | null): Promise<AgentStatus | null> {
  if (!agentId) return null
  const client = await ctx.ready()
  try {
    return await client.request<AgentStatus>('GET', `/agents/${enc(agentId)}/status`)
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
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
      if (opened.agentId && agentWasRunning) {
        const client = await ctx.ready()
        const pw = await client.request<{ needsPassword: boolean; unlocked: boolean }>('GET', `/agents/${enc(opened.agentId)}/identity/password`)
        if (pw.needsPassword && !pw.unlocked) {
          ctx.session.forgetUnlocked(filePath)
          return { success: true, filePath, needsPassword: true }
        }
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
    if (!ctx.session.filePath) return { document: '', agentConfig: null, chat: null }
    const client = await ctx.ready()
    return readOpenAgent(ctx, 'Reading the open agent', async (id) => {
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
    if (!ctx.session.filePath) return { document: '', agentConfig: null, statusText: '' }
    const client = await ctx.ready()
    return readOpenAgent(ctx, 'Reading the open agent', async (id) => {
      const h = await client.request<AgentHeader>('GET', `/agents/${enc(id)}/header`)
      return { document: h.document, agentConfig: h.agentConfig, statusText: h.statusText }
    })
  },

  [IPC.DOC_GET_CHAT]: async (ctx, _event, args?: { loop?: string }) => {
    if (!ctx.session.filePath) return { chatHistory: null }
    const client = await ctx.ready()
    return readOpenAgent(ctx, 'Reading the open agent\'s chat', async (id) => {
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
      // Unknown file, or the agent stopped: tell them apart.
      if (!(await agentStatus(ctx, agentId))) {
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
    const running = await agentStatus(ctx, ctx.session.agentId ?? await ctx.runningAgentAt(filePath))
    if (running) {
      // Reuse path: the agent already runs in the daemon.
      ctx.session.noteAgent(filePath, running.id)
      const [tasks, asks] = await Promise.all([
        client.request<{ tasks: unknown[] }>('GET', `/agents/${enc(running.id)}/tasks`, { query: { status: 'pending_approval' } }).catch(() => ({ tasks: [] })),
        client.request<{ asks: unknown[] }>('GET', `/agents/${enc(running.id)}/asks`).catch(() => ({ asks: [] })),
      ])
      return { success: true, agentState: running.runtimeState, pendingApprovals: tasks.tasks, pendingAsks: asks.asks }
    }
    // Fresh start: W1-A's start route on the file, with Studio's provider
    // gate (`preflight`: provider_missing / provider_unconfigured) and the
    // startup turn (on the open document's workspace when one is held, W2-A).
    // The route takes no `hasUserMessage` (W3-A); a file whose own key is locked starts unchecked
    // (`preflight.code: credentials_locked`), and the prompt-before-start of
    // design §6.1 row 27 is W3-A's.
    const release = ctx.bridge.holdForeground(filePath)
    try {
      const started = await client.request<{ agent?: AgentStatus & { id: string }; preflight?: { code: string; message: string } }>(
        'POST', `/agents/${enc(filePath)}/start`, { query: { preflight: 1 }, timeoutMs: 120_000 })
      const agentId = started.agent?.id ?? await ctx.runningAgentAt(filePath)
      if (agentId) ctx.session.noteAgent(filePath, agentId)
      if (started.preflight) ctx.log.warn(`[Backend] AGENT_START: ${started.preflight.message}`)
      const config = agentId ? (await client.request<{ config: AgentConfig }>('GET', `/agents/${enc(agentId)}/config`)).config : null
      return { success: true, agentState: config ? resolveStartInState(config) : started.agent?.runtimeState }
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
      const { turnId } = await client.request<{ turnId: string }>('POST', `/agents/${enc(agentId)}/chat`, { body: { ...body, ...(args?.loop ? { loop: args.loop } : {}) } })
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
