import { useRef, type ReactNode, type RefObject } from 'react'
import { Box, Text, useBoxMetrics, type DOMElement } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { KeyHints, type KeyHintSpec } from './KeyHint'

export interface ModalProps {
  title: string
  width?: number
  /** Hints on the bottom row. */
  hints?: KeyHintSpec[]
  children?: ReactNode
  /** Esc closes. Handled at the overlay layer, so it never reaches the view underneath. */
  onClose?: () => void
}

/**
 * A framed dialog. The overlay host centers it; keys go to the overlay layer.
 * Opaque: a blank layer is painted under the content so nothing from the
 * panes underneath (sidebar rule, transcript text) shows through empty rows.
 */
export function Modal({ title, width = 60, hints, children, onClose }: ModalProps) {
  const theme = useTheme()
  const ref = useRef<DOMElement>(null)
  const metrics = useBoxMetrics(ref as RefObject<DOMElement>)
  useKeys((_input, key) => {
    if (key.escape && onClose) { onClose(); return true }
    return false
  }, { layer: 'overlay', active: !!onClose })
  const fillWidth = Math.max(0, metrics.width - 2)
  const fillRows = Math.max(0, metrics.height - 2)
  return (
    <Box
      ref={ref}
      flexDirection="column"
      width={width}
      borderStyle={theme.ascii ? 'classic' : 'round'}
      borderColor={theme.color.borderFocus}
      backgroundColor={theme.color.overlay}
      paddingX={1}
    >
      {metrics.hasMeasured && fillWidth > 0 && fillRows > 0 ? (
        <Box position="absolute" top={0} left={0} width={fillWidth} height={fillRows} flexDirection="column">
          {Array.from({ length: fillRows }, (_, i) => <Text key={i} backgroundColor={theme.color.overlay}>{' '.repeat(fillWidth)}</Text>)}
        </Box>
      ) : null}
      <Text bold color={theme.color.accent} inverse={theme.mono}>{title}</Text>
      <Box flexDirection="column" marginTop={1}>{children}</Box>
      {hints && hints.length > 0 ? (
        <Box marginTop={1}><KeyHints hints={hints} /></Box>
      ) : null}
    </Box>
  )
}

export interface ConfirmProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onResolve: (confirmed: boolean) => void
  width?: number
}

/** Yes/no dialog: y/Enter confirms, n/Esc cancels. */
export function Confirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onResolve, width }: ConfirmProps) {
  const theme = useTheme()
  useKeys((input, key) => {
    if (key.return || input === 'y' || input === 'Y') { onResolve(true); return true }
    if (key.escape || input === 'n' || input === 'N' || (key.ctrl && input === 'c')) { onResolve(false); return true }
    return true
  }, { layer: 'overlay' })
  return (
    <Modal
      title={title}
      width={width}
      hints={[{ keys: 'y enter', label: confirmLabel }, { keys: 'n esc', label: cancelLabel }]}
    >
      <Text color={danger ? theme.color.warn : theme.color.text} wrap="wrap">{message}</Text>
    </Modal>
  )
}
