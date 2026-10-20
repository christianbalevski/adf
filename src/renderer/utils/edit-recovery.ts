import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { useAgentStore } from '../stores/agent.store'
import { useDocumentStore } from '../stores/document.store'

/**
 * W3-F: while a "changed elsewhere" notice holds the user's unsaved version
 * (an editor tab's `conflict`, the config panel's `configConflict`), main
 * keeps a copy at `<userData>/recovered/<agent>/<path>` (edit-recovery.ts in
 * main). Resolving the notice, or discarding the version on close or agent
 * switch, removes it. A quit or crash with the notice up therefore leaves the
 * copy, and the next launch lists it (RecoveredEditsNotice).
 *
 * The first copy is written at once; later typing under the notice updates it
 * after `delayMs`. Each copy is filed under the agent that was open when its
 * conflict appeared, so an agent switch never files it under the next agent.
 */

export const CONFIG_RECOVERY_PATH = 'config.json'

/** `runtimeId`: the agent's runtime, omitted for This computer (docs/design/multi-runtime.md §4.5). */
type Stash = { agentFilePath: string; path: string; content: string | null; runtimeId?: string }

/** The stash fields naming the open agent's runtime: none for This computer, so its copies are the ones kept before. */
function runtimeField(): { runtimeId?: string } {
  const runtimeId = useDocumentStore.getState().runtimeId
  return runtimeId && runtimeId !== 'local' ? { runtimeId } : {}
}
type Api = { recoveryStash?: (stash: Stash) => Promise<unknown> }

export function startEditRecovery(api: Api | undefined = typeof window !== 'undefined' ? window.adfApi : undefined, delayMs = 500): () => void {
  if (!api?.recoveryStash) return () => {}
  const stash = (s: Stash) => { void api.recoveryStash!(s).catch((err) => console.error('[Recovery] Could not keep a copy of unsaved text:', err)) }
  /** Copies on disk now, by `agent\0path`. */
  const kept = new Map<string, Stash>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The agent each conflicted tab belongs to: the one open when its conflict appeared. */
  const tabOwner = new Map<string, string>()

  const sync = () => {
    const want = new Map<string, Stash>()
    const open = useDocumentStore.getState().filePath
    const conflicted = new Set<string>()
    for (const tab of useEditorTabsStore.getState().tabs) {
      if (!tab.conflict) continue
      conflicted.add(tab.path)
      if (!tabOwner.has(tab.path) && open) tabOwner.set(tab.path, open)
      const owner = tabOwner.get(tab.path)
      if (owner) {
        const rt = runtimeField()
        want.set(`${rt.runtimeId ?? ''}\0${owner}\0${tab.path}`, { agentFilePath: owner, path: tab.path, content: tab.content, ...rt })
      }
    }
    for (const path of [...tabOwner.keys()]) if (!conflicted.has(path)) tabOwner.delete(path)
    const config = useAgentStore.getState().configConflict
    if (config?.owner) {
      const rt = runtimeField()
      want.set(`${rt.runtimeId ?? ''}\0${config.owner}\0${CONFIG_RECOVERY_PATH}`, { agentFilePath: config.owner, path: CONFIG_RECOVERY_PATH, content: `${JSON.stringify(config.mine, null, 2)}\n`, ...rt })
    }

    for (const [key, entry] of want) {
      const have = kept.get(key)
      if (have?.content === entry.content) continue
      clearTimeout(timers.get(key))
      timers.delete(key)
      if (!have) {
        kept.set(key, entry)
        stash(entry)
      } else {
        timers.set(key, setTimeout(() => {
          timers.delete(key)
          kept.set(key, entry)
          stash(entry)
        }, delayMs))
      }
    }
    for (const [key, entry] of [...kept]) {
      if (want.has(key)) continue
      clearTimeout(timers.get(key))
      timers.delete(key)
      kept.delete(key)
      stash({ ...entry, content: null })
    }
  }

  // Quitting with a copy still waiting for its debounce: write it now.
  const flush = () => {
    for (const [key, timer] of [...timers]) {
      clearTimeout(timer)
      timers.delete(key)
    }
    kept.clear()
    sync()
  }
  const win = typeof window !== 'undefined' ? window : null
  win?.addEventListener('beforeunload', flush)
  const unsubTabs = useEditorTabsStore.subscribe(sync)
  // The agent store changes on every streamed token: only its conflict matters here.
  const unsubAgent = useAgentStore.subscribe((s, prev) => { if (s.configConflict !== prev.configConflict) sync() })
  sync()
  return () => {
    unsubTabs()
    unsubAgent()
    win?.removeEventListener('beforeunload', flush)
    for (const timer of timers.values()) clearTimeout(timer)
  }
}

/**
 * Before a restart main asked for (daemon mode: Reconnect, or Use Embedded
 * for This Session, after the connection failed): keep every unsaved editor
 * of the open agent as a recovery copy, listed at the next launch. The
 * README tab or the document, every dirty text tab, and the config panel's
 * version under a conflict. Answers how many copies were written.
 */
export async function stashUnsavedEditors(api: Api | undefined = typeof window !== 'undefined' ? window.adfApi : undefined): Promise<number> {
  const agentFilePath = useDocumentStore.getState().filePath
  if (!api?.recoveryStash || !agentFilePath) return 0
  const copies = new Map<string, string>()
  for (const tab of useEditorTabsStore.getState().tabs) {
    if (tab.kind === 'file' && !tab.isBinary && tab.isDirty) copies.set(tab.path, tab.content)
  }
  const doc = useDocumentStore.getState()
  if (doc.isDirty && !copies.has('README.md')) copies.set('README.md', doc.documentContent)
  const config = useAgentStore.getState().configConflict
  if (config?.owner === agentFilePath) copies.set(CONFIG_RECOVERY_PATH, `${JSON.stringify(config.mine, null, 2)}\n`)
  let written = 0
  for (const [path, content] of copies) {
    try {
      await api.recoveryStash({ agentFilePath, path, content, ...runtimeField() })
      written++
    } catch (err) {
      console.error(`[Recovery] Could not keep a copy of unsaved ${path}:`, err)
    }
  }
  return written
}

/** The launch notice's sentence for the copies a quit, crash or restart left. */
export function recoveredEditsMessage(files: ReadonlyArray<{ agent: string; path: string }>): string {
  const names = files.map((f) => `${f.agent}/${f.path}`)
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
  return `Studio kept your unsaved version of ${shown} from the last session, which ended before it was saved.`
}
