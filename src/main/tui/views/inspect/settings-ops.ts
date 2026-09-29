// Settings writes. Each one re-reads the config right before writing, applies
// its change to that fresh copy (only the edited fields move), PUTs it and
// reloads the store's copy. Writes run one at a time (a burst of Space presses
// is a queue, never two PUTs racing over the same base). Every outcome is a
// toast; the daemon's refusals come back as error toasts via actions.run.

import type { AgentConfig } from '../../api/types'
import type { TuiActions } from '../../state/store'
import { editText, editorLabel, type EditResult } from '../../util/editor'
import { setInstructions, type Change } from './settings-model'

let queue: Promise<unknown> = Promise.resolve()

function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Re-read, apply, PUT, reload. Resolves true when the daemon took the change. */
export function applyChange(actions: TuiActions, agentId: string, change: (fresh: AgentConfig) => Change, label = 'Settings'): Promise<boolean> {
  return serial(async () => {
    const fresh = await actions.run(label, c => c.config(agentId))
    if (!fresh) return false
    const result = change(fresh.config)
    if (!result.ok) { actions.toast(result.error, 'warn'); return false }
    if (same(result.config, fresh.config)) { actions.toast('Already set, nothing saved', 'info', 2000); return false }
    const saved = await actions.run(label, c => c.putConfig(agentId, result.config))
    if (!saved) return false
    await actions.loadConfig(agentId)
    actions.toast(result.message, 'success', 2500)
    return true
  })
}

/**
 * Save edited instructions. `original` is the text the editor opened with; if
 * the daemon's copy moved since (the agent's sys_update_config, Studio, another
 * client), ask before overwriting it.
 */
export async function saveInstructions(actions: TuiActions, agentId: string, label: string, original: string, text: string): Promise<boolean> {
  if (text === original) { actions.toast('Instructions unchanged, nothing saved', 'info', 2000); return false }
  const fresh = await actions.run('Instructions', c => c.config(agentId))
  if (!fresh) return false
  const theirs = fresh.config.instructions ?? ''
  if (theirs !== original && theirs !== text) {
    const overwrite = await actions.confirm({
      title: `Instructions of ${label} changed on the daemon`,
      message: 'While you were editing, the instructions changed on the daemon (the agent, Studio or another client). Saving replaces them with your text.',
      confirmLabel: 'Overwrite',
      cancelLabel: 'Keep theirs',
      danger: true,
    })
    if (!overwrite) { actions.toast('Instructions edit discarded (the daemon copy changed meanwhile)', 'warn'); return false }
  }
  return applyChange(actions, agentId, cfg => setInstructions(cfg, text), 'Instructions')
}

type Suspend = (callback: () => void | Promise<void>) => Promise<void>

/** $EDITOR round trip for the instructions: returns the edited text, or null (reported). */
export async function editInstructionsExternally(actions: TuiActions, label: string, text: string, suspend: Suspend, edit: (text: string) => Promise<EditResult> = t => editText(t, { filename: `${label}.instructions.md` })): Promise<string | null> {
  let result: EditResult = { text: null, changed: false, editor: editorLabel() }
  await suspend(async () => { result = await edit(text) })
  if (result.text === null) {
    actions.toast(`Editor ${result.editor}: ${result.error ?? 'failed'}. Set EDITOR (or ADF_EDITOR) to your editor.`, 'error')
    return null
  }
  // Editors add a final newline; the instructions never had one unless typed.
  return result.changed ? result.text.replace(/\r?\n$/, '') : text
}
