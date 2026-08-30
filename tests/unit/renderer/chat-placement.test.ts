import { describe, it, expect, beforeEach, vi } from 'vitest'

// localStorage stub (no jsdom in the node test environment). Installed before
// the store module is imported so the lazy initial read sees it.
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
})

const { useAppStore, selectChatInCenter } = await import('../../../src/renderer/stores/app.store')

const CHAT_PLACEMENT_KEY = 'adf-chat-placement'

/**
 * Chat placement — the one persisted preference deciding whether the Loops
 * panel is mounted in the right dock or as a pinned tab on the center stage.
 * The layout itself isn't testable in this (DOM-less) harness; what IS testable
 * is the state machine every consumer reads: the persisted round-trip, the
 * dock's fallback when its Loops tab disappears, and the "take me to the chat"
 * routing that both slots share.
 */
beforeEach(() => {
  storage.clear()
  useAppStore.setState({
    chatPlacement: 'side',
    centerChatTabActive: false,
    rightPanel: 'loop',
    rightPanelCollapsed: false,
    showMeshGraph: false,
  })
})

describe('chat placement preference', () => {
  it('defaults to side — the dock keeps its Loops tab', () => {
    const s = useAppStore.getState()
    expect(s.chatPlacement).toBe('side')
    expect(selectChatInCenter(s)).toBe(false)
  })

  it('persists the choice to localStorage in both directions', () => {
    useAppStore.getState().setChatPlacement('center')
    expect(storage.get(CHAT_PLACEMENT_KEY)).toBe('center')

    useAppStore.getState().setChatPlacement('side')
    expect(storage.get(CHAT_PLACEMENT_KEY)).toBe('side')
  })

  it('moves the dock off Loops when the chat leaves for the center', () => {
    useAppStore.setState({ rightPanel: 'loop' })
    useAppStore.getState().setChatPlacement('center')

    const s = useAppStore.getState()
    // The dock keeps its OTHER tabs — it just can't stay on the one that left.
    expect(s.rightPanel).not.toBe('loop')
    expect(s.centerChatTabActive).toBe(true)
  })

  it('leaves a non-Loops dock tab alone when moving to center', () => {
    useAppStore.setState({ rightPanel: 'files' })
    useAppStore.getState().setChatPlacement('center')
    expect(useAppStore.getState().rightPanel).toBe('files')
  })

  it('reveals the dock on Loops when the chat comes back', () => {
    useAppStore.getState().setChatPlacement('center')
    useAppStore.setState({ rightPanelCollapsed: true })

    useAppStore.getState().setChatPlacement('side')
    const s = useAppStore.getState()
    expect(s.rightPanel).toBe('loop')
    // Collapsed + "put the chat back here" would leave the chat nowhere.
    expect(s.rightPanelCollapsed).toBe(false)
    expect(s.centerChatTabActive).toBe(false)
  })

  it('yields to the fleet map, which replaces the center stage entirely', () => {
    useAppStore.getState().setChatPlacement('center')
    expect(selectChatInCenter(useAppStore.getState())).toBe(true)

    useAppStore.setState({ showMeshGraph: true })
    // Otherwise the chat would be unreachable on the map.
    expect(selectChatInCenter(useAppStore.getState())).toBe(false)
  })
})

describe('expandRightPanelToTab follows the chat', () => {
  it('routes to the center tab instead of the dock in center placement', () => {
    useAppStore.getState().setChatPlacement('center')
    useAppStore.setState({ centerChatTabActive: false, rightPanel: 'inbox' })

    useAppStore.getState().expandRightPanelToTab('loop')
    const s = useAppStore.getState()
    expect(s.centerChatTabActive).toBe(true)
    // The dock is not hijacked onto a tab it no longer has.
    expect(s.rightPanel).toBe('inbox')
  })

  it('still opens the dock tab in side placement', () => {
    useAppStore.setState({ rightPanel: 'files', rightPanelCollapsed: true })
    useAppStore.getState().expandRightPanelToTab('loop')

    const s = useAppStore.getState()
    expect(s.rightPanel).toBe('loop')
    expect(s.rightPanelCollapsed).toBe(false)
  })

  it('is unaffected for non-chat destinations in center placement', () => {
    useAppStore.getState().setChatPlacement('center')
    useAppStore.getState().expandRightPanelToTab('agent', 'config')

    const s = useAppStore.getState()
    expect(s.rightPanel).toBe('agent')
    expect(s.agentSubTab).toBe('config')
  })
})
