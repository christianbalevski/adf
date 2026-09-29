// The fleet tree: every agent with its state, pending-HIL and unread-inbox
// badges and a turn spinner, each expandable into its cognition loops (main +
// inner loops) with per-loop running/idle/off glyphs and the next scheduled
// run — which threads of which agents are busy, at a glance. Below the loaded
// agents, like Studio's sidebar, every tracked folder lists its agents that
// are not running (dimmed: stopped, needs review, load error) under a folder
// header; Enter / s on one starts it. `/agents running` hides them.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme, stateColor, type Theme } from '../../app/theme'
import { WHEEL_STEP, useKeys, useWheel } from '../../app/keys'
import { useStore } from '../../state/store'
import { useAgents, useConnection, useSelectedAgentId, useSelectedLoops, useTracked, useViewState } from '../../state/hooks'
import { Spinner } from '../../ui/Spinner'
import { displayWidth, truncate } from '../../ui/text'
import { MAIN_LOOP } from '../../api/types'
import type { AgentEntry, LoopState } from '../../state/types'
import { folderName, isTrackedKey, stoppedLabel, type TrackedAgent, type TrackedState } from '../../state/tracked'
import type { SidebarProps } from '../types'
import { agentName, describeAgent, describeLoop, formatIn, nextRunByLoop, type AgentKind } from './model'
import { useFleetData, useFleetPoller } from './data'
import { openChat } from './ops'
import { startStopped, stoppedGlyph, useAgentsFilter } from './stopped'

export const SIDEBAR_STATE_KEY = 'fleet.sidebar'

interface SidebarState {
  /** Explicit expand/collapse per agent id; absent = expanded. */
  collapsed: Record<string, boolean>
  filter: string
  cursor: string | null
}

const INITIAL: SidebarState = { collapsed: {}, filter: '', cursor: null }

export type TreeRow =
  | { kind: 'agent'; key: string; agent: AgentEntry; expanded: boolean; loopCount: number }
  | { kind: 'loop'; key: string; agent: AgentEntry; loop: LoopState }
  /** A tracked folder's header (not selectable): its name and loaded / total agents. */
  | { kind: 'folder'; key: string; path: string; loaded: number; total: number }
  /** A tracked agent that is not loaded (key = its `file:<path>` selection key). */
  | { kind: 'stopped'; key: string; entry: TrackedAgent }

/**
 * Loaded agents (expandable into loops), then each tracked folder's agents
 * that are not loaded under the folder's header. `tracked` null (or the
 * `running` filter) = loaded agents only.
 */
export function buildTree(agents: AgentEntry[], collapsed: Record<string, boolean>, filter: string, tracked: Pick<TrackedState, 'folders' | 'stopped'> | null = null): TreeRow[] {
  const q = filter.trim().toLowerCase()
  const rows: TreeRow[] = []
  for (const agent of agents) {
    const id = agent.summary.id
    const loops = agent.loops ?? []
    const name = agentName(agent).toLowerCase()
    const agentHit = !q || name.includes(q) || agent.summary.name.toLowerCase().includes(q)
    const loopHits = q ? loops.filter(l => l.info.name.toLowerCase().includes(q)) : loops
    if (!agentHit && loopHits.length === 0) continue
    const expanded = q ? true : !collapsed[id]
    rows.push({ kind: 'agent', key: `a:${id}`, agent, expanded, loopCount: loops.length })
    if (!expanded) continue
    for (const loop of agentHit ? loops : loopHits) rows.push({ kind: 'loop', key: `l:${id}:${loop.info.name}`, agent, loop })
  }
  if (!tracked) return rows
  for (const folder of tracked.folders) {
    const stopped = tracked.stopped.filter(t => t.folder === folder.path && (!q || t.agent.name.toLowerCase().includes(q) || t.relPath.toLowerCase().includes(q)))
    if (stopped.length === 0) continue
    rows.push({ kind: 'folder', key: `d:${folder.path}`, path: folder.path, loaded: folder.loadedCount, total: folder.agentCount })
    for (const entry of stopped) rows.push({ kind: 'stopped', key: entry.key, entry })
  }
  return rows
}

function target(row: TreeRow): { agentId: string; loop: string } | null {
  if (row.kind === 'folder') return null
  if (row.kind === 'stopped') return { agentId: row.entry.key, loop: MAIN_LOOP }
  return { agentId: row.agent.summary.id, loop: row.kind === 'loop' ? row.loop.info.name : MAIN_LOOP }
}

const agentIdOf = (row: TreeRow): string | null => (row.kind === 'agent' || row.kind === 'loop' ? row.agent.summary.id : row.kind === 'stopped' ? row.entry.key : null)

