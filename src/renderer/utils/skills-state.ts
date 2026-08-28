/**
 * The renderer's one writer for `skills-state.json`.
 *
 * Two surfaces mute skills — the Skills panel's checkboxes and the composer's
 * `/skills disable|enable` commands — and the file is edited read-modify-write,
 * so two overlapping edits would each read the pre-edit document and the second
 * write would erase the first. The queue below is module-level rather than
 * per-component precisely so that it serializes *across* those surfaces, not
 * just within one of them.
 *
 * The other hazard is identity: DOC_WRITE_INTERNAL_FILE carries no agent, so it
 * lands in whichever workspace main has open when it arrives. Every write
 * captures the agent it started under and is abandoned — before and after the
 * read — if the agent changed or a switch is in flight.
 */

import { useDocumentStore } from '../stores/document.store'
import { useEditorTabsStore, isAgentSwitching } from '../stores/editor-tabs.store'
import { mergeDisabledList, SKILLS_STATE_PATH } from './skills-panel'

/** The agent a write belongs to: the open document's path at the time it began. */
export function currentSkillsOwner(): string | null {
  return useDocumentStore.getState().filePath
}

/**
 * Guard for the async gap around a write. Returns the reason to abandon, or
 * null when the caller still owns the workspace it started in.
 */
export function agentChanged(owner: string | null): string | null {
  if (isAgentSwitching()) return 'The open agent is switching — nothing was written.'
  if (useDocumentStore.getState().filePath !== owner) {
    return 'The open agent changed — nothing was written.'
  }
  return null
}

/**
 * Keep an open editor tab on a skills file honest.
 *
 * The tab store's external-write path is the reload mechanism; it is normally
 * driven by the runtime's `file_updated` event, which deliberately skips writes
 * Studio itself made (assemble-agent.ts) — so a tab showing skills-state.json
 * would sit on pre-toggle text until it was closed and reopened. Dirty tabs are
 * left alone: unsaved human edits outrank a refresh.
 */
export function syncOpenTab(path: string, content: string | null | undefined): void {
  if (content == null) return
  const store = useEditorTabsStore.getState()
  const tab = store.tabs.find((t) => t.path === path)
  if (!tab || tab.kind !== 'file' || tab.isDirty || tab.content === content) return
  store.updateTabFromExternal(path, content)
}

/** One promise chain for every skills-state.json write in the renderer. */
let stateQueue: Promise<unknown> = Promise.resolve()

/** Run `task` after every state write already queued, whether or not they succeeded. */
export function enqueueStateWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = stateQueue.then(task, task)
  stateQueue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Mute or unmute one skill by merging into `skills-state.json`.
 *
 * Unknown keys, and names the caller cannot see (a package removed while
 * muted), survive untouched. The write itself triggers the reindex — no caller
 * writes `skills-registry.json`, and none touches config, tools or approvals.
 *
 * Resolves to an error message, or null on success.
 */
export function setSkillMuted(name: string, enabled: boolean, owner: string | null): Promise<string | null> {
  return enqueueStateWrite(async () => {
    const blocked = agentChanged(owner)
    if (blocked) return blocked
    const stateFile = await window.adfApi?.readInternalFile(SKILLS_STATE_PATH)
    const blockedAfterRead = agentChanged(owner)
    if (blockedAfterRead) return blockedAfterRead
    const next = mergeDisabledList(stateFile?.content, name, enabled)
    const written = await window.adfApi?.writeInternalFile(SKILLS_STATE_PATH, next)
    if (!written?.success) return `Could not write ${SKILLS_STATE_PATH}.`
    syncOpenTab(SKILLS_STATE_PATH, next)
    return null
  })
}
