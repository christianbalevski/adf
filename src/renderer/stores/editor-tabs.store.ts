import { create } from 'zustand'
import type { ContainerPhase } from '../../shared/types/compute.types'
import type { ResourceWriter } from '../../shared/types/resource-revision.types'

export interface BrowserTabMeta {
  agentFilePath: string
  containerName: string
  /** Needed to re-query the viewer port once the container becomes ready. */
  agentId: string
  agentName: string
  /** Host loopback port serving the container's noVNC viewer; null until the
   *  container is ready and its display stack is up. */
  hostPort: number | null
  /** Container lifecycle at open time; the viewer follows live phase events after that. */
  phase?: ContainerPhase
  detail?: string
  /** Bumped by reloadBrowserTab — the viewer reloads when it changes. */
  reloadNonce?: number
}

export interface EditorTab {
  path: string
  content: string
  savedContent: string
  isDirty: boolean
  isBinary: boolean
  /** Stored `adf_files.mime_type`, when the opener had it. Untrusted — an agent
   *  can write any value — so it only ever feeds resolveImageMime's allowlist. */
  mimeType?: string
  extension: string
  kind: 'file' | 'browser'
  browserMeta?: BrowserTabMeta
  /**
   * W3-F: the revision `savedContent` is (from the read, the last save, or the
   * last external write applied). A save passes it as `baseRevision`;
   * undefined saves without one (last write wins, as before revisions).
   */
  revision?: number
  /** W3-F: someone else changed the file while this tab had unsaved text; the tab shows the notice. */
  conflict?: TabConflict
  /**
   * Someone else's change replaced this (clean) tab's text. The tab shows a
   * short-lived "Updated by … · Undo" strip; cleared by typing, a save, or
   * dismissal. Not persisted.
   */
  replaced?: TabReplaced
}

/** What a clean tab showed before someone else's write replaced it. */
export interface TabReplaced {
  previous: string
  writer: ResourceWriter | null
  /** Tells two replacements of the same tab apart (restarts the strip's timer). */
  seq: number
}

/** Someone else's change that arrived over unsaved text (or refused a save). */
export interface TabConflict {
  /** Their text, when known; null: Reload reads it. */
  content: string | null
  revision?: number
  writer: ResourceWriter | null
}

/** What an external write says about itself (file_updated / document_updated, W3-F). */
export interface ExternalWriteMeta {
  revision?: number
  writer?: ResourceWriter | null
}

/** Identifies one external (agent) write so consumers can tell repeats apart. */
export interface ExternalWriteMark {
  path: string
  seq: number
}

interface EditorTabsState {
  tabs: EditorTab[]
  activeTabPath: string | null
  /**
   * Bumped by updateTabFromExternal. The save layer watches it to drop a queued
   * write the agent has already superseded — without this the editor shows the
   * agent's text while a stale debounce puts the pre-agent text back on disk.
   */
  lastExternalWrite: ExternalWriteMark | null
  /** W3-F: bumped to move focus to the "changed elsewhere" notice (Ctrl+S while it is up). */
  conflictFocusSeq: number

  /** `revision` (W3-F): the revision `content` is, from the read that produced it. */
  openTab: (path: string, content: string, isBinary: boolean, mimeType?: string, revision?: number) => void
  /**
   * `activate: false` adds/refreshes the tab without taking the stage — used
   * by the auto-open on agent startup so it doesn't yank the user off the chat.
   */
  openBrowserTab: (meta: BrowserTabMeta, opts?: { activate?: boolean }) => void
  reloadBrowserTab: (path: string) => void
  closeTab: (path: string) => void
  setActiveTab: (path: string) => void
  updateTabContent: (path: string, content: string) => void
  /**
   * `saved` (W3-F): the text the save wrote, when the save layer marks the tab
   * after the write answered (typing meanwhile keeps the tab dirty). Without
   * it, the tab's current text, as before.
   */
  markTabSaved: (path: string, saved?: string) => void
  /**
   * Someone else wrote the file. A clean tab takes their text; a tab with
   * unsaved text keeps it and gets a `conflict` instead (W3-F), so the user
   * chooses rather than losing either version.
   */
  updateTabFromExternal: (path: string, content: string, meta?: ExternalWriteMeta) => void
  /** W3-F: the revision a save of this tab produced. */
  setTabRevision: (path: string, revision: number | undefined) => void
  /** W3-F: a save was refused; the tab keeps its text and shows the notice. */
  setTabConflict: (path: string, conflict: TabConflict, mine?: string) => void
  /**
   * W3-F: the user's answer to the notice. `reload`: take their text (needs
   * `conflict.content`). `keep`: keep this text, now based on their revision;
   * the tab is dirty and the next save overwrites theirs.
   */
  resolveTabConflict: (path: string, choice: 'reload' | 'keep', theirs?: { content: string; revision?: number }) => void
  /** W3-F: focus the active tab's notice (a save was asked for while it is up). */
  focusConflictNotice: () => void
  /**
   * Undo of a replacement: the tab shows what it held before, unsaved (dirty
   * over their text and revision), and returns that text for the caller to
   * save. Null when there is nothing to undo.
   */
  undoExternalReplace: (path: string) => string | null
  /** The "Updated by" strip timed out or was closed. */
  dismissExternalReplace: (path: string) => void
  reset: () => void
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
}