export function FleetSidebar({ width, height, focused }: SidebarProps) {
  useFleetPoller()
  const theme = useTheme()
  const store = useStore()
  const agents = useAgents()
  const tracked = useTracked()
  const filterMode = useAgentsFilter()
  const data = useFleetData()
  const selectedAgentId = useSelectedAgentId()
  const selectedLoops = useSelectedLoops()
  const offline = useConnection().reachable === false
  const [view, setView] = useViewState<SidebarState>(SIDEBAR_STATE_KEY, INITIAL)
  const offsetRef = useRef(0)

  const shownTracked = filterMode === 'all' ? tracked : null
  const rows = useMemo(() => buildTree(agents, view.collapsed, view.filter, shownTracked), [agents, view.collapsed, view.filter, shownTracked])
  const selectedLoop = selectedAgentId ? selectedLoops[selectedAgentId] ?? MAIN_LOOP : MAIN_LOOP

  // The cursor follows the shared (agent, loop) selection unless it already
  // sits on a row that targets it (an agent row and its main row both do).
  const cursorIndex = useMemo(() => {
    const at = rows.findIndex(r => r.key === view.cursor)
    if (at >= 0) {
      const t = target(rows[at])
      if (t && t.agentId === selectedAgentId && t.loop === selectedLoop) return at
    }
    if (isTrackedKey(selectedAgentId)) {
      const stoppedRow = rows.findIndex(r => r.kind === 'stopped' && r.key === selectedAgentId)
      if (stoppedRow >= 0) return stoppedRow
    }
    const loopRow = selectedLoop !== MAIN_LOOP ? rows.findIndex(r => r.kind === 'loop' && r.agent.summary.id === selectedAgentId && r.loop.info.name === selectedLoop) : -1
    if (loopRow >= 0) return loopRow
    const agentRow = rows.findIndex(r => r.kind === 'agent' && r.agent.summary.id === selectedAgentId)
    if (agentRow >= 0) return agentRow
    const first = rows.findIndex(r => r.kind !== 'folder')
    return first >= 0 ? first : 0
  }, [rows, view.cursor, selectedAgentId, selectedLoop])

  const patch = (next: Partial<SidebarState>) => setView(prev => ({ ...prev, ...next }))

  const moveTo = (index: number, direction: 1 | -1 = index >= cursorIndex ? 1 : -1) => {
    if (rows.length === 0) return
    let at = Math.max(0, Math.min(rows.length - 1, index))
    // Folder headers are not selectable: step over them (back the other way at an end).
    while (rows[at]?.kind === 'folder' && at + direction >= 0 && at + direction < rows.length) at += direction
    while (rows[at]?.kind === 'folder' && at - direction >= 0 && at - direction < rows.length) at -= direction
    const row = rows[at]
    const t = target(row)
    if (!t) return
    patch({ cursor: row.key })
    const state = store.getState()
    if (state.selectedAgentId !== t.agentId) store.actions.selectAgent(t.agentId)
    if ((state.selectedLoop[t.agentId] ?? MAIN_LOOP) !== t.loop) store.actions.selectLoop(t.agentId, t.loop)
  }

  const setCollapsed = (agentId: string, value: boolean) => setView(prev => ({ ...prev, collapsed: { ...prev.collapsed, [agentId]: value } }))

  const filtering = view.filter.length > 0
  const bodyRows = Math.max(1, height - 1 - (filtering ? 1 : 0))

  useKeys((input, key) => {
    const row = rows[cursorIndex]
    if (key.upArrow) { moveTo(cursorIndex - 1); return true }
    if (key.downArrow) { moveTo(cursorIndex + 1); return true }
    if (key.pageUp) { moveTo(cursorIndex - bodyRows); return true }
    if (key.pageDown) { moveTo(cursorIndex + bodyRows); return true }
    if (key.home) { moveTo(0); return true }
    if (key.end) { moveTo(rows.length - 1); return true }
    if (key.return) {
      if (row?.kind === 'stopped') { patch({ cursor: row.key }); startStopped(store, row.entry); return true }
      const t = row ? target(row) : null
      if (row && t) { patch({ cursor: row.key }); openChat(store, t.agentId, t.loop) }
      return true
    }
    if ((key.ctrl || key.shift) && (key.leftArrow || key.rightArrow)) return false
    if ((key.rightArrow || key.leftArrow || input === ' ') && (row?.kind === 'stopped' || row?.kind === 'folder')) return true
    if (key.rightArrow && row) {
      if (row.kind === 'agent' && !row.expanded) setCollapsed(row.agent.summary.id, false)
      else if (row.kind === 'agent' && rows[cursorIndex + 1]?.kind === 'loop') moveTo(cursorIndex + 1)
      return true
    }
    if (key.leftArrow && row && (row.kind === 'agent' || row.kind === 'loop')) {
      if (row.kind === 'loop') moveTo(rows.findIndex(r => r.kind === 'agent' && r.agent.summary.id === row.agent.summary.id))
      else if (row.expanded && !filtering) setCollapsed(row.agent.summary.id, true)
      return true
    }
    if (input === ' ' && row && (row.kind === 'agent' || row.kind === 'loop')) {
      const id = row.agent.summary.id
      if (filtering) return true
      const agentRow = rows.find(r => r.kind === 'agent' && r.agent.summary.id === id)
      const expanded = agentRow?.kind === 'agent' ? agentRow.expanded : true
      setCollapsed(id, expanded)
      if (row.kind === 'loop' && expanded) patch({ cursor: `a:${id}` })
      return true
    }
    if (key.backspace || key.delete) {
      if (!filtering) return false
      patch({ filter: view.filter.slice(0, -1) })
      return true
    }
    if (key.escape && filtering) { patch({ filter: '' }); return true }
    if (key.ctrl || key.meta || key.tab || key.escape || !input || /[\u0000-\u001f\u007f]/.test(input)) return false
    // Type-to-filter. Digits only extend a filter already started (bare
    // digits switch views); `?`, `:` and `/` stay with the shell.
    if (!filtering && /^[0-9?:/ ]/.test(input)) return false
    patch({ filter: view.filter + input.replace(/[?:/]/g, '') })
    return true
  }, { layer: 'sidebar', active: focused })

  // The cursor stays in view when it moves; the wheel scrolls the tree
  // without selecting (selection here switches the agent everywhere).
  const revealed = useRef('')
  const [, redraw] = useState(0)
  if (revealed.current !== `${cursorIndex}|${bodyRows}`) {
    revealed.current = `${cursorIndex}|${bodyRows}`
    // A stopped agent's folder header comes into view with it.
    const top = rows[cursorIndex - 1]?.kind === 'folder' && bodyRows > 1 ? cursorIndex - 1 : cursorIndex
    if (top < offsetRef.current) offsetRef.current = top
    if (cursorIndex >= offsetRef.current + bodyRows) offsetRef.current = cursorIndex - bodyRows + 1
  }
  offsetRef.current = Math.max(0, Math.min(offsetRef.current, Math.max(0, rows.length - bodyRows)))
  const boxRef = useRef<DOMElement>(null)
  useWheel(boxRef, delta => {
    const next = Math.max(0, Math.min(offsetRef.current + delta * WHEEL_STEP, Math.max(0, rows.length - bodyRows)))
    if (next !== offsetRef.current) { offsetRef.current = next; redraw(n => n + 1) }
  })
  const windowRows = rows.slice(offsetRef.current, offsetRef.current + bodyRows)

  // Keep the stored cursor on a real row when the tree reshapes.
  useEffect(() => {
    if (rows.length && rows[cursorIndex] && rows[cursorIndex].key !== view.cursor && view.cursor !== null && !rows.some(r => r.key === view.cursor)) {
      patch({ cursor: rows[cursorIndex].key })
    }
  }, [rows, cursorIndex])

  const busy = agents.filter(a => describeAgent(a).busy).length
  const inner = Math.max(8, width - 3)
  const stoppedCount = tracked?.stopped.length ?? 0
  const counts = `${agents.length}${busy ? `/${busy} busy` : ''}${stoppedCount ? ` +${stoppedCount} off${filterMode === 'running' ? ' (hidden)' : ''}` : ''}`
  const agentMatches = rows.filter(r => r.kind === 'agent' || r.kind === 'stopped').length
  return (
    <Box ref={boxRef} flexDirection="column" width={width} height={height} paddingX={1}
      borderStyle={theme.ascii ? 'classic' : 'single'} borderTop={false} borderBottom={false} borderLeft={false}
      borderColor={focused ? theme.color.borderFocus : theme.color.border}>
      <Text wrap="truncate-end">
        <Text bold color={focused ? theme.color.accent : theme.color.muted} inverse={theme.mono && focused}>FLEET</Text>
        <Text color={theme.color.dim}>{' '.repeat(Math.max(1, inner - 5 - displayWidth(counts)))}{counts}</Text>
      </Text>
      {filtering ? (
        <Text wrap="truncate-end">
          <Text color={theme.color.accent}>{theme.glyph.pointer} </Text>
          <Text color={theme.color.text}>{view.filter}</Text>
          {focused ? <Text inverse> </Text> : null}
          <Text color={theme.color.dim}>  {agentMatches} match</Text>
        </Text>
      ) : null}
      {rows.length === 0 ? (
        <Text color={theme.color.muted} wrap="wrap">{filtering ? `No agent or loop matches "${view.filter}".` : offline ? 'Daemon offline. Start it with adf daemon start (Fleet view, 1, has details).' : 'No agents yet. On the Fleet view: n new agent, o load an .adf (or /new, /load).'}</Text>
      ) : windowRows.map((row, i) => {
        const selected = offsetRef.current + i === cursorIndex
        switch (row.kind) {
          case 'agent': return <AgentRow key={row.key} row={row} selected={selected} focused={focused} width={inner} unread={data.agents[row.agent.summary.id]?.unread} />
          case 'loop': return <LoopRow key={row.key} row={row} selected={selected} focused={focused} width={inner} nextRun={nextRunByLoop(data.agents[row.agent.summary.id]?.timers)[row.loop.info.name]} />
          case 'folder': return <FolderRow key={row.key} row={row} width={inner} />
          case 'stopped': return <StoppedRow key={row.key} row={row} selected={selected} focused={focused} width={inner} errors={tracked?.errors ?? {}} busy={tracked?.busy[row.entry.agent.filePath]} />
        }
      })}
    </Box>
  )
}

