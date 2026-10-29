import { dialog } from '../platform'
import type { LoopMedia } from '../../../../shared/types/media.types'
import { basename, dirname } from 'node:path'
import { IPC } from '../../../../shared/constants/ipc-channels'
import { DaemonError, type AgentStatus, type ChatHistory } from '../../../../shared/daemon-client'
import { CHAT_BODY_LIMIT_BYTES } from '../../../../shared/constants/chat-limits'
import { resolveStartInState, type AgentConfig } from '../../../../shared/types/adf-v02.types'
import { MAX_INLINE_BINARY_BYTES } from '../../../../shared/utils/image-files'
import type { FleetPendingInteraction } from '../../../../shared/types/ipc.types'
import { DaemonModeUnavailableError } from '../errors'
import { enc, isNotFound, type DaemonHandlerTable, type DaemonModeContext } from '../context'
import { samePath } from '../session'
import { killCount } from '../kill-epoch'
import { KILL_IN_PROGRESS_ERROR } from '../../../runtime/runtime-gate'
import { TURN_WAIT_TIMEOUT_MS } from '../event-bridge'
import { isAgentGone, notOpenError, onOpenFile, requireOpenAgent } from '../documents/open-file'
import { isTempLocation } from '../documents/file-handlers'

/**
 * The daemon-mode handlers of the core flow: open a file, read it, start the
 * agent, chat with it, stop it (the three parity scenarios, tracker W0-F).
 * Results have the embedded handlers' shapes (src/main/ipc/index.ts); W3-A's
 * handlers for the rest of FILE_*, DOC_*, AGENT_* (documents/) build on the
 * same session.
 *
 * FILE_OPEN holds the file as a document of Studio's client session (W2-A,
 * W2-B), so the /agents/:id routes reach it whether its agent runs or not.
 * A file the daemon no longer holds (the hold failed, or the daemon
 * restarted and the re-hold failed) is refused with "open it again"; it is
 * never read another way.
 */

/** Same window as embedded DOC_GET_BATCH / DOC_GET_CHAT. */
const LOOP_DISPLAY_LIMIT = 200

