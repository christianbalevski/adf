// Inspect: the selected agent under the hood. Tabs for its status (loops,
// triggers, WebSocket), config (edit in $EDITOR), usage by model, MCP
// servers, adapters, identity metadata, logs, tables and its own live
// events. Everything daemon-wide (status, sign-in, providers, network, every
// agent's events) is the Runtime view (6). Also hosts the /theme dialog.

import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useSelectedAgent, useSelectedAgentId, useSelectedLoop } from '../../state/hooks'
import { TabStrip } from '../../ui/Tabs'
import type { ViewDefinition, ViewProps } from '../types'
import { inspectCommands } from './commands'
import { TABS, readInspectState, useInspectState } from './state'
import { EventsTab } from './EventsTab'
import { ConfigTab } from './ConfigTab'
import { AdaptersTab, IdentityTab, LogsTab, McpTab, RuntimeTab, TablesTab, UsageTab } from './DiagTabs'
import { TasksTab } from './TasksTab'
import { ThemeOverlay } from './overlays'
import { MODEL_OVERLAY, ModelOverlay } from './model-picker'
import { EVENT_KEYS } from './event-keys'

function InspectView({ width: paneWidth, height, focused }: ViewProps) {
  // One column of air on each side, like the other views.
  const width = Math.max(10, paneWidth - 2)
  const theme = useTheme()
  const agentId = useSelectedAgentId()
  const agent = useSelectedAgent()
  const loop = useSelectedLoop()
  const [state, update] = useInspectState()
  const tab = state.tab

  useKeys((input, key) => {
    if (key.ctrl || key.meta || (key.shift && (key.leftArrow || key.rightArrow))) return false
    const at = TABS.findIndex(t => t.id === tab)
    if (key.rightArrow || input === ']') { update({ tab: TABS[(at + 1) % TABS.length].id }); return true }
    if (key.leftArrow || input === '[') { update({ tab: TABS[(at + TABS.length - 1) % TABS.length].id }); return true }
    return false
  }, { layer: 'view' })

  const bodyHeight = Math.max(1, height - 2)
  const label = agent ? agent.summary.handle || agent.summary.name : ''
  let body
  if (!agentId) body = <Text color={theme.color.muted} wrap="wrap">Select an agent (sidebar, /agent or Ctrl+K) to inspect it. Daemon-wide status, sign-in, providers and every agent’s events are in Runtime (6).</Text>
  else {
    const props = { agentId, width, height: bodyHeight, focused }
    switch (tab) {
      case 'events': body = <EventsTab width={width} height={bodyHeight} focused={focused} scope="agent" filters={state.events} update={events => update({ events })} json={state.json} />; break
      case 'config': body = <ConfigTab key={agentId} {...props} label={label} />; break
      case 'diag': body = <RuntimeTab key={agentId} {...props} />; break
      case 'usage': body = <UsageTab key={agentId} {...props} />; break
      case 'mcp': body = <McpTab key={agentId} {...props} />; break
      case 'adapters': body = <AdaptersTab key={agentId} {...props} />; break
      case 'identity': body = <IdentityTab key={agentId} {...props} />; break
      case 'logs': body = <LogsTab key={agentId} {...props} />; break
      case 'tables': body = <TablesTab key={agentId} {...props} />; break
      case 'tasks': body = <TasksTab key={agentId} {...props} />; break
    }
  }

  return (
    <Box flexDirection="column" width={paneWidth} height={height} paddingX={1}>
      <TabStrip tabs={TABS} active={tab} width={width} lead={agent ? `${label} ${theme.glyph.pointer}` : 'no agent'} right={agent ? `${theme.glyph.loop} ${loop}` : ''} />
      <Text color={theme.color.dim}>{theme.glyph.hbar.repeat(Math.max(1, width))}</Text>
      <Box flexDirection="column" height={bodyHeight} width={width} overflow="hidden">{body}</Box>
    </Box>
  )
}

const inspect: ViewDefinition = {
  id: 'inspect',
  title: 'Inspect',
  key: '5',
  component: InspectView,
  keyHints: scope => (readInspectState(scope.state()).tab === 'tasks'
    ? [
        { keys: 'enter', label: 'detail' },
        { keys: 'f', label: 'filter' },
        { keys: 'y', label: 'approve' },
        { keys: 'n', label: 'reject' },
        { keys: 'a', label: 'always' },
      ]
    : [
        { keys: 'left right', label: 'tab' },
        { keys: 'enter', label: 'detail' },
        { keys: 'r', label: 'refresh' },
        { keys: 'e', label: 'edit config' },
      ]),
  helpKeys: [
    { keys: [{ keys: 'left right', label: `The selected agent’s tabs: ${TABS.map(t => t.title).join(' ')} ([ ])` }] },
    {
      title: 'Other tabs',
      keys: [
        { keys: 'e', label: 'Config: edit in $EDITOR (validated, changed keys confirmed; also /config edit)' },
        { keys: 'w', label: 'Status: open the agent’s website (W copies its URL)' },
        { keys: 'enter', label: 'Logs / Tables: details · row' },
        { keys: 'f', label: 'Logs: follow' },
        { keys: 'n p', label: 'Tables: next / previous page' },
        { keys: 'r', label: 'Reload' },
      ],
    },
    {
      title: 'Tasks (approvals and async tool calls; also /tasks)',
      keys: [
        { keys: 'f', label: 'Filter: pending · active (+ running) · all' },
        { keys: '/', label: 'Search tool, status, reason, loop, origin, args' },
        { keys: 'enter esc', label: 'Detail (args, result, error, timestamps) · back' },
        { keys: 'y n', label: 'Approve · reject the highlighted call waiting for approval' },
        { keys: 'a', label: 'Always approve its tool (confirmed; not offered for one-time approvals)' },
        { keys: 'N', label: 'Reject with feedback (the agent sees the text)' },
        { keys: 'A', label: 'Approve all waiting calls (confirmed; protection overrides skipped)' },
      ],
    },
    {
      title: 'Events (this agent’s live umbilical events; every agent: Runtime › Events)',
      keys: EVENT_KEYS.filter(k => k.keys !== 'a'),
    },
  ],
  ...inspectCommands,
  overlays: {
    'inspect.theme': ThemeOverlay,
    [MODEL_OVERLAY]: ModelOverlay,
  },
}

export default inspect
