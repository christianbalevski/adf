import { afterEach, describe, expect, it, vi } from 'vitest'
import { preserveBrowserEdits } from '../../src/web/recovery'
import { browserMediaUrl } from '../../src/web/media-url'
import { WebTransport, WebSessionError } from '../../src/web/transport'
import { mediaUrl, resolveHtmlMediaUrls, setMediaUrlResolver } from '../../src/renderer/utils/media-url'

class Events {
  static last: Events
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(readonly url: string, readonly options: unknown) { Events.last = this }
}
const source = Events as unknown as typeof EventSource
function readyTransport(...args: ConstructorParameters<typeof WebTransport>): WebTransport {
  const transport = new WebTransport(...args)
  transport.connect()
  Events.last.onmessage!({ data: JSON.stringify({ channel: 'web:tab-generation', args: ['generation-one'] }) })
  return transport
}


describe('browser Studio transport', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('refuses reload when the shared edit stasher swallowed a storage quota failure', async () => {
    const quota = new Error('Storage quota exceeded')
    const stash = async (api: { recoveryStash: (entry: { agentFilePath: string; path: string; content: string }) => Promise<unknown> }) => {
      await api.recoveryStash({ agentFilePath: '/agent.adf', path: 'README.md', content: 'unsaved edit' }).catch(() => {})
      return 0
    }
    await expect(preserveBrowserEdits(stash, async () => { throw quota })).rejects.toBe(quota)
    await expect(preserveBrowserEdits(stash, async () => ({ success: true }))).resolves.toBeUndefined()
  })
  it('waits for the tab generation before sending the first mutation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 'saved' })))
    const transport = new WebTransport('tab-one', 'session-one', () => {}, fetcher, source)
    const mutation = transport.invoke('write')
    expect(fetcher).not.toHaveBeenCalled()
    Events.last.onmessage!({ data: JSON.stringify({ channel: 'web:tab-generation', args: ['generation-one'] }) })
    await expect(mutation).resolves.toBe('saved')
    expect(JSON.parse(fetcher.mock.calls[0][1].body).generation).toBe('generation-one')
  })
  it('stops stale mutations when the backend recreates the tab context', async () => {
    const state = vi.fn()
    const fetcher = vi.fn()
    const transport = readyTransport('tab-one', 'session-one', state, fetcher, source)
    Events.last.onmessage!({ data: JSON.stringify({ channel: 'web:tab-generation', args: ['generation-two'] }) })
    expect(state).toHaveBeenLastCalledWith('reset')
    await expect(transport.invoke('write')).rejects.toBeInstanceOf(WebSessionError)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('resets when a mutation detects context loss before SSE reconnects', async () => {
    const state = vi.fn()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Tab reset', code: 'web_tab_reset' }), { status: 409 }))
    const transport = readyTransport('tab-one', 'session-one', state, fetcher, source)
    await expect(transport.invoke('write')).rejects.toThrow('Tab reset')
    expect(state).toHaveBeenLastCalledWith('reset')
    await expect(transport.invoke('write-again')).rejects.toBeInstanceOf(WebSessionError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not bind native fetch to the transport instance', async () => {
    const nativeLike = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({ result: 'ok' })))
    })
    vi.stubGlobal('fetch', nativeLike)
    const transport = readyTransport('tab-one', 'session-one', () => {}, undefined, source)
    await expect(transport.invoke('read')).resolves.toBe('ok')
    expect(nativeLike).toHaveBeenCalledOnce()
  })
  it('uses cookie credentials and preserves exact invoke arguments/results', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { success: true, revision: 8 } })))
    const transport = readyTransport('tab-one', 'session-one', () => {}, fetcher, source)
    await expect(transport.invoke('adf:doc:set-document', { content: 'hello', baseRevision: 7 })).resolves.toEqual({ success: true, revision: 8 })
    expect(fetcher).toHaveBeenCalledWith('/web/invoke', expect.objectContaining({
      credentials: 'same-origin', method: 'POST', body: JSON.stringify({ channel: 'adf:doc:set-document', args: [{ content: 'hello', baseRevision: 7 }], clientId: 'tab-one', storageScope: 'session-one', generation: 'generation-one' }),
    }))
  })
  it('never retries a mutation after failure and exposes server error codes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Conflict', code: 'revision_conflict' }), { status: 409 }))
    const transport = readyTransport('tab-one', 'session-one', () => {}, fetcher, source)
    await expect(transport.invoke('write')).rejects.toMatchObject({ message: 'Conflict', code: 'revision_conflict' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('preserves an operation permission error without logging out a valid session', async () => {
    const state = vi.fn()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Outside allowed roots', code: 'outside_roots' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, storageScope: 'session-one' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'still connected' })))
    const transport = readyTransport('tab-one', 'session-one', state, fetcher, source)
    await expect(transport.invoke('open-file')).rejects.toMatchObject({ message: 'Outside allowed roots', code: 'outside_roots' })
    expect(state).not.toHaveBeenCalledWith('unauthorized')
    await expect(transport.invoke('read')).resolves.toBe('still connected')
  })
  it('reports expired auth instead of silently losing a mutation', async () => {
    const state = vi.fn()
    const transport = readyTransport('tab-one', 'session-one', state, vi.fn().mockResolvedValue(new Response('', { status: 401 })), source)
    await expect(transport.invoke('write')).rejects.toBeInstanceOf(WebSessionError)
    expect(state).toHaveBeenCalledWith('unauthorized')
  })
  it('stops streams and rejects later mutations when authentication expires', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const state = vi.fn()
    const listener = vi.fn()
    const transport = readyTransport('tab-one', 'session-one', state, fetcher, source)
    transport.on('agent-event', listener)
    transport.connect()
    const events = Events.last
    await expect(transport.invoke('write')).rejects.toBeInstanceOf(WebSessionError)
    await expect(transport.invoke('write-again')).rejects.toBeInstanceOf(WebSessionError)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(events.close).toHaveBeenCalledOnce()
    events.onopen!()
    events.onmessage!({ data: JSON.stringify({ channel: 'agent-event', args: ['late'] }) })
    expect(listener).not.toHaveBeenCalled()
    expect(state).toHaveBeenLastCalledWith('unauthorized')
  })
  it('invalidates an old tab when another sign-in has replaced its session cookie', async () => {
    const state = vi.fn()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true, storageScope: 'different-session' })))
    const transport = readyTransport('tab-one', 'session-one', state, fetcher, source)
    transport.connect()
    Events.last.onerror!()
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('unauthorized'))
    await expect(transport.invoke('pending-message')).rejects.toBeInstanceOf(WebSessionError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('ignores a pending session check after the transport is closed', async () => {
    let finish!: (response: Response) => void
    const state = vi.fn()
    const transport = readyTransport('tab-one', 'session-one', state, vi.fn(() => new Promise<Response>(resolve => { finish = resolve })), source)
    transport.connect()
    Events.last.onerror!()
    transport.close()
    state.mockClear()
    finish(new Response('', { status: 401 }))
    await Promise.resolve()
    expect(state).not.toHaveBeenCalled()
  })
  it('delivers streamed events in IPC shape and removes subscriptions', () => {
    const transport = readyTransport('tab one', 'session-one', () => {}, vi.fn(), source)
    const listener = vi.fn()
    transport.on('agent-event', listener)
    transport.connect()
    expect(Events.last.url).toBe('/web/events?clientId=tab+one&storageScope=session-one')
    expect(Events.last.options).toEqual({ withCredentials: true })
    Events.last.onmessage!({ data: JSON.stringify({ channel: 'agent-event', args: [{ seq: 1 }] }) })
    expect(listener).toHaveBeenCalledWith(undefined, { seq: 1 })
    transport.removeListener('agent-event', listener)
    Events.last.onmessage!({ data: JSON.stringify({ channel: 'agent-event', args: [{ seq: 2 }] }) })
    expect(listener).toHaveBeenCalledTimes(1)
    transport.close()
    expect(Events.last.close).toHaveBeenCalledOnce()
  })
  it('gives identically named images distinct URLs after opening another agent', () => {
    const context = { clientId: 'tab-one', storageScope: 'session-one', runtime: 'local', view: 1, filePath: '/first.adf' }
    const first = browserMediaUrl('adf-file://photo%20%26%20name.png', context)
    const second = browserMediaUrl('adf-file://photo%20%26%20name.png', { ...context, view: 2 })
    expect(first).not.toBe(second)
    expect(new URL(first, 'http://localhost').searchParams.get('path')).toBe('photo & name.png')
    expect(new URL(first, 'http://localhost').searchParams.get('storageScope')).toBe('session-one')
    expect(browserMediaUrl('https://example.test/photo.png', context)).toBe('https://example.test/photo.png')
  })
  it('resolves media displays without altering internal editor links', () => {
    setMediaUrlResolver((url) => url.startsWith('adf-file://') ? '/web/file?clientId=tab&path=' + encodeURIComponent(url.slice(11)) : url)
    expect(mediaUrl('https://example.test/image.png')).toBe('https://example.test/image.png')
    const html = '<a href="adf-file://a.png">Open</a><img src="adf-file://a.png">'
    expect(resolveHtmlMediaUrls(html)).toBe('<a href="adf-file://a.png">Open</a><img src="/web/file?clientId=tab&amp;path=a.png">')
    setMediaUrlResolver((url) => url)
  })
})
