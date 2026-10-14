import { dialog } from 'electron'
import { IPC } from '../../../../shared/constants/ipc-channels'
import type { AgentRef, AgentStatus, ChatHistory, ContentResult, FileContent, MetaResult } from '../../../../shared/daemon-client'
import { resolveStartInState, type AgentConfig } from '../../../../shared/types/adf-v02.types'
import { MAX_INLINE_BINARY_BYTES } from '../../../../shared/utils/image-files'
import { DaemonModeUnavailableError } from '../errors'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { samePath } from '../session'

/**
 * The daemon-mode handlers of the core flow: open a file, read it, start the
 * agent, chat with it, stop it (the three parity scenarios, tracker W0-F).
 * Results have the embedded handlers' shapes (src/main/ipc/index.ts); the
 * W3-A handlers for the rest of FILE_*, DOC_*, AGENT_* build on the same
 * session.
 *
 * Until open documents (W2-A) and client sessions (W2-B) land, a file's
 * contents are reachable only while its agent runs in the daemon. Reading a
 * file that is open but not running throws a DaemonModeUnavailableError
 * naming W2-A; it never reads the file another way.
 */

/** Same window as embedded DOC_GET_BATCH / DOC_GET_CHAT. */
const LOOP_DISPLAY_LIMIT = 200

