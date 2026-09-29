// A credential save the daemon refused because the agent's credentials
// envelope is locked there (409 credentials_locked). The owner either
// unlocks (identity flow, the setup resumes after) or explicitly replaces
// the unreadable saved value (confirmed: the old value is discarded).
// Shared by the channel and MCP dialogs; the typed secrets stay in the
// calling dialog's component state.

import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { Modal } from '../ui/Modal'
import type { CredentialMeta } from '../api/types'

export function lockedCredentialMessage(name: string): string {
  return `This agent's saved ${name} is locked and can't be read (identity not unlocked). Unlock first (/identity), or replace it — the old value is discarded.`
}

/** Edit-form placeholder for one stored field: never the value. `fallback` when nothing is known (older daemon). */
export function credentialPlaceholder(meta: Record<string, CredentialMeta> | null | undefined, key: string, fallback: string): string {
  if (!meta) return fallback
  const entry = meta[key]
  if (!entry?.present) return 'not set'
  return entry.locked ? 'set • locked · type to replace' : 'set • (hidden) · type to replace'
}

export interface LockedCredentialProps {
  name: string
  title: string
  width: number
  confirming: boolean
  onUnlock: () => void
  onReplace: () => void
  onConfirm: (confirmed: boolean) => void
  onCancel: () => void
}

export function LockedCredential({ name, title, width, confirming, onUnlock, onReplace, onConfirm, onCancel }: LockedCredentialProps) {
  const theme = useTheme()
  useKeys((input, key) => {
    const cancel = key.escape || (key.ctrl && input === 'c')
    if (confirming) {
      if (input === 'y' || input === 'Y' || key.return) { onConfirm(true); return true }
      if (input === 'n' || input === 'N' || cancel) { onConfirm(false); return true }
      return true
    }
    if (input === 'u' || input === 'U') { onUnlock(); return true }
    if (input === 'r' || input === 'R') { onReplace(); return true }
    if (input === 'c' || input === 'C' || cancel) { onCancel(); return true }
    return true
  }, { layer: 'overlay' })
  return (
    <Modal
      title={title}
      width={width}
      hints={confirming
        ? [{ keys: 'y enter', label: 'Replace' }, { keys: 'n esc', label: 'Back' }]
        : [{ keys: 'u', label: 'Unlock' }, { keys: 'r', label: 'Replace' }, { keys: 'c esc', label: 'Cancel' }]}
    >
      <Text color={theme.color.warn} wrap="wrap">{theme.glyph.cross} {lockedCredentialMessage(name)}</Text>
      {confirming
        ? <Box marginTop={1}><Text color={theme.color.error} wrap="wrap">Replace the saved {name}? The old value is discarded unread; the new one is sealed once the identity unlocks.</Text></Box>
        : null}
    </Modal>
  )
}
