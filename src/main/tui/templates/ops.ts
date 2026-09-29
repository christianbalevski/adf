// /templates: opener and the $EDITOR flows (instructions, seed files, the
// config as JSON). Writes go through the daemon's /templates routes, the same
// AgentTemplatesService Studio's template editor uses. Every outcome is a
// toast; nothing is written without a change, and an invalid config offers
// to reopen the editor with the text as left.

import type { TuiStore, TuiActions } from '../state/store'
import type { AgentConfig } from '../api/types'
import { openIdentity } from '../identity/Onboarding'
import { editText, editorLabel, type EditResult } from '../util/editor'
import { changedKeysBetween, checkConfigText } from '../views/inspect/config-edit'
import { SEED_FILES, TEMPLATES_OVERLAY, type SeedKey, type TemplatesOverlayProps } from './model'

type Store = Pick<TuiStore, 'actions' | 'getState'>
export type Suspend = (run: () => void | Promise<void>) => Promise<void>
export type Editor = (text: string, filename: string) => Promise<EditResult>
export type EditOutcome = 'saved' | 'unchanged' | 'discarded' | 'failed'

const defaultEditor: Editor = (text, filename) => editText(text, { filename })

/** Opens the templates dialog, or the identity dialog first when the owner identity is not ready. */
export function openTemplates(store: Store, props: TemplatesOverlayProps = {}): void {
  const identity = store.getState().identity
  if (identity && identity.status !== 'ready') {
    openIdentity(store, { mode: 'status', then: TEMPLATES_OVERLAY, thenProps: { ...props }, reason: 'Templates are sealed under your owner identity: set it up or unlock it first, then the templates follow.' })
    return
  }
  store.actions.pushOverlay({ kind: TEMPLATES_OVERLAY, props: { ...props } })
}

async function runEditor(actions: TuiActions, suspend: Suspend, edit: Editor, text: string, filename: string): Promise<EditResult | null> {
  let result: EditResult = { text: null, changed: false, editor: editorLabel() }
  await suspend(async () => { result = await edit(text, filename) })
  if (result.text === null) {
    actions.toast(`Editor ${result.editor}: ${result.error ?? 'failed'}. Set EDITOR (or ADF_EDITOR) to your editor.`, 'error')
    return null
  }
  return result
}

/** config.instructions in $EDITOR, then PUT the fresh config with only that field changed. */
export async function editTemplateInstructions(actions: TuiActions, suspend: Suspend, id: string, edit: Editor = defaultEditor): Promise<EditOutcome> {
  const detail = await actions.run('Open template', c => c.templateDetail(id))
  if (!detail) return 'failed'
  const before = detail.contents.config.instructions ?? ''
  actions.toast(`Editing the instructions of ${detail.template?.name ?? id}: save and close the editor to continue`, 'info')
  const result = await runEditor(actions, suspend, edit, before, `${id}.instructions.md`)
  if (!result) return 'failed'
  const text = result.text!.replace(/\r\n/g, '\n')
  if (text === before.replace(/\r\n/g, '\n')) { actions.toast('Instructions unchanged, nothing saved', 'info'); return 'unchanged' }
  // Re-read: another client may have changed other fields meanwhile.
  const fresh = await actions.run('Re-check template', c => c.templateDetail(id))
  if (!fresh) return 'failed'
  const saved = await actions.run('Save instructions', c => c.putTemplateConfig(id, { ...fresh.contents.config, instructions: text } as AgentConfig))
  if (!saved) return 'failed'
  actions.toast(`Instructions of ${fresh.template?.name ?? id} saved`, 'success')
  return 'saved'
}

/** A seed file (README.md, mind.md, soul.md) in $EDITOR, then PUT it. */
export async function editTemplateSeedFile(actions: TuiActions, suspend: Suspend, id: string, key: SeedKey, edit: Editor = defaultEditor): Promise<EditOutcome> {
  const file = SEED_FILES.find(f => f.key === key)!
  const detail = await actions.run('Open template', c => c.templateDetail(id))
  if (!detail) return 'failed'
  const before = detail.contents.files[key] ?? ''
  actions.toast(`Editing ${file.path} of ${detail.template?.name ?? id}: save and close the editor to continue`, 'info')
  const result = await runEditor(actions, suspend, edit, before, `${id}.${file.path}`)
  if (!result) return 'failed'
  const text = result.text!
  if (text.replace(/\r\n/g, '\n') === before.replace(/\r\n/g, '\n')) { actions.toast(`${file.path} unchanged, nothing saved`, 'info'); return 'unchanged' }
  const saved = await actions.run(`Save ${file.path}`, c => c.putTemplateFile(id, file.path, text))
  if (!saved) return 'failed'
  actions.toast(`${file.path} of ${detail.template?.name ?? id} saved`, 'success')
  return 'saved'
}

/** The whole config as JSON in $EDITOR: validate with the config schema, confirm the changed keys, PUT. */
export async function editTemplateConfig(actions: TuiActions, suspend: Suspend, id: string, edit: Editor = defaultEditor): Promise<EditOutcome> {
  const detail = await actions.run('Open template', c => c.templateDetail(id))
  if (!detail) return 'failed'
  const original = detail.contents.config as AgentConfig
  const label = detail.template?.name ?? id
  let text = `${JSON.stringify(original, null, 2)}\n`
  for (;;) {
    const result = await runEditor(actions, suspend, edit, text, `${id}.config.json`)
    if (!result) return 'failed'
    if (!result.changed) { actions.toast('Config unchanged, nothing saved', 'info'); return 'unchanged' }
    const check = await checkConfigText(result.text!, original)
    if (!check.ok) {
      const again = await actions.confirm({
        title: 'Config is invalid',
        message: `${check.errors.join('\n')}\n\nEdit again? Discard drops your edit.`,
        confirmLabel: 'Edit again',
        cancelLabel: 'Discard',
        danger: true,
      })
      if (!again) { actions.toast('Config edit discarded', 'warn'); return 'discarded' }
      text = result.text!
      continue
    }
    if (check.changedKeys.length === 0) { actions.toast('Config unchanged (formatting only), nothing saved', 'info'); return 'unchanged' }
    const fresh = await actions.run('Re-check template', c => c.templateDetail(id))
    if (!fresh) return 'failed'
    const theirs = changedKeysBetween(original, fresh.contents.config)
    const save = await actions.confirm({
      title: `Save config of the ${label} template?`,
      message: `Changed: ${check.changedKeys.join(', ')}${theirs.length ? `\nChanged on the daemon while you edited (saving reverts them): ${theirs.join(', ')}` : ''}${check.warnings.length ? `\nWarning: ${check.warnings.join('; ')}` : ''}\n\n${'New agents made from it start with this config.'}`,
      confirmLabel: 'Save',
      cancelLabel: 'Discard',
      danger: theirs.length > 0 || check.warnings.length > 0,
    })
    if (!save) { actions.toast('Config edit discarded', 'warn'); return 'discarded' }
    const saved = await actions.run('Save template config', c => c.putTemplateConfig(id, check.config))
    if (!saved) return 'failed'
    actions.toast(`Config of the ${label} template saved (${check.changedKeys.join(', ')})`, 'success')
    return 'saved'
  }
}
