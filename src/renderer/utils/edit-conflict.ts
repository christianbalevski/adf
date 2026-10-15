import { useEditorTabsStore, type TabConflict } from '../stores/editor-tabs.store'
import { useAgentStore } from '../stores/agent.store'
import { describeWriter, type ResourceConflict, type ResourceWriter } from '../../shared/types/resource-revision.types'

/**
 * W3-F: saving over the revision an editor last saw, and what the editor does
 * when someone else wrote in between. Shared by the editor tabs and the
 * config panel, in both backends (Studio main answers the same shapes).
 *
 * A refused save is a conflict only when the text the edit was based on is
 * no longer what is there. When it still is, only the revision moved (a
 * restarted daemon, a write that changed nothing, this window's own earlier
 * save): the save goes again over the new revision without asking.
 */

/** What setDocument / writeInternalFile / setAgentConfig answer (preload). */
export type SaveAnswer = { success?: boolean; revision?: number; conflict?: ResourceConflict } | null | undefined

/** What a save is based on: the revision and text of the file when the edit began. */
export interface SaveBase {
  revision: number | undefined
  baseContent: string
}

export type SaveOutcome =
  | { kind: 'saved'; revision?: number }
  | { kind: 'retry'; baseRevision: number }
  | { kind: 'conflict'; conflict: TabConflict }

/**
 * `baseContent`: the text the edit started from; `sent`: the text saved.
 * An answer without a conflict counts as saved (embedded answers that way
 * for a save it did not refuse, and an older backend never refuses).
 */
export function classifySave(answer: SaveAnswer, baseContent: string, sent: string): SaveOutcome {
  const conflict = answer?.conflict
  if (!conflict) return { kind: 'saved', revision: answer?.revision }
  // Someone wrote exactly this text: nothing of theirs would be lost.
  if (conflict.content === sent) return { kind: 'saved', revision: conflict.revision }
  if (conflict.content != null && conflict.content === baseContent) return { kind: 'retry', baseRevision: conflict.revision }
  return { kind: 'conflict', conflict: { content: conflict.content ?? null, revision: conflict.revision, writer: conflict.writer } }
}

/**
 * Save an editor tab's text over its revision and apply the answer to the
 * tab: saved (its new revision), saved again over a revision that only moved,
 * or a conflict (the tab keeps `content` and shows the notice).
 */
export async function saveTabContent(
  path: string,
  content: string,
  write: (content: string, baseRevision: number | undefined) => Promise<SaveAnswer>,
  base?: SaveBase,
): Promise<SaveOutcome> {
  const store = useEditorTabsStore.getState
  const tab = store().tabs.find((t) => t.path === path)
  // The base taken when the save was scheduled (editor-save.ts), else the tab's now.
  const baseContent = base ? base.baseContent : tab?.savedContent ?? ''
  const baseRevision = base ? base.revision : tab?.revision
  let outcome = classifySave(await write(content, baseRevision), baseContent, content)
  if (outcome.kind === 'retry') {
    console.info(`[Editor] ${path}: revision moved without a change to the text; saving over ${outcome.baseRevision}`)
    outcome = classifySave(await write(content, outcome.baseRevision), baseContent, content)
    // Moved twice in a row: let the user see it rather than loop.
    if (outcome.kind === 'retry') outcome = { kind: 'conflict', conflict: { content: baseContent, revision: outcome.baseRevision, writer: null } }
  }
  if (outcome.kind === 'conflict') {
    // A tab closed while this save was on its way comes back with the
    // notice: the refused text has nowhere else to go.
    if (!store().tabs.some((t) => t.path === path)) store().openTab(path, outcome.conflict.content ?? content, false, undefined, outcome.conflict.revision)
    store().setTabConflict(path, outcome.conflict, content)
    return outcome
  }
  store().markTabSaved(path, content)
  const now = store().tabs.find((t) => t.path === path)
  // Only while the tab still holds what this save wrote: a change that
  // arrived meanwhile carries its own (newer) revision.
  if (now && !now.conflict && now.savedContent === content) store().setTabRevision(path, outcome.revision)
  return outcome
}

