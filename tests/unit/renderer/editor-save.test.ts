import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { captureSaveBase, registerEditorFlush, resetEditorSaves, saveActiveEditorTab, saveEditorTab } from '../../../src/renderer/utils/editor-save'
import { changeAgentConfig, confirmDiscardConflicts, type SaveAnswer } from '../../../src/renderer/utils/edit-conflict'
import { CONFIG_RECOVERY_PATH, recoveredEditsMessage, startEditRecovery, stashUnsavedEditors, watchRecoveredEdits } from '../../../src/renderer/utils/edit-recovery'
import { setSkillMuted } from '../../../src/renderer/utils/skills-state'

/**
 * W3-F review fixes in the renderer, both backends:
 * - Ctrl+S / File > Save goes through the editor's save path (over the
 *   revision; not while the notice is up: the notice gets focus);
 * - the base of a save is taken when it is scheduled, so a save delivered
 *   after its tab closed still names it, and a refusal brings the tab back;
 * - close and agent switch ask before unsaved text under a notice goes;
 * - while a notice is up main keeps a recovery copy, which a quit leaves;
 * - one-shot config writes and the skills-state merge save over a revision.
 */

const AGENT = 'C:/agents/agent-1.adf'
const tabs = () => useEditorTabsStore.getState()
const tab = (path: string) => tabs().tabs.find((t) => t.path === path)
const api: Record<string, ReturnType<typeof vi.fn>> = {}

beforeEach(() => {
  tabs().reset()
  useAgentStore.getState().reset()
  useDocumentStore.getState().reset()
  useDocumentStore.getState().setFilePath(AGENT)
  resetEditorSaves()
  for (const k of Object.keys(api)) delete api[k]
  ;(globalThis as { window?: unknown }).window = { adfApi: api, addEventListener: () => {}, removeEventListener: () => {} }
})
afterEach(() => { delete (globalThis as { window?: unknown }).window })

const conflict = (path: string) => {
  tabs().openTab(path, 'base', false, undefined, 1)
  tabs().updateTabContent(path, 'mine')
  tabs().updateTabFromExternal(path, 'theirs', { revision: 2, writer: { kind: 'agent' } })
}

describe('Ctrl+S / File > Save', () => {
  it('a tab under the notice is not saved: the notice gets focus', async () => {
    conflict('notes.md')
    api.writeInternalFile = vi.fn()
    const before = tabs().conflictFocusSeq
    saveActiveEditorTab()
    await new Promise((r) => setTimeout(r, 0))
    expect(api.writeInternalFile).not.toHaveBeenCalled()
    expect(tabs().conflictFocusSeq).toBe(before + 1)
    expect(tab('notes.md')).toMatchObject({ content: 'mine', isDirty: true })
  })

  it('the editor\'s pending save is delivered through it; without an editor, the active tab is saved over its revision', async () => {
    const flush = vi.fn()
    const unregister = registerEditorFlush(flush)
    saveActiveEditorTab()
    expect(flush).toHaveBeenCalledTimes(1)
    unregister()

    tabs().openTab('notes.md', 'a', false, undefined, 7)
    tabs().updateTabContent('notes.md', 'b')
    api.writeInternalFile = vi.fn(async () => ({ success: true, revision: 8 }))
    saveActiveEditorTab()
    await vi.waitFor(() => expect(tab('notes.md')?.revision).toBe(8))
    expect(api.writeInternalFile).toHaveBeenCalledWith('notes.md', 'b', { baseRevision: 7 })
  })
})