const MIB = 1024 * 1024
/** AGENT_INVOKE: a chat over the daemon's chat route limit, with both sizes. */
function chatTooLarge(bytes: number): string {
  const size = bytes > 0 ? `${(bytes / MIB).toFixed(1)} MB encoded; ` : ''
  return `This message is too large to send: ${size}the ADF daemon accepts at most ${CHAT_BODY_LIMIT_BYTES / MIB} MB per chat message (attachments count base64-encoded). Send fewer or smaller attachments.`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Embedded DOC_READ_INTERNAL_FILE's text extensions (ipc/index.ts). */
const TEXT_EXTS = new Set(['md', 'txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'csv', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'log', 'sql', 'env', 'cfg', 'ini', 'jsx', 'tsx'])

function mapChat(history: ChatHistory['chatHistory']): { version: number; uiLog: unknown[]; llmMessages: unknown[]; earlierCount: number } {
  // The daemon answers null for an empty loop; embedded answers an empty view.
  if (!history) return { version: 1, uiLog: [], llmMessages: [], earlierCount: 0 }
  return { version: history.version, uiLog: history.uiLog, llmMessages: history.llmMessages, earlierCount: history.earlierCount }
}

/** GET /agents/:id/status: answers an open document too (`running: false`). */
type TargetStatus = AgentStatus & { running?: boolean; sessionId?: string; loopStates?: Record<string, string>; media?: Record<string, LoopMedia> }

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

/** A reviewed file that is not loaded, moved out of the temp dir into the agents folder (POST /files/relocate); its new path, or null. */
async function healStrandedTempFile(ctx: DaemonModeContext, filePath: string): Promise<string | null> {
  const client = await ctx.ready()
  try {
    const info = await client.request<{ loaded: boolean; reviewed?: boolean }>('GET', '/files/agent', { query: { path: filePath } })
    if (info.loaded || info.reviewed !== true) return null
    const moved = await client.request<{ movedTo?: string; moveError?: string }>('POST', '/files/relocate', { body: { path: filePath } })
    if (moved.moveError) ctx.log.warn(`[Review] ${moved.moveError}`)
    if (!moved.movedTo) return null
    ctx.log.log(`[Review] Self-healed stranded temp agent -> ${moved.movedTo}`)
    ctx.session.rekey(filePath, moved.movedTo)
    ctx.recordRecentFile(moved.movedTo)
    return moved.movedTo
  } catch (err) {
    ctx.log.warn(`[Review] Could not move ${filePath} out of the temp dir: ${err instanceof Error ? err.message : String(err)}`)
    return null
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
  /** W3-F: the revisions of the config and the document. */
  configRevision?: number
  documentRevision?: number
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
      // dialog on needsPassword): the session's hold answers it (W2-A), and an
      // agent reached only as running is asked directly.
      const locked = opened.opened ? opened.opened.needsPassword === true : !!opened.agentId && await passwordLocked(ctx, opened.agentId)
      if (locked) {
        ctx.session.forgetUnlocked(filePath)
        // A running agent the daemon holds no key for keeps running on the
        // stub provider (every turn fails credentials_locked); other clients
        // may be watching it. It is not stopped: the answer says it runs, the
        // unlock rebuilds its real provider in place, and the renderer
        // re-attaches it after the prompt (useAdfFile completeFileOpen).
        // Embedded stops such a background agent instead (it cannot hand it
        // to the foreground without the key; design §3.2, W5-A1).
        if (agentWasRunning) {
          ctx.log.log(`[Backend] FILE_OPEN: ${basename(filePath)} runs without its password key; asking for the password, the agent keeps running`)
          return { success: true, filePath, needsPassword: true, agentWasRunning: true }
        }
        return { success: true, filePath, needsPassword: true }
      }
      // Self-heal a claimed-but-stranded temp file, as embedded's FILE_OPEN:
      // reviewed already, but a prior move failed and it still sits in the OS
      // temp dir. Local mode only: the temp dir is this machine's.
      if (!agentWasRunning && ctx.mode === 'local' && await isTempLocation(dirname(filePath))) {
        const moved = await healStrandedTempFile(ctx, filePath)
        if (moved) return { success: true, filePath: moved, agentWasRunning, movedTo: moved }
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
        // W3-F: the revisions the config panel and the document tab save over.
        configRevision: b.configRevision,
        documentRevision: b.documentRevision,
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
      // Unknown file, or the daemon no longer has the agent: tell them apart.
      if (isAgentGone(err, agentId)) throw notOpenError(ctx, 'Reading a file of the open agent')
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
    // W3-F: the revision an editor saves over (writeInternalFile's baseRevision), as embedded.
    const revision = Number(res.headers.get('x-adf-revision') ?? NaN)
    if (text) return { content: buf.toString('utf-8'), binary: false, ...info, ...(Number.isSafeInteger(revision) ? { revision } : {}) }
    return { content: buf.toString('base64'), binary: true, ...info }
  },

  [IPC.AGENT_STATUS]: async (ctx, _event, opts?: { mediaFor?: string }) => {
    const status = await agentStatus(ctx, ctx.session.agentId)
    if (!status) return { running: false, state: 'stopped' }
    const media = opts?.mediaFor ? status.media?.[opts.mediaFor] : undefined
    return { running: true, state: status.runtimeState, ...(media ? { media } : {}) }
  },

  /**
   * `reattachOnly`: the renderer re-attaching an agent that ran when its file
   * was opened, not a Start. It answers the running agent (in error too) or
   * `not_running`, and never stops or starts one: an agent a Kill is stopping
   * stays stopped.
   */
  [IPC.AGENT_START]: async (ctx, _event, args?: { filePath?: string; hasUserMessage?: boolean; reattachOnly?: boolean }) => {
    const filePath = ctx.session.filePath
    if (!filePath) return { success: false, error: 'No file open' }
    if (args?.filePath && !samePath(args.filePath, filePath, ctx.mode === 'remote')) {
      return { success: false, error: 'Agent file changed since start was requested' }
    }
    // A Kill sent while this start awaits: the start is not carried out after it (kill-epoch.ts).
    const kills = killCount(ctx)
    const killed = () => killCount(ctx) !== kills
    const client = await ctx.ready()
    let running = await agentStatus(ctx, ctx.session.agentId ?? await ctx.runningAgentAt(filePath))
    // A re-attach takes an agent in error too (it is alive and may recover); only Start rebuilds it.
    if (args?.reattachOnly && (!running || running.runtimeState === 'stopped')) {
      return { success: false, code: 'not_running', error: `${basename(filePath, '.adf')} is not running.` }
    }
    if (!args?.reattachOnly && running && (running.runtimeState === 'stopped' || running.runtimeState === 'error')) {
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
      const mine = interactions.filter((i) => samePath(i.filePath, agentPath, ctx.mode === 'remote'))
      return {
        success: true,
        sessionId: running.sessionId,
        agentState: triggers.displayState ?? running.runtimeState,
        // Side loops keep running across a switch; the view starts from their real states (embedded: sideLoopStates()).
        loopStates: running.loopStates ?? {},
        pendingApprovals: mine.filter((i) => i.type === 'approval').map((i) => ({
          requestId: i.requestId,
          name: i.toolName,
          input: i.input,
          ...(i.reason !== undefined ? { reason: i.reason } : {}),
          ...(i.protection !== undefined ? { protection: i.protection } : {}),
          ...(i.canAlwaysApprove !== undefined ? { canAlwaysApprove: i.canAlwaysApprove } : {}),
          ...(i.alwaysApproveBlockedReason !== undefined ? { alwaysApproveBlockedReason: i.alwaysApproveBlockedReason } : {}),
        })),
        pendingAsks: mine.filter((i) => i.type === 'ask').map((i) => ({ requestId: i.requestId, question: i.question, questions: i.questions ?? [] })),
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
    if (killed()) return { success: false, code: 'kill_in_progress', error: KILL_IN_PROGRESS_ERROR }
    const release = ctx.bridge.holdForeground(filePath)
    try {
      const started = await client.request<{ agent?: AgentStatus & { id: string }; sessionId?: string; preflight?: { code: string; message: string } }>(
        'POST', `/agents/${enc(documentId ?? filePath)}/start`, { query: { preflight: 1, ...(args?.hasUserMessage ? { hasUserMessage: 1 } : {}) }, timeoutMs: 120_000 })
      if (killed()) {
        // The start reached the daemon after the Kill did: stop what it started.
        const startedId = started.agent?.id ?? await ctx.runningAgentAt(filePath)
        if (startedId) await client.request('POST', `/agents/${enc(startedId)}/stop`, { timeoutMs: 60_000 }).catch(() => {})
        return { success: false, code: 'kill_in_progress', error: KILL_IN_PROGRESS_ERROR }
      }
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
    // A rename deferred while it ran moves the file now; embedded applies it
    // (and pushes FILE_RENAMED) before it answers, so this waits for the push.
    const filePath = ctx.session.filePath
    const pending = filePath
      ? await client.request<{ pendingName?: string }>('GET', '/files/agent', { query: { path: filePath } }).then((i) => i.pendingName, () => undefined)
      : undefined
    const moved = pending && filePath ? ctx.bridge.awaitPush('file_renamed', (p) => samePath((p as { oldPath?: string })?.oldPath, filePath, ctx.mode === 'remote')) : null
    try {
      await client.request('POST', `/agents/${enc(agentId)}/stop`, { timeoutMs: 60_000 })
    } catch (err) {
      moved?.cancel()
      if (!isNotFound(err)) {
        ctx.bridge.attach(agentId)
        throw err
      }
    }
    if (moved && !(await moved.done)) ctx.log.warn(`[Backend] AGENT_STOP: ${filePath} was to be renamed to "${pending}" at the stop; no rename arrived from the ADF daemon`)
    return { success: true }
  },

  [IPC.AGENT_INVOKE]: async (ctx, _event, args: { userMessage?: string; filePath?: string; content?: Array<{ type: string }>; loop?: string }) => {
    const target = args?.filePath ?? ctx.session.filePath
    // A refused chat is answered, as embedded answers a dispatch it refuses:
    // the renderer shows it (an error row, or "Not sent" in the queue).
    let agentId: string | null = null
    const failed = (error: string) => ({ success: false, error })
    if (!target) return { success: false, error: 'Agent not running' }
    let client: Awaited<ReturnType<DaemonModeContext['ready']>>
    try {
      client = await ctx.ready()
      agentId = samePath(target, ctx.session.filePath, ctx.mode === 'remote') && ctx.session.agentId ? ctx.session.agentId : await ctx.runningAgentAt(target)
      if (!agentId || !(await agentStatus(ctx, agentId))) return failed('Agent not running')
    } catch (error) {
      return failed(errorText(error))
    }
    // Content blocks (images, files) go as they are, as embedded's content_json.
    const blocks = Array.isArray(args?.content) && args.content.length > 0 ? args.content : null
    const body = { ...(blocks ? { content: blocks } : { text: args?.userMessage ?? '' }), ...(args?.loop ? { loop: args.loop } : {}), echoed: true }
    const size = blocks ? Buffer.byteLength(JSON.stringify(body)) : 0
    if (size > CHAT_BODY_LIMIT_BYTES) return failed(chatTooLarge(size))
    try {
      // `echoed`: the renderer already shows the message, as embedded's dispatch marks it.
      const { turnId } = await client.request<{ turnId: string }>('POST', `/agents/${enc(agentId)}/chat`, { body })
      // Embedded resolves once the dispatched turn has run; so does this.
      const outcome = await ctx.bridge.waitForTurn(agentId, turnId, args?.loop ?? 'main')
      // From here the daemon HAS the message (the chat route answered its
      // turnId): `accepted` tells the renderer's queue it went, so it is
      // never put back and sent a second time. Only a refused send requeues.
      // Only a daemon that is gone ends the chat with an error (its turn cannot end).
      if (outcome === 'exited') {
        // The turn can never end: the chat gets what embedded's executor sends on a failed turn (an error row, then idle).
        const error = 'The ADF daemon exited while the message waited for its turn; the chat shows what arrived.'
        ctx.bridge.reportChatFailure({ agentId, filePath: target }, args?.loop, error)
        return { success: false, accepted: true, code: 'daemon_exited', error }
      }
      if (outcome === 'disconnected') {
        // The daemon may still run the turn: no error; its state is read on reconnect (EventBridge.recheckTurns).
        ctx.bridge.recheckOnReconnect({ agentId, filePath: target }, args?.loop)
        return { success: false, accepted: true, error: 'The connection to the ADF daemon was lost while the message waited for its turn; the chat shows what arrived.' }
      }
      // Embedded has no such limit and the turn's events keep arriving: nothing is shown.
      if (outcome === 'timeout') return { success: false, accepted: true, error: `No end of the turn arrived from the ADF daemon within ${TURN_WAIT_TIMEOUT_MS / 60_000} minutes.` }
      return { success: true }
    } catch (error) {
      // A daemon of another build may hold a smaller limit than this Studio checks.
      if (error instanceof DaemonError && error.status === 413) return failed(chatTooLarge(size))
      return failed(errorText(error))
    }
  },
}
