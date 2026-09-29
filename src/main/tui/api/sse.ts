// SSE subscriber for `GET /events` over fetch streaming (no EventSource dep).
//
// - Resumes with `?since=<cursor>` after a drop, so the daemon replays what
//   was buffered while we were away.
// - Dedupes by `agent_id + seq` (the durable per-agent order); events with no
//   owning agent (seq 0) dedupe by transport cursor.
// - Reports every connection transition through `onState` — the store turns
//   them into the header's connection dot and a visible notice.
// - An idle watchdog (the daemon heartbeats every 30s) catches half-open
//   connections that never error.

import type { DaemonEventFrame } from './types'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface ConnectionInfo {
  state: ConnectionState
  /** Consecutive failed attempts since the last successful open. */
  attempt: number
  /** Why the last attempt failed or the stream dropped. */
  error?: string
  /** Delay before the next attempt, when reconnecting. */
  retryInMs?: number
  /** True on an open that followed a drop: callers should resync snapshots. */
  resumed?: boolean
}

export interface EventStreamOptions {
  baseUrl: string
  /** Request headers; a function is re-read on every (re)connect. */
  headers?: Record<string, string> | (() => Record<string, string>)
  fetch?: typeof fetch
  /** Only this agent's events (`?agentId=`). */
  agentId?: string
  /** Start after this cursor, replaying the daemon's buffer past it. */
  since?: number
  /**
   * With no `since`: true replays the daemon's whole buffer on first connect,
   * false (default) starts live. Reconnects always resume from the last cursor.
   */
  replay?: boolean
  onEvent: (frame: DaemonEventFrame) => void
  onState?: (info: ConnectionInfo) => void
  /** Backoff bounds. Defaults 500ms → 10s. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Reconnect when nothing (not even a heartbeat) arrives for this long. Default 75s. */
  idleTimeoutMs?: number
  /** Max remembered dedupe keys. Default 5000. */
  dedupeWindow?: number
}

export class EventStream {
  private readonly options: EventStreamOptions
  private readonly fetchImpl: typeof fetch
  private controller: AbortController | null = null
  private closed = false
  private started = false
  private attempt = 0
  private hasOpened = false
  private lastCursor: number
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private info: ConnectionInfo = { state: 'idle', attempt: 0 }

  constructor(options: EventStreamOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.lastCursor = options.since ?? -1
  }

  get cursor(): number {
    return this.lastCursor
  }

  get connection(): ConnectionInfo {
    return this.info
  }

  start(): this {
    if (this.started) return this
    this.started = true
    void this.connect()
    return this
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.clearIdle()
    this.controller?.abort()
    this.setState({ state: 'closed', attempt: this.attempt })
  }

  /** Drop the current connection and reconnect now (e.g. user-requested). */
  reconnect(): void {
    if (this.closed) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      void this.connect()
      return
    }
    this.controller?.abort()
  }

  private setState(info: ConnectionInfo): void {
    this.info = info
    try { this.options.onState?.(info) } catch { /* a bad listener must not kill the stream */ }
  }

  private buildUrl(): string {
    const params = new URLSearchParams()
    if (this.options.agentId) params.set('agentId', this.options.agentId)
    if (this.lastCursor >= 0) params.set('since', String(this.lastCursor))
    else if (!this.options.replay) params.set('since', String(Number.MAX_SAFE_INTEGER))
    const qs = params.toString()
    return `${this.options.baseUrl}/events${qs ? `?${qs}` : ''}`
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    this.retryTimer = null
    const resumed = this.hasOpened
    this.setState({ state: this.hasOpened || this.attempt > 0 ? 'reconnecting' : 'connecting', attempt: this.attempt })
    const controller = new AbortController()
    this.controller = controller
    let failure: string | undefined
    try {
      const response = await this.fetchImpl(this.buildUrl(), {
        headers: { Accept: 'text/event-stream', ...(typeof this.options.headers === 'function' ? this.options.headers() : this.options.headers ?? {}) },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
      }
      this.attempt = 0
      this.hasOpened = true
      this.setState({ state: 'open', attempt: 0, resumed })
      this.armIdle()
      await this.read(response.body, controller)
      failure = 'stream ended'
    } catch (err) {
      failure = controller.signal.aborted && this.closed ? undefined : errorMessage(err)
    } finally {
      this.clearIdle()
    }
    if (this.closed) return
    this.attempt += 1
    const delay = this.backoff()
    this.setState({ state: 'reconnecting', attempt: this.attempt, error: failure, retryInMs: delay })
    this.retryTimer = setTimeout(() => { void this.connect() }, delay)
  }

  private backoff(): number {
    const min = this.options.minBackoffMs ?? 500
    const max = this.options.maxBackoffMs ?? 10_000
    const exp = Math.min(max, min * 2 ** Math.max(0, this.attempt - 1))
    return Math.round(exp / 2 + Math.random() * (exp / 2))
  }

  private armIdle(): void {
    this.clearIdle()
    const timeout = this.options.idleTimeoutMs ?? 75_000
    this.idleTimer = setTimeout(() => this.controller?.abort(new Error('idle timeout')), timeout)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private async read(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const abort = () => { void reader.cancel().catch(() => {}) }
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.armIdle()
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.handleBlock(block)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', abort)
    }
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('aborted')
  }

  private handleBlock(block: string): void {
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'data') data.push(value)
    }
    if (data.length === 0) return
    let frame: DaemonEventFrame
    try {
      frame = JSON.parse(data.join('\n')) as DaemonEventFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object' || !frame.event) return
    if (typeof frame.cursor === 'number') {
      // Cursors are process-local: going backwards means the daemon restarted,
      // and its seq-0 cursor keys no longer mean anything.
      if (frame.cursor < this.lastCursor) this.forgetCursorKeys()
      this.lastCursor = frame.cursor
    }
    const key = dedupeKey(frame)
    if (key) {
      if (this.seen.has(key)) return
      this.remember(key)
    }
    try { this.options.onEvent(frame) } catch { /* listener errors never break the stream */ }
  }

  private remember(key: string): void {
    this.seen.add(key)
    this.seenOrder.push(key)
    const cap = this.options.dedupeWindow ?? 5000
    while (this.seenOrder.length > cap) {
      const old = this.seenOrder.shift()
      if (old) this.seen.delete(old)
    }
  }

  private forgetCursorKeys(): void {
    for (let i = this.seenOrder.length - 1; i >= 0; i--) {
      const key = this.seenOrder[i]
      if (key.startsWith('c:')) {
        this.seen.delete(key)
        this.seenOrder.splice(i, 1)
      }
    }
  }
}

/** `a:<agent>:<seq>` for agent events, `c:<cursor>` for daemon-scope ones. */
export function dedupeKey(frame: DaemonEventFrame): string | null {
  const { event } = frame
  if (event.agent_id && typeof event.seq === 'number' && event.seq > 0) return `a:${event.agent_id}:${event.seq}`
  if (typeof frame.cursor === 'number') return `c:${frame.cursor}`
  return null
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return err.message
  }
  return String(err)
}
