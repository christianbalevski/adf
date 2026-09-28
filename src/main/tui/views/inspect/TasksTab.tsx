// Inspect › Tasks: the selected agent's adf_tasks, newest first. f cycles the
// status filter (pending · active · all), / searches, Enter opens the detail.
// A row waiting for approval gets the chat approval card's actions: y approve,
// a always approve (confirmed; never offered where the daemon refuses it),
// n reject, N reject with feedback, A approve every gated call (confirmed).
// The list reloads on this agent's hil.* / tool / task events and on r.

import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions, useStore } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { List } from '../../ui/List'
import { TextInput } from '../../ui/TextInput'
import { formatAgo, formatClock, truncate } from '../../ui/text'
import type { TaskListEntry } from '../../api/types'
import { useDaemonData } from './hooks'
import { useInspectState } from './state'
import { LinesView } from './LinesView'
import { alwaysApprove, rejectWithFeedback } from '../chat/approvals'
import {
  isAwaitingApproval, isTaskEvent, loadTasks, matchesFilter, nextFilter, searchTasks, statusTone,
  taskDetailLines, taskLoop, taskReason, taskUpdated, type TaskFilter,
} from './tasks'

interface TabProps { agentId: string; width: number; height: number; focused: boolean }

/** Debounce for live reloads (a burst of hil/tool events reloads once). */
export const TASKS_RELOAD_MS = 250

const FILTER_LABEL: Record<TaskFilter, string> = {
  pending: 'pending (awaiting approval or resolve)',
  active: 'active (pending + running)',
  all: 'all',
}

/** Reload `reload` when this agent's task-related events arrive (O(new events) per store change). */
function useTaskEventReload(agentId: string, reload: () => void): void {
  const store = useStore()
  useEffect(() => {
    let seen = store.getState().lastEvents.at(-1)
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = store.subscribe(() => {
      const events = store.getState().lastEvents
      const last = events.at(-1)
      if (last === seen) return
      let hit = false
      for (let i = events.length - 1; i >= 0 && events[i] !== seen; i--) {
        if (isTaskEvent(events[i], agentId)) { hit = true; break }
      }
      seen = last
      if (hit && !timer) timer = setTimeout(() => { timer = null; reload() }, TASKS_RELOAD_MS)
    })
    return () => { unsubscribe(); if (timer) clearTimeout(timer) }
  }, [store, agentId, reload])
}

