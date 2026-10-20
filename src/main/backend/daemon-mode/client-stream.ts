import {
  DaemonError,
  SUPPORTED_CLIENT_API_VERSION,
  type ClientFrame as WireFrame,
  type ClientPushTopic,
  type DaemonClient,
  type EventStream,
  type StreamGap as WireGap,
} from '../../../shared/daemon-client'
import type { AgentExecutionEvent } from '../../../shared/types/ipc.types'

/**
 * The client session and client event stream as Studio main consumes them
 * (design D5, D5.1). The event bridge (event-bridge.ts) and the session
 * (session.ts) depend only on `ClientSession`; `createDaemonClientSession`
 * implements it over the daemon's client sessions (W2-B: POST
 * /client/sessions, GET /client/sessions/:id/events, focus, documents).
 *
 * Frames carry domain events. For `push` frames the payload of each topic is
 * the payload of its IPC push channel, exactly as embedded Studio sends it
 * (PUSH_TOPICS in event-bridge.ts names the channel).
 *
 * Turn bookkeeping (D5): executor frames carry the `turnId` of their turn
 * and, on `turn_complete` and `error`, the ids it absorbed; a stop that
 * drops chats sends a `turn` frame (`discarded`). `turnEndOf` reads a
 * turn's end from its executor frame; AGENT_INVOKE waits settle on both.
 */

/** Host events (D5 `host` frames, W1-A's lifecycle events). */
export type HostEventType =
  | 'agent_starting'
  | 'agent_started'
  | 'agent_start_failed'
  | 'agent_stopping'
  | 'agent_stopped'
  | 'agent_loops_changed'
  | 'agent_state_changed'
  /** A trigger failed; RuntimeService already emitted the `error` executor event (W1-A). */
  | 'trigger_error'
  /** The startup dispatch failed; the `error` executor event came first. */
  | 'startup_failed'

export interface ExecutorFrame {
  kind: 'executor'
  agentId: string
  filePath: string | null
  /** The executor event as AGENT_EVENT carries it; `event.loop` names a side loop. */
  event: AgentExecutionEvent
  /**
   * The daemon reduced the payload because this session is not focused on
   * the agent (D5.1): `tool_result`, `tool_input` (input fields cut) or
   * `stub` (scalars only). Never sent on AGENT_EVENT.
   */
  stripped?: 'tool_result' | 'tool_input' | 'stub'
  /** The turn the event belongs to (the chat's `turnId`); absent outside a turn. */
  turnId?: string
  /** On `error` and a `turn_complete` that was not interrupted: the other chats the turn answered. */
  absorbedTurnIds?: string[]
}

export interface HostFrame {
  kind: 'host'
  /** Null only for `agent_starting` / `agent_start_failed` before the file's id was read. */
  agentId: string | null
  filePath: string | null
  type: HostEventType
  /** Event-specific fields: `state`, `handle` (agent_started), `activeLoops`, `error`, `code`. */
  payload: Record<string, unknown>
  timestamp: number
}

export type PushTopic = ClientPushTopic

export interface PushFrame {
  kind: 'push'
  topic: PushTopic
  /** The agent the push is about, for topics scoped to the open file. */
  agentId?: string | null
  filePath?: string | null
  payload: unknown
  /** The payload was reduced for a session not focused on the agent. */
  stripped?: 'stub'
}

/**
 * A chat's turn ended: `completed` / `error` (the turn that handled
 * `turnIds`, plus the chats it absorbed), or `discarded` (a stop dropped
 * `turnIds` and cut off `unansweredTurnIds`). AGENT_INVOKE waits settle here.
 */
export interface TurnFrame {
  kind: 'turn'
  agentId: string
  filePath: string | null
  loop?: string
  outcome: 'completed' | 'error' | 'discarded'
  turnIds: string[]
  unansweredTurnIds: string[]
}

export type ClientFrame = ExecutorFrame | HostFrame | PushFrame | TurnFrame

export interface StreamGap {
  /** `evicted`: frames past the session ring (or one oversized frame) were lost; `epoch_changed`: the daemon restarted. */
  reason: 'evicted' | 'epoch_changed' | 'oversized' | 'new_session'
  epoch?: string
  dropped?: number
}

export interface StreamConnection {
  state: 'connecting' | 'open' | 'reconnecting' | 'closed'
  error?: string
}

