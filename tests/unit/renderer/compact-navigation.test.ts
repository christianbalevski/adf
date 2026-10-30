import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const write = vi.fn()
vi.stubGlobal('localStorage', { getItem: () => null, setItem: write, removeItem: () => {} })
const browser = { location: { search: '' }, adfApi: { platform: 'web' }, matchMedia: () => ({ matches: true }), addEventListener: () => {}, removeEventListener: () => {} }
vi.stubGlobal('window', browser)
const { useAppStore } = await import('../../../src/renderer/stores/app.store')
const { useCompactNavigationStore } = await import('../../../src/renderer/stores/compact-navigation.store')
const { openConfigSection, openConfigLoop } = await import('../../../src/renderer/utils/open-config-section')

const savedLayout = { chatPlacement: 'side' as const, centerChatTabActive: false, rightPanel: 'inbox' as const, agentSubTab: 'timers' as const, rightPanelCollapsed: true, sidebarCollapsed: true, sidebarWidth: 280 }
function expectSavedLayout() {
  expect(useAppStore.getState()).toMatchObject(savedLayout)
  expect(write).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.useFakeTimers()
  browser.adfApi.platform = 'web'
  useAppStore.setState({ ...savedLayout, showMeshGraph: false, showSettings: false, showHome: false, pendingConfigSection: null, pendingConfigLoop: null })
  useCompactNavigationStore.setState({ panel: null, rightPanel: 'overview', agentSubTab: 'config', chatTabActive: true })
  write.mockClear()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('compact navigation through existing shared actions', () => {
  it('opens Config from tool links and reveals the requested loop without changing desktop layout', () => {
    openConfigSection('Tools')
    expect(useCompactNavigationStore.getState()).toMatchObject({ panel: 'details', rightPanel: 'agent', agentSubTab: 'config' })
    expect(useAppStore.getState().pendingConfigSection).toBe('Tools')
    openConfigLoop('worker')
    expect(useAppStore.getState()).toMatchObject({ pendingConfigSection: 'Loops', pendingConfigLoop: 'worker' })
    expectSavedLayout()
  })
  it('returns from a document or details panel to the center chat through show-loop navigation', () => {
    useAppStore.getState().setCenterChatTabActive(false)
    useAppStore.getState().expandRightPanelToTab('agent', 'skills')
    expect(useCompactNavigationStore.getState()).toMatchObject({ panel: 'details', chatTabActive: false })
    useAppStore.getState().expandRightPanelToTab('loop')
    expect(useCompactNavigationStore.getState()).toMatchObject({ panel: null, chatTabActive: true })
    expectSavedLayout()
  })
  it('routes panel, subsection and keyboard toggles into mobile navigation', () => {
    const app = useAppStore.getState()
    app.toggleSidebar()
    expect(useCompactNavigationStore.getState().panel).toBe('agents')
    app.toggleSidebar()
    expect(useCompactNavigationStore.getState().panel).toBeNull()
    app.toggleRightPanel()
    app.setRightPanel('agent')
    app.setAgentSubTab('identity')
    expect(useCompactNavigationStore.getState()).toMatchObject({ panel: 'details', rightPanel: 'agent', agentSubTab: 'identity' })
    app.setCenterChatTabActive(false) // Open an internal document from Files.
    expect(useCompactNavigationStore.getState()).toMatchObject({ panel: null, chatTabActive: false })
    expectSavedLayout()
  })
  it('keeps mesh chat reachable and closes mobile navigation when changing main views', () => {
    const app = useAppStore.getState()
    app.setShowMeshGraph(true)
    app.expandRightPanelToTab('loop')
    expect(useCompactNavigationStore.getState()).toMatchObject({ panel: 'details', rightPanel: 'loop' })
    app.setShowHome(true)
    expect(useCompactNavigationStore.getState().panel).toBeNull()
    app.toggleSidebar()
    app.openSettingsAt('providers')
    expect(useCompactNavigationStore.getState().panel).toBeNull()
    expectSavedLayout()
  })
  it('ignores placement and resize writes while compact, retaining desktop behavior otherwise', () => {
    const app = useAppStore.getState()
    app.setChatPlacement('center')
    app.setSidebarWidth(120)
    app.revealRightPanel()
    expectSavedLayout()
    browser.adfApi.platform = 'linux'
    app.expandRightPanelToTab('agent', 'config')
    expect(useAppStore.getState()).toMatchObject({ rightPanel: 'agent', agentSubTab: 'config', rightPanelCollapsed: false })
    expect(write).toHaveBeenCalled()
  })
})
