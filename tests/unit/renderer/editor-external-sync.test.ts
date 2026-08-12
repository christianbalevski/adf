import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'

/**
 * The external-sync guard shared by the two editors, and the large-file gate
 * that decides which of them is showing.
 *
 * Both editors take their content as a prop that round-trips through the tab
 * store, and both emit on a debounce. The guard therefore has to compare the
 * incoming prop against a SNAPSHOT taken when the editor last handed text over
 * (MarkdownEditor's `lastPushedContent`, CodeMirrorEditor's `lastSynced`) —
 * never against the live document. With the emit debounced, a keystroke can
 * land between "emit" and the prop coming back, and a live-doc comparison reads
 * that keystroke as an external write and dispatches the pre-keystroke text
 * over it.
 */

const LARGE_MD_CHARS = 128_000

type Guard = 'compare-to-live-doc' | 'compare-to-last-synced'

/** CodeMirrorEditor's change/emit/sync cycle, reduced to the guard. */
function simulate(guard: Guard) {
  let doc = 'X'
  let lastSynced: string | null = 'X'
  let pendingProp = 'X'      // what React will render with
  let cancelled = false

  const type = (ch: string) => { doc += ch }

  // flushChange: read the doc, stamp the snapshot, hand it to the store.
  const emit = () => {
    lastSynced = doc
    pendingProp = doc
  }

  // React renders; the sync effect runs with the (now stale) prop.
  const syncEffect = () => {
    const content = pendingProp
    if (guard === 'compare-to-live-doc') {
      if (content === doc) return
    } else {
      if (content === lastSynced) return
      lastSynced = content
    }
    cancelled = true      // cancelPendingChange()
    doc = content         // full-range dispatch replaces the document
  }

  // An agent write reaches the editor as a new value of the `content` prop.
  const receiveExternal = (content: string) => { pendingProp = content }

  return {
    type,
    emit,
    receiveExternal,
    syncEffect,
    get doc() { return doc },
    get cancelled() { return cancelled },
  }
}

describe('external-sync guard under a debounced emit', () => {
  // Was: the guard compared against `view.state.doc.toString()`, so the "b"
  // typed after the emit made prop !== doc, cancelling the pending emit and
  // dispatching "Xa" over the document.
  it('survives a keystroke landing between emit and the prop echoing back', () => {
    const s = simulate('compare-to-last-synced')
    s.type('a')
    s.emit()
    s.type('b')          // lands inside the 250ms window, before React commits
    s.syncEffect()
    expect(s.doc).toBe('Xab')
    expect(s.cancelled).toBe(false)
  })

  it('the live-doc comparison it replaced eats that keystroke', () => {
    const s = simulate('compare-to-live-doc')
    s.type('a')
    s.emit()
    s.type('b')
    s.syncEffect()
    expect(s.doc).toBe('Xa')       // the "b" is gone
    expect(s.cancelled).toBe(true) // ...and its pending emit was cancelled too
  })

  it('still applies a genuine external write that arrives mid-edit', () => {
    const s = simulate('compare-to-last-synced')
    s.type('a')
    s.emit()
    s.type('b')                 // un-emitted local edit still in the document
    s.receiveExternal('AGENT MEMORY')
    s.syncEffect()
    expect(s.doc).toBe('AGENT MEMORY')
    expect(s.cancelled).toBe(true) // the un-emitted "b" is dropped, as intended
  })
})

/**
 * MarkdownEditor's gate. It used to be frozen in a useState initializer at
 * mount, so a tab opened small and then grown by an agent still parsed in rich
 * mode — the multi-second freeze the gate exists to prevent, with no reopen
 * needed. It is now re-derived from the current content and re-checked in the
 * sync effect, with a one-shot override for an explicit "Rich" click.
 */