export interface ClientStreamListener {
  onFrame(frame: ClientFrame): void
  /** Frames were lost: the bridge resyncs (D6). */
  onGap(gap: StreamGap): void
  onConnection(connection: StreamConnection): void
  /**
   * The stream is open again after a drop, or a new session replaced an
   * expired one. The client re-establishes what the session held: it
   * re-sends the focus and re-holds its documents. Resumed frames wait for
   * it to finish; a new session awaits it before starting its stream.
   */
  onReattached?(info: { epochChanged: boolean }): void | Promise<void>
  /** No session can be used with this daemon (client API version): shown, and the connection is failed. */
  onFatal?(message: string): void
}

export interface ClientSession {
  readonly kind: 'client-session'
  /** The daemon's session id once opened (requests carry it: X-ADF-Client-Session). */
  readonly sessionId: string | null
  start(listener: ClientStreamListener): void
  /** The agent whose deltas and full payloads the stream carries (D5). */
  setFocus(agentId: string | null): Promise<void>
  /** Hold an `.adf` (D4), preferring a known agent's identity when its path may have changed. */
  holdDocument(filePath: string, agentId?: string): Promise<HeldDocument>
  releaseDocument(agentId: string): Promise<void>
  /** Drop the stream connection and reconnect now. */
  reconnect(): void
  /** End the session (DELETE /client/sessions/:id) and close the stream. */
  end(): Promise<void>
  /**
   * Studio's quit (§8.3): close the stream and end the session through
   * POST /client/sessions/:id/quit, which stops the daemon when `stopDaemon`
   * and the daemon allows it. Null when no session was open.
   */
  quit?(stopDaemon: boolean): Promise<ClientQuitAnswer | null>
}

/** POST /client/sessions/:id/quit answer (daemon/routes/client-lifecycle-routes.ts). */
export interface ClientQuitAnswer {
  sessionId: string
  ended: boolean
  stopping: boolean
  reason: string
  otherSessions: number
}

/** POST /client/sessions/:id/documents answer (W2-A's open answer: `running`, `needsPassword`, `readOnly`, …). */
export interface HeldDocument {
  agentId: string
  filePath?: string | null
  running?: boolean
  needsPassword?: boolean
  readOnly?: string
  [key: string]: unknown
}

export const STUDIO_CLIENT_NAME = 'studio'

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/**
 * The chats an executor frame ends: `turn_complete` (an interrupted one
 * too; its replay ends the id again) and `error` end their turn and the ids
 * it absorbed. Null for every other frame and for a turn with no id.
 */
export function turnEndOf(frame: ExecutorFrame): TurnFrame | null {
  const type = frame.event.type
  if (type !== 'turn_complete' && type !== 'error') return null
  const turnIds = [...(frame.turnId ? [frame.turnId] : []), ...(frame.absorbedTurnIds ?? [])]
  if (turnIds.length === 0) return null
  const loop = frame.event.loop
  return {
    kind: 'turn',
    agentId: frame.agentId,
    filePath: frame.filePath,
    ...(loop ? { loop } : {}),
    outcome: type === 'turn_complete' ? 'completed' : 'error',
    turnIds,
    unansweredTurnIds: [],
  }
}

/** One wire frame as the bridge's frame, or null (a kind Studio does not read). */
export function translateClientFrame(frame: WireFrame): ClientFrame | null {
  switch (frame.kind) {
    case 'executor':
      return {
        kind: 'executor',
        agentId: frame.agentId,
        filePath: frame.filePath,
        event: frame.event,
        ...(frame.stripped ? { stripped: frame.stripped } : {}),
        ...(typeof frame.turnId === 'string' ? { turnId: frame.turnId } : {}),
        ...(Array.isArray(frame.absorbedTurnIds) && frame.absorbedTurnIds.length > 0 ? { absorbedTurnIds: stringList(frame.absorbedTurnIds) } : {}),
      }
    case 'host':
      return { kind: 'host', agentId: frame.agentId, filePath: frame.filePath, type: frame.type as HostEventType, payload: frame.payload ?? {}, timestamp: frame.timestamp }
    case 'push':
      return {
        kind: 'push',
        topic: frame.topic,
        agentId: frame.agentId,
        filePath: frame.filePath,
        payload: frame.payload,
        ...(frame.stripped ? { stripped: frame.stripped } : {}),
      }
    case 'turn':
      return {
        kind: 'turn',
        agentId: frame.agentId,
        filePath: frame.filePath,
        ...(frame.loop ? { loop: frame.loop } : {}),
        outcome: 'discarded',
        turnIds: stringList(frame.turnIds),
        unansweredTurnIds: stringList(frame.unansweredTurnIds),
      }
    default:
      return null
  }
}