export function agentGlyph(theme: Theme, kind: AgentKind): { glyph: string; color: string | undefined } {
  switch (kind) {
    case 'error': return { glyph: theme.glyph.cross, color: theme.color.error }
    case 'waiting': return { glyph: theme.glyph.warn, color: theme.color.warn }
    case 'suspended': return { glyph: theme.glyph.warn, color: theme.color.warn }
    case 'hibernate':
    case 'off': return { glyph: theme.glyph.ring, color: theme.color.dim }
    case 'active': return { glyph: theme.glyph.dot, color: theme.color.live }
    case 'unknown': return { glyph: theme.glyph.ring, color: theme.color.muted }
    default: return { glyph: theme.glyph.dot, color: stateColor(theme, kind) }
  }
}

function rowColors(theme: Theme, selected: boolean, focused: boolean) {
  const on = selected && focused
  return {
    bg: on ? theme.color.selectionBg : undefined,
    inverse: theme.mono && on,
    underline: theme.mono && selected && !focused,
    fg: (color: string | undefined) => (on ? theme.color.selectionFg : color),
  }
}

function AgentRow({ row, selected, focused, width, unread }: { row: Extract<TreeRow, { kind: 'agent' }>; selected: boolean; focused: boolean; width: number; unread?: number }) {
  const theme = useTheme()
  const { agent } = row
  const view = describeAgent(agent)
  const c = rowColors(theme, selected, focused)
  const pending = agent.pendingTasks.length + agent.pendingAsks.length
  const inbox = unread ?? agent.unreadInbox
  const innerLoops = (agent.loops ?? []).filter(l => !l.info.isMain)
  const runningInner = view.runningLoops.filter(l => l !== MAIN_LOOP).length
  const inboxGlyph = theme.ascii ? '<' : '«'
  const badges = [
    !row.expanded && innerLoops.length ? `${theme.glyph.loop}${runningInner ? `${runningInner}/` : ''}${innerLoops.length}` : '',
    pending ? `${theme.glyph.warn}${pending}` : '',
    inbox ? `${inboxGlyph}${inbox}` : '',
  ].filter(Boolean)
  const badgeText = badges.join(' ')
  const expander = row.loopCount > 1 ? (row.expanded ? theme.glyph.expanded : theme.glyph.collapsed) : ' '
  const nameRoom = Math.max(3, width - 4 - (badgeText ? displayWidth(badgeText) + 1 : 0))
  const name = truncate(agentName(agent), nameRoom)
  const stateRoom = nameRoom - displayWidth(name) - 1
  const stateText = stateRoom >= 4 ? truncate(view.label, stateRoom) : ''
  const fill = Math.max(0, width - 4 - displayWidth(name) - (stateText ? displayWidth(stateText) + 1 : 0) - (badgeText ? displayWidth(badgeText) + 1 : 0))
  const glyph = agentGlyph(theme, view.kind)
  return (
    <Text backgroundColor={c.bg} inverse={c.inverse} underline={c.underline} wrap="truncate-end">
      <Text color={c.fg(theme.color.dim)}>{expander} </Text>
      {view.busy ? <Spinner color={c.fg(theme.color.live)} /> : <Text color={c.fg(glyph.color)}>{glyph.glyph}</Text>}
      <Text bold color={c.fg(selected ? theme.color.accent : theme.color.text)}> {name}</Text>
      {stateText ? <Text color={c.fg(theme.color.muted)}> {stateText}</Text> : null}
      <Text>{' '.repeat(fill)}</Text>
      {badges.map((badge, i) => (
        <Text key={badge} bold color={c.fg(badge.startsWith(theme.glyph.warn) ? theme.color.warn : badge.startsWith(theme.glyph.loop) ? theme.color.loop : theme.color.info)}>
          {i === 0 ? ' ' : ' '}{badge}
        </Text>
      ))}
    </Text>
  )
}