function makeGate(initial: string, { frozen = false }: { frozen?: boolean } = {}) {
  let content = initial
  const gatedAtOpen = content.length > LARGE_MD_CHARS
  let rawMode = gatedAtOpen
  let override = false
  let parsed: string | null = null

  const shouldGate = (next: string) => {
    if (frozen) return false            // pre-fix: decided once, at mount
    if (next.length <= LARGE_MD_CHARS) return false
    if (override) { override = false; return false }
    rawMode = true
    return true
  }

  return {
    /** An external (agent) write arriving at the open tab. */
    receive(next: string) {
      content = next
      if (rawMode) return                 // source view: nothing to parse
      if (shouldGate(next)) return
      parsed = next
    },
    clickRich() {
      override = true
      rawMode = false
      if (shouldGate(content)) return
      parsed = content
    },
    get rawMode() { return rawMode },
    get parsed() { return parsed },
    /** The notice is derived from the current size, not from the open-time one. */
    get notice() {
      const large = frozen ? gatedAtOpen : content.length > LARGE_MD_CHARS
      return rawMode && large
        ? `Large file (${Math.round(content.length / 1024)} KB) — showing source`
        : null
    },
  }
}

describe('large-markdown gate', () => {
  it('a small file opens in rich mode and parses, exactly as before', () => {
    const g = makeGate('# hello')
    expect(g.rawMode).toBe(false)
    g.receive('# hello there')
    expect(g.parsed).toBe('# hello there')
    expect(g.notice).toBeNull()
  })

  it('a file opened over the threshold starts in source view with a notice', () => {
    const g = makeGate('x'.repeat(LARGE_MD_CHARS + 1))
    expect(g.rawMode).toBe(true)
    expect(g.parsed).toBeNull()
    expect(g.notice).toContain('showing source')
  })

  // Was: gatedLarge was frozen at mount, so this content went straight into
  // ProseMirror and froze the window.
  it('re-gates a tab the agent grows past the threshold while it is open', () => {
    const g = makeGate('# small')
    g.receive('x'.repeat(600_000))
    expect(g.rawMode).toBe(true)
    expect(g.parsed).toBeNull()          // never parsed
    expect(g.notice).toContain('586 KB')
  })

  it('the frozen gate it replaced parsed that content and kept a stale notice', () => {
    const g = makeGate('# small', { frozen: true })
    g.receive('x'.repeat(600_000))
    expect(g.rawMode).toBe(false)
    expect(g.parsed).toHaveLength(600_000)   // the 30s freeze

    const cleared = makeGate('x'.repeat(600_000), { frozen: true })
    cleared.receive('')                      // "Clear Agent State" empties mind.md
    expect(cleared.notice).toContain('0 KB')
  })

  it('an explicit "Rich" click still parses the oversized document, once', () => {
    const g = makeGate('x'.repeat(600_000))
    g.clickRich()
    expect(g.rawMode).toBe(false)
    expect(g.parsed).toHaveLength(600_000)

    // The override is one-shot: the next agent write re-gates.
    g.receive('y'.repeat(600_000))
    expect(g.rawMode).toBe(true)
  })

  // Was: the notice text came from the frozen open-time size, so clearing
  // mind.md left "Large file (0 KB) — showing source" on screen.
  it('drops the notice when the file is emptied under it', () => {
    const g = makeGate('x'.repeat(600_000))
    expect(g.notice).not.toBeNull()
    g.receive('')
    expect(g.notice).toBeNull()
  })
})

describe('editor-tabs.store — reopening a tab', () => {
  beforeEach(() => useEditorTabsStore.getState().reset())

  // Was: openTab on an already-open path only set activeTabPath, so a reopen
  // could not re-evaluate the gate either.
  it('refreshes a clean tab so the reopen sees the current file', () => {
    const s = () => useEditorTabsStore.getState()
    s().openTab('mind.md', 'small', false)
    s().openTab('mind.md', 'x'.repeat(600_000), false)
    expect(s().tabs[0].content).toHaveLength(600_000)
    expect(s().tabs[0].isDirty).toBe(false)
    expect(s().activeTabPath).toBe('mind.md')
  })

  it('leaves a dirty tab alone — unsaved edits outrank what the caller read', () => {
    const s = () => useEditorTabsStore.getState()
    s().openTab('mind.md', 'A', false)
    s().updateTabContent('mind.md', 'A + unsaved edit')
    s().openTab('mind.md', 'A', false)
    expect(s().tabs[0].content).toBe('A + unsaved edit')
    expect(s().tabs[0].isDirty).toBe(true)
  })

  it('does not duplicate the tab', () => {
    const s = () => useEditorTabsStore.getState()
    s().openTab('mind.md', 'A', false)
    s().openTab('mind.md', 'B', false)
    expect(s().tabs).toHaveLength(1)
  })
})
