// One-off owner message into a loop. POST /chat with `loop` appends it to that
// loop's stream and queues a turn there (the wake), without leaving this view.

import { useState } from 'react'
import { Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useActions, useStore, type TuiActions } from '../../state/store'
import { useLoop } from '../../state/hooks'
import { Modal } from '../../ui/Modal'
import { Form, type FormValues } from './Form'
import { agentName } from './common'
import type { OverlayProps } from '../types'

export interface SendDialogProps {
  agentId: string
  loop: string
  text?: string
}

export async function sendToLoop(actions: TuiActions, agentId: string, loop: string, text: string, agentLabel: string): Promise<boolean> {
  const ok = await actions.sendChat(text, { agentId, loop })
  if (ok) actions.toast(`Sent to ${agentLabel} ${loop}: turn queued (its reply is in the ${loop} transcript)`, 'success')
  else actions.toast(`Not sent to ${loop}: see the error in the ${loop} transcript`, 'error')
  return ok
}

export function SendDialog({ overlay, close, width }: OverlayProps) {
  const props = (overlay.props ?? {}) as unknown as SendDialogProps
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const loop = useLoop(props.agentId, props.loop)
  const [values, setValues] = useState<FormValues>({ text: props.text ?? '' })
  const [error, setError] = useState<string | undefined>()
  const label = agentName(store.getState(), props.agentId)
  const dialogWidth = Math.max(40, Math.min(width - 4, 90))
  return (
    <Modal title={`Send to ${props.loop} ${theme.glyph.sep} ${label}`} width={dialogWidth} hints={[{ keys: 'enter', label: 'send & wake' }, { keys: 'esc', label: 'cancel' }]}>
      {loop && !loop.info.enabled ? <Text color={theme.color.warn}>{theme.glyph.warn} {props.loop} is disabled: the daemon refuses messages until it is enabled.</Text> : null}
      <Form
        fields={[{ kind: 'text', key: 'text', label: 'Message', placeholder: 'e.g. research the new pricing page', hint: 'delivered as an owner message; the loop runs a turn on it' }]}
        values={values}
        onChange={setValues}
        errors={{ text: error }}
        onSubmit={() => {
          const text = String(values.text ?? '').trim()
          if (!text) { setError('Type a message'); return }
          close()
          void sendToLoop(actions, props.agentId, props.loop, text, label)
        }}
        onCancel={close}
        width={dialogWidth - 4}
        height={4}
      />
    </Modal>
  )
}
