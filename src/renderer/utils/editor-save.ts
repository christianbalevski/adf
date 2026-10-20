import { useEditorTabsStore, isAgentSwitching } from '../stores/editor-tabs.store'
import { useDocumentStore } from '../stores/document.store'
import { saveTabContent, type SaveAnswer, type SaveBase, type SaveOutcome } from './edit-conflict'
import { openApi } from './runtime-api'

/**
 * W3-F: the one way an editor tab's text reaches the file, for the editor's
 * debounced save, Ctrl+S / File > Save, and a tab closed with a save still
 * pending.
 *
 * - The base (the tab's revision and saved text) is taken when the save is
 *   scheduled, so a save delivered after its tab closed still names what it
 *   was based on.
 * - Saves of one file run one after another. A save based on the same
 *   revision as the one before it in the chain, which this window wrote,
 *   goes over the revision that save produced: it holds the same edit plus
 *   later typing, and nobody else wrote in between.
 * - Nothing is written for a tab showing the "changed elsewhere" notice.
 */

const chains = new Map<string, Promise<unknown>>()
/** Per file: base revision → what this window's save over it produced. */
const produced = new Map<string, Map<number | undefined, { revision?: number; content: string }>>()

/** The base of a save of `path` scheduled now. */
export function captureSaveBase(path: string): SaveBase {
  const tab = useEditorTabsStore.getState().tabs.find((t) => t.path === path)
  return { revision: tab?.revision, baseContent: tab?.savedContent ?? '' }
}

/** Forget what earlier saves produced (agent switch: other files, other revisions). */
export function resetEditorSaves(): void {
  produced.clear()
}

/**
 * Write `content` to `path` of the agent at `owner` over `base`. Dropped when
 * the agent changed (writeInternalFile has no agent argument) or the tab
 * shows the notice. Resolves to the save's outcome, or null when dropped.
 */
export function saveEditorTab(path: string, content: string, owner: string | null, base: SaveBase = captureSaveBase(path)): Promise<SaveOutcome | null> {
  const api = openApi()
  const current = () => owner === useDocumentStore.getState().filePath && !isAgentSwitching()
  if (!api || !current()) return Promise.resolve(null)
  if (useEditorTabsStore.getState().tabs.find((t) => t.path === path)?.conflict) return Promise.resolve(null)
  const write = (text: string, baseRevision: number | undefined): Promise<SaveAnswer> => {
    // Re-checked per attempt: a save queued behind another must not land after a switch.
    if (!current()) return Promise.resolve({ success: false })
    const opts = baseRevision !== undefined ? { baseRevision } : undefined
    return path === 'README.md' ? api.setDocument(text, opts) : api.writeInternalFile(path, text, opts)
  }
  const run = (chains.get(path) ?? Promise.resolve())
    .then(async () => {
      if (!current() || useEditorTabsStore.getState().tabs.find((t) => t.path === path)?.conflict) return null
      let effective = base
      const mine = produced.get(path)
      for (let hop = 0; hop < 16 && mine?.has(effective.revision); hop++) {
        const next = mine.get(effective.revision)!
        effective = { revision: next.revision, baseContent: next.content }
      }
      const outcome = await saveTabContent(path, content, write, effective)
      if (outcome.kind === 'saved' && outcome.revision !== undefined) {
        const map = produced.get(path) ?? new Map()
        map.set(effective.revision, { revision: outcome.revision, content })
        produced.set(path, map)
      }
      return outcome
    })
    .catch((err) => { console.error(`[Editor] Saving ${path} failed:`, err); return null })
  chains.set(path, run)
  void run.finally(() => { if (chains.get(path) === run) chains.delete(path) })
  return run
}

/**
 * Ctrl+S / File > Save for the editor: EditorPanel registers how to deliver
 * its debounced save now; without an editor mounted the active tab is saved
 * directly. A tab showing the notice is not saved: the notice gets focus.
 */
let flushEditor: (() => void) | null = null

export function registerEditorFlush(flush: () => void): () => void {
  flushEditor = flush
  return () => { if (flushEditor === flush) flushEditor = null }
}

export function saveActiveEditorTab(): void {
  const store = useEditorTabsStore.getState()
  const active = store.tabs.find((t) => t.path === store.activeTabPath)
  if (active?.conflict) {
    store.focusConflictNotice()
    return
  }
  if (flushEditor) {
    flushEditor()
    return
  }
  if (active && active.kind === 'file' && active.isDirty) void saveEditorTab(active.path, active.content, useDocumentStore.getState().filePath)
}
