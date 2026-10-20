/**
 * Keyboard navigation in the renderer: the platform command modifier, which
 * keys the fleet map may take, the context-menu key, the shortcut table's
 * key caps, and Go to agent's ranking.
 */
import { describe, expect, it } from 'vitest'
import { isContextMenuKey, isPrimaryModifier, isTypingElement, mapOwnsKey } from '../../../src/renderer/utils/keyboard'
import { collectSwitcherAgents, fuzzyMatch, rankAgents, type SwitcherAgent } from '../../../src/renderer/utils/agent-switcher'
import { FLEET_MAP_SECTIONS, SHORTCUT_SECTIONS, formatKey, rowFor } from '../../../src/shared/constants/keyboard-shortcuts'
import { useKeyboardStore } from '../../../src/renderer/stores/keyboard.store'
import type { TrackedDirEntry } from '../../../src/shared/types/ipc.types'

describe('isPrimaryModifier', () => {
  it('is ⌘ alone on macOS and Ctrl alone elsewhere', () => {
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    // Win+S on Windows is not Save.
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, false)).toBe(false)
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: true }, false)).toBe(false)
  })
})

/** An element-shaped object: its tag, and the selectors its ancestors match. */
function el(tagName: string, opts: { editable?: boolean; matches?: string[]; inside?: boolean } = {}) {
  return {
    tagName,
    isContentEditable: !!opts.editable,
    inside: opts.inside ?? false,
    closest: (selector: string) => (opts.matches ?? []).some((m) => selector.includes(m)) ? {} : null,
  }
}
const root = { contains: (node: unknown) => !!(node as { inside?: boolean })?.inside }
const page = { body: { tagName: 'BODY' }, documentElement: { tagName: 'HTML' } }

describe('isTypingElement', () => {
  it('takes inputs, text areas, selects, comboboxes, text boxes and editable content', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTypingElement(el(tag)), tag).toBe(true)
    expect(isTypingElement(el('DIV', { editable: true }))).toBe(true)
    expect(isTypingElement(el('DIV', { matches: ['[role="combobox"]'] }))).toBe(true)
    expect(isTypingElement(el('SPAN', { matches: ['[contenteditable]'] }))).toBe(true)
    expect(isTypingElement(el('BUTTON'))).toBe(false)
    expect(isTypingElement(null)).toBe(false)
  })
})

describe('mapOwnsKey', () => {
  it('the map takes keys when it or nothing has the focus', () => {
    expect(mapOwnsKey(page.body, root, page)).toBe(true)
    expect(mapOwnsKey(page.documentElement, root, page)).toBe(true)
    expect(mapOwnsKey(el('DIV', { inside: true }), root, page)).toBe(true)
  })
  it('never from a field, a control outside the map, or a dialog, menu or list', () => {
    expect(mapOwnsKey(el('INPUT', { inside: true }), root, page)).toBe(false)
    expect(mapOwnsKey(el('SELECT', { inside: true }), root, page)).toBe(false)
    expect(mapOwnsKey(el('BUTTON'), root, page)).toBe(false)
    expect(mapOwnsKey(el('BUTTON', { inside: true, matches: ['[role="dialog"]'] }), root, page)).toBe(false)
    expect(mapOwnsKey(el('BUTTON', { inside: true, matches: ['[role="menu"]'] }), root, page)).toBe(false)
    expect(mapOwnsKey(el('DIV', { inside: true }), null, page)).toBe(false)
  })
})

