// Chat dialogs: deny-with-reason and full approval details.

import { useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { Modal } from '../../ui/Modal'
import { TextInput } from '../../ui/TextInput'
import type { OverlayProps } from '../types'
import { parseArgs, prettyJson } from './model'
import { taskReason } from './Dock'

export const DENY_OVERLAY = 'chat.deny'
export const DETAILS_OVERLAY = 'chat.approval'

interface TaskOverlayProps {
  agentId: string
  taskId: string
  tool: string
}

function taskProps(props: OverlayProps): TaskOverlayProps {
  return (props.overlay.props ?? {}) as unknown as TaskOverlayProps
}

export function DenyOverlay(props: OverlayProps) {
  const theme = useTheme()
  const actions = useActions()
  const { agentId, taskId, tool } = taskProps(props)
  const [reason, setReason] = useState('')
  return (
    <Modal
      title={`Deny ${tool}`}
      width={Math.min(props.width - 4, 72)}
      onClose={props.close}
      hints={[{ keys: 'enter', label: 'deny' }, { keys: 'esc', label: 'cancel' }]}
    >
      <Text color={theme.color.muted}>Optional reason — the agent sees it as feedback:</Text>
      <Box borderStyle={theme.ascii ? 'classic' : 'single'} borderColor={theme.color.border} paddingX={1}>
        <TextInput
          value={reason}
          onChange={setReason}
          focused
          keyLayer="overlay"
          maxRows={3}
          placeholder="why not? (Enter to deny without a reason)"
          onSubmit={text => {
            props.close()
            void actions.resolveTask(agentId, taskId, 'deny', text.trim() || undefined)
          }}
        />
      </Box>
    </Modal>
  )
}

export function ApprovalDetailsOverlay(props: OverlayProps) {
  const theme = useTheme()
  const actions = useActions()
  const { agentId, taskId, tool } = taskProps(props)
  const agent = useAgent(agentId)
  const task = agent?.pendingTasks.find(t => t.id === taskId)
  const body = task ? prettyJson(parseArgs(task.args)) : '(no longer pending)'
  const dialogWidth = Math.min(props.width - 4, 96)
  const lines = body.split('\n').flatMap(line => chunk(line, Math.max(8, dialogWidth - 4)))
  const room = Math.max(4, props.height - 12)
  const [top, setTop] = useState(0)
  const maxTop = Math.max(0, lines.length - room)

  useKeys((input, key) => {
    if (key.escape) { props.close(); return true }
    if (input === 'y' && task) { props.close(); void actions.resolveTask(agentId, taskId, 'approve'); return true }
    if (input === 'n' && task) { props.close(); actions.pushOverlay({ kind: DENY_OVERLAY, props: { agentId, taskId, tool } }); return true }
    if (key.downArrow || input === 'j') { setTop(t => Math.min(maxTop, t + 1)); return true }
    if (key.upArrow || input === 'k') { setTop(t => Math.max(0, t - 1)); return true }
    if (key.pageDown) { setTop(t => Math.min(maxTop, t + room)); return true }
    if (key.pageUp) { setTop(t => Math.max(0, t - room)); return true }
    return true
  }, { layer: 'overlay' })

  const reason = task ? taskReason(task) : undefined
  return (
    <Modal
      title={`Approval · ${tool}`}
      width={dialogWidth}
      hints={task ? [{ keys: 'y', label: 'approve' }, { keys: 'n', label: 'deny' }, { keys: 'up down', label: 'scroll' }, { keys: 'esc', label: 'close' }] : [{ keys: 'esc', label: 'close' }]}
    >
      <Text color={theme.color.muted} wrap="truncate-end">task {taskId}{task?.origin ? ` · from ${task.origin}` : ''}</Text>
      {reason ? <Text color={theme.color.warn} wrap="wrap">{reason}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {lines.slice(top, top + room).map((line, i) => <Text key={top + i} color={theme.color.text}>{line || ' '}</Text>)}
      </Box>
      {lines.length > room ? <Text color={theme.color.dim}>lines {top + 1}-{Math.min(lines.length, top + room)} of {lines.length}</Text> : null}
    </Modal>
  )
}

function chunk(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width))
  return out
}
