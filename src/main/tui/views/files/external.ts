// Open a file target in the OS default app (xlsx, images, pdf, … anything the
// viewer cannot render): temp copy → default handler. The default handler
// returns at once, so there is no "editor closed" moment; instead the copy's
// mtime is watched and `s` saves it back: re-fetch to detect a concurrent
// change → confirm → write. Temp copies live until the TUI exits.

import { promises as fs, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBrowser } from '../../../cli/auth-flow'
import type { DaemonClient } from '../../api/client'
import type { TuiActions } from '../../state/store'
import { loadTarget, writeTarget, type LoadedContent } from './io'
import { formatBytes, targetFileName, targetKey, targetLabel, type FileTarget } from './model'

export interface ExternalCopy {
  agentId: string
  target: FileTarget
  /** Temp copy the default app has open. */
  file: string
  /** What the daemon had when the copy was made (or last saved back). */
  original: Buffer
  binary: boolean
  mime?: string | null
  /** mtime of the copy right after it was written; later = changed in the app. */
  mtimeMs: number
}

export interface ExternalDeps {
  client: DaemonClient
  actions: TuiActions
  agentId: string
  agentLabel: string
  /** Launch the OS default handler for a path (tests inject a fake). */
  open?: (file: string) => void
}

const copies = new Map<string, ExternalCopy>()
const dirs = new Set<string>()
let exitHook = false

const copyKey = (agentId: string, target: FileTarget) => `${agentId}\0${targetKey(target)}`
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const bytesOf = (loaded: LoadedContent) => (loaded.binary ? Buffer.from(loaded.bytes ?? new Uint8Array()) : Buffer.from(loaded.text ?? '', 'utf-8'))

export function externalCopy(agentId: string, target: FileTarget): ExternalCopy | undefined {
  return copies.get(copyKey(agentId, target))
}

/** True when the app saved the copy since it was made (or last saved back). */
export function externalChanged(copy: ExternalCopy): boolean {
  try {
    return statSync(copy.file).mtimeMs !== copy.mtimeMs
  } catch {
    return false
  }
}

/** Remove every temp copy (TUI exit; tests). */
export function cleanupExternalCopies(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.clear()
  copies.clear()
}

export async function openExternal(deps: ExternalDeps, target: FileTarget): Promise<boolean> {
  const { actions, agentId } = deps
  const label = targetLabel(target)
  const loaded = await actions.run(`Open ${label}`, c => loadTarget(c, agentId, target))
  if (!loaded) return false
  const bytes = bytesOf(loaded)

  // Reopening reuses the copy, so unsaved changes in it are never overwritten.
  const existing = externalCopy(agentId, target)
  let file = existing?.file
  if (!existing || !externalChanged(existing)) {
    try {
      if (!file) {
        const dir = await fs.mkdtemp(join(tmpdir(), 'adf-tui-open-'))
        dirs.add(dir)
        if (!exitHook) { exitHook = true; process.once('exit', cleanupExternalCopies) }
        file = join(dir, targetFileName(target))
      }
      await fs.writeFile(file, bytes)
    } catch (err) {
      actions.toast(`Cannot write a temp copy of ${label} in ${tmpdir()}: ${errorText(err)}`, 'error', 12_000)
      return false
    }
    copies.set(copyKey(agentId, target), { agentId, target, file, original: bytes, binary: loaded.binary, mime: loaded.mime, mtimeMs: (await fs.stat(file)).mtimeMs })
  }

  ;(deps.open ?? openBrowser)(file!)
  actions.toast(`Opened ${label} in the default app — after saving there, press s to save it back (${file})`, 'info', 8000)
  return true
}

export type SaveBackOutcome = 'written' | 'unchanged' | 'discarded' | 'failed'

export async function saveBackExternal(deps: ExternalDeps, target: FileTarget): Promise<SaveBackOutcome> {
  const { client, actions, agentId, agentLabel } = deps
  const label = targetLabel(target)
  const copy = externalCopy(agentId, target)
  if (!copy) {
    actions.toast(`${label} is not open in an app — press o to open it`, 'warn')
    return 'failed'
  }

  let edited: Buffer
  try {
    edited = await fs.readFile(copy.file)
  } catch (err) {
    actions.toast(`Cannot read ${copy.file}: ${errorText(err)} — nothing written`, 'error', 12_000)
    return 'failed'
  }
  if (edited.equals(copy.original)) {
    copy.mtimeMs = (await fs.stat(copy.file)).mtimeMs
    actions.toast(`No changes to ${label}`, 'info')
    return 'unchanged'
  }

  // Re-fetch: did the agent (or anyone) change it since the copy was made?
  let concurrent: string | null = null
  try {
    const current = await loadTarget(client, agentId, target)
    if (!bytesOf(current).equals(copy.original)) concurrent = 'changed in the agent since you opened it'
  } catch (err) {
    const status = (err as { status?: number | null }).status
    concurrent = status === 404 ? 'was deleted since you opened it' : `could not be re-checked (${errorText(err)})`
  }

  const ok = await actions.confirm({
    title: concurrent ? `Concurrent change: ${label}` : `Save ${label}`,
    message: [
      concurrent ? `WARNING: ${label} ${concurrent}. Writing replaces that version.` : null,
      `Write ${label} in ${agentLabel}: ${formatBytes(copy.original.length)} -> ${formatBytes(edited.length)}`,
    ].filter(Boolean).join('\n'),
    confirmLabel: concurrent ? 'Overwrite' : 'Write',
    cancelLabel: 'Cancel',
    danger: !!concurrent,
  })
  if (!ok) return 'discarded'

  const written = await actions.run(`Write ${label}`, c => (copy.binary && target.kind === 'file'
    ? c.writeFile(agentId, target.path, { contentBase64: edited.toString('base64'), ...(copy.mime ? { mimeType: copy.mime } : {}) })
    : writeTarget(c, agentId, target, edited.toString('utf-8'))
  ).then(() => true))
  if (!written) {
    actions.toast(`Write failed. Your copy is still at ${copy.file}`, 'error', 12_000)
    return 'failed'
  }
  copy.original = edited
  copy.mtimeMs = (await fs.stat(copy.file)).mtimeMs
  actions.toast(`Saved ${label} from the app`, 'success')
  return 'written'
}