let externalWriteSeq = 0
let replacedSeq = 0

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  lastExternalWrite: null,
  conflictFocusSeq: 0,

  openTab: (path, content, isBinary, mimeType, revision) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
      // Re-opening reloads from disk, but only over a clean tab — unsaved local
      // edits outrank whatever the caller read. Refreshing also lets the editor
      // re-evaluate the large-file gate, which it can't do without new content.
      // A binary tab carries no content, so its kind is compared instead: the
      // file may have been replaced by one of a different type since it opened.
      const changed =
        existing.content !== content ||
        existing.isBinary !== isBinary ||
        (isBinary && existing.mimeType !== mimeType)
      if (!existing.isDirty && changed) {
        set({
          tabs: tabs.map((t) => (t.path === path ? { ...t, content, savedContent: content, isBinary, mimeType, revision } : t)),
          activeTabPath: path
        })
        return
      }
      set({ activeTabPath: path })
      return
    }
    const tab: EditorTab = {
      path,
      content,
      savedContent: content,
      isDirty: false,
      isBinary,
      mimeType,
      extension: getExtension(path),
      kind: 'file',
      ...(revision !== undefined ? { revision } : {})
    }
    set({ tabs: [...tabs, tab], activeTabPath: path })
  },

  openBrowserTab: (meta, opts) => {
    const activate = opts?.activate ?? true
    const path = `browser://${meta.agentFilePath}`
    const { tabs, activeTabPath } = get()
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
      // The port changes when the container is recreated — refresh in place.
      set({
        tabs: tabs.map((t) => (t.path === path ? { ...t, browserMeta: meta } : t)),
        activeTabPath: activate ? path : activeTabPath
      })
      return
    }
    const tab: EditorTab = {
      path,
      content: '',
      savedContent: '',
      isDirty: false,
      isBinary: false,
      extension: '',
      kind: 'browser',
      browserMeta: meta
    }
    set({ tabs: [...tabs, tab], activeTabPath: activate ? path : activeTabPath })
  },

  reloadBrowserTab: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path && t.kind === 'browser' && t.browserMeta
          ? { ...t, browserMeta: { ...t.browserMeta, reloadNonce: (t.browserMeta.reloadNonce ?? 0) + 1 } }
          : t
      )
    }))
  },

  closeTab: (path) => {
    const { tabs, activeTabPath } = get()
    const idx = tabs.findIndex((t) => t.path === path)
    if (idx === -1) return
    const newTabs = tabs.filter((t) => t.path !== path)
    let newActive = activeTabPath
    if (activeTabPath === path) {
      if (newTabs.length === 0) {
        newActive = null
      } else if (idx < newTabs.length) {
        newActive = newTabs[idx].path
      } else {
        newActive = newTabs[newTabs.length - 1].path
      }
    }
    set({ tabs: newTabs, activeTabPath: newActive })
  },

  setActiveTab: (path) => {
    set({ activeTabPath: path })
  },

  updateTabContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? { ...t, content, isDirty: content !== t.savedContent, ...(t.replaced && content !== t.content ? { replaced: undefined } : {}) }
          : t
      )
    }))
  },

  markTabSaved: (path, saved) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? saved === undefined
            ? { ...t, savedContent: t.content, isDirty: false }
            : { ...t, savedContent: saved, isDirty: t.content !== saved }
          : t
      )
    }))
  },

  updateTabFromExternal: (path, content, meta) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.path !== path) return t
        // Unsaved text over a change from elsewhere: keep both (W3-F). The
        // save layer drops its queued write (lastExternalWrite below), so
        // nothing reaches the file until the user picks Reload or Keep mine.
        if (t.isDirty && t.content !== content) {
          // A repeat of the change already shown (the README path hears it
          // twice: the event, then the document store) keeps what it knew.
          if (t.conflict && t.conflict.content === content && meta === undefined) return t
          return { ...t, conflict: { content, revision: meta?.revision, writer: meta?.writer ?? null } }
        }
        // A clean tab takes their text, and says so: the strip names the
        // writer and offers Undo (the text it showed is kept for that).
        const replaced = t.content !== content && t.kind === 'file' && !t.isBinary
          ? { previous: t.content, writer: meta?.writer ?? null, seq: ++replacedSeq }
          : t.replaced
        return { ...t, content, savedContent: content, isDirty: false, revision: meta ? meta.revision : t.revision, conflict: undefined, replaced }
      }),
      // Marked unconditionally: the save layer needs to know the file changed
      // underneath it even when no tab is currently showing it.
      lastExternalWrite: { path, seq: ++externalWriteSeq }
    }))
  },

  setTabRevision: (path, revision) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, revision } : t)) }))
  },

  setTabConflict: (path, conflict, mine) => {
    set((s) => ({
      // The refused text is still unsaved: the tab shows it (again, if their
      // change replaced it meanwhile, or the tab was reopened on their text),
      // dirty, over their text. Any other text in the tab is the user's own,
      // typed while the save was on its way (unsaved, or typed and deleted
      // back to the saved text; an external change never replaces unsaved
      // text), and newer than `mine`: it stays.
      tabs: s.tabs.map((t) => {
        if (t.path !== path) return t
        const showsMineOrTheirs = !t.isDirty && (t.content === mine || t.content === conflict.content)
        return { ...t, content: showsMineOrTheirs ? mine ?? t.content : t.content, conflict, isDirty: true, savedContent: conflict.content ?? t.savedContent, replaced: undefined }
      })
    }))
  },

  resolveTabConflict: (path, choice, theirs) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.path !== path || !t.conflict) return t
        if (choice === 'reload') {
          const content = theirs?.content ?? t.conflict.content ?? t.savedContent
          return { ...t, content, savedContent: content, isDirty: false, revision: theirs ? theirs.revision : t.conflict.revision, conflict: undefined, replaced: undefined }
        }
        // Keep mine: based on their revision now; dirty until the save lands.
        return { ...t, isDirty: true, revision: t.conflict.revision, conflict: undefined }
      })
    }))
  },

  focusConflictNotice: () => {
    set((s) => ({ conflictFocusSeq: s.conflictFocusSeq + 1 }))
  },

  undoExternalReplace: (path) => {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab?.replaced || tab.conflict) return null
    const previous = tab.replaced.previous
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, content: previous, isDirty: previous !== t.savedContent, replaced: undefined } : t
      )
    }))
    return previous
  },

  dismissExternalReplace: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path && t.replaced ? { ...t, replaced: undefined } : t))
    }))
  },

  reset: () => {
    set({ tabs: [], activeTabPath: null, lastExternalWrite: null })
  }
}))

