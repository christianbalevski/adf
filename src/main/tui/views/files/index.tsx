// Files view: the agent document, its mind and its virtual files (tree +
// viewer + $EDITOR round-trip), plus read-only inbox / outbox / meta tabs.

import { useCallback } from 'react'
import { StoppedAgentPanel } from '../fleet/stopped'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useSelectedTracked, useSelectedAgent, useSelectedLoop, useViewState } from '../../state/hooks'
import { useStore } from '../../state/store'
import { displayWidth } from '../../ui/text'
import { filesCommands } from './commands'
import { DataTab } from './DataTab'
import { FilesTab } from './FilesTab'
import { InputDialog } from './InputDialog'
import { INITIAL_STATE, TABS, VIEW_ID, readViewState, type AgentFilesState, type FilesPane, type FilesTab as Tab, type FilesViewState } from './state'
import type { KeyHintSpec } from '../../ui/KeyHint'
import type { CommandScope } from '../../commands/types'
import type { ViewDefinition, ViewProps } from '../types'

const TAB_TITLES: Record<Tab, string> = { files: 'Files', inbox: 'Inbox', outbox: 'Outbox', meta: 'Meta' }

function FilesView({ width, height, focused }: ViewProps) {
  const theme = useTheme()
  const store = useStore()
  const agent = useSelectedAgent()
  const stopped = useSelectedTracked()
  const loop = useSelectedLoop()
  const [state, setState] = useViewState<FilesViewState>(VIEW_ID, INITIAL_STATE)
  const agentId = agent?.summary.id ?? null
  const agentLabel = agent ? agent.summary.handle || agent.summary.name : ''

  const patch = useCallback((next: Partial<FilesViewState>) => {
    setState({ ...readViewState(store.getState()), ...next })
  }, [store, setState])
  const setPane = useCallback((pane: FilesPane) => patch({ pane }), [patch])
  const setTab = (tab: Tab) => patch({ tab, pane: 'list' })
  const setAgentState = useCallback((next: Partial<AgentFilesState>) => {
    if (!agentId) return
    const current = readViewState(store.getState())
    patch({ agents: { ...current.agents, [agentId]: { ...current.agents[agentId], ...next } } })
  }, [agentId, store, patch])
  const clearRequest = useCallback(() => patch({ request: undefined }), [patch])

  useKeys((input, key) => {
    if (key.ctrl || key.meta || (key.shift && (key.leftArrow || key.rightArrow))) return false
    // ←/→ switch tabs ([ ] still work, unlisted).
    const step = key.rightArrow || input === ']' ? 1 : key.leftArrow || input === '[' ? -1 : 0
    if (step) {
      const i = TABS.indexOf(state.tab)
      setTab(TABS[(i + step + TABS.length) % TABS.length])
      return true
    }
    return false
  }, { layer: 'view', active: !!agentId })

  if (stopped && !agent) return <StoppedAgentPanel entry={stopped} width={width} height={height} focused={focused} what="document, mind or files" />
  if (!agent || !agentId) {
    return (
      <Box flexDirection="column" paddingX={1} width={width} height={height}>
        <Text color={theme.color.muted}>Select an agent (Tab to the sidebar) to browse its document, mind, files, inbox, outbox and meta.</Text>
      </Box>
    )
  }

  const unread = agent.unreadInbox ?? 0
  const bodyHeight = Math.max(3, height - 1)
  const bodyWidth = Math.max(10, width - 2)
  // The agent › loop label keeps its width; the "←/→ switch" hint only shows
  // when the tabs, hint and label all fit with a gap.
  const target = `${agentLabel} ${theme.glyph.pointer} ${theme.glyph.loop} ${loop}`
  const targetWidth = Math.min(displayWidth(target), Math.max(8, Math.floor(bodyWidth / 2)))
  const tabsWidth = TABS.reduce((n, tab, i) => n + (i > 0 ? 3 : 0) + TAB_TITLES[tab].length + (tab === 'inbox' && unread > 0 ? 1 + String(unread).length : 0), 0)
  const showSwitch = tabsWidth + 12 + 2 + targetWidth <= bodyWidth

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Box width={bodyWidth} justifyContent="space-between">
        <Text wrap="truncate-end">
          {TABS.map((tab, i) => {
            const active = tab === state.tab
            const label = `${TAB_TITLES[tab]}${tab === 'inbox' && unread > 0 ? ` ${unread}` : ''}`
            return (
              <Text key={tab}>
                {i > 0 ? <Text color={theme.color.dim}> {theme.glyph.sep} </Text> : null}
                <Text
                  bold={active}
                  underline={active && theme.mono}
                  inverse={active && theme.mono}
                  color={active ? theme.color.accent : tab === 'inbox' && unread > 0 ? theme.color.live : theme.color.muted}
                >
                  {label}
                </Text>
              </Text>
            )
          })}
          {showSwitch ? <Text color={theme.color.dim}>  {theme.ascii ? '</>' : '←/→'} switch</Text> : null}
        </Text>
        <Box flexShrink={0} marginLeft={2} width={targetWidth}>
          <Text color={theme.color.dim} wrap="truncate-start">{target}</Text>
        </Box>
      </Box>
      {state.tab === 'files' ? (
        <FilesTab
          width={bodyWidth}
          height={bodyHeight}
          focused={focused}
          agentId={agentId}
          agentLabel={agentLabel}
          pane={state.pane}
          setPane={setPane}
          agentState={state.agents[agentId] ?? {}}
          setAgentState={setAgentState}
          request={state.request}
          clearRequest={clearRequest}
        />
      ) : (
        <DataTab
          key={`${state.tab}:${agentId}`}
          kind={state.tab}
          width={bodyWidth}
          height={bodyHeight}
          focused={focused}
          agentId={agentId}
          agentLabel={agentLabel}
          pane={state.pane}
          setPane={setPane}
        />
      )}
    </Box>
  )
}