describe('isContextMenuKey', () => {
  const key = (k: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
    ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods })
  it('is Shift+F10 or the Menu key, with no other modifier', () => {
    expect(isContextMenuKey(key('F10', { shiftKey: true }))).toBe(true)
    expect(isContextMenuKey(key('ContextMenu'))).toBe(true)
    expect(isContextMenuKey(key('F10'))).toBe(false)
    expect(isContextMenuKey(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(isContextMenuKey(key('Enter'))).toBe(false)
  })
})

describe('shortcut key caps', () => {
  it('formats accelerators for each platform', () => {
    expect(formatKey('CmdOrCtrl+Shift+N', true)).toBe('⌘⇧N')
    expect(formatKey('CmdOrCtrl+Shift+N', false)).toBe('Ctrl+Shift+N')
    expect(formatKey('CmdOrCtrl+,', false)).toBe('Ctrl+,')
    expect(formatKey('CmdOrCtrl+-', true)).toBe('⌘-')
    expect(formatKey('CmdOrCtrl+Plus', false)).toBe('Ctrl++')
    expect(formatKey('Ctrl+CmdOrCtrl+F', true)).toBe('⌃⌘F')
    expect(formatKey('+', false)).toBe('+')
    expect(formatKey('Shift', true)).toBe('⇧')
    expect(formatKey('Alt', false)).toBe('Alt')
    expect(formatKey('Space', true)).toBe('Space')
  })

  it('uses the macOS keys and label where a row has them', () => {
    const full = SHORTCUT_SECTIONS.flatMap((s) => s.rows).find((r) => r.label === 'Full screen')!
    expect(rowFor(full, true).keys).toEqual(['⌃⌘F'])
    expect(rowFor(full, false).keys).toEqual(['F11'])
    const scroll = FLEET_MAP_SECTIONS[0].rows.find((r) => r.keys[0] === 'scroll')!
    expect(rowFor(scroll, true).label).toContain('⌃scroll')
    expect(rowFor(scroll, false).label).toContain('Ctrl+scroll')
  })

  it('keeps the fleet map\'s user-facing name', () => {
    expect(SHORTCUT_SECTIONS.flatMap((s) => s.rows).some((r) => r.label === 'Mesh')).toBe(true)
  })
})

const ID_1 = '6f0b8f8e-1c1d-4a35-9d38-3b6a1f6f6a01'
const ID_2 = '6f0b8f8e-1c1d-4a35-9d38-3b6a1f6f6a02'

function agent(name: string, extra: Partial<SwitcherAgent> = {}): SwitcherAgent {
  return { filePath: `/agents/${name}.adf`, name, folder: 'agents', running: false, needsYou: 0, ...extra }
}

describe('Go to agent ranking', () => {
  it('no query: agents that need you, then running agents, then the rest, each by name', () => {
    const list = [agent('agent-4'), agent('agent-3', { running: true }), agent('agent-2', { needsYou: 1 }), agent('agent-1')]
    expect(rankAgents(list, '').map((m) => m.agent.name)).toEqual(['agent-2', 'agent-3', 'agent-1', 'agent-4'])
  })

  it('a query keeps matching agents: prefix, word start, substring, then scattered', () => {
    const list = [agent('xagent-1'), agent('beta-agent-1'), agent('agent-1'), agent('a-g-e-n-t')]
    expect(rankAgents(list, 'agent').map((m) => m.agent.name)).toEqual(['agent-1', 'beta-agent-1', 'xagent-1', 'a-g-e-n-t'])
    expect(rankAgents(list, 'zzz')).toEqual([])
  })

  it('within one match quality, agents that need you and running agents come first', () => {
    const list = [agent('agent-1'), agent('agent-2', { running: true }), agent('agent-3', { needsYou: 2 })]
    expect(rankAgents(list, 'agent').map((m) => m.agent.name)).toEqual(['agent-3', 'agent-2', 'agent-1'])
  })

  it('fuzzy: in order, case and spaces ignored, matched characters for highlighting', () => {
    expect(fuzzyMatch('A1', 'agent-1')).toMatchObject({ quality: 0, matched: [0, 6] })
    expect(fuzzyMatch('ag 1', 'agent-1')?.matched).toEqual([0, 1, 6])
    expect(fuzzyMatch('1a', 'agent-1')).toBeNull()
    // A later word start wins only when the rest still matches after it.
    expect(fuzzyMatch('ab', 'xa-a-b')?.matched).toEqual([3, 5])
    expect(fuzzyMatch('ab', 'xa-b-a')?.matched).toEqual([1, 3])
  })

  it('collects each tracked agent once, with its state and pending requests', () => {
    const file = (name: string, agentId: string): TrackedDirEntry => ({ filePath: `/agents/${name}.adf`, fileName: `${name}.adf`, agentName: name, agentId })
    const agents = collectSwitcherAgents({
      directories: ['/agents', '/agents'],
      filesByDir: {
        '/agents': [file('agent-1', ID_1), { filePath: '/agents/sub', fileName: 'sub', isDirectory: true, children: [file('agent-2', ID_2)] }, { filePath: '/agents/notes.txt', fileName: 'notes.txt' }],
      },
      currentFilePath: '/agents/agent-1.adf',
      foregroundRunning: true,
      isBackgroundRunning: () => false,
      pendingFilePaths: ['/agents/agent-2.adf', '/agents/agent-2.adf'],
    })
    expect(agents).toEqual([
      { filePath: '/agents/agent-1.adf', name: 'agent-1', folder: 'agents', running: true, needsYou: 0 },
      { filePath: '/agents/agent-2.adf', name: 'agent-2', folder: 'agents', running: false, needsYou: 2 },
    ])
  })
})

describe('keyboard store', () => {
  it('one keyboard modal at a time', () => {
    const s = useKeyboardStore.getState()
    s.setSwitcherOpen(true)
    expect(useKeyboardStore.getState()).toMatchObject({ switcherOpen: true, shortcutsOpen: false })
    s.setShortcutsOpen(true)
    expect(useKeyboardStore.getState()).toMatchObject({ switcherOpen: false, shortcutsOpen: true })
    s.setShortcutsOpen(false)
    expect(useKeyboardStore.getState()).toMatchObject({ switcherOpen: false, shortcutsOpen: false })
  })
})