/** The message shown when the daemon speaks another client API (§8.2: the switch dialog handles version skew). */
export function clientApiMismatchMessage(daemonVersion: unknown, clientApiVersion: unknown): string {
  return `The ADF daemon${typeof daemonVersion === 'string' ? ` ${daemonVersion}` : ''} speaks client API ${String(clientApiVersion)}; this Studio needs ${SUPPORTED_CLIENT_API_VERSION}. Update the daemon (or Studio) so both are the same version.`
}

export interface DaemonClientSessionOptions {
  /** Studio's version (POST /client/sessions `version`). */
  version: string
  /** §8.3: the daemon stops when this session expires and no other is open (local mode, keepDaemonRunning off). */
  exitDaemonWhenClosed: boolean
  /** Local mode: this Studio's pid, so a relaunch after a crash ends the dead Studio's session at once (it is not "another client"). */
  pid?: number
  log?: Pick<Console, 'log' | 'warn'>
  /** Retry delay while the daemon cannot be reached to open the session. */
  retryMs?: number
  /** EventStream idle timeout (tests). */
  idleTimeoutMs?: number
}

const isGone = (err: unknown): boolean => err instanceof DaemonError && err.status === 404
/**
 * A proxy in front of the daemon (a TLS proxy, `tailscale serve`, the other
 * computer's gateway) answers 502, 503 or 504 while the daemon behind it is
 * down or restarting: the daemon is unreachable for now, so the open is
 * retried, as for a refused connection.
 */
const gatewayDown = (err: unknown): boolean => err instanceof DaemonError && (err.status === 502 || err.status === 503 || err.status === 504)
/** The session itself is gone (`session_not_found`), not a file or document it names. */
const sessionGone = (err: unknown): boolean => isGone(err) && ((err as DaemonError).body as { code?: unknown } | null)?.code === 'session_not_found'

/**
 * A `ClientSession` over the daemon's client sessions (W2-B).
 *
 * - Opening: GET /version must report `clientApiVersion` ===
 *   SUPPORTED_CLIENT_API_VERSION, else `onFatal` with an "update the daemon"
 *   message (no fallback stream). An unreachable daemon is retried, and so is
 *   a proxy's 502, 503 or 504 for a daemon behind it that is down.
 * - A 404 on reconnect (the session expired, or the daemon restarted) opens
 *   a new session: the focus and the documents are sent again (awaited
 *   `onReattached`), then its stream starts and the bridge resyncs.
 * - Every `stream.gap` (evicted, oversized, new epoch) reaches `onGap`.
 */