function FolderRow({ row, width }: { row: Extract<TreeRow, { kind: 'folder' }>; width: number }) {
  const theme = useTheme()
  const count = `${row.loaded}/${row.total}`
  const name = truncate(folderName(row.path), Math.max(3, width - displayWidth(count) - 1))
  return (
    <Text wrap="truncate-end">
      <Text bold color={theme.color.muted}>{name}</Text>
      <Text>{' '.repeat(Math.max(1, width - displayWidth(name) - displayWidth(count)))}</Text>
      <Text color={theme.color.dim}>{count}</Text>
    </Text>
  )
}

function StoppedRow({ row, selected, focused, width, errors, busy }: { row: Extract<TreeRow, { kind: 'stopped' }>; selected: boolean; focused: boolean; width: number; errors: Record<string, string>; busy?: string }) {
  const theme = useTheme()
  const c = rowColors(theme, selected, focused)
  const { entry } = row
  const label = busy ? (busy === 'starting' ? 'starting' : 'loading') : stoppedLabel(entry, errors)
  const glyph = stoppedGlyph(theme, entry, errors)
  const nameRoom = Math.max(3, width - 4)
  const name = truncate(entry.agent.name, nameRoom)
  const stateRoom = nameRoom - displayWidth(name) - 1
  const stateText = stateRoom >= 4 ? truncate(label, stateRoom) : ''
  const labelColor = label === 'needs review' ? theme.color.warn : label === 'load error' || label === 'unreadable' ? theme.color.error : theme.color.dim
  return (
    <Text backgroundColor={c.bg} inverse={c.inverse} underline={c.underline} wrap="truncate-end">
      <Text>  </Text>
      {busy ? <Spinner color={c.fg(theme.color.live)} /> : <Text color={c.fg(glyph.color)}>{glyph.glyph}</Text>}
      <Text color={c.fg(selected ? theme.color.accent : theme.color.muted)} bold={selected}> {name}</Text>
      {stateText ? <Text color={c.fg(labelColor)}> {stateText}</Text> : null}
    </Text>
  )
}

