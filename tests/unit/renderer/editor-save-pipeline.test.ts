import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useEditorTabsStore,
  beginAgentSwitch,
  endAgentSwitch,
  isAgentSwitching,
} from '../../../src/renderer/stores/editor-tabs.store'

/**
 * There is no jsdom / @testing-library in this repo, so the editor components
 * cannot be mounted. These are faithful transcriptions of the two debounce
 * stages and the guards added on top of them, small enough to diff against the
 * source:
 *
 *   CodeMirrorEditor.tsx  — 250ms change debounce, echo guard on `lastSynced`
 *   EditorPanel.tsx       — 300ms save debounce, agent-owner + switch guards,
 *                           external-write invalidation, unmount flush
 *
 * Each case here fails against the pre-fix code; the comment on each says how.
 */

const CHANGE_DEBOUNCE_MS = 250
const SAVE_DEBOUNCE_MS = 300

/**
 * EditorPanel's save layer + the workspace the main process writes into.
 * `guarded: false` reproduces the pre-fix layer (no owner, no switch window, no
 * external-write invalidation) so the cases below can show what each guard buys.
 */
function makePanel({ guarded = true }: { guarded?: boolean } = {}) {
  const disk: Array<{ workspace: string; path: string; content: string }> = []
  let currentWorkspace = 'agentA.adf'
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSave: { path: string; content: string; owner: string | null } | null = null

  // DOC_WRITE_INTERNAL_FILE (ipc/index.ts) writes into whatever workspace is
  // open *at delivery time* — the path carries no agent identity.
  const performSave = (path: string, content: string, owner: string | null) => {
    if (guarded && (owner !== filePath() || isAgentSwitching())) return
    disk.push({ workspace: currentWorkspace, path, content })
  }

  // Stands in for useDocumentStore.getState().filePath.
  let documentFilePath: string | null = 'agentA.adf'
  const filePath = () => documentFilePath

  const cancelPendingSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    pendingSave = null
  }

  const panel = {
    disk,
    /** main swaps its workspace inside the openFile IPC. */
    swapWorkspace: (w: string) => { currentWorkspace = w },
    /** openFile's setFilePath, which runs after the IPC has already swapped. */
    setFilePath: (p: string) => { documentFilePath = p },
    handleChange(path: string, content: string) {
      if (guarded && isAgentSwitching()) return
      if (saveTimer) clearTimeout(saveTimer)
      const owner = filePath()
      pendingSave = { path, content, owner }
      saveTimer = setTimeout(() => {
        pendingSave = null
        saveTimer = null
        performSave(path, content, owner)
      }, SAVE_DEBOUNCE_MS)
    },
    /** EditorPanel's subscription to lastExternalWrite. */
    onExternalWrite(path: string) {
      if (!guarded) return
      if (pendingSave?.path === path) cancelPendingSave()
    },
    unmount() {
      if (saveTimer) clearTimeout(saveTimer)
      const p = pendingSave
      pendingSave = null
      if (p) performSave(p.path, p.content, p.owner)
    },
  }
  return panel
}

/** The editor-side debounce (identical in CodeMirrorEditor and RichMarkdownView). */
function makeEditor(path: string, panel: ReturnType<typeof makePanel>) {
  let doc = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let hasPending = false
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!hasPending) return
    hasPending = false
    panel.handleChange(path, doc)
  }
  return {
    type(ch: string) {
      doc += ch
      hasPending = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, CHANGE_DEBOUNCE_MS)
    },
    /** External write replaces the doc and cancels the pending local edit. */
    externalWrite(content: string) {
      if (timer) clearTimeout(timer)
      timer = null
      hasPending = false
      doc = content
    },
    unmountFlush: flush,
    get doc() { return doc },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  // Leave the switch counter balanced even if a case throws mid-switch.
  while (isAgentSwitching()) endAgentSwitch()
})
afterEach(() => vi.useRealTimers())