describe('the base of a save', () => {
  it('is the one taken when scheduled: a save delivered after its tab closed still names it, and a refusal brings the tab back', async () => {
    tabs().openTab('notes.md', 'a', false, undefined, 7)
    tabs().updateTabContent('notes.md', 'mine')
    const base = captureSaveBase('notes.md')
    tabs().closeTab('notes.md')
    api.writeInternalFile = vi.fn(async (): Promise<SaveAnswer> => ({ success: false, conflict: { resource: 'notes.md', revision: 9, writer: { kind: 'agent' }, content: 'theirs' } }))
    const outcome = await saveEditorTab('notes.md', 'mine', AGENT, base)
    expect(api.writeInternalFile).toHaveBeenCalledWith('notes.md', 'mine', { baseRevision: 7 })
    expect(outcome?.kind).toBe('conflict')
    expect(tab('notes.md')).toMatchObject({ content: 'mine', isDirty: true, conflict: { content: 'theirs', revision: 9, writer: { kind: 'agent' } } })
  })

  it('two saves scheduled over one revision: the second goes over the revision the first produced, not refused by it', async () => {
    tabs().openTab('notes.md', 'a', false, undefined, 7)
    tabs().updateTabContent('notes.md', 'ab')
    const base = captureSaveBase('notes.md')
    let revision = 7
    api.writeInternalFile = vi.fn(async (_p: string, _t: string, opts?: { baseRevision?: number }) => {
      if (opts?.baseRevision !== revision) return { success: false, conflict: { resource: 'notes.md', revision, writer: null, content: 'x' } }
      return { success: true, revision: ++revision }
    })
    const first = saveEditorTab('notes.md', 'ab', AGENT, base)
    const second = saveEditorTab('notes.md', 'abc', AGENT, base)
    expect(await first).toMatchObject({ kind: 'saved', revision: 8 })
    expect(await second).toMatchObject({ kind: 'saved', revision: 9 })
    expect(api.writeInternalFile.mock.calls.map((c) => c[2])).toEqual([{ baseRevision: 7 }, { baseRevision: 8 }])
  })

  it('a save for another agent than the open one is dropped', async () => {
    api.writeInternalFile = vi.fn()
    expect(await saveEditorTab('notes.md', 'x', 'C:/agents/agent-2.adf')).toBeNull()
    expect(api.writeInternalFile).not.toHaveBeenCalled()
  })
})

describe('close and agent switch over unsaved text under a notice', () => {
  it('asks; nothing to ask about without a notice', () => {
    const confirm = vi.fn(() => false)
    tabs().openTab('clean.md', 'x', false)
    expect(confirmDiscardConflicts(undefined, confirm)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()

    conflict('notes.md')
    expect(confirmDiscardConflicts(['notes.md'], confirm)).toBe(false)
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes to notes.md?\n\nSomeone else changed it while you were editing. OK discards your version. Cancel keeps it open.')
    expect(confirmDiscardConflicts(['clean.md'], confirm)).toBe(true)
  })

  it('an agent switch also counts the config panel\'s version', () => {
    conflict('notes.md')
    useAgentStore.getState().setConfigConflict({ mine: { name: 'agent-1' } as never, theirs: null, revision: 3, writer: { kind: 'agent' }, owner: AGENT })
    const confirm = vi.fn(() => true)
    expect(confirmDiscardConflicts(undefined, confirm)).toBe(true)
    expect(confirm.mock.calls[0][0]).toMatch(/^Discard your unsaved changes to notes\.md and the config\?/)
  })
})

describe('recovery copies', () => {
  it('kept while a notice is up, under the agent it belongs to; updated as the user types; removed when resolved', async () => {
    vi.useFakeTimers()
    try {
      const stash = vi.fn(async () => ({ success: true }))
      const stop = startEditRecovery({ recoveryStash: stash }, 500)
      conflict('notes.md')
      expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: 'notes.md', content: 'mine' })

      tabs().updateTabContent('notes.md', 'mine, more')
      expect(stash).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(500)
      expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: 'notes.md', content: 'mine, more' })

      // The next agent opens while the old tab is still there: the copy stays filed under agent-1.
      useDocumentStore.getState().setFilePath('C:/agents/agent-2.adf')
      tabs().updateTabContent('notes.md', 'mine, most')
      vi.advanceTimersByTime(500)
      expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: 'notes.md', content: 'mine, most' })

      tabs().resolveTabConflict('notes.md', 'reload')
      expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: 'notes.md', content: null })

      useAgentStore.getState().setConfigConflict({ mine: { name: 'agent-1' } as never, theirs: null, revision: 3, writer: null, owner: AGENT })
      expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: CONFIG_RECOVERY_PATH, content: '{\n  "name": "agent-1"\n}\n' })
      useAgentStore.getState().setConfigConflict(null)
      expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: CONFIG_RECOVERY_PATH, content: null })
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a discarded close removes the copy; the launch notice names what a quit left', () => {
    const stash = vi.fn(async () => ({ success: true }))
    const stop = startEditRecovery({ recoveryStash: stash }, 500)
    conflict('notes.md')
    tabs().closeTab('notes.md')
    expect(stash).toHaveBeenLastCalledWith({ agentFilePath: AGENT, path: 'notes.md', content: null })
    stop()
    expect(recoveredEditsMessage([{ agent: 'agent-1', path: 'notes.md' }])).toBe('Studio kept your unsaved version of agent-1/notes.md from the last session, which ended before it was saved.')
  })
})

