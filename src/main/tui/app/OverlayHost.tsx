import type { ComponentType } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from './theme'
import { useShell } from './shell-context'
import { HelpOverlay, Palette } from './palette'
import { useStore } from '../state/store'
import { useTopOverlay } from '../state/hooks'
import { Confirm, Modal } from '../ui/Modal'
import type { OverlayProps } from '../views/types'
import { IdentityDialog } from '../identity/IdentityDialog'
import { NewAgentDialog } from '../identity/NewAgentDialog'
import { IDENTITY_OVERLAY, NEW_AGENT_OVERLAY } from '../identity/model'
import { AuthDialog } from '../auth/AuthDialog'
import { AUTH_OVERLAY } from '../auth/model'
import { TERMINAL_SETUP_OVERLAY, TerminalSetupDialog } from './terminal-setup'

export { SHELL_KEYS } from './shell-keys'

function ConfirmOverlay({ overlay }: OverlayProps) {
  const store = useStore()
  const p = (overlay.props ?? {}) as { title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
  return (
    <Confirm
      title={p.title ?? 'Confirm'}
      message={p.message ?? ''}
      confirmLabel={p.confirmLabel}
      cancelLabel={p.cancelLabel}
      danger={p.danger}
      onResolve={confirmed => store.resolveConfirm(overlay.id, confirmed)}
    />
  )
}

function Unknown({ overlay, close }: OverlayProps) {
  const theme = useTheme()
  return (
    <Modal title="Unknown dialog" onClose={close} hints={[{ keys: 'esc', label: 'close' }]}>
      <Text color={theme.color.warn}>No view registers an overlay of kind "{overlay.kind}".</Text>
    </Modal>
  )
}

const BUILTIN_OVERLAYS: Record<string, ComponentType<OverlayProps>> = {
  palette: Palette,
  help: HelpOverlay,
  confirm: ConfirmOverlay,
  [IDENTITY_OVERLAY]: IdentityDialog,
  [NEW_AGENT_OVERLAY]: NewAgentDialog,
  [AUTH_OVERLAY]: AuthDialog,
  [TERMINAL_SETUP_OVERLAY]: TerminalSetupDialog,
}

/** Renders the topmost overlay centered over the body. Built-ins + view-registered kinds. */
export function OverlayHost({ width, height }: { width: number; height: number }) {
  const store = useStore()
  const { views } = useShell()
  const overlay = useTopOverlay()
  if (!overlay) return null
  const close = () => store.actions.popOverlay(overlay.id)
  let Component = BUILTIN_OVERLAYS[overlay.kind]
  if (!Component) {
    for (const view of views) {
      const found = view.overlays?.[overlay.kind]
      if (found) { Component = found; break }
    }
  }
  const Render = Component ?? Unknown
  return (
    <Box position="absolute" top={0} left={0} width={width} height={height} alignItems="center" justifyContent="center">
      <Render key={overlay.id} overlay={overlay} close={close} width={width} height={height} />
    </Box>
  )
}