/** The notice's sentence: "<what> was changed by <writer> while you were editing." */
export function conflictMessage(what: string, writer: ResourceWriter | null | undefined): string {
  return `${what} was changed by ${describeWriter(writer)} while you were editing.`
}

/** A config refusal: their config, the revision it is, who wrote it. */
export interface ConfigConflict {
  theirs: unknown
  revision: number
  writer: ResourceWriter | null
}

export type ConfigSaveOutcome =
  | { kind: 'saved'; revision?: number }
  | { kind: 'retry'; baseRevision: number }
  | { kind: 'conflict'; conflict: ConfigConflict }

/**
 * classifySave for the config panel. `baseConfig`: the config the edit
 * started from (null: never retry). Configs compare as stable JSON without
 * `metadata.updated_at`, which every save stamps.
 */
export function classifyConfigSave(answer: SaveAnswer, baseConfig: unknown, sent: unknown): ConfigSaveOutcome {
  const conflict = answer?.conflict
  if (!conflict) return { kind: 'saved', revision: answer?.revision }
  const theirs = conflict.config
  if (theirs != null && configFingerprint(theirs) === configFingerprint(sent)) return { kind: 'saved', revision: conflict.revision }
  if (theirs != null && baseConfig != null && configFingerprint(theirs) === configFingerprint(baseConfig)) return { kind: 'retry', baseRevision: conflict.revision }
  return { kind: 'conflict', conflict: { theirs: theirs ?? null, revision: conflict.revision, writer: conflict.writer } }
}

function configFingerprint(config: unknown): string {
  if (!config || typeof config !== 'object') return stableJson(config)
  const c = config as { metadata?: Record<string, unknown> }
  return stableJson(c.metadata ? { ...c, metadata: { ...c.metadata, updated_at: undefined } } : c)
}

/** Stable JSON (sorted keys), to compare two configs regardless of key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
  })
}

/**
 * Close or agent switch over unsaved text under a "changed elsewhere"
 * notice: ask before it goes. `paths`: the tabs being closed; without it,
 * every conflicted tab and the config panel's version (an agent switch).
 * True: go ahead (the user discarded, or nothing was at stake). The
 * recovery copies go with the conflicts (edit-recovery.ts).
 */
export function confirmDiscardConflicts(
  paths?: readonly string[],
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  const names = useEditorTabsStore.getState().tabs.filter((t) => t.conflict && (!paths || paths.includes(t.path))).map((t) => t.path)
  if (!paths && useAgentStore.getState().configConflict) names.push('the config')
  if (names.length === 0) return true
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const them = names.length === 1 ? 'it' : 'them'
  return confirm(`Discard your unsaved changes to ${list}?\n\nSomeone else changed ${them} while you were editing. OK discards your version. Cancel keeps ${them} open.`)
}

/**
 * A one-shot config change from outside the config panel (Identity → publish
 * attestations, the provider setup dialog): read the config with its
 * revision, apply `change`, save over that revision. Refused because
 * someone else saved in between: read again and apply the change to their
 * config (the change is a few fields, not a stale copy of the whole), up to
 * three times. The store takes the saved config and its revision, so the
 * config panel's next save is based on it and does not blame another window
 * for this one's change. Answers the saved config, or null.
 */
export async function changeAgentConfig<C extends object>(change: (config: C) => C): Promise<C | null> {
  const api = window.adfApi
  if (!api?.getAgentConfigWithRevision) return null
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await api.getAgentConfigWithRevision()
    if (!read?.config) return null
    const updated = change(read.config as unknown as C)
    const saved = await api.setAgentConfig(updated, read.revision !== undefined ? { baseRevision: read.revision } : undefined)
    if (saved?.conflict) continue
    if (saved && saved.success === false) return null
    const store = useAgentStore.getState()
    store.setConfig(updated as never)
    if (saved?.revision !== undefined) store.setConfigRevision(saved.revision)
    return updated
  }
  return null
}
