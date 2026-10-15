import { useEditorTabsStore, type TabConflict } from '../stores/editor-tabs.store'
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
): Promise<SaveOutcome> {
  const store = useEditorTabsStore.getState
  const tab = store().tabs.find((t) => t.path === path)
  const baseContent = tab?.savedContent ?? ''
  let outcome = classifySave(await write(content, tab?.revision), baseContent, content)
  if (outcome.kind === 'retry') {
    console.info(`[Editor] ${path}: revision moved without a change to the text; saving over ${outcome.baseRevision}`)
    outcome = classifySave(await write(content, outcome.baseRevision), baseContent, content)
    // Moved twice in a row: let the user see it rather than loop.
    if (outcome.kind === 'retry') outcome = { kind: 'conflict', conflict: { content: baseContent, revision: outcome.baseRevision, writer: null } }
  }
  if (outcome.kind === 'conflict') {
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