describe('a restart main asks for after the daemon connection failed', () => {
  it('keeps every unsaved editor of the open agent as a recovery copy; saved and binary tabs are left alone', async () => {
    const stash = vi.fn(async () => ({ success: true }))
    tabs().openTab('notes.md', 'base', false, undefined, 1)
    tabs().updateTabContent('notes.md', 'typed, not saved')
    tabs().openTab('saved.md', 'clean', false, undefined, 1)
    tabs().openTab('image.png', '', true, undefined, 1)
    useDocumentStore.getState().setDocumentContent('# unsaved readme')
    expect(await stashUnsavedEditors({ recoveryStash: stash })).toBe(2)
    // R3B-3: one hand-off, one stamp: main keeps them in that hand-off's own folder.
    const kept = (stash.mock.calls[0] as unknown as [{ kept?: string }])[0].kept
    expect(kept).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/)
    expect(stash.mock.calls.map((c) => c[0])).toEqual([
      { agentFilePath: AGENT, path: 'notes.md', content: 'typed, not saved', kept },
      { agentFilePath: AGENT, path: 'README.md', content: '# unsaved readme', kept },
    ])
  })

  it('nothing open: nothing kept', async () => {
    useDocumentStore.getState().setFilePath(null)
    const stash = vi.fn(async () => ({ success: true }))
    expect(await stashUnsavedEditors({ recoveryStash: stash })).toBe(0)
    expect(stash).not.toHaveBeenCalled()
  })
})

describe('writes outside the editors', () => {
  it('a one-shot config change saves over the read revision, re-applies on a refusal, and gives the store the saved revision', async () => {
    let revision = 10
    let stored = { name: 'agent-1', description: 'a', card: {} as Record<string, unknown> }
    api.getAgentConfigWithRevision = vi.fn(async () => ({ config: stored, revision }))
    let first = true
    api.setAgentConfig = vi.fn(async (config: typeof stored, opts?: { baseRevision?: number }) => {
      if (first) { first = false; stored = { ...stored, description: 'theirs' }; revision++; return { success: false, conflict: { resource: 'config', revision, writer: { kind: 'agent' }, config: stored } } }
      if (opts?.baseRevision !== revision) throw new Error('stale base')
      stored = config
      return { success: true, revision: ++revision }
    })
    const saved = await changeAgentConfig<typeof stored>((c) => ({ ...c, card: { publish_attestations: true } }))
    expect(saved).toEqual({ name: 'agent-1', description: 'theirs', card: { publish_attestations: true } })
    expect(useAgentStore.getState().configRevision).toBe(12)
    expect(useAgentStore.getState().config).toEqual(saved)
  })

  it('skills-state.json: written over the revision read; a refusal merges again on their version', async () => {
    let content = '{"disabled":[]}'
    let revision = 1
    api.readInternalFile = vi.fn(async () => ({ content, binary: false, revision }))
    let first = true
    api.writeInternalFile = vi.fn(async (_p: string, text: string, opts?: { baseRevision?: number }) => {
      if (first) { first = false; content = '{"disabled":["from-the-agent"]}'; revision++; return { success: false, conflict: { resource: 'skills-state.json', revision, writer: { kind: 'agent' }, content } } }
      if (opts?.baseRevision !== revision) return { success: false, conflict: { resource: 'skills-state.json', revision, writer: null, content } }
      content = text
      return { success: true, revision: ++revision }
    })
    expect(await setSkillMuted('pdf', false, AGENT)).toBeNull()
    expect(JSON.parse(content).disabled).toEqual(expect.arrayContaining(['from-the-agent', 'pdf']))
  })
})