export function createDaemonClientSession(client: DaemonClient, options: DaemonClientSessionOptions): ClientSession {
  const log = options.log ?? console
  let listener: ClientStreamListener | null = null
  let sessionId: string | null = null
  let stream: EventStream<WireFrame> | null = null
  let clearReplay: (() => void) | null = null
  let streamGeneration = 0
  let focus: string | null = null
  let ended = false
  let opening: Promise<string | null> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const openSession = async (): Promise<string | null> => {
    while (!ended) {
      try {
        const info = await client.version()
        if (info.clientApiVersion !== SUPPORTED_CLIENT_API_VERSION) {
          const message = clientApiMismatchMessage(info.version, info.clientApiVersion)
          log.warn(`[Backend] ${message}`)
          listener?.onFatal?.(message)
          return null
        }
        const created = await client.createClientSession({ client: STUDIO_CLIENT_NAME, version: options.version, exitDaemonWhenClosed: options.exitDaemonWhenClosed, ...(options.pid ? { pid: options.pid } : {}) })
        log.log(`[Backend] Client session ${created.sessionId} opened${options.exitDaemonWhenClosed ? ' (the daemon stops when it expires and no other client is open)' : ''}`)
        return created.sessionId
      } catch (err) {
        if (ended) return null
        if (err instanceof DaemonError && (err.unreachable || gatewayDown(err))) {
          listener?.onConnection({ state: 'reconnecting', error: err.message })
          await new Promise<void>((r) => { retryTimer = setTimeout(r, options.retryMs ?? 2_000); retryTimer.unref?.() })
          continue
        }
        const message = isGone(err)
          ? clientApiMismatchMessage(undefined, 'none (no client sessions)')
          : `Studio could not open a client session on the ADF daemon: ${err instanceof Error ? err.message : String(err)}`
        log.warn(`[Backend] ${message}`)
        listener?.onFatal?.(message)
        return null
      }
    }
    return null
  }

  const startStream = (id: string): void => {
    const l = listener!
    const generation = ++streamGeneration
    let reattaching: Promise<void> = Promise.resolve()
    let pendingReattachments = 0
    let buffered: Array<{ frame?: ClientFrame; gap?: StreamGap; size: number }> = []
    let bufferedSize = 0
    let dropped = 0
    const active = () => !ended && sessionId === id && generation === streamGeneration
    clearReplay = () => { buffered = []; bufferedSize = 0; dropped = 0 }
    const emit = (item: { frame?: ClientFrame; gap?: StreamGap }): void => {
      if (!active()) return
      try {
        if (item.frame) l.onFrame(item.frame)
        else if (item.gap) l.onGap(item.gap)
      } catch (err) {
        log.warn(`[Backend] Client stream listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const deliver = (item: { frame?: ClientFrame; gap?: StreamGap; size: number }): void => {
      if (!active()) return
      if (!pendingReattachments) { emit(item); return }
      // HTTP re-holds must not race replayed writes. Bound the replay held
      // behind them; a slow re-hold produces a visible resync on overflow.
      if (buffered.length >= 4096 || bufferedSize + item.size > 8 * 1024 * 1024) {
        dropped += buffered.length
        buffered = []
        bufferedSize = 0
      }
      if (item.size > 8 * 1024 * 1024) { dropped++; return }
      buffered.push(item)
      bufferedSize += item.size
    }
    stream = client.clientSessionEvents(id, {
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      onEvent: (wire) => {
        const frame = translateClientFrame(wire)
        if (frame) deliver({ frame, size: pendingReattachments ? JSON.stringify(wire).length * 2 : 0 })
      },
      onState: (info) => {
        if (stream === null || !active()) return
        l.onConnection({ state: info.state === 'idle' ? 'connecting' : info.state, ...(info.error ? { error: info.error } : {}) })
        // The session is gone (expired while we were away, or a restarted daemon): open a new one.
        if (info.state === 'reconnecting' && info.error?.startsWith('HTTP 404')) void reopen()
      },
      onResume: (info) => {
        if (!active()) return
        pendingReattachments++
        reattaching = reattaching.then(async () => {
          if (!active()) return
          await l.onReattached?.({ epochChanged: info.reason === 'epoch_changed' })
        }).catch((err) => {
          log.warn(`[Backend] Re-holding the documents after resume failed: ${err instanceof Error ? err.message : String(err)}`)
        }).then(() => {
          pendingReattachments--
          if (!active() || pendingReattachments) return
          const replay = buffered
          const lost = dropped
          buffered = []
          bufferedSize = 0
          dropped = 0
          if (lost) emit({ gap: { reason: 'evicted', dropped: lost } })
          for (const item of replay) {
            if (!active()) break
            emit(item)
          }
        })
        if (!info.exact && info.reason === 'epoch_changed') deliver({ gap: { reason: 'epoch_changed', epoch: info.epoch }, size: 0 })
      },
      onGap: (gap: WireGap) => {
        if (!active()) return
        const raw = (gap as { reason: string }).reason
        deliver({ gap: { reason: raw === 'oversized' || raw === 'epoch_changed' ? raw : 'evicted', epoch: gap.epoch, ...(gap.dropped !== undefined ? { dropped: gap.dropped } : {}) }, size: 0 })
      },
    }).start()
  }

  const open = (): Promise<string | null> => {
    opening ??= (async () => {
      const id = await openSession()
      if (!id || ended) {
        if (id) void client.endClientSession(id).catch(() => {})
        return null
      }
      sessionId = id
      if (focus) await client.setClientSessionFocus(id, focus).catch((err) => log.warn(`[Backend] Could not set the session focus: ${err instanceof Error ? err.message : String(err)}`))
      return id
    })().finally(() => { opening = null })
    return opening
  }

  let reopening: Promise<void> | null = null
  const reopen = (): Promise<void> => {
    reopening ??= (async () => {
      const old = stream
      streamGeneration++
      clearReplay?.()
      stream = null
      old?.close()
      const previous = sessionId
      sessionId = null
      log.warn(`[Backend] Client session ${previous ?? '?'} is gone on the daemon; opening a new one`)
      const id = await open()
      // quit()/end() during an await: no stream and no gap after it.
      if (!id || !listener || ended) return
      // The new session holds nothing yet: focus and documents first, then frames.
      try { await listener.onReattached?.({ epochChanged: true }) } catch (err) {
        log.warn(`[Backend] Re-holding the documents on the new session failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (ended) return
      startStream(id)
      listener.onGap({ reason: 'new_session' })
    })().finally(() => { reopening = null })
    return reopening
  }

  /** The session id for a call, opening the session if needed; a 404 reopens it once. */
  /**
   * The session id for a call, waiting for an open in progress. It never
   * waits for a whole reopen: that awaits `onReattached`, whose re-holds run
   * after the caller's own operation (session.ts serializes them).
   */
  const currentId = async (): Promise<string | null> => sessionId ?? (opening ? await opening : sessionId)

  /** Run a call on the session; a `session_not_found` opens a new session and retries once. */
  const withSession = async <T>(what: string, run: (id: string) => Promise<T>): Promise<T> => {
    const id = await currentId()
    if (!id) throw new Error(`${what}: Studio has no client session on the ADF daemon`)
    try {
      return await run(id)
    } catch (err) {
      if (!sessionGone(err)) throw err
      if (sessionId === id) void reopen()
      const next = await currentId()
      if (!next || next === id) throw err
      return run(next)
    }
  }

  return {
    kind: 'client-session',
    get sessionId() { return sessionId },
    start(l) {
      if (listener) return
      listener = l
      l.onConnection({ state: 'connecting' })
      void open().then((id) => { if (id && !ended) startStream(id) })
    },
    async setFocus(agentId) {
      focus = agentId
      if (!sessionId) return // sent when the session opens
      await withSession('Setting the session focus', (id) => client.setClientSessionFocus(id, agentId))
    },
    async holdDocument(filePath, agentId) {
      return withSession('Opening the file', async (id) => {
        // A resumed session may have missed a rename. Resolve the known
        // document by identity before falling back to its last path on restart.
        if (agentId) {
          try { return await client.holdClientSessionDocument(id, { agentId }) } catch (err) {
            if (!isGone(err) || sessionGone(err)) throw err
          }
        }
        return client.holdClientSessionDocument(id, { filePath })
      }) as Promise<HeldDocument>
    },
    async releaseDocument(agentId) {
      if (!sessionId) return
      try {
        await client.releaseClientSessionDocument(sessionId, agentId)
      } catch (err) {
        // The session or the hold is gone already: nothing is held.
        if (!isGone(err)) throw err
      }
    },
    reconnect() {
      stream?.reconnect()
    },
    async quit(stopDaemon) {
      ended = true
      streamGeneration++
      clearReplay?.()
      if (retryTimer) clearTimeout(retryTimer)
      stream?.close()
      stream = null
      const id = sessionId
      sessionId = null
      if (!id) return null
      try {
        return await client.withTimeout(5_000).request<ClientQuitAnswer>('POST', `/client/sessions/${encodeURIComponent(id)}/quit`, { body: { stopDaemon } })
      } catch (err) {
        // A daemon from before the quit route: end the session the old way (it keeps running).
        if (!isGone(err)) throw err
        await client.withTimeout(5_000).endClientSession(id).catch(() => {})
        return { sessionId: id, ended: true, stopping: false, reason: 'the daemon has no quit route (older build); it keeps running', otherSessions: 0 }
      }
    },
    async end() {
      ended = true
      streamGeneration++
      clearReplay?.()
      if (retryTimer) clearTimeout(retryTimer)
      stream?.close()
      stream = null
      const id = sessionId
      sessionId = null
      if (id) {
        try {
          await client.withTimeout(5_000).endClientSession(id)
        } catch (err) {
          log.warn(`[Backend] Ending client session ${id} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  }
}
