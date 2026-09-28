import { useState } from 'react'
import { Text } from 'ink'
import { useTheme } from '../../app/theme'
import { Modal } from '../../ui/Modal'
import { TextInput } from '../../ui/TextInput'
import type { OverlayProps } from '../types'
import { resolveAsk, type AskTextOptions } from './state'

/** One-line text dialog (new file path, rename target). Enter accepts, Esc cancels. */
export function InputDialog({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const options = (overlay.props ?? {}) as unknown as AskTextOptions
  const [value, setValue] = useState(options.initial ?? '')
  const finish = (result: string | null) => {
    resolveAsk(overlay.id, result)
    close()
  }
  return (
    <Modal
      title={options.title}
      width={Math.min(width - 4, 72)}
      hints={[{ keys: 'enter', label: 'ok' }, { keys: 'esc', label: 'cancel' }]}
      onClose={() => finish(null)}
    >
      <Text color={theme.color.muted}>{options.label}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={text => { finish(text); return true }}
        focused
        keyLayer="overlay"
        maxRows={1}
        onKey={(input, key) => {
          if (key.ctrl && input === 'c') { finish(null); return true }
          return false
        }}
      />
      {options.hint ? <Text color={theme.color.dim} wrap="wrap">{options.hint}</Text> : null}
    </Modal>
  )
}
