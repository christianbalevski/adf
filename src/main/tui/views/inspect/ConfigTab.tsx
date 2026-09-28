import { useEffect, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions } from '../../state/store'
import { useAgent } from '../../state/hooks'
import type { AgentConfig } from '../../api/types'
import type { TuiActions } from '../../state/store'
import { LinesView } from './LinesView'
import { valueLines } from './format'
import { useInspectState } from './state'
import { editText, editorLabel, type EditResult } from '../../util/editor'
import { changedKeysBetween, checkConfigText } from './config-edit'

type Suspend = (callback: () => void | Promise<void>) => Promise<void>

/**
 * Edit loop: $EDITOR → JSON + schema validation → confirm the changed keys →
 * PUT. An invalid edit offers to reopen the editor with the text as left, so
 * nothing typed is lost silently.
 */
export async function editConfigFlow(agentId: string, label: string, actions: TuiActions, suspend: Suspend, edit: (text: string) => Promise<EditResult> = text => editText(text, { filename: `${label}.config.json` })): Promise<'saved' | 'unchanged' | 'discarded' | 'failed'> {
  const original = await actions.loadConfig(agentId)
  if (!original) return 'failed'
  let text = `${JSON.stringify(original, null, 2)}\n`
  for (;;) {
    let result: EditResult = { text: null, changed: false, editor: editorLabel() }
    await suspend(async () => { result = await edit(text) })
    if (result.text === null) {
      actions.toast(`Editor ${result.editor}: ${result.error ?? 'failed'}. Set EDITOR (or ADF_EDITOR) to your editor.`, 'error')
      return 'failed'
    }
    if (!result.changed) {
      actions.toast('Config unchanged, nothing saved', 'info')
      return 'unchanged'
    }
    const check = await checkConfigText(result.text, original)
    if (!check.ok) {
      const again = await actions.confirm({
        title: 'Config is invalid',
        message: `${check.errors.join('\n')}\n\nEdit again? Discard drops your edit.`,
        confirmLabel: 'Edit again',
        cancelLabel: 'Discard',
        danger: true,
      })
      if (!again) { actions.toast('Config edit discarded', 'warn'); return 'discarded' }
      text = result.text
      continue
    }
    if (check.changedKeys.length === 0) {
      actions.toast('Config unchanged (formatting only), nothing saved', 'info')
      return 'unchanged'
    }
    // Re-fetch: the agent (loop_manage), the Loops/Triggers tabs or another
    // client may have changed the config while the editor was open.
    const fresh = await actions.run('Re-check config', c => c.config(agentId).then(r => r.config))
    if (!fresh) return 'failed'
    const theirs = changedKeysBetween(original, fresh)
    if (theirs.length > 0) {
      const overwrite = await actions.confirm({
        title: `Config of ${label} changed on the daemon`,
        message: `While you were editing, these keys changed on the daemon: ${theirs.join(', ')}.\nSaving your copy reverts them${theirs.includes('loops') ? ' (a loop added meanwhile would be removed and archived)' : ''}.\nYou changed: ${check.changedKeys.join(', ')}.${check.warnings.length ? `\nWarning: ${check.warnings.join('; ')}` : ''}`,
        confirmLabel: 'Overwrite',
        cancelLabel: 'Discard',
        danger: true,
      })
      if (!overwrite) { actions.toast('Config edit discarded (the daemon copy changed meanwhile)', 'warn'); return 'discarded' }
    }
    if (changedKeysBetween(fresh, check.config).length === 0) { actions.toast('Config already matches the daemon, nothing saved', 'info'); return 'unchanged' }
    const save = theirs.length > 0 || await actions.confirm({
      title: `Save config of ${label}?`,
      message: `Changed: ${check.changedKeys.join(', ')}${check.warnings.length ? `\nWarning: ${check.warnings.join('; ')}` : ''}`,
      confirmLabel: 'Save',
      cancelLabel: 'Discard',
      danger: check.warnings.length > 0,
    })
    if (!save) { actions.toast('Config edit discarded', 'warn'); return 'discarded' }
    const saved = await actions.run('Save config', c => c.putConfig(agentId, check.config as AgentConfig))
    if (!saved) return 'failed'
    actions.toast(`Config of ${label} saved (${check.changedKeys.join(', ')})`, 'success')
    await actions.loadConfig(agentId)
    return 'saved'
  }
}

export function ConfigTab({ agentId, label, width, height, focused }: { agentId: string; label: string; width: number; height: number; focused: boolean }) {
  const theme = useTheme()
  const actions = useActions()
  const { suspendTerminal } = useApp()
  const agent = useAgent(agentId)
  const [inspect, update] = useInspectState()
  const [busy, setBusy] = useState(false)
  const config = agent?.config

  const edit = () => {
    setBusy(true)
    void editConfigFlow(agentId, label, actions, suspendTerminal).finally(() => setBusy(false))
  }
  // /config edit: open the editor once per request.
  useEffect(() => {
    if (!inspect.editRequest || busy) return
    update({ editRequest: undefined })
    edit()
  }, [inspect.editRequest])

  useEffect(() => {
    if (!config) void actions.loadConfig(agentId)
  }, [agentId])

  useKeys((input, key) => {
    if (key.ctrl || key.meta || busy) return false
    if (input === 'e') { edit(); return true }
    if (input === 'r') { void actions.loadConfig(agentId).then(c => { if (c) actions.toast('Config reloaded', 'info', 1500) }); return true }
    return false
  }, { layer: 'main', active: focused })

  const loops = config?.loops ?? []
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end" color={theme.color.muted}>
        {config ? `${config.model?.provider ?? '?'}/${config.model?.model_id ?? '?'} ${theme.glyph.sep} loops: main${loops.length ? ` + ${loops.map(l => `${l.name}${l.enabled === false ? ' (off)' : ''}`).join(', ')}` : ' only'}` : 'loading config…'}
        {busy ? `  ${theme.glyph.sep} editing in ${editorLabel()}…` : ''}
      </Text>
      <LinesView
        lines={config ? valueLines(config, inspect.json) : []}
        width={width}
        height={Math.max(1, height - 2)}
        active={focused && !busy}
        emptyText="No config loaded."
      />
      <Text color={theme.color.dim} wrap="truncate-end">e edit in $EDITOR {theme.glyph.sep} r reload {theme.glyph.sep} /json raw JSON {theme.glyph.sep} up/down scroll</Text>
    </Box>
  )
}
