import type { IpcListener, IpcRendererLike } from '../shared/runtime-ipc'

export type WebConnectionState = 'connecting' | 'connected' | 'disconnected' | 'unauthorized' | 'reset'
export class WebSessionError extends Error {
  constructor() { super('Your Studio session has expired. Sign in again.'); this.name = 'WebSessionError' }
}

/** Same-origin transport. The daemon token is exchanged once for an HttpOnly cookie. */
export class WebTransport implements IpcRendererLike {
  private readonly listeners = new Map<string, Set<IpcListener>>()
  private stream: EventSource | null = null
  private closed = false
  private generation: string | null = null
  private readonly generationWaiters = new Set<(generation: string | null) => void>()
  constructor(
    readonly clientId: string,
    readonly storageScope: string,
    private readonly onState: (state: WebConnectionState) => void = () => {},
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
    private readonly eventSource: typeof EventSource = EventSource,
  ) {}

  async invoke(channel: string, ...args: unknown[]): Promise<any> {
    if (this.closed) throw new WebSessionError()
    if (!this.generation) {
      this.connect()
      await new Promise<void>((resolve, reject) => {
        const finish = (generation: string | null) => {
          clearTimeout(timer); this.generationWaiters.delete(finish)
          if (generation) resolve(); else reject(new WebSessionError())
        }
        const timer = setTimeout(() => {
          this.generationWaiters.delete(finish)
          reject(new Error('Studio is waiting for its event connection. Try again once connected.'))
        }, 15_000)
        this.generationWaiters.add(finish)
      })
    }
    if (this.closed) throw new WebSessionError()
    const response = await this.request('/web/invoke', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args, clientId: this.clientId, storageScope: this.storageScope, generation: this.generation }),
    })
    if (response.status === 401) { this.close(); this.onState('unauthorized'); throw new WebSessionError() }
    if (this.closed) throw new WebSessionError()
    const body = await response.json() as { result?: unknown; error?: string; code?: string }
    if (!response.ok) {
      if (body.code === 'web_tab_reset') { this.close(); this.onState('reset'); throw new Error(body.error || 'Studio connection reset. Reloading the tab.') }
      // A forbidden file/operation is not necessarily a revoked session.
      // Check authentication without replaying the rejected operation.
      if (response.status === 403) {
        const check = await this.request('/web/session', { credentials: 'same-origin' }).catch(() => null)
        const session = check?.ok ? await check.json() : null
        if (check?.status === 401 || check?.status === 403 || (session && (!session.authenticated || session.storageScope !== this.storageScope))) {
          this.close(); this.onState('unauthorized'); throw new WebSessionError()
        }
      }
      const error = new Error(body.error || `Studio request failed (${response.status})`)
      if (body.code) Object.assign(error, { code: body.code })
      throw error
    }
    return body.result
  }

  send(channel: string, ...args: unknown[]): void {
    void this.invoke(channel, ...args).catch((error) => console.error('[Studio Web]', error))
  }
  on(channel: string, listener: IpcListener): this {
    const listeners = this.listeners.get(channel) ?? new Set<IpcListener>()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return this
  }
  removeListener(channel: string, listener: IpcListener): this {
    this.listeners.get(channel)?.delete(listener)
    return this
  }
  emit(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      try { listener(undefined, ...args) } catch (error) { console.error('[Studio Web event]', error) }
    }
  }
  connect(): void {
    if (this.stream || this.closed) return
    this.onState('connecting')
    const stream = new this.eventSource(`/web/events?${new URLSearchParams({ clientId: this.clientId, storageScope: this.storageScope })}`, { withCredentials: true })
    this.stream = stream
    stream.onopen = () => { if (!this.closed) this.onState('connecting') }
    stream.onmessage = (event) => {
      if (this.closed) return
      try {
        const message = JSON.parse(event.data) as { channel: string; args: unknown[] }
        if (message.channel === 'web:tab-generation') {
          const generation = message.args?.[0]
          if (typeof generation !== 'string') return
          if (this.generation && generation !== this.generation) {
            this.close(); this.onState('reset'); return
          }
          this.generation = generation
          for (const ready of [...this.generationWaiters]) ready(generation)
          this.onState('connected')
          return
        }
        if (typeof message.channel === 'string' && Array.isArray(message.args)) this.emit(message.channel, ...message.args)
      } catch (error) { console.error('[Studio Web] Invalid event', error) }
    }
    stream.onerror = () => {
      if (this.closed) return
      this.onState('disconnected')
      // EventSource does not expose HTTP status. Check the session without
      // replaying any mutations; reconnecting SSE is handled by the browser.
      void this.request('/web/session', { credentials: 'same-origin' })
        .then(async (response) => {
          if (this.closed) return
          const session = response.ok ? await response.json() : null
          if (response.status === 401 || response.status === 403 || (session && (!session.authenticated || session.storageScope !== this.storageScope))) {
            this.close(); this.onState('unauthorized')
          }
        }).catch(() => {})
    }
  }
  close(): void { this.closed = true; this.stream?.close(); this.stream = null; for (const ready of [...this.generationWaiters]) ready(null) }
}