function LoopRow({ row, selected, focused, width, nextRun }: { row: Extract<TreeRow, { kind: 'loop' }>; selected: boolean; focused: boolean; width: number; nextRun?: number }) {
  const theme = useTheme()
  const { loop, agent } = row
  const d = describeLoop(agent, loop)
  const c = rowColors(theme, selected, focused)
  const hint = d.kind === 'running' ? d.label : d.kind === 'disabled' ? 'off' : nextRun !== undefined ? formatIn(nextRun) : ''
  const nameRoom = Math.max(3, width - 5 - (hint ? displayWidth(hint) + 1 : 0))
  const name = truncate(loop.info.name, nameRoom)
  const fill = Math.max(0, width - 5 - displayWidth(name) - (hint ? displayWidth(hint) + 1 : 0))
  const nameColor = !loop.info.enabled ? theme.color.dim : loop.info.isMain ? theme.color.accent : theme.color.loop
  return (
    <Text backgroundColor={c.bg} inverse={c.inverse} underline={c.underline} wrap="truncate-end">
      <Text>  </Text>
      {d.kind === 'running'
        ? <Spinner color={c.fg(theme.color.loop)} />
        : <Text color={c.fg(d.kind === 'disabled' ? theme.color.dim : theme.color.muted)}>{d.kind === 'disabled' ? '-' : theme.glyph.ring}</Text>}
      <Text color={c.fg(nameColor)}> {theme.glyph.loop}</Text>
      <Text color={c.fg(nameColor)} bold={selected}>{name}</Text>
      <Text>{' '.repeat(fill)}</Text>
      {hint ? <Text color={c.fg(d.kind === 'running' ? theme.color.live : theme.color.muted)}> {hint}</Text> : null}
    </Text>
  )
}