function keyHints(scope: CommandScope): KeyHintSpec[] {
  const state = readViewState(scope.state())
  if (state.pane === 'viewer') {
    return [
      { keys: 'backspace', label: 'back' },
      { keys: 'up down', label: 'scroll' },
      { keys: '/', label: 'search' },
      ...(state.tab === 'files' ? [{ keys: 'e', label: 'edit' }, { keys: 'o', label: 'open in app' }] : []),
      { keys: 'left right', label: 'tabs' },
    ]
  }
  if (state.tab !== 'files') {
    return [
      { keys: 'enter', label: 'read' },
      { keys: 'left right', label: 'tabs' },
      { keys: '/', label: 'filter' },
      ...(state.tab === 'meta' ? [] : [{ keys: 'f', label: 'status' }]),
      { keys: 'r', label: 'reload' },
    ]
  }
  return [
    // The status bar shows the first few; the rest are in /help.
    { keys: 'enter', label: 'open' },
    { keys: 'backspace', label: 'up' },
    { keys: 'left right', label: 'tabs' },
    { keys: 'e', label: 'edit' },
    { keys: 'o', label: 'open in app' },
    { keys: 'n', label: 'new' },
    { keys: '/', label: 'filter' },
    { keys: 'd', label: 'delete' },
  ]
}

const files: ViewDefinition = {
  id: VIEW_ID,
  title: 'Files',
  key: '2',
  group: 'agent',
  component: FilesView,
  keyHints,
  helpKeys: [
    {
      title: 'Files tab (tree)',
      keys: [
        { keys: 'up down', label: 'Move; the viewer previews the highlighted entry' },
        { keys: 'enter', label: 'Open the file in the viewer · open / close a folder' },
        { keys: 'backspace', label: 'Close the folder · go to the parent folder (never deletes)' },
        { keys: 'left right', label: 'Tabs: Files · Inbox · Outbox · Meta' },
        { keys: 'space', label: 'Toggle a folder' },
        { keys: '/', label: 'Filter by path (fuzzy)' },
        { keys: 'e', label: 'Edit in $EDITOR, then confirm the write (diff shown)' },
        { keys: 'o', label: 'Open in the default app (xlsx, images, pdf, …)' },
        { keys: 's', label: 'Save the default-app copy back (asks)' },
        { keys: 'n', label: 'New file' },
        { keys: 'm', label: 'Rename / move (a folder moves with its files)' },
        { keys: 'd delete', label: 'Delete (asks)' },
        { keys: 'p', label: 'Protection: none → read_only → no_delete' },
        { keys: 'a', label: 'Toggle authorized' },
        { keys: 'r', label: 'Reload' },
      ],
    },
    {
      title: 'Viewer',
      keys: [
        { keys: 'backspace esc', label: 'Back to the list (the entry stays selected)' },
        { keys: 'up down', label: 'Scroll (j k; PgUp PgDn Space page; g G top/bottom)' },
        { keys: '/', label: 'Search, then n N next / previous hit' },
        { keys: 'e', label: 'Edit this file' },
        { keys: 'o s', label: 'Open in the default app · save that copy back' },
      ],
    },
    {
      title: 'Inbox · Outbox · Meta (read-only)',
      keys: [
        { keys: 'enter', label: 'Read the message / entry (Backspace or Esc: back)' },
        { keys: '/', label: 'Filter' },
        { keys: 'f', label: 'Status filter (inbox, outbox)' },
        { keys: 'r', label: 'Reload' },
      ],
    },
  ],
  overlays: { 'files.input': InputDialog },
  ...filesCommands,
}

export default files