// R3B-3 (multi-runtime.md §20 item 3): a hand-off's copies are its own, and offered in this session.
describe('copies a hand-off keeps (a reconnect, a move, Remove)', () => {
  const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/
  type Call = { agentFilePath: string; path: string; content: string | null; kept?: string }

  it('each hand-off names its own stamp; a later notice on the file, and its removal, are the notice\'s copy only', async () => {
    const stash = vi.fn(async (_s: Call) => ({ success: true }))
    const stop = startEditRecovery({ recoveryStash: stash }, 500)
    conflict('notes.md')
    // T1 kept on Reconnect.
    expect(await stashUnsavedEditors({ recoveryStash: stash })).toBe(1)
    const first = stash.mock.calls.at(-1)![0]
    expect(first).toEqual({ agentFilePath: AGENT, path: 'notes.md', content: 'mine', kept: expect.stringMatching(STAMP) })
    // The agent reopens: its editors go, then T2 under a new notice, resolved.
    tabs().reset()
    conflict('notes.md')
    tabs().updateTabContent('notes.md', 'T2')
    tabs().resolveTabConflict('notes.md', 'reload')
    // A second reconnect keeps another copy, under another stamp.
    tabs().openTab('notes.md', 'base', false, undefined, 1)
    tabs().updateTabContent('notes.md', 'T3')
    expect(await stashUnsavedEditors({ recoveryStash: stash })).toBe(1)
    const second = stash.mock.calls.at(-1)![0]
    expect(second).toEqual({ agentFilePath: AGENT, path: 'notes.md', content: 'T3', kept: expect.stringMatching(STAMP) })
    expect(second.kept).not.toBe(first.kept)
    stop()
    // Every removal is of a notice's copy, never of a hand-off's.
    const removals = stash.mock.calls.map((c) => c[0]).filter((s) => s.content === null)
    expect(removals.length).toBeGreaterThan(0)
    expect(removals.every((s) => s.kept === undefined)).toBe(true)
  })

  it('one hand-off\'s copies share one stamp', async () => {
    const stash = vi.fn(async (_s: Call) => ({ success: true }))
    tabs().openTab('notes.md', 'base', false, undefined, 1)
    tabs().updateTabContent('notes.md', 'typed')
    useDocumentStore.getState().setDocumentContent('# unsaved readme')
    expect(await stashUnsavedEditors({ recoveryStash: stash })).toBe(2)
    const stamps = new Set(stash.mock.calls.map((c) => c[0].kept))
    expect(stamps.size).toBe(1)
    expect([...stamps][0]).toMatch(STAMP)
  })

  it('the recovered-edits notice lists them at once: the launch\'s copies and the hand-off\'s, not a notice\'s copy still in use', async () => {
    const launch = [{ agent: 'agent-1', path: 'a.md', file: '/r/agent-1-1/a.md' }]
    let listed: Array<{ agent: string; path: string; file: string; kept?: boolean }> = launch
    const recoveryList = vi.fn(async () => ({ root: '/r', files: listed }))
    const shown: Array<{ files: string[]; session: boolean }> = []
    const stop = watchRecoveredEdits({ recoveryList }, (files, session) => { shown.push({ files: files.map((f) => `${f.agent}/${f.path}`), session }) })
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toEqual([{ files: ['agent-1/a.md'], session: false }])

    // A hand-off: main now also holds a notice's copy in use (b.md) and the hand-off's (notes.md).
    listed = [...launch, { agent: 'agent-1', path: 'b.md', file: '/r/agent-1-1/b.md' }, { agent: 'agent-1', path: 'notes.md', file: '/r/agent-1-1~kept-x/notes.md', kept: true }]
    tabs().openTab('notes.md', 'base', false, undefined, 1)
    tabs().updateTabContent('notes.md', 'typed')
    await stashUnsavedEditors({ recoveryStash: vi.fn(async () => ({ success: true })) })
    await new Promise((r) => setTimeout(r, 0))
    expect(shown.at(-1)).toEqual({ files: ['agent-1/a.md', 'agent-1/notes.md'], session: true })
    stop()
    expect(recoveredEditsMessage([{ agent: 'agent-1', path: 'notes.md' }], { session: true })).toBe('Studio kept your unsaved version of agent-1/notes.md.')
  })
})