export function TasksTab({ agentId, width, height, focused }: TabProps) {
  const theme = useTheme()
  const actions = useActions()
  const agent = useAgent(agentId)
  const agentLabel = agent?.summary.handle || agent?.summary.name || agentId
  const [inspect, update] = useInspectState()
  const filter = inspect.tasksFilter
  const [tick, setTick] = useState(0)
  const refresh = useMemo(() => () => setTick(n => n + 1), [])
  const tasks = useDaemonData(`${agentId}:${filter}:${tick}`, c => loadTasks(c, agentId, filter))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const detail = useDaemonData(detailId ? `${agentId}:${detailId}:${tick}` : null, c => c.task(agentId, detailId ?? ''))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')

  useTaskEventReload(agentId, refresh)
  useEffect(() => { setSelectedId(null); setDetailId(null) }, [agentId])

  const all = useMemo(() => tasks.data ?? [], [tasks.data])
  const visible = useMemo(() => searchTasks(all.filter(t => matchesFilter(t, filter)), query), [all, filter, query])
  const found = selectedId ? visible.findIndex(t => t.id === selectedId) : -1
  const index = found >= 0 ? found : 0
  const current = visible[index]
  // The cursor is anchored on a task id, so rows arriving live never move it.
  // When its task leaves the list (resolved, filtered out) the highlight falls
  // back to the top row but approval keys refuse until a row is picked again.
  const adrift = selectedId !== null && found < 0
  useEffect(() => { if (selectedId === null && visible[0]) setSelectedId(visible[0].id) }, [selectedId, visible])
  const shown: TaskListEntry | undefined = detailId ? (detail.data?.task ?? all.find(t => t.id === detailId)) : undefined

  /** y / a / n / N / A on a task. True when the key was an approval key (consumed). */
  const act = (input: string, task: TaskListEntry | undefined, drifted = false): boolean => {
    if (input === 'A') { void approveAll(); return true }
    if (!['y', 'a', 'n', 'N'].includes(input)) return false
    // Only on the row the owner picked, and only while it waits for approval.
    if (drifted) { actions.toast('The selected task left the list: pick a row first (↑↓)', 'warn'); return true }
    if (!isAwaitingApproval(task)) return true
    const done = () => refresh()
    if (input === 'y') void actions.resolveTask(agentId, task.id, 'approve').then(done)
    else if (input === 'a') void alwaysApprove(actions, agentId, agentLabel, task).then(done)
    else if (input === 'n') void actions.resolveTask(agentId, task.id, 'deny').then(done)
    else rejectWithFeedback(actions, agentId, task)
    return true
  }

  const approveAll = async () => {
    const pending = all.filter(isAwaitingApproval).length
    if (pending === 0) { actions.toast('Nothing is waiting for approval', 'info'); return }
    const ok = await actions.confirm({
      title: 'Approve all',
      message: `Approve every tool call of ${agentLabel} waiting for approval (${pending} listed)? Protection overrides are skipped: approve those one by one.`,
      confirmLabel: 'Approve all',
    })
    if (!ok) return
    await actions.approveAllTasks(agentId)
    refresh()
  }

  // The detail view's keys (the list's are on the List below).
  useKeys((input, key) => {
    if (key.ctrl || key.meta) return false
    if (key.escape || key.backspace) { setDetailId(null); return true }
    if (input === 'r') { refresh(); return true }
    return act(input, shown)
  }, { layer: 'main', active: focused && !!detailId })

  const asOf = tasks.loadedAt ? `as of ${formatClock(tasks.loadedAt)}` : ''
  const status = tasks.loading ? 'refreshing…' : asOf

  if (detailId) {
    const lines = shown ? taskDetailLines(shown) : []
    const pending = isAwaitingApproval(shown)
    return (
      <Box flexDirection="column" width={width} height={height}>
        {detail.error && !shown ? <Text color={theme.color.error}>Could not load task: {detail.error}</Text> : null}
        <LinesView lines={lines} width={width} height={Math.max(1, height - 1 - (detail.error && !shown ? 1 : 0))} active={focused} emptyText={detail.loading ? 'Loading…' : 'Task not found.'} />
        <Text color={theme.color.dim} wrap="truncate-end">
          esc back {theme.glyph.sep} {pending ? `y approve ${theme.glyph.sep} a always ${theme.glyph.sep} n reject ${theme.glyph.sep} N reject with feedback ${theme.glyph.sep} ` : ''}r refresh {status ? `${theme.glyph.sep} ${status}` : ''}
        </Text>
      </Box>
    )
  }

  const statusW = 16
  const toolW = Math.min(22, Math.max(10, Math.floor(width / 7)))
  const loopW = 12
  const ageW = 5
  const originW = Math.min(16, Math.max(8, Math.floor(width / 9)))
  const reasonW = Math.max(4, width - 2 - statusW - toolW - loopW - ageW * 2 - originW - 6)
  const listHeight = Math.max(1, height - 3 - (editing ? 1 : 0) - (tasks.error ? 1 : 0))
  const awaiting = all.filter(isAwaitingApproval).length
  const pendingHere = isAwaitingApproval(current)

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.accent}>Tasks </Text>
        <Text color={theme.color.muted}>
          {visible.length}/{all.length} {theme.glyph.sep} {FILTER_LABEL[filter]}{query ? ` ${theme.glyph.sep} search: ${query}` : ''}{awaiting ? ` ${theme.glyph.sep} ${awaiting} awaiting approval` : ''}{status ? ` ${theme.glyph.sep} ${status}` : ''}
        </Text>
      </Text>
      {tasks.error ? <Text color={theme.color.error} wrap="truncate-end">Could not load tasks: {tasks.error} (r retries)</Text> : null}
      {editing ? (
        <TextInput
          focused={focused}
          keyLayer="main"
          prompt="search › "
          placeholder="tool, status, reason, loop, origin, args"
          value={draft}
          onChange={setDraft}
          maxRows={1}
          onKey={(_input, key) => {
            if (key.escape) { setEditing(false); return true }
            return false
          }}
          onSubmit={value => { setQuery(value.trim()); setEditing(false); return true }}
        />
      ) : null}
      <Text color={theme.color.dim} wrap="truncate-end">
        {'  '}{'status'.padEnd(statusW)} {'tool'.padEnd(toolW)} {'loop'.padEnd(loopW)} {'new'.padStart(ageW)} {'upd'.padStart(ageW)} {'origin'.padEnd(originW)} reason
      </Text>
      <List
        items={visible}
        getKey={t => t.id}
        height={listHeight}
        width={width}
        active={focused && !editing}
        selectedIndex={index}
        onSelectedIndexChange={(_i, item) => setSelectedId(item?.id ?? null)}
        onSubmit={t => setDetailId(t.id)}
        onKey={(input, key, item) => {
          if (key.ctrl || key.meta) return false
          if (input === 'f') { update({ tasksFilter: nextFilter(filter) }); return true }
          if (input === '/') { setDraft(query); setEditing(true); return true }
          if (key.escape && query) { setQuery(''); return true }
          if (input === 'r') { refresh(); return true }
          return act(input, item, adrift)
        }}
        emptyText={tasks.loading && !tasks.data ? 'Loading tasks…' : query ? `No task matches "${query}".` : filter === 'all' ? 'No tasks.' : `No ${filter} tasks (f shows ${nextFilter(filter)}).`}
        renderItem={(t, { selected }) => {
          const fg = selected ? theme.color.selectionFg : undefined
          const tone = statusTone(t.status)
          const statusColor = tone === 'warn' ? theme.color.warn : tone === 'error' ? theme.color.error : tone === 'success' ? theme.color.success : tone === 'live' ? theme.color.live : tone === 'muted' ? theme.color.muted : theme.color.text
          const loop = taskLoop(t)
          return (
            <Text wrap="truncate-end" backgroundColor={selected ? theme.color.selectionBg : undefined} inverse={theme.mono && selected} bold={selected}>
              <Text color={fg}>{selected ? theme.glyph.pointer : ' '} </Text>
              <Text color={fg ?? statusColor}>{truncate(t.status, statusW).padEnd(statusW)} </Text>
              <Text color={fg ?? theme.color.tool}>{truncate(t.tool, toolW).padEnd(toolW)} </Text>
              <Text color={fg ?? (loop === 'main' ? theme.color.muted : theme.color.loop)}>{truncate(loop, loopW).padEnd(loopW)} </Text>
              <Text color={fg ?? theme.color.dim}>{formatAgo(t.created_at).padStart(ageW)} </Text>
              <Text color={fg ?? theme.color.dim}>{(t.completed_at ? formatAgo(taskUpdated(t)) : '-').padStart(ageW)} </Text>
              <Text color={fg ?? theme.color.muted}>{truncate(t.origin || '-', originW).padEnd(originW)} </Text>
              <Text color={fg ?? theme.color.text}>{truncate(taskReason(t) || '', reasonW)}</Text>
            </Text>
          )
        }}
      />
      <Text color={theme.color.dim} wrap="truncate-end">
        enter detail {theme.glyph.sep} f filter {theme.glyph.sep} / search {theme.glyph.sep} {pendingHere ? `y approve ${theme.glyph.sep} a always ${theme.glyph.sep} n reject ${theme.glyph.sep} N feedback ${theme.glyph.sep} ` : ''}{awaiting ? `A approve all ${theme.glyph.sep} ` : ''}r refresh
      </Text>
    </Box>
  )
}