/**
 * Agent-switch window. DOC_WRITE_INTERNAL_FILE carries no agent identity — it
 * writes into whatever workspace the main process has open when it arrives — so
 * a save that fires while the workspace is being swapped lands in the wrong
 * agent's file. The switch is marked from before main swaps until the incoming
 * agent's tabs are loaded, and the save layer drops anything scheduled inside
 * it. Module state, not store state: nothing should re-render on this.
 *
 * A counter rather than a boolean because openFile brackets the whole switch
 * and loadFileContents, which it calls, brackets its own half.
 */
let agentSwitchDepth = 0

/**
 * Debounced writers that carry no agent identity (AgentConfig's save) register
 * here so their pending edit is delivered while the outgoing agent's workspace
 * is still the open one — a switch that never blurs the field (keyboard nav)
 * would otherwise drop the last debounce window of typing.
 */
const preSwitchFlushers = new Set<() => void>()

export function registerPreSwitchFlush(flush: () => void): () => void {
  preSwitchFlushers.add(flush)
  return () => { preSwitchFlushers.delete(flush) }
}

export function beginAgentSwitch(): void {
  if (agentSwitchDepth === 0) {
    for (const flush of preSwitchFlushers) {
      try { flush() } catch { /* a failed flush must not block the switch */ }
    }
  }
  agentSwitchDepth++
}

export function endAgentSwitch(): void {
  if (agentSwitchDepth > 0) agentSwitchDepth--
}

export function isAgentSwitching(): boolean {
  return agentSwitchDepth > 0
}
