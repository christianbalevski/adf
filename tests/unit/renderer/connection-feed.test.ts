/**
 * The window's connection feed (connection.store.ts): one CONNECTION_CHANGED
 * listener, also after a failed first load is retried (review item 8).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.resetModules()
})

describe('startConnectionFeed', () => {
  it('a retry after a failed load leaves one listener, and the view still arrives', async () => {
    let listeners = 0
    let push: ((view: unknown) => void) | null = null
    let calls = 0
    const view = { current: { id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' }, next: null, rows: [], discovery: null }
    ;(globalThis as { window?: unknown }).window = {
      adfApi: {
        onConnectionChanged: (cb: (v: unknown) => void) => { listeners++; push = cb; return () => { listeners--; push = null } },
        listConnections: () => (++calls === 1 ? Promise.reject(new Error('not yet')) : Promise.resolve(view)),
      },
    }
    const { startConnectionFeed, useConnectionStore } = await import('../../../src/renderer/stores/connection.store')
    startConnectionFeed()
    await new Promise((r) => setTimeout(r, 0))
    expect(listeners).toBe(0)
    startConnectionFeed()
    await new Promise((r) => setTimeout(r, 0))
    expect(listeners).toBe(1)
    expect(useConnectionStore.getState().view).toEqual(view)
    startConnectionFeed()
    expect(listeners).toBe(1)
    push!({ ...view, next: { id: 'remote:x', name: 'x' } })
    expect(useConnectionStore.getState().view?.next).toEqual({ id: 'remote:x', name: 'x' })
  })
})
