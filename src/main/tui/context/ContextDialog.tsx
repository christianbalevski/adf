// /context: Studio's context breakdown modal in the terminal. One loop of one
// agent: the total against the auto-compact threshold, the categories that
// make it up (system prompt, injected files, tools, each MCP server, dynamic
// instructions, conversation) biggest first, Enter to see a category's
// biggest items, c to compact now, r to re-measure, ←/→ for the agent's other
// loops. Figures come from GET /agents/:id/context.

import { useEffect, useRef, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { fit, formatClock, formatCount, truncate } from '../ui/text'
import { DaemonError, MAIN_LOOP, type AgentContextResult } from '../api/types'
import type { OverlayProps } from '../views/types'
import {
  CONTEXT_OVERLAY,
  barText,
  categoryIndex,
  contextRows,
  pressureOf,
  thresholdText,
  windowStart,
  type ContextOverlayProps,
  type ContextRow,
} from './model'

interface DialogState {
  loop: string
  data: AgentContextResult | null
  error: string | null
  loading: boolean
  compacting: boolean
  /** Selected category id (null = the first). */
  cursor: string | null
  expanded: string | null
  start: number
  measuredAt: number | null
}

function errorText(err: unknown): string {
  if (err instanceof DaemonError) {
    const body = err.body as { error?: string } | null
    if (err.status === 404 && !body?.error?.includes('loop')) return 'This daemon has no context endpoint (GET /agents/:id/context): update the daemon.'
    return body?.error ?? err.message
  }
  return err instanceof Error ? err.message : String(err)
}

function pressureColor(theme: Theme, percent: number): string | undefined {
  const p = pressureOf(percent)
  return p === 'high' ? theme.color.error : p === 'warn' ? theme.color.warn : theme.color.success
}

export function ContextDialog({ overlay, close: closeOverlay, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const g = theme.glyph
  const props = (overlay.props ?? {}) as Partial<ContextOverlayProps>
  const agentId = props.agentId ?? ''
  // State lives in the store (keyed by this overlay): the compact confirm
  // unmounts this dialog, and the flow that asked must land its result where
  // the remounted dialog reads it.
  const slotKey = `${CONTEXT_OVERLAY}.dialog:${overlay.id}`
  const initial = useRef<DialogState>({ loop: props.loop || MAIN_LOOP, data: null, error: null, loading: false, compacting: false, cursor: null, expanded: null, start: 0, measuredAt: null }).current
  const read = (): DialogState => (store.getState().viewState[slotKey] as DialogState | undefined) ?? initial
  const alive = () => store.getState().overlays.some(o => o.id === overlay.id)
  const patch = (next: Partial<DialogState>) => { if (alive()) store.actions.setViewState(slotKey, { ...read(), ...next }) }
  const s = useTuiSelector(state => (state.viewState[slotKey] as DialogState | undefined) ?? initial)
  const agent = useTuiSelector(state => state.agents[agentId])
  const close = () => { closeOverlay(); store.actions.setViewState(slotKey, null) }

  const agentLabel = agent?.summary.handle || agent?.summary.name || agentId
  const loopNames = (agent?.loops ?? []).filter(l => l.info.isMain || l.info.enabled).map(l => l.info.name)
  const loops = loopNames.includes(s.loop) ? loopNames : [...loopNames, s.loop]

  const load = async (loop: string) => {
    if (!agentId) return
    patch({ loading: true, loop })
    try {
      const data = await store.client.agentContext(agentId, loop)
      if (read().loop !== loop) return
      const keep = data.categories.some(c => c.id === read().cursor)
      patch({ data, error: null, loading: false, measuredAt: Date.now(), ...(keep ? {} : { cursor: null, expanded: null, start: 0 }) })
    } catch (err) {
      if (read().loop !== loop) return
      patch({ data: null, error: errorText(err), loading: false })
    }
  }

  // First mount only: a remount (after the compact confirm) keeps what the store holds.
  useEffect(() => {
    if (!read().data && !read().error) void load(read().loop)
    if (agentId && !store.getState().agents[agentId]?.loops) void store.actions.refreshLoops(agentId)
  }, [])

  const compact = async () => {
    const { loop, data } = read()
    if (!data?.available || read().compacting) return
    const ok = await store.actions.confirm({
      title: 'Compact now',
      message: `Summarize the "${loop}" loop's history now to free context? A summary replaces the older messages (the conversation is ${formatCount(data.breakdown?.messages_tokens ?? 0)} tokens now). Not while the loop is mid-turn.`,
      confirmLabel: 'Compact',
    })
    if (!ok) return
    patch({ compacting: true })
    const done = await store.actions.compactLoop(agentId, loop)
    patch({ compacting: false })
    if (done) await load(loop)
  }

  const categories = s.data?.categories ?? []
  const cursor = categoryIndex(categories, s.cursor)
  const selected = categories[cursor]
  const rows = contextRows(categories, s.expanded)
  const cursorRow = rows.findIndex(r => r.kind === 'category' && r.category.id === selected?.id)

  const dialogWidth = Math.max(40, Math.min(width - 4, 96))
  const inner = dialogWidth - 4
  // Chrome: border 2, title 2, header 3, blank 1, note + measured 2, hints 2.
  const rowsHeight = Math.max(3, height - 16)
  const start = windowStart(rows.length, Math.max(0, cursorRow), rowsHeight, s.start)
  useEffect(() => { if (start !== s.start) patch({ start }) }, [start])

  useKeys((input, key) => {
    if (key.escape) return false
    if (key.upArrow || input === 'k') { if (cursor > 0) patch({ cursor: categories[cursor - 1]!.id }); return true }
    if (key.downArrow || input === 'j') { if (cursor < categories.length - 1) patch({ cursor: categories[cursor + 1]!.id }); return true }
    if (key.home) { if (categories[0]) patch({ cursor: categories[0].id }); return true }
    if (key.end) { const last = categories[categories.length - 1]; if (last) patch({ cursor: last.id }); return true }
    if (key.return || input === ' ') {
      if (selected && selected.items.length > 0) patch({ cursor: selected.id, expanded: s.expanded === selected.id ? null : selected.id })
      return true
    }
    if (key.leftArrow || key.rightArrow) {
      if (loops.length > 1) {
        const i = Math.max(0, loops.indexOf(s.loop))
        const next = loops[(i + (key.rightArrow ? 1 : loops.length - 1)) % loops.length]!
        patch({ data: null, error: null, cursor: null, expanded: null, start: 0 })
        void load(next)
      }
      return true
    }
    if (input === 'r') { void load(s.loop); return true }
    if (input === 'c') { void compact(); return true }
    return !(key.ctrl && input === 'c')
  }, { layer: 'overlay' })

  const hints = [
    { keys: '↑↓', label: 'move' },
    { keys: 'enter', label: 'items' },
    { keys: 'c', label: 'compact' },
    { keys: 'r', label: 'refresh' },
    ...(loops.length > 1 ? [{ keys: '←→', label: 'loop' }] : []),
    { keys: 'esc', label: 'close' },
  ]

  const data = s.data
  const header = [agentLabel, `loop ${s.loop}${loops.length > 1 ? ` (${loops.indexOf(s.loop) + 1}/${loops.length})` : ''}`, data?.model.modelId ?? agent?.config?.model?.model_id ?? ''].filter(Boolean).join(` ${g.sep} `)

  let body: ReactNode
  if (!agentId) {
    body = <Text color={theme.color.muted}>Select an agent first.</Text>
  } else if (s.error) {
    body = <Text color={theme.color.error} wrap="wrap">{s.error}</Text>
  } else if (!data) {
    body = <Spinner label={`Measuring context${g.ellipsis}`} color={theme.color.live} />
  } else if (!data.available) {
    body = (
      <Box flexDirection="column">
        <Text color={theme.color.muted} wrap="wrap">
          {s.loop === MAIN_LOOP
            ? 'Nothing to measure: the agent is not running (start it, or send it a message).'
            : `Nothing to measure: the ${s.loop} loop has no running executor (it has not run yet, is disabled, or was put to sleep).`}
        </Text>
        <Text color={theme.color.dim}>{thresholdText(data, formatCount)}</Text>
      </Box>
    )
  } else {
    const total = data.totalTokens ?? 0
    const pct = data.percent ?? 0
    const barWidth = Math.max(10, inner - 24)
    const bar = barText(total, data.compactThreshold, barWidth, theme.ascii)
    const color = pressureColor(theme, pct)
    const over = total > data.compactThreshold
    const differs = data.compactThreshold !== data.agentCompactThreshold
    const rowBar = Math.min(18, Math.max(6, Math.floor(inner * 0.22)))
    const labelWidth = Math.max(8, inner - 2 - rowBar - 1 - 7 - 5 - 2)
    const shown = rows.slice(start, start + rowsHeight)
    body = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={color}>{bar.filled}</Text>
          <Text color={theme.color.dim}>{bar.empty}</Text>
          <Text color={theme.color.dim}>{g.vbar}</Text>
          <Text bold> {formatCount(total)}</Text>
          <Text color={theme.color.muted}> / {formatCount(data.compactThreshold)} </Text>
          <Text bold color={color}>{pct}%</Text>
        </Text>
        <Text color={theme.color.dim} wrap="truncate-end">
          {over ? `over the threshold: compacts before the next request ${g.sep} ` : ''}{thresholdText(data, formatCount)}{differs ? ` ${g.sep} agent: ${formatCount(data.agentCompactThreshold)}` : ''}
        </Text>
        <Box marginTop={1} flexDirection="column" height={Math.min(rows.length, rowsHeight)}>
          {shown.map((row, i) => (
            <RowLine key={`${start + i}`} row={row} selectedId={selected?.id} total={total} labelWidth={labelWidth} rowBar={rowBar} theme={theme} />
          ))}
        </Box>
        {rows.length > rowsHeight ? <Text color={theme.color.dim}>{`${start + 1}-${Math.min(rows.length, start + rowsHeight)} of ${rows.length} rows`}</Text> : null}
        <Box marginTop={1}><Text color={theme.color.muted} wrap="truncate-end">{selected ? `${selected.label}: ${selected.note}` : ''}</Text></Box>
        <Text color={theme.color.dim} wrap="truncate-end">
          {s.compacting ? `Compacting ${s.loop}${g.ellipsis}` : s.loading ? `Re-measuring${g.ellipsis}` : s.measuredAt ? `Measured ${formatClock(s.measuredAt)} ${g.sep} conversation estimated, the rest tokenized` : ''}
        </Text>
      </Box>
    )
  }

  return (
    <Modal title={`Context ${g.sep} ${truncate(header, inner - 12)}`} width={dialogWidth} hints={hints} onClose={close}>
      {body}
    </Modal>
  )
}

function RowLine({ row, selectedId, total, labelWidth, rowBar, theme }: { row: ContextRow; selectedId?: string; total: number; labelWidth: number; rowBar: number; theme: Theme }) {
  const g = theme.glyph
  const share = (tokens: number) => (total > 0 ? `${Math.round((tokens / total) * 100)}%` : '0%')
  if (row.kind === 'category') {
    const c = row.category
    const isSel = c.id === selectedId
    const marker = row.expandable ? (row.expanded ? g.expanded : g.collapsed) : ' '
    const label = `${marker} ${c.label}${c.count !== undefined ? ` (${c.count})` : ''}`
    const bar = barText(c.tokens, total, rowBar, theme.ascii)
    return (
      <Text wrap="truncate-end" inverse={theme.mono && isSel} bold={isSel}>
        <Text color={isSel ? theme.color.accent : theme.color.dim}>{isSel ? g.pointer : ' '} </Text>
        <Text color={isSel ? theme.color.text : theme.color.muted}>{fit(truncate(label, labelWidth), labelWidth)}</Text>
        <Text> </Text>
        <Text color={theme.color.accent}>{bar.filled}</Text>
        <Text color={theme.color.dim}>{bar.empty}</Text>
        <Text>{fit(formatCount(c.tokens), 7, 'right')}</Text>
        <Text color={theme.color.dim}>{fit(share(c.tokens), 5, 'right')}</Text>
      </Text>
    )
  }
  if (row.kind === 'more') {
    return <Text color={theme.color.dim} wrap="truncate-end">{`      ${g.ellipsis} ${row.hidden} smaller not shown`}</Text>
  }
  const name = `    ${row.name}${row.detail ? ` (${row.detail})` : ''}`
  return (
    <Text wrap="truncate-end">
      <Text color={theme.color.dim}>  </Text>
      <Text color={theme.color.muted}>{fit(truncate(name, labelWidth + 1 + rowBar), labelWidth + 1 + rowBar)}</Text>
      <Text color={theme.color.muted}>{fit(formatCount(row.tokens), 7, 'right')}</Text>
      <Text color={theme.color.dim}>{fit(share(row.tokens), 5, 'right')}</Text>
    </Text>
  )
}