describe('editor -> panel save pipeline', () => {
  it('a quiescent edit still reaches disk after both debounces', () => {
    const panel = makePanel()
    const ed = makeEditor('mind.md', panel)
    ed.type('a')
    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS + SAVE_DEBOUNCE_MS)
    expect(panel.disk).toEqual([{ workspace: 'agentA.adf', path: 'mind.md', content: 'a' }])
  })

  // Was: the 300ms timer armed before the switch fired afterwards and
  // writeInternalFile delivered agent A's text into agent B's workspace.
  it('a save armed before an agent switch is abandoned, not delivered to the next agent', () => {
    const panel = makePanel()
    const ed = makeEditor('mind.md', panel)
    ed.type('secret note for agent A')
    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS) // editor debounce -> scheduleSave(300ms) armed

    // User switches agents: main swaps the workspace inside the openFile IPC,
    // then openFile sets the new filePath.
    beginAgentSwitch()
    panel.swapWorkspace('agentB.adf')
    panel.setFilePath('agentB.adf')
    endAgentSwitch()

    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(panel.disk).toEqual([])
  })

  // Was: the flush ran after the workspace had swapped but before setFilePath,
  // so an owner check alone still saw a match and wrote into the new agent.
  it('a save scheduled while the switch is in flight is dropped', () => {
    const panel = makePanel()
    const ed = makeEditor('mind.md', panel)
    ed.type('typed just before switching')

    beginAgentSwitch()
    panel.swapWorkspace('agentB.adf')
    // reset() unmounts the editor mid-switch; its teardown flushes.
    ed.unmountFlush()
    panel.setFilePath('agentB.adf')
    endAgentSwitch()

    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS + SAVE_DEBOUNCE_MS)
    expect(panel.disk).toEqual([])
  })

  // Was: pendingSaveRef was only cleared when the timer fired, so a later
  // unmount (opening Settings, toggling the fleet map) replayed the pre-agent
  // text over the agent's write.
  it('an agent write cancels the queued save it supersedes', () => {
    const panel = makePanel()
    const ed = makeEditor('mind.md', panel)
    ed.type('local')
    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS) // pendingSave = {mind.md, 'local'}

    // Agent writes mind.md: the tab, the editor and the save layer all learn about it.
    ed.externalWrite('AGENT MEMORY')
    panel.onExternalWrite('mind.md')

    panel.unmount()
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(panel.disk).toEqual([])
    expect(ed.doc).toBe('AGENT MEMORY')
  })

  it('an agent write to a different file leaves our queued save alone', () => {
    const panel = makePanel()
    const ed = makeEditor('mind.md', panel)
    ed.type('local')
    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS)

    panel.onExternalWrite('soul.md')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(panel.disk).toEqual([{ workspace: 'agentA.adf', path: 'mind.md', content: 'local' }])
  })

  it('without the guards the same three interleavings each corrupt a file', () => {
    // (a) armed before the switch, delivered after it
    const a = makePanel({ guarded: false })
    const ea = makeEditor('mind.md', a)
    ea.type('agent A text')
    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS)
    a.swapWorkspace('agentB.adf')
    a.setFilePath('agentB.adf')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(a.disk).toEqual([{ workspace: 'agentB.adf', path: 'mind.md', content: 'agent A text' }])

    // (b) scheduled by the teardown flush during the switch
    const b = makePanel({ guarded: false })
    const eb = makeEditor('mind.md', b)
    eb.type('agent A text')
    b.swapWorkspace('agentB.adf')
    eb.unmountFlush()
    b.setFilePath('agentB.adf')
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)
    expect(b.disk).toEqual([{ workspace: 'agentB.adf', path: 'mind.md', content: 'agent A text' }])

    // (c) replayed over an agent write by a later unmount
    const c = makePanel({ guarded: false })
    const ec = makeEditor('mind.md', c)
    ec.type('local')
    vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS)
    ec.externalWrite('AGENT MEMORY')
    c.onExternalWrite('mind.md')
    c.unmount()
    expect(c.disk).toEqual([{ workspace: 'agentA.adf', path: 'mind.md', content: 'local' }])
  })

  it('closing a tab still flushes its pending save — the guards only fire on a switch', () => {
    const panel = makePanel()
    const ed = makeEditor('mind.md', panel)
    ed.type('typed then closed')
    ed.unmountFlush()   // closeTab unmounts the editor
    panel.unmount()
    expect(panel.disk).toEqual([{ workspace: 'agentA.adf', path: 'mind.md', content: 'typed then closed' }])
  })
})

describe('agent-switch guard', () => {
  it('nests, so openFile and the loadFileContents it calls can both bracket the switch', () => {
    expect(isAgentSwitching()).toBe(false)
    beginAgentSwitch()
    beginAgentSwitch()
    endAgentSwitch()
    expect(isAgentSwitching()).toBe(true)
    endAgentSwitch()
    expect(isAgentSwitching()).toBe(false)
  })

  it('never goes negative, so an unbalanced end cannot unfreeze a live switch', () => {
    endAgentSwitch()
    beginAgentSwitch()
    expect(isAgentSwitching()).toBe(true)
    endAgentSwitch()
    expect(isAgentSwitching()).toBe(false)
  })
})

describe('editor-tabs.store — external write marking', () => {
  beforeEach(() => useEditorTabsStore.getState().reset())

  it('updateTabFromExternal publishes a fresh mark the save layer can key on', () => {
    const s = () => useEditorTabsStore.getState()
    s().openTab('mind.md', 'A', false)
    expect(s().lastExternalWrite).toBeNull()

    s().updateTabFromExternal('mind.md', 'AGENT WROTE THIS')
    const first = s().lastExternalWrite
    expect(first).toMatchObject({ path: 'mind.md' })

    s().updateTabFromExternal('mind.md', 'AGENT WROTE THIS AGAIN')
    // A repeat write to the same path has to be distinguishable from the first.
    expect(s().lastExternalWrite).not.toBe(first)
    expect(s().lastExternalWrite!.seq).toBeGreaterThan(first!.seq)
  })

  it('marks writes to files that have no open tab', () => {
    const s = () => useEditorTabsStore.getState()
    s().updateTabFromExternal('notes/deep.md', 'x')
    expect(s().lastExternalWrite).toMatchObject({ path: 'notes/deep.md' })
  })
})