/** Embedded DOC_READ_INTERNAL_FILE's text extensions (ipc/index.ts). */
const TEXT_EXTS = new Set(['md', 'txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'log', 'sql', 'env', 'cfg', 'ini', 'jsx', 'tsx'])

/** The open file's agent id, or a visible refusal when its agent does not run in the daemon. */
function requireOpenAgent(ctx: DaemonModeContext, what: string): string {
  const id = ctx.session.agentId
  if (id) return id
  throw new DaemonModeUnavailableError(what, 'W2-A', `${ctx.session.filePath} is not running in the daemon, and open documents are not available yet`)
}

/** Reads of the open agent; a 404 means it stopped (W2-A keeps the document open across a stop). */
async function readOpenAgent<T>(ctx: DaemonModeContext, what: string, read: (agentId: string) => Promise<T>): Promise<T> {
  const agentId = requireOpenAgent(ctx, what)
  try {
    return await read(agentId)
  } catch (err) {
    if (isNotFound(err)) {
      throw new DaemonModeUnavailableError(what, 'W2-A', `${ctx.session.filePath} is no longer running in the daemon, and open documents are not available yet`)
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

let batchFieldsLogged = false

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

  [IPC.DOC_GET_BATCH]: async (ctx) => {
    if (!ctx.session.filePath) return { document: '', agentConfig: null, chat: null }
    const client = await ctx.ready()
    return readOpenAgent(ctx, 'Reading the open agent', async (id) => {
      const [document, config, chat, meta] = await Promise.all([
        client.request<ContentResult>('GET', `/agents/${enc(id)}/document`),
        client.request<{ config: AgentConfig }>('GET', `/agents/${enc(id)}/config`),
        client.request<ChatHistory>('GET', `/agents/${enc(id)}/chat`, { query: { limit: LOOP_DISPLAY_LIMIT } }),
        client.request<MetaResult>('GET', `/agents/${enc(id)}/meta`),
      ])
      if (!batchFieldsLogged) {
        batchFieldsLogged = true
        ctx.log.warn('[Backend] DOC_GET_BATCH: lastTokens and contextBaseline are not available in daemon mode yet: W2-A (no route returns them)')
      }
      return {
        document: document.content,
        agentConfig: config.config,
        lastTokens: undefined,
        contextBaseline: null,
        statusText: meta.entries.find((e) => e.key === 'status')?.value ?? '',
        chat: mapChat(chat.chatHistory),
      }
    })
  },

  [IPC.DOC_GET_HEADER]: async (ctx) => {
    if (!ctx.session.filePath) return { document: '', agentConfig: null, statusText: '' }
    const client = await ctx.ready()
    return readOpenAgent(ctx, 'Reading the open agent', async (id) => {
      const [document, config, meta] = await Promise.all([
        client.request<ContentResult>('GET', `/agents/${enc(id)}/document`),
        client.request<{ config: AgentConfig }>('GET', `/agents/${enc(id)}/config`),
        client.request<MetaResult>('GET', `/agents/${enc(id)}/meta`),
      ])
      return { document: document.content, agentConfig: config.config, statusText: meta.entries.find((e) => e.key === 'status')?.value ?? '' }
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

  [IPC.DOC_READ_INTERNAL_FILE]: async (ctx, _event, args: { path: string; binaryContent?: boolean }) => {
    if (!ctx.session.filePath) return { content: null, binary: false }
    const client = await ctx.ready()
    const agentId = requireOpenAgent(ctx, 'Reading a file of the open agent')
    let file: FileContent
    try {
      file = await client.request<FileContent>('GET', `/agents/${enc(agentId)}/files/content`, { query: { path: args.path } })
    } catch (err) {
      if (!isNotFound(err)) throw err
      // Unknown file, or the agent stopped: tell them apart.
      if (!(await agentStatus(ctx, agentId))) {
        throw new DaemonModeUnavailableError('Reading a file of the open agent', 'W2-A', `${ctx.session.filePath} is no longer running in the daemon`)
      }
      return { content: null, binary: false }
    }
    const buf = file.encoding === 'base64' ? Buffer.from(file.content_base64 ?? '', 'base64') : Buffer.from(file.content ?? '', 'utf-8')
    const info = { mimeType: file.mime_type, size: buf.length }
    const ext = args.path.split('.').pop()?.toLowerCase() ?? ''
    if (TEXT_EXTS.has(ext)) return { content: buf.toString('utf-8'), binary: false, ...info }
    if (!args.binaryContent) return { content: '', binary: true, ...info }
    if (buf.length > MAX_INLINE_BINARY_BYTES) return { content: '', binary: true, tooLarge: true, ...info }
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
    // Fresh start. Interim until W2-A (start on the open document): load the
    // file, which starts it; `hasUserMessage` has no route parameter yet.
    try {
      const ref = await client.request<AgentRef>('POST', '/agents/load', { body: { filePath, requireReview: true }, timeoutMs: 120_000 })
      ctx.session.noteAgent(filePath, ref.id)
      return { success: true, agentState: resolveStartInState(ref.config) }
    } catch (err) {
      const body = (err as { body?: { code?: unknown } }).body
      return { success: false, error: err instanceof Error ? err.message : String(err), ...(typeof body?.code === 'string' ? { code: body.code } : {}) }
    }
  },

  [IPC.AGENT_STOP]: async (ctx) => {
    const agentId = ctx.session.agentId
    if (!agentId) return { success: true }
    const client = await ctx.ready()
    try {
      await client.request('POST', `/agents/${enc(agentId)}/stop`, { timeoutMs: 60_000 })
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    return { success: true }
  },

  [IPC.AGENT_INVOKE]: async (ctx, _event, args: { userMessage?: string; filePath?: string; content?: Array<{ type: string; text?: string }>; loop?: string }) => {
    const client = await ctx.ready()
    const target = args?.filePath ?? ctx.session.filePath
    if (!target) return { success: false, error: 'Agent not running' }
    const agentId = samePath(target, ctx.session.filePath) && ctx.session.agentId ? ctx.session.agentId : await ctx.runningAgentAt(target)
    if (!agentId || !(await agentStatus(ctx, agentId))) return { success: false, error: 'Agent not running' }
    const blocks = Array.isArray(args?.content) && args.content.length > 0 ? args.content : null
    if (blocks?.some((b) => b.type !== 'text')) {
      throw new DaemonModeUnavailableError('Sending images or files in a chat message', 'W2-A', 'POST /agents/:id/chat takes text only')
    }
    const text = blocks ? blocks.map((b) => b.text ?? '').join('') : (args?.userMessage ?? '')
    try {
      const { turnId } = await client.request<{ turnId: string }>('POST', `/agents/${enc(agentId)}/chat`, { body: { text, ...(args?.loop ? { loop: args.loop } : {}) } })
      // Embedded resolves once the dispatched turn has run; so does this.
      await ctx.bridge.waitForTurn(agentId, turnId, args?.loop ?? 'main')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  },
}
