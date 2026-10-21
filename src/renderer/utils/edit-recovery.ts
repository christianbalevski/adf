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

/**
 * `runtimeId`: the agent's runtime, omitted for This computer (docs/design/multi-runtime.md §4.5).
 * `kept`: a hand-off's stamp (§20 item 3): main keeps the copy in that hand-off's own folder.
 */
type Stash = { agentFilePath: string; path: string; content: string | null; runtimeId?: string; kept?: string }

/** The stash fields naming the open agent's runtime: none for This computer, so its copies are the ones kept before. */
function runtimeField(): { runtimeId?: string } {
  const runtimeId = useDocumentStore.getState().runtimeId
  return runtimeId && runtimeId !== 'local' ? { runtimeId } : {}
}
type Api = { recoveryStash?: (stash: Stash) => Promise<unknown> }

/** The key of a copy on disk: runtime, agent and path. */
const copyKey = (runtimeId: string | undefined, agentFilePath: string, path: string): string => `${runtimeId ?? ''}\0${agentFilePath}\0${path}`

/** Hand-offs so far: two in one millisecond still get two stamps. */
let handOffs = 0
/** Called once a hand-off kept copies: the recovered-edits notice lists them now (watchRecoveredEdits). */
const keptListeners = new Set<() => void>()

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
        want.set(copyKey(rt.runtimeId, owner, tab.path), { agentFilePath: owner, path: tab.path, content: tab.content, ...rt })
      }
    }
    for (const path of [...tabOwner.keys()]) if (!conflicted.has(path)) tabOwner.delete(path)
    const config = useAgentStore.getState().configConflict
    if (config?.owner) {
      const rt = runtimeField()
      want.set(copyKey(rt.runtimeId, config.owner, CONFIG_RECOVERY_PATH), { agentFilePath: config.owner, path: CONFIG_RECOVERY_PATH, content: `${JSON.stringify(config.mine, null, 2)}\n`, ...rt })
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
      // The notice's copy only: a hand-off's copies are in their own folder (stashUnsavedEditors).
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
 * version under a conflict. Answers how many copies were written. The
 * copies are handed off (multi-runtime.md §20 item 3): they carry this
 * hand-off's stamp, so main keeps them in a folder of their own that no
 * notice's copy or later hand-off writes over or removes, and the
 * recovered-edits notice lists them at once.
 */
export async function stashUnsavedEditors(api: Api | undefined = typeof window !== 'undefined' ? window.adfApi : undefined): Promise<number> {
  const agentFilePath = useDocumentStore.getState().filePath
  if (!api?.recoveryStash || !agentFilePath) return 0
  // Read now, with everything else: a caller may close the agent while the copies are written.
  const rt = runtimeField()
  const copies = new Map<string, string>()
  for (const tab of useEditorTabsStore.getState().tabs) {
    if (tab.kind === 'file' && !tab.isBinary && tab.isDirty) copies.set(tab.path, tab.content)
  }
  const doc = useDocumentStore.getState()
  if (doc.isDirty && !copies.has('README.md')) copies.set('README.md', doc.documentContent)
  const config = useAgentStore.getState().configConflict
  if (config?.owner === agentFilePath) copies.set(CONFIG_RECOVERY_PATH, `${JSON.stringify(config.mine, null, 2)}\n`)
  if (copies.size === 0) return 0
  const kept = `${new Date().toISOString().replace(/[:.]/g, '-')}-${++handOffs}`
  let written = 0
  for (const [path, content] of copies) {
    try {
      await api.recoveryStash({ agentFilePath, path, content, ...rt, kept })
      written++
    } catch (err) {
      console.error(`[Recovery] Could not keep a copy of unsaved ${path}:`, err)
    }
  }
  if (written > 0) {
    for (const listener of [...keptListeners]) {
      try { listener() } catch (err) { console.error('[Recovery] A listener of kept copies failed:', err) }
    }
  }
  return written
}

type RecoveredEntry = { agent: string; path: string; file: string; kept?: boolean }
type ListApi = { recoveryList?: () => Promise<{ files?: RecoveredEntry[] } | null | undefined> }

/**
 * The recovered-edits notice's list: the copies the launch found, then, after
 * each hand-off in this session (`session`: true), those plus the hand-offs'
 * copies. A copy a "changed elsewhere" notice holds now is not listed. Answers
 * the unsubscribe.
 */
export function watchRecoveredEdits(api: ListApi | undefined, onFiles: (files: RecoveredEntry[], session: boolean) => void): () => void {
  if (!api?.recoveryList) return () => {}
  let alive = true
  /** The copies the launch found; each later list waits for it, in order. */
  let launch = new Set<string>()
  let loads: Promise<void> = Promise.resolve()
  const load = (session: boolean) => {
    loads = loads.then(() => api.recoveryList!()).then((r) => {
      if (!alive) return
      const files = r?.files ?? []
      if (!session) launch = new Set(files.map((f) => f.file))
      const shown = files.filter((f) => f.kept || launch.has(f.file))
      if (session || shown.length > 0) onFiles(shown, session)
    }).catch(() => { /* older main */ })
  }
  load(false)
  const listener = () => load(true)
  keptListeners.add(listener)
  return () => {
    alive = false
    keptListeners.delete(listener)
  }
}

/** The notice's sentence for the copies a quit, crash or restart left; `session`: with copies a hand-off kept in this session. */
export function recoveredEditsMessage(files: ReadonlyArray<{ agent: string; path: string }>, opts: { session?: boolean } = {}): string {
  const names = files.map((f) => `${f.agent}/${f.path}`)
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
  if (opts.session) return `Studio kept your unsaved version of ${shown}.`
  return `Studio kept your unsaved version of ${shown} from the last session, which ended before it was saved.`
}
