// Edit a file target in the user's $VISUAL / $EDITOR: temp copy → hand the
// terminal to the editor (ink's suspendTerminal) → diff-summary confirm →
// re-fetch to detect a concurrent change → write back. The temp copy is kept
// whenever the edit is not written, so no keystroke is ever lost.

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { DaemonClient } from '../../api/client'
import type { TuiActions } from '../../state/store'
import { resolveEditor, runEditorProcess } from '../../util/editor'
import { loadTarget, writeTarget } from './io'
import { describeDiff, targetFileName, targetLabel, type FileTarget } from './model'

export interface EditDeps {
  client: DaemonClient
  actions: TuiActions
  agentId: string
  agentLabel: string
  /** ink's `useApp().suspendTerminal`: releases raw mode + screen, restores and redraws after. */
  suspend: (run: () => Promise<void>) => Promise<void>
  env?: NodeJS.ProcessEnv
}

export interface EditOptions {
  /** Create a new file (the target must not exist yet). */
  create?: boolean
}

export type EditOutcome = 'written' | 'unchanged' | 'discarded' | 'failed'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export async function editTarget(deps: EditDeps, target: FileTarget, options: EditOptions = {}): Promise<EditOutcome> {
  const { client, actions, agentId, agentLabel } = deps
  const label = targetLabel(target)
  const env = deps.env ?? process.env

  let original = ''
  if (!options.create) {
    const loaded = await actions.run(`Open ${label}`, c => loadTarget(c, agentId, target))
    if (!loaded) return 'failed'
    if (loaded.binary || loaded.text === undefined) {
      actions.toast(`${label} is binary — editing binary files is not supported`, 'warn')
      return 'failed'
    }
    original = loaded.text
  }

  let dir: string
  let file: string
  try {
    dir = await fs.mkdtemp(join(tmpdir(), 'adf-tui-edit-'))
    file = join(dir, targetFileName(target))
    await fs.writeFile(file, original, 'utf-8')
  } catch (err) {
    actions.toast(`Cannot prepare a temp copy of ${label} in ${tmpdir()}: ${errorText(err)}`, 'error', 12_000)
    return 'failed'
  }
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)

  const editor = resolveEditor(env)
  actions.toast(`Editing ${label} of ${agentLabel} in ${basename(editor[0])} — save and close the editor to continue`, 'info')
  const exit: { code: number | null } = { code: null }
  try {
    await deps.suspend(async () => { exit.code = await runEditorProcess(editor, file, env) })
  } catch (err) {
    await cleanup()
    actions.toast(`Could not start editor "${editor.join(' ')}": ${err instanceof Error ? err.message : String(err)} (set $VISUAL or $EDITOR)`, 'error')
    return 'failed'
  }
  if (exit.code !== 0 && exit.code !== null) {
    actions.toast(`Editor exited with code ${exit.code} — nothing written. Your copy: ${file}`, 'warn', 12_000)
    return 'discarded'
  }

  let edited: string
  try {
    edited = await fs.readFile(file, 'utf-8')
  } catch (err) {
    actions.toast(`Cannot read the edited copy ${file} (moved or deleted in the editor?): ${errorText(err)} — nothing written`, 'error', 12_000)
    return 'failed'
  }
  if (original.charCodeAt(0) !== 0xfeff) edited = stripBom(edited)
  if (edited === original && !options.create) {
    await cleanup()
    actions.toast(`No changes to ${label}`, 'info')
    return 'unchanged'
  }

  // Re-fetch: did the agent (or anyone) change it while the editor was open?
  let concurrent: string | null = null
  if (options.create) {
    if (target.kind === 'file') {
      const list = await client.files(agentId).catch(() => null)
      if (list?.files.some(f => f.path === target.path)) concurrent = 'was created by someone else while you were editing'
    }
  } else {
    try {
      const current = await loadTarget(client, agentId, target)
      if (current.text !== original) {
        const theirs = describeDiff(original, current.text ?? '', 0)
        concurrent = `changed while you were editing (their change: ${theirs.summary})`
      }
    } catch (err) {
      const status = (err as { status?: number | null }).status
      concurrent = status === 404 ? 'was deleted while you were editing' : `could not be re-checked (${err instanceof Error ? err.message : String(err)})`
    }
  }

  const diff = describeDiff(original, edited)
  const message = [
    concurrent ? `WARNING: ${label} ${concurrent}. Writing replaces that version.` : null,
    `${options.create ? 'Create' : 'Write'} ${label} in ${agentLabel}: ${diff.summary}`,
    ...diff.lines,
  ].filter((line): line is string => line !== null).join('\n')

  const ok = await actions.confirm({
    title: concurrent ? `Concurrent change: ${label}` : `${options.create ? 'Create' : 'Save'} ${label}`,
    message,
    confirmLabel: concurrent ? 'Overwrite' : options.create ? 'Create' : 'Write',
    cancelLabel: 'Discard',
    danger: !!concurrent,
  })
  if (!ok) {
    actions.toast(`Not written. Your edited copy is kept at ${file}`, 'warn', 12_000)
    return 'discarded'
  }
  const written = await actions.run(`Write ${label}`, c => writeTarget(c, agentId, target, edited).then(() => true))
  if (!written) {
    actions.toast(`Write failed. Your edited copy is kept at ${file}`, 'error', 12_000)
    return 'failed'
  }
  await cleanup()
  actions.toast(`${options.create ? 'Created' : 'Saved'} ${label} (${diff.summary})`, 'success')
  return 'written'
}
