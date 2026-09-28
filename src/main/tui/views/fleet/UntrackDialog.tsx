// "Stop tracking" confirm with one choice: also unload the folder's agents
// (default: they keep running). y/Enter confirms, n/Esc cancels, u toggles.

import { useState } from 'react'
import { Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { Modal } from '../../ui/Modal'
import type { OverlayProps } from '../types'
import { untrackFolder } from './folders'

export function UntrackDialog({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const path = String((overlay.props as { path?: string } | undefined)?.path ?? '')
  const [unload, setUnload] = useState(false)
  useKeys((input, key) => {
    if (key.return || input === 'y' || input === 'Y') { close(); void untrackFolder(store, path, unload); return true }
    if (key.escape || input === 'n' || input === 'N' || (key.ctrl && input === 'c')) { close(); return true }
    if (input === 'u' || input === ' ') { setUnload(v => !v); return true }
    return true
  }, { layer: 'overlay' })
  return (
    <Modal
      title="Stop tracking folder"
      width={Math.max(40, Math.min(width - 4, 80))}
      hints={[{ keys: 'y enter', label: 'stop tracking' }, { keys: 'u', label: 'unload agents' }, { keys: 'n esc', label: 'cancel' }]}
    >
      <Text wrap="wrap">Stop tracking {path}? Files are not touched.</Text>
      <Text> </Text>
      <Text color={unload ? theme.color.warn : theme.color.muted}>[{unload ? theme.glyph.check : ' '}] also unload its agents{unload ? '' : ' (they keep running)'}</Text>
    </Modal>
  )
}
