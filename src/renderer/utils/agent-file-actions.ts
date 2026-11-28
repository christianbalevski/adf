import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { reportFailure } from '../stores/failure-notices.store'
import { captureAgentView, isCurrentAgentView } from './agent-view'
import { saveFileNow } from './editor-save'
import { openApi } from './runtime-api'
import { MAX_INLINE_BINARY_BYTES } from '../../shared/utils/image-files'

/**
 * What the user can do to one of the open agent's files, from the Files panel,
 * a file tab's menu or a chat link. Each writes the file's unsaved editor text
 * first, so a save never lands after it on a path that moved or went away;
 * each reports its own failure and answers whether it was done. Composed from
 * the existing internal-file calls: a duplicate is a read and a write that
 * must not overwrite anything.
 */

/** The agent's document and memory: main reads them by name, so they are never renamed or deleted. */
export const CORE_FILES: ReadonlySet<string> = new Set(['README.md', 'mind.md'])

const UNSAVED = 'its unsaved text could not be saved first'

async function attempt(what: string, run: () => Promise<boolean | void>): Promise<boolean> {
  try {
    return (await run()) !== false
  } catch (err) {
    reportFailure(what, err)
    return false
  }
}

/** `notes.md` → `notes copy.md`, then `notes copy 2.md`, … — the first free one. */
export function duplicatePath(path: string, taken: ReadonlySet<string>): string {
  const slash = path.lastIndexOf('/') + 1
  const dot = path.lastIndexOf('.')
  const cut = dot > slash ? dot : path.length
  const stem = path.slice(0, cut)
  const ext = path.slice(cut)
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Opens a save dialog for the file. A cancelled dialog is not a failure. */
export function downloadAgentFile(path: string): Promise<boolean> {
  return attempt(`Could not download ${path}`, async () => {
    // The file as saved: a tab whose text could not be saved (a change notice) still downloads what is on disk.
    await saveFileNow(path)
    const result = await openApi()?.downloadInternalFile(path)
    if (result && !result.success && result.error) throw new Error(result.error)
  })
}

/** Saves a copy under a free name next to the file and opens it. */
export function duplicateAgentFile(path: string): Promise<boolean> {
  return attempt(`Could not duplicate ${path}`, async () => {
    const api = openApi()
    const view = captureAgentView()
    if (!api || !view.filePath) return false
    if (!await saveFileNow(path)) throw new Error(UNSAVED)
    const tab = useEditorTabsStore.getState().tabs.find((t) => t.path === path && t.kind === 'file')
    const read = await api.readInternalFile(path, { binaryContent: true })
    if (read.content == null) throw new Error('the file no longer exists')
    if (read.tooLarge) throw new Error(`it is larger than ${Math.round(MAX_INLINE_BINARY_BYTES / 1024 / 1024)} MB`)
    const { files } = await api.getInternalFiles()
    const to = duplicatePath(path, new Set(files.map((f) => f.path)))
    const mimeType = read.mimeType ?? tab?.mimeType
    const body = read.binary ? { contentBase64: read.content } : { content: read.content }
    if (!isCurrentAgentView(view)) return false
    const result = await api.writeInternalFiles(view.filePath, [{ path: to, ...body, ...(mimeType ? { mimeType } : {}), mustNotExist: true }])
    if (!result.success) throw new Error(result.error)
    if (!isCurrentAgentView(view)) return false
    useEditorTabsStore.getState().openTab(to, read.binary ? '' : read.content, read.binary, mimeType, result.revisions[to])
  })
}

/** Deletes the file and closes its tab. */
export function deleteAgentFile(path: string): Promise<boolean> {
  return attempt(`Could not delete ${path}`, async () => {
    // The save before a delete is only there to leave nothing pending; a refused one does not stop it.
    await saveFileNow(path)
    const result = await openApi()?.deleteInternalFile(path)
    if (!result?.success) throw new Error('it is protected or no longer exists. Protection can be changed in Files.')
    useEditorTabsStore.getState().closeTab(path)
  })
}

/** Renames the file; its tab follows. */
export function renameAgentFile(from: string, to: string): Promise<boolean> {
  return attempt(`Could not rename ${from}`, async () => {
    const api = openApi()
    if (!api) return false
    if (!await saveFileNow(from)) throw new Error(UNSAVED)
    // A tab left open on the destination gives way to the moved one; not with text that was never saved.
    const there = useEditorTabsStore.getState().tabs.find((t) => t.path === to && t.kind === 'file')
    if (there?.isDirty || there?.conflict) throw new Error(`${to} is open with unsaved text. Close its tab first.`)
    const view = captureAgentView()
    const result = await api.renameInternalFile(from, to)
    // Both backends answer String(err): "Error: File already exists: …".
    if (!result.success) throw new Error(result.error?.replace(/^Error: /, '') || 'the rename was refused')
    if (!isCurrentAgentView(view)) return
    useEditorTabsStore.getState().renameTabPath(from, to)
    await refreshMovedTab(to)
  })
}

/** Renames a folder; the tabs of the files in it follow. */
export function renameAgentFolder(from: string, to: string): Promise<boolean> {
  return attempt(`Could not rename ${from}`, async () => {
    const api = openApi()
    if (!api) return false
    const inside = useEditorTabsStore.getState().tabs.filter((t) => t.kind === 'file' && t.path.startsWith(`${from}/`))
    for (const tab of inside) if (!await saveFileNow(tab.path)) throw new Error(`the unsaved text of ${tab.path} could not be saved first`)
    const view = captureAgentView()
    const result = await api.renameFolder(from, to)
    if (!result.success) throw new Error('the rename was refused')
    if (!isCurrentAgentView(view)) return
    useEditorTabsStore.getState().renameTabPath(from, to, { folder: true })
    await Promise.all(inside.map((tab) => refreshMovedTab(`${to}/${tab.path.slice(from.length + 1)}`)))
  })
}

/**
 * Revisions are kept per path, and a new extension may class the file
 * differently (text or binary): a moved tab takes both from the file at its
 * new path, in place, without taking the stage.
 */
async function refreshMovedTab(path: string): Promise<void> {
  const api = openApi()
  const view = captureAgentView()
  const tab = useEditorTabsStore.getState().tabs.find((t) => t.path === path && t.kind === 'file')
  if (!api || !tab) return
  const meta = await api.readInternalFile(path, { revisionOnly: true })
  if (meta.content == null || !isCurrentAgentView(view)) return
  // The same kind keeps its text; the other kind is read again.
  const read = meta.binary === tab.isBinary ? null : await api.readInternalFile(path)
  if ((read && read.content == null) || !isCurrentAgentView(view)) return
  const from = read ?? meta
  useEditorTabsStore.setState((s) => ({
    tabs: s.tabs.map((t) => {
      if (t.path !== path || t.kind !== 'file') return t
      const moved = { ...t, mimeType: from.mimeType, revision: from.revision }
      if (!read) return moved
      const content = read.binary ? '' : read.content ?? ''
      return { ...moved, content, savedContent: content, isDirty: false, isBinary: read.binary }
    }),
  }))
}
