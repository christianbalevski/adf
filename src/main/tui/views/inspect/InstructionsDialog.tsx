// /instructions: edit the agent's instructions in place (Enter is a newline,
// Ctrl+S saves, Ctrl+O hands the text to $EDITOR and back, Esc cancels and asks
// when there are unsaved changes). Props `editor: true` (Settings `e`,
// `/instructions edit`) goes straight to $EDITOR and saves on return. Saving
// re-reads the config first and asks before overwriting instructions that
// changed on the daemon meanwhile (settings-ops.ts saveInstructions).

import { useEffect, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { TextInput } from '../../ui/TextInput'
import { Modal } from '../../ui/Modal'
import { editorLabel } from '../../util/editor'
import type { OverlayProps } from '../types'
import { editInstructionsExternally, saveInstructions } from './settings-ops'
import { isLocked, INSTRUCTIONS_LOCK_KEYS } from './settings-model'

export function InstructionsOverlay({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { actions } = store
  const { suspendTerminal } = useApp()
  const agentId = String(overlay.props?.agentId ?? '')
  const external = overlay.props?.editor === true
  const who = store.getState().agents[agentId]?.summary.handle || store.getState().agents[agentId]?.summary.name || agentId
  const [original, setOriginal] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState<string | null>(external ? `editing in ${editorLabel()}…` : null)
  const closed = useRef(false)
  const done = () => { if (!closed.current) { closed.current = true; close() } }

  const openEditor = async (from: string) => {
    setBusy(`editing in ${editorLabel()}…`)
    const edited = await editInstructionsExternally(actions, who, from, suspendTerminal)
    setBusy(null)
    return edited ?? null
  }

  useEffect(() => {
    void (async () => {
      const fresh = await actions.run('Instructions', c => c.config(agentId))
      if (!fresh) { done(); return }
      const current = fresh.config.instructions ?? ''
      setOriginal(current)
      setText(current)
      setLocked(isLocked(fresh.config, INSTRUCTIONS_LOCK_KEYS))
      if (!external) return
      const edited = await openEditor(current)
      if (edited === null) { done(); return }
      if (edited === current) { actions.toast('Instructions unchanged, nothing saved', 'info', 2000); done(); return }
      setBusy('saving…')
      const saved = await saveInstructions(actions, agentId, who, current, edited)
      setBusy(null)
      if (saved) done()
      else setText(edited) // keep the edit in the dialog: nothing typed is lost
    })()
  }, [])

  const save = async () => {
    if (original === null || busy) return
    setBusy('saving…')
    const saved = await saveInstructions(actions, agentId, who, original, text)
    setBusy(null)
    if (saved || text === original) done()
  }

  const cancel = async () => {
    if (busy) return
    if (original !== null && text !== original) {
      const discard = await actions.confirm({ title: 'Discard your changes?', message: 'The instructions were edited but not saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
      if (!discard) return
    }
    done()
  }

  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { void cancel(); return true }
    return false
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(40, Math.min(width - 4, 110))
  const rows = Math.max(3, Math.min(24, height - 12))
  const lines = text ? text.split('\n').length : 0
  return (
    <Modal
      title={`Instructions ${theme.glyph.sep} ${who}${busy ? ` ${theme.glyph.sep} ${busy}` : ''}`}
      width={dialogWidth}
      hints={[{ keys: 'ctrl+s', label: 'save' }, { keys: 'enter', label: 'newline' }, { keys: 'ctrl+o', label: '$EDITOR' }, { keys: 'esc', label: 'cancel' }]}
    >
      <Text color={theme.color.muted} wrap="truncate-end">
        The agent’s own text, always in its system prompt. {'{{path}}'} placeholders resolve to workspace files.
      </Text>
      {locked ? <Text color={theme.color.warn} wrap="truncate-end">Locked for the agent (its sys_update_config cannot change them); you still can.</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {original === null ? <Text color={theme.color.dim}>Loading…</Text> : (
          <TextInput
            value={text}
            onChange={setText}
            onSubmit={() => false}
            focused={!busy}
            keyLayer="overlay"
            maxRows={rows}
            prompt=""
            placeholder="No instructions yet. Type them here."
            onKey={(input, key, api) => {
              if (key.ctrl && input === 's') { void save(); return true }
              if (key.ctrl && input === 'o') {
                void openEditor(api.value).then(edited => { if (edited !== null) setText(edited) })
                return true
              }
              if (key.return && !key.shift && !key.meta) { api.insert('\n'); return true }
              return false
            }}
          />
        )}
      </Box>
      <Text color={theme.color.dim} wrap="truncate-end">{lines} line{lines === 1 ? '' : 's'}, {text.length} chars{original !== null && text !== original ? ` ${theme.glyph.sep} unsaved` : ''}</Text>
    </Modal>
  )
}
