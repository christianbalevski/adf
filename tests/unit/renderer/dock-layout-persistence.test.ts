import { describe, it, expect, beforeEach, vi } from 'vitest'

// localStorage stub (no jsdom in the node test environment), installed before
// the store module is imported so its initial reads see it.
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
})

async function freshStore() {
  vi.resetModules()
  return (await import('../../../src/renderer/stores/app.store')).useAppStore
}

/**
 * Dock and bottom-panel layout survives a restart: dock tab, agent sub-tab,
 * dock collapsed, bottom panel open, its tab, and Logs live. A foreign or
 * missing value falls back to the default; a throwing storage never breaks
 * the store.
 */
beforeEach(() => { storage.clear() })

describe('dock layout persistence', () => {
  it('defaults on a fresh install: Overview, Timers, expanded, panel closed, Logs live', async () => {
    const s = (await freshStore()).getState()
    expect(s.rightPanel).toBe('overview')
    expect(s.agentSubTab).toBe('timers')
    expect(s.rightPanelCollapsed).toBe(false)
    expect(s.showLogsPanel).toBe(false)
    expect(s.bottomPanelTab).toBe('logs')
    expect(s.logsAutoRefresh).toBe(true)
  })

  it('every writer persists, and a restart restores it', async () => {
    const store = await freshStore()
    store.getState().expandRightPanelToTab('agent', 'config')
    store.getState().toggleRightPanel()
    store.getState().toggleLogsPanel()
    store.getState().setBottomPanelTab('tasks')
    store.getState().setLogsAutoRefresh(false)

    const s = (await freshStore()).getState()
    expect(s.rightPanel).toBe('agent')
    expect(s.agentSubTab).toBe('config')
    expect(s.rightPanelCollapsed).toBe(true)
    expect(s.showLogsPanel).toBe(true)
    expect(s.bottomPanelTab).toBe('tasks')
    expect(s.logsAutoRefresh).toBe(false)
  })

  it('a direct setState counts too (the chat placement switch writes rightPanel that way)', async () => {
    const store = await freshStore()
    store.getState().toggleRightPanel()
    expect(storage.get('adf-dock-collapsed')).toBe('1')
    store.getState().setChatPlacement('side')
    expect(storage.get('adf-dock-tab')).toBe('loop')
    expect(storage.get('adf-dock-collapsed')).toBe('0')
  })

  it('foreign stored values fall back to the defaults', async () => {
    storage.set('adf-dock-tab', 'nonsense')
    storage.set('adf-dock-agent-subtab', 'nope')
    storage.set('adf-dock-collapsed', 'yes')
    storage.set('adf-bottom-panel-tab', 'console')
    storage.set('adf-logs-live', '')
    const s = (await freshStore()).getState()
    expect(s.rightPanel).toBe('overview')
    expect(s.agentSubTab).toBe('timers')
    expect(s.rightPanelCollapsed).toBe(false)
    expect(s.bottomPanelTab).toBe('logs')
    expect(s.logsAutoRefresh).toBe(true)
  })

  it('a throwing storage leaves the defaults and never throws from a setter', async () => {
    const getItem = vi.fn(() => { throw new Error('denied') })
    const setItem = vi.fn(() => { throw new Error('full') })
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: () => {} })
    try {
      const store = await freshStore()
      expect(store.getState().rightPanel).toBe('overview')
      expect(() => store.getState().setRightPanel('files')).not.toThrow()
      expect(store.getState().rightPanel).toBe('files')
    } finally {
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => { storage.set(k, v) },
        removeItem: (k: string) => { storage.delete(k) },
      })
    }
  })
})
