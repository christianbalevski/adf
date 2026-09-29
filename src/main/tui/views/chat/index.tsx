// Chat: one conversation per (agent, loop). Loop tabs on top, a virtualized
// transcript (history backfill + live events), the approval/ask dock and a
// turn footer. The shell's prompt is the composer; this view adds per-loop
// behaviour to it (answering asks, Esc to interrupt, queued sends).

import { useEffect, useRef, useState } from 'react'
import { findTracked } from '../../state/tracked'
import { StoppedAgentPanel } from '../fleet/stopped'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from '../../app/theme'
import { WHEEL_STEP, elementRect, keyLabel, useClick, useKeyRouter, useKeys, useWheel, type KeyHandler } from '../../app/keys'
import { newlineKey } from '../../app/terminal'
import { viewsHint } from '../../app/StatusBar'
import { useActions, useClient, useStore, useTuiSelector, shallowEqual } from '../../state/store'
import { useSelectedTracked, useAuthNeed, useFocus, useLoop, useSelectedAgent, useSelectedLoop, useTranscript, useViewState } from '../../state/hooks'
import { authNeedText } from '../../auth/model'
import { shortUrl, siteOf, type Site } from '../../web/model'
import { openSite } from '../../web/ops'
import { transcriptKey, type AgentEntry, type LoopState, type TranscriptItem, type TuiState } from '../../state/types'
import { displayWidth, oneLine, truncate } from '../../ui/text'
import { MAIN_LOOP, type Timer } from '../../api/types'
import type { CommandScope } from '../../commands/types'
import type { PromptCompletion, ViewDefinition, ViewProps } from '../types'
import { TranscriptItemView } from './Transcript'
import { LoopTabs } from './LoopTabs'
import { Dock, dockHeight, topCard, type DockAction, type DockModel } from './Dock'
import { Footer } from './Footer'
import { loopContextPercent } from '../../context/model'
import { ApprovalDetailsOverlay, DENY_OVERLAY, DETAILS_OVERLAY, DenyOverlay } from './overlays'
import { alwaysApprove, rejectWithFeedback } from './approvals'
import type { TaskListEntry } from '../../api/types'
import { chatCommands, readChatState } from './commands'
import { isPromptEmpty, isPromptMenuOpen } from '../../app/Prompt'
import {
  CHAT_VIEW,
  FOLLOW,
  applyMention,
  completeMention,
  mentionAt,
  INITIAL_CHAT_STATE,
  copyToClipboard,
  cycleLoop,
  digestEvents,
  fitInfoSegments,
  wakesText,
  type InfoSegment,
  isExpandable,
  itemHeight,
  itemText,
  lastReply,
  loopRunning,
  loopStateLabel,
  loopTabs,
  navigate,
  offsetOf,
  pendingAsksFor,
  pendingTasksFor,
  posAt,
  queuedItems,
  windowAt,
  withMarkers,
  type ChatState,
  type ScrollPos,
  type TimerLookup,
} from './model'

/** Loop kinds of activity that count as "something new happened here". */
const UNSEEN_EVENTS = new Set(['turn.delta', 'turn.completed', 'tool.started', 'hil.requested', 'ask.requested', 'agent.error', 'message.received', 'timer.fired', 'loop.compacted'])

const APPROVE_ARM_MS = 2500

function agentLabel(agent: AgentEntry | undefined): string {
  return agent ? agent.summary.handle || agent.summary.name || agent.summary.id : ''
}

/** Registers one commit after mount, so it sits above the shell prompt's own input handler. */
function LateKeys({ handler, layer }: { handler: KeyHandler; layer: 'input' }) {
  useKeys(handler, { layer })
  return null
}

function ChatView({ width: paneWidth, height, focused }: ViewProps) {
  // One column of air on each side, like the other views.
  const width = Math.max(10, paneWidth - 2)
  const theme = useTheme()
  const g = theme.glyph
  const store = useStore()
  const actions = useActions()
  const client = useClient()
  const agent = useSelectedAgent()
  const stopped = useSelectedTracked()
  const authNeed = useAuthNeed(agent?.summary.id)
  const agentId = agent?.summary.id ?? null
  const loopName = useSelectedLoop()
  const loop = useLoop(agentId, loopName)
  const transcript = useTranscript(agentId, loopName)
  const [chat, setChat] = useViewState<ChatState>(CHAT_VIEW, INITIAL_CHAT_STATE)
  const focusZone = useFocus()
  const key = agentId ? transcriptKey(agentId, loopName) : ''
  const mountedAt = useRef(Date.now())
  const [late, setLate] = useState(false)
  useEffect(() => { setLate(true) }, [])

  // --- data -----------------------------------------------------------------

  useEffect(() => {
    if (agentId) void actions.ensureTranscript(agentId, loopName)
  }, [agentId, loopName])

  const [timers, setTimers] = useState<Record<string, Timer[]>>({})
  const refetchTimers = (id: string) => {
    client.timers(id).then(result => setTimers(prev => ({ ...prev, [id]: result.timers }))).catch(() => {
      setTimers(prev => (prev[id] ? prev : { ...prev, [id]: [] }))
    })
  }
  const loopCount = agent?.loops?.length ?? 0
  useEffect(() => { if (agentId) refetchTimers(agentId) }, [agentId, loopCount])

  const lastEvents = useTuiSelector(s => s.lastEvents)
  const digested = useRef<ChatState['digested'] | null>(null)
  const timerAttempts = useRef(new Set<string>())
  useEffect(() => {
    const current = (store.getState().viewState[CHAT_VIEW] as ChatState | undefined) ?? INITIAL_CHAT_STATE
    if (!digested.current) digested.current = current.digested
    const lookup: TimerLookup = (id, timerId) => {
      const found = timers[id]?.find(t => t.id === timerId)
      if (found) return found
      const attempt = `${id}:${timerId}`
      if (!timerAttempts.current.has(attempt)) {
        timerAttempts.current.add(attempt)
        refetchTimers(id)
        return 'wait'
      }
      return 'unknown'
    }
    const { next } = digestEvents({ ...current, digested: digested.current }, lastEvents, lookup)
    digested.current = next.digested
    if (next.markers !== current.markers || next.turns !== current.turns) setChat(prev => ({ ...prev, markers: next.markers, turns: next.turns, digested: next.digested }))
  }, [lastEvents, timers])

  // Unseen activity in the loops not on screen.
  const latest = useTuiSelector(s => {
    const out: Record<string, number> = {}
    if (!agentId) return out
    for (const a of s.activity) if (a.agentId === agentId && a.loop !== loopName && UNSEEN_EVENTS.has(a.type)) out[a.loop] = a.at
    return out
  }, shallowEqual)
  useEffect(() => {
    if (!agentId) return
    const k = transcriptKey(agentId, loopName)
    return () => {
      const at = Date.now()
      setChat(prev => ({ ...prev, seen: { ...prev.seen, [k]: at } }))
    }
  }, [agentId, loopName])

  const transcripts = useTuiSelector(s => s.transcripts)
  // The agent's status line now sits on the composer's top border (app/ComposerTop.tsx); the website stays here.
  useTuiSelector(s => s.web?.server)
  const site = siteOf(store.getState(), agentId)

  // --- derived --------------------------------------------------------------

  const tabs = loopTabs(agent)
  const running = loopRunning(agent, loop) || transcript.live
  const state = loopStateLabel(agent, loop, loopName)
  const turn = chat.turns[key]
  const turnStart = running ? (turn && turn.endedAt === undefined ? turn.startedAt : mountedAt.current) : null
  const tasks = pendingTasksFor(agent, loopName)
  const asks = pendingAsksFor(agent, loopName, transcripts)
  const queued = queuedItems(transcript.items, running, turnStart)
  const queuedIds = new Set(queued.map(q => q.id))
  const dockModel: DockModel = { tasks, asks, suspended: loopName === MAIN_LOOP && agent?.executorState === 'suspended', queued }
  const unseen = new Set(Object.entries(latest).filter(([name, at]) => at > (chat.seen[agentId ? transcriptKey(agentId, name) : ''] ?? 0)).map(([name]) => name))
  const pendingLoops = new Set((agent?.pendingTasks ?? []).filter(t => t.status === 'pending_approval').map(t => (typeof t.origin === 'string' && t.origin.startsWith('loop:') ? t.origin.slice(5) : MAIN_LOOP)))

  const markers = chat.markers[key]
  const older: TranscriptItem[] = transcript.oldestOffset > 0
    ? [{ id: 'chat:older', at: 0, local: true, kind: 'notice', level: 'info', text: transcript.loading ? `loading earlier history${g.ellipsis}` : `${transcript.oldestOffset} earlier rows ${g.sep} scroll up or Home to load` }]
    : []
  const items = useMergedItems(transcript.items, markers, older)

  const heightCache = useRef(new WeakMap<TranscriptItem, { w: number; f: string; h: number }>())
  const isExpanded = (item: TranscriptItem) => !!chat.expanded[`${key}|${item.id}`]
  const heights = items.map(item => {
    const expanded = isExpanded(item)
    const f = `${expanded ? 1 : 0}${chat.showThinking ? 1 : 0}${queuedIds.has(item.id) ? 1 : 0}`
    const cached = heightCache.current.get(item)
    if (cached && cached.w === width && cached.f === f) return cached.h
    const h = Math.max(1, itemHeight(item, width, { expanded, showThinking: chat.showThinking }))
    heightCache.current.set(item, { w: width, f, h })
    return h
  })
  const keys = items.map(item => item.id)

  const infoRows = 1
  const dockRows = agentId ? dockHeight(dockModel, width) : 0
  const paneHeight = Math.max(2, height - 1 - infoRows - 1 - dockRows)
  const offset = offsetOf(chat.scroll[key], keys, heights)
  const scrolled = offset > 0
  const viewport = Math.max(1, paneHeight - (scrolled ? 1 : 0))
  const win = windowAt(heights, offset, viewport)
  const selectedId = chat.selected[key] ?? null
  const topVisible = win.start === 0 && heights.slice(0, win.end + 1).reduce((a, b) => a + b, 0) - win.clip <= viewport

  const loadOlderGuard = useRef('')
  useEffect(() => {
    if (!agentId || !scrolled || !topVisible || transcript.loading || transcript.oldestOffset <= 0) return
    const guard = `${key}:${transcript.oldestOffset}`
    if (loadOlderGuard.current === guard) return
    loadOlderGuard.current = guard
    void actions.loadOlder(agentId, loopName)
  }, [scrolled, topVisible, transcript.oldestOffset, transcript.loading, key])

  // --- actions --------------------------------------------------------------

  const patch = (fn: (prev: ChatState) => Partial<ChatState>) => setChat(prev => ({ ...prev, ...fn(prev) }))
  const scrollTo = (nextOffset: number) => patch(prev => ({ scroll: { ...prev.scroll, [key]: posAt(nextOffset, keys, heights, viewport) } }))
  const follow = () => patch(prev => ({ scroll: { ...prev.scroll, [key]: FOLLOW }, selected: { ...prev.selected, [key]: null } }))
  const scrollBy = (delta: number) => {
    const max = Math.max(0, win.total - viewport)
    if (delta > 0 && offset >= max && agentId) void actions.loadOlder(agentId, loopName)
    const next = Math.max(0, Math.min(max, offset + delta))
    if (next === 0) follow()
    else scrollTo(next)
  }
  // ↑/↓ move the selection item by item; a selected item taller than the view
  // scrolls inside itself first (half a view per press).
  const select = (dir: -1 | 1) => {
    if (items.length === 0) return
    const at = selectedId ? keys.indexOf(selectedId) : -1
    const nav = navigate(heights, at, offset, viewport, dir, Math.max(1, Math.floor(viewport / 2)), win.end)
    if (nav.loadOlder && agentId) void actions.loadOlder(agentId, loopName)
    if (nav.index === 'follow') { follow(); return }
    const index = nav.index
    patch(prev => ({
      selected: { ...prev.selected, [key]: keys[index] },
      scroll: { ...prev.scroll, [key]: posAt(nav.offset, keys, heights, viewport) },
    }))
  }
  const clearSelection = () => {
    if (!selectedId) return false
    patch(prev => ({ selected: { ...prev.selected, [key]: null } }))
    return true
  }
  const selectedItem = selectedId ? items.find(item => item.id === selectedId) : undefined
  const toggleItem = (target: TranscriptItem) => {
    const k = `${key}|${target.id}`
    const expandable = isExpandable(target)
    // Expanding grows the item downwards: keep its first row on screen (it
    // would otherwise scroll up out of view at the live end).
    let scroll: ScrollPos | undefined
    const index = keys.indexOf(target.id)
    if (expandable && !chat.expanded[k] && index >= 0) {
      const grown = heights.slice()
      grown[index] = Math.max(1, itemHeight(target, width, { expanded: true, showThinking: chat.showThinking }))
      let below = 0
      for (let i = index + 1; i < grown.length; i++) below += grown[i]
      const top = below + grown[index]
      // Scrolled off the live end the "newer rows below" line takes a row.
      const vp = Math.max(1, paneHeight - 1)
      if (top > offset + viewport) scroll = posAt(top - vp, keys, grown, vp)
    }
    patch(prev => ({
      ...(expandable ? { expanded: { ...prev.expanded, [k]: !prev.expanded[k] } } : {}),
      ...(scroll ? { scroll: { ...prev.scroll, [key]: scroll } } : {}),
      selected: { ...prev.selected, [key]: target.id },
    }))
  }
  const toggle = () => {
    const target = selectedItem ?? [...items].reverse().find(isExpandable)
    if (!target || !isExpandable(target)) return
    toggleItem(target)
  }
  const switchLoop = (delta: number) => {
    if (!agentId || tabs.length < 2) return
    actions.selectLoop(agentId, cycleLoop(tabs, loopName, delta))
  }
  const copy = async () => {
    const text = selectedItem ? itemText(selectedItem) : lastReply(transcript.items)
    if (!text) { actions.toast('Nothing to copy yet', 'warn'); return }
    const ok = await copyToClipboard(text)
    actions.toast(ok ? `Copied ${text.length} chars` : `Clipboard unavailable: ${truncate(oneLine(text), 120)}`, ok ? 'success' : 'warn')
  }
  const approveTarget = () => {
    if (selectedItem?.kind === 'hil' && selectedItem.status === 'pending') {
      const taskId = selectedItem.taskId
      return { taskId, tool: selectedItem.tool, task: tasks.find(t => t.id === taskId) }
    }
    const task = tasks[0]
    return task ? { taskId: task.id, tool: task.tool, task } : null
  }
  // The approval card's actions: keys (y / a armed, see below) and clicks.
  const dockAction = (action: DockAction) => {
    if (!agentId) return
    if (action === 'resume') { void actions.respondSuspend(agentId, true); return }
    if (action === 'shutdown') {
      void actions.confirm({ title: 'Shut down', message: `Shut ${agentLabel(agent)} down instead of resuming?`, danger: true })
        .then(ok => { if (ok) void actions.respondSuspend(agentId, false) })
      return
    }
    const target = approveTarget()
    if (!target) return
    const task = target.task ?? { id: target.taskId, tool: target.tool, args: '{}', status: 'pending_approval', created_at: 0 } as TaskListEntry
    if (action === 'approve') void actions.resolveTask(agentId, target.taskId, 'approve')
    else if (action === 'always') void alwaysApprove(actions, agentId, agentLabel(agent), task)
    else if (action === 'reject') void actions.resolveTask(agentId, target.taskId, 'deny')
    else if (action === 'feedback') rejectWithFeedback(actions, agentId, task)
    else actions.pushOverlay({ kind: DETAILS_OVERLAY, props: { agentId, taskId: target.taskId, tool: target.tool } })
  }
  const interrupt = () => {
    if (!agentId) return false
    void actions.interrupt(agentId, loopName)
    return true
  }
  // `y` approves at once only on a selected pending approval; otherwise it
  // arms and a second `y` approves, so a stray keypress never runs a tool.
  const armed = useRef<{ taskId: string; key: string; at: number } | null>(null)

  // --- keys -----------------------------------------------------------------

  // The wheel without mouse mode (alternate scroll) arrives as several ↑/↓ in
  // one read. An arrow waits for the rest of its read: a burst scrolls the
  // transcript by lines; a single arrow moves the item selection (transcript
  // focused, or an empty composer) or, over composer text, is replayed to the
  // prompt as a key (caret / history).
  const router = useKeyRouter()
  const pendingArrow = useRef<{ input: string; key: Parameters<KeyHandler>[1]; delta: number; count: number; items: boolean } | null>(null)
  const replaying = useRef(false)
  const queueArrow = (input: string, k: Parameters<KeyHandler>[1], items: boolean): true => {
    const step = k.upArrow ? 1 : -1
    const pending = pendingArrow.current
    if (pending) { pending.delta += step; pending.count++; return true }
    pendingArrow.current = { input, key: k, delta: step, count: 1, items }
    setImmediate(() => {
      const p = pendingArrow.current
      pendingArrow.current = null
      if (!p) return
      if (p.count > 1) { if (p.delta) scrollBy(p.delta); return }
      if (p.items) { select(p.delta > 0 ? -1 : 1); return }
      replaying.current = true
      try { router.dispatch(p.input, p.key, { focus: 'input', overlayOpen: store.getState().overlays.length > 0 }) } finally { replaying.current = false }
    })
    return true
  }

  useKeys((input, k) => {
    if (!agentId) return false
    if ((k.ctrl || k.shift) && k.leftArrow) { switchLoop(-1); return true }
    if ((k.ctrl || k.shift) && k.rightArrow) { switchLoop(1); return true }
    if (k.ctrl || k.meta) return false
    if (k.leftArrow || input === '[') { switchLoop(-1); return true }
    if (k.rightArrow || input === ']') { switchLoop(1); return true }
    if (k.upArrow || k.downArrow) return queueArrow(input, k, true)
    if (input === 'k') { select(-1); return true }
    if (input === 'j') { select(1); return true }
    if (k.escape && clearSelection()) return true
    if (k.pageUp) { scrollBy(Math.max(1, viewport - 2)); return true }
    if (k.pageDown) { scrollBy(-Math.max(1, viewport - 2)); return true }
    if (k.home || input === 'g') { scrollBy(win.total); return true }
    if (k.end || input === 'G') { follow(); return true }
    if (k.return || input === ' ') { toggle(); return true }
    if (input === 't') { patch(prev => ({ showThinking: !prev.showThinking })); actions.toast(`Thinking ${chat.showThinking ? 'collapsed' : 'expanded'}`, 'info', 1500); return true }
    if (input === 'c') { void copy(); return true }
    if (input === 'w') { void openSite(store, agentId); return true }
    const card = topCard(dockModel)
    if (card === 'hil' && (input === 'y' || input === 'a')) {
      const target = approveTarget()
      if (!target) return false
      // A stray key never approves: y / a act at once only on a selected
      // pending approval; otherwise the first press arms and a second one acts.
      const explicit = selectedItem?.kind === 'hil' && selectedItem.status === 'pending' && selectedItem.taskId === target.taskId
      const prior = armed.current
      if (explicit || (prior && prior.taskId === target.taskId && prior.key === input && Date.now() - prior.at < APPROVE_ARM_MS)) {
        armed.current = null
        dockAction(input === 'y' ? 'approve' : 'always')
      } else {
        armed.current = { taskId: target.taskId, key: input, at: Date.now() }
        actions.toast(`Press ${input} again to ${input === 'y' ? 'approve' : 'always approve'} ${target.tool} (${target.taskId})`, 'warn', APPROVE_ARM_MS)
      }
      return true
    }
    if (card === 'hil' && (input === 'n' || input === 'f' || input === 'v')) {
      dockAction(input === 'n' ? 'reject' : input === 'f' ? 'feedback' : 'details')
      return true
    }
    if (card === 'suspend' && (input === 'y' || input === 'n')) { dockAction(input === 'y' ? 'resume' : 'shutdown'); return true }
    if (input === 'a' && card === 'ask') { actions.setFocus('input'); return true }
    return false
  }, { layer: 'main', active: focused })

  // Esc interrupts from the transcript too (the prompt's own layer is below).
  useKeys((_input, k) => {
    // From the sidebar Esc just leaves the sidebar (shell); it never interrupts.
    if (!k.escape || store.getState().focus === 'sidebar') return false
    if (running) return interrupt()
    return false
  }, { layer: 'view' })

  // The wheel scrolls the transcript whichever pane has focus.
  const transcriptRef = useRef<DOMElement>(null)
  useWheel(transcriptRef, delta => scrollBy(-delta * WHEEL_STEP), { active: !!agentId })

  // Mouse mode: a click on an item selects it; on a tool call, thinking,
  // context or approval it also expands / collapses it. The prompt keeps focus.
  const itemRefs = useRef(new Map<string, DOMElement>())
  useClick(transcriptRef, event => {
    const box = elementRect(transcriptRef.current)
    if (!box || event.y >= box.y + viewport) return false
    for (const [id, el] of itemRefs.current) {
      const rect = elementRect(el)
      if (!rect || event.y < rect.y || event.y >= rect.y + rect.height) continue
      const target = items.find(item => item.id === id)
      if (!target) return false
      toggleItem(target)
      return true
    }
    return false
  }, { active: !!agentId })

  // Runs before the prompt's own keys. Ctrl/Shift+←/→ are left to the prompt
  // (word jumps) and the shell (loop switch). An empty composer has nothing
  // to move through, so ↑/↓ select transcript items there (Enter / Space
  // expand the selected one, Esc lets go of it) and Home/End scroll; once
  // there is text they edit it (history: Ctrl+↑/↓).
  const inputKeys: KeyHandler = (input, k) => {
    if (!agentId) return false
    if (k.pageUp) { scrollBy(Math.max(1, viewport - 2)); return true }
    if (k.pageDown) { scrollBy(-Math.max(1, viewport - 2)); return true }
    // Sending jumps back to the live end, wherever the transcript was scrolled.
    if (k.return && !k.shift && !k.meta && !k.ctrl && !isPromptEmpty() && !isPromptMenuOpen() && offset > 0) follow()
    if (replaying.current) return false
    const plain = !k.ctrl && !k.meta && !k.shift && !isPromptMenuOpen()
    if (plain && (k.upArrow || k.downArrow)) return queueArrow(input, k, isPromptEmpty())
    if (plain && isPromptEmpty()) {
      if (k.home) { scrollBy(win.total); return true }
      if (k.end) { follow(); return true }
      if (selectedItem && (k.return || input === ' ')) { toggle(); return true }
      if (k.escape && clearSelection()) return true
    }
    // Esc interrupts a running turn; otherwise the shell takes it (twice clears
    // the text, an empty prompt goes up to the tab bar).
    if (k.escape && !isPromptMenuOpen() && running) return interrupt()
    return false
  }

  // --- render ---------------------------------------------------------------

  if (stopped && !agent) return <StoppedAgentPanel entry={stopped} width={paneWidth} height={height} focused={focused} what="conversation" />
  if (!agent || !agentId) {
    return (
      <Box flexDirection="column" padding={1} width={paneWidth} height={height}>
        <Text color={theme.color.muted}>No agent selected.</Text>
        <Text color={theme.color.dim}>Pick one in the sidebar (Tab), with /agent &lt;handle&gt;, or from the Fleet view (5).</Text>
      </Box>
    )
  }

  const label = agentLabel(agent)
  const loopTimers = (timers[agentId] ?? []).filter(t => !t.expired && (t.loop ?? MAIN_LOOP) === loopName)
  const infoSegments = fitInfoSegments(
    infoLineSegments({ isMain: loop?.info.isMain !== false && loopName === MAIN_LOOP, loop, timers: loopTimers, agent, site, authNeed: authNeed ? authNeedText(authNeed) : null, glyph: g }),
    width,
    displayWidth(` ${g.sep} `),
  )
  const model = loop?.info.config?.model?.model_id ?? agent.config?.model?.model_id ?? agent.lastModel
  const visible = items.slice(win.start, win.end + 1)
  // The selection shows while the transcript or the composer drives it.
  const showSelection = focused || focusZone === 'input'

  return (
    <Box flexDirection="column" width={paneWidth} height={height} paddingX={1}>
      <LoopTabs agentLabel={label} tabs={tabs} selected={loopName} unseen={unseen} pending={pendingLoops} width={width} />
      <Text wrap="truncate-end">
        {infoSegments.length === 0 ? ' ' : infoSegments.map((seg, i) => (
          <Text key={seg.key}>
            {i > 0 ? <Text color={theme.color.dim}> {g.sep} </Text> : null}
            <Text {...infoStyle(seg.key, theme)}>{seg.text}</Text>
          </Text>
        ))}
      </Text>
      <Box ref={transcriptRef} height={paneHeight} width={width} flexDirection="column" overflow="hidden">
        {items.length === 0 ? (
          <Box height={paneHeight} flexDirection="column" justifyContent="flex-end">
            <Text color={theme.color.muted}>
              {transcript.loading || !transcript.loaded ? `Loading ${loopName}${g.ellipsis}` : `No messages in ${loopName} yet ${g.sep} type below to talk to ${loopName === MAIN_LOOP ? label : `the ${loopName} loop`}`}
            </Text>
          </Box>
        ) : (
          <Box height={viewport} width={width} flexDirection="column" overflow="hidden" justifyContent="flex-end">
            <Box flexDirection="column" flexShrink={0} marginBottom={-win.clip}>
              {visible.map(item => (
                <Box key={item.id} flexShrink={0} ref={el => { if (el) itemRefs.current.set(item.id, el); else itemRefs.current.delete(item.id) }}>
                  <TranscriptItemView
                    item={item}
                    width={width}
                    selected={showSelection && item.id === selectedId}
                    expanded={isExpanded(item)}
                    showThinking={chat.showThinking}
                    queued={queuedIds.has(item.id)}
                  />
                </Box>
              ))}
            </Box>
          </Box>
        )}
        {scrolled ? (
          <Text wrap="truncate-end" color={theme.color.accent}>{g.expanded} {offset} newer row{offset === 1 ? '' : 's'} below {g.sep} End to follow live</Text>
        ) : null}
      </Box>
      {/* Keyed by width: after some resize sequences ink reuses a stale layout
          for the card and drops its title line; a fresh subtree lays out clean. */}
      <Dock key={`dock:${width}`} model={dockModel} width={width} focused={focused} agentLabel={loopName === MAIN_LOOP ? label : `${label} ${g.pointer} ${loopName}`} onAction={dockAction} />
      <Footer width={width} running={running} state={state} turn={turn} since={mountedAt.current} model={model} error={transcript.error} contextPercent={loopContextPercent(agent.config, loopName, turn?.lastInput)} />
      {late ? <LateKeys handler={inputKeys} layer="input" /> : null}
    </Box>
  )
}

function useMergedItems(items: TranscriptItem[], markers: ChatState['markers'][string] | undefined, older: TranscriptItem[]): TranscriptItem[] {
  const cache = useRef<{ items: TranscriptItem[]; markers: unknown; older: string; out: TranscriptItem[] } | null>(null)
  const olderKey = older.map(o => (o.kind === 'notice' ? o.text : '')).join()
  const c = cache.current
  if (c && c.items === items && c.markers === markers && c.older === olderKey) return c.out
  const out = [...older, ...withMarkers(items, markers)]
  cache.current = { items, markers, older: olderKey, out }
  return out
}

/**
 * The line under the loop tabs, most important first when narrow: sign-in
 * warning, disabled loop, host access, the loop's schedule, the inner loop's
 * goal, the website, autonomous, new inbox (the agent's status line is on the
 * composer's top border).
 */
export function infoLineSegments(input: {
  isMain: boolean
  loop: LoopState | undefined
  timers: Timer[]
  agent: AgentEntry
  site: Site | null
  authNeed: string | null
  glyph: { warn: string; check: string; sep: string }
  now?: number
}): InfoSegment[] {
  const { isMain, loop, agent, glyph } = input
  const out: InfoSegment[] = []
  if (input.authNeed) out.push({ key: 'auth', text: `${glyph.warn} ${input.authNeed}`, order: 0, priority: 0, flex: true })
  if (!isMain && loop && !loop.info.enabled) out.push({ key: 'disabled', text: `disabled: /loop on ${loop.info.name} to enable`, order: 1, priority: 1 })
  if (agent.config?.compute?.host_access === true) out.push({ key: 'host', text: `host ${glyph.check}`, order: 2, priority: 2 })
  const wakes = wakesText(input.timers, input.now, glyph.sep)
  if (wakes) out.push({ key: 'wakes', text: wakes, order: 5, priority: 3 })
  if (!isMain && loop) out.push({ key: 'goal', text: `goal: ${oneLine(loop.info.goal || '(none)')}`, order: 4, priority: 4, flex: true })
  if (input.site) out.push({ key: 'web', text: input.site.url ? `web ${shortUrl(input.site.url)}` : 'web server stopped (w)', order: 6, priority: 6 })
  if (!isMain && loop?.info.config?.autonomous) out.push({ key: 'autonomous', text: 'autonomous', order: 7, priority: 7 })
  if (isMain && agent.unreadInbox > 0) out.push({ key: 'inbox', text: `${agent.unreadInbox} new inbox`, order: 8, priority: 8 })
  return out
}

function infoStyle(key: string, theme: ReturnType<typeof useTheme>): { color?: string; bold?: boolean; underline?: boolean } {
  switch (key) {
    case 'auth': return { color: theme.color.warn, bold: true }
    case 'disabled': return { color: theme.color.warn }
    case 'host': return { color: theme.color.success }
    case 'status': return { color: theme.color.muted }
    case 'wakes': return { color: theme.color.info }
    case 'web': return { color: theme.color.live }
    case 'inbox': return { color: theme.color.info }
    default: return { color: theme.color.dim }
  }
}

// --- prompt integration ---------------------------------------------------------

function pendingAskFor(state: TuiState, agentId: string | null, loop: string) {
  if (!agentId) return undefined
  return pendingAsksFor(state.agents[agentId], loop, state.transcripts)[0]
}

function placeholder(scope: CommandScope): string {
  const state = scope.state()
  const agent = scope.agentId ? state.agents[scope.agentId] : undefined
  const stopped = scope.stoppedKey ? findTracked(state, scope.stoppedKey) : undefined
  if (stopped) return stopped.agent.status === 'needs_review' ? `${stopped.agent.name} is stopped and needs review · Shift+Tab, then s reviews it` : `${stopped.agent.name} is stopped · a message starts it, then sends · or Shift+Tab, then s`
  if (!agent || !scope.agentId) return 'Select an agent (Tab → sidebar) or type /help'
  const label = agentLabel(agent)
  const target = scope.loop === MAIN_LOOP ? label : `${label} › ${scope.loop}`
  if (pendingAskFor(state, scope.agentId, scope.loop)) return `Answer ${label}'s question · Enter sends the answer`
  const loopState = agent.loops?.find(l => l.info.name === scope.loop)
  if (loopState && !loopState.info.enabled) return `${scope.loop} is disabled · /loop on ${scope.loop} to enable it`
  if (loopRunning(agent, loopState)) return `Message ${target} · queued until the turn ends · Esc interrupts`
  return `Message ${target}   / commands · ${keyLabel(newlineKey())} newline`
}

// `@path` completion over the agent's files; the list is cached briefly per agent.
const FILES_TTL_MS = 10_000
const fileCache = new Map<string, { at: number; paths: Promise<string[]> }>()

async function completeFiles(value: string, cursor: number, scope: CommandScope): Promise<PromptCompletion[]> {
  const mention = mentionAt(value, cursor)
  if (!mention || !scope.agentId) return []
  const agentId = scope.agentId
  let cached = fileCache.get(agentId)
  if (!cached || Date.now() - cached.at > FILES_TTL_MS) {
    cached = { at: Date.now(), paths: scope.client.files(agentId).then(r => r.files.map(f => f.path)).catch(() => []) }
    fileCache.set(agentId, cached)
  }
  const paths = await cached.paths
  return completeMention(mention.partial, paths, 6).map(path => {
    const applied = applyMention(value, cursor, path)
    return { value: applied.value, cursor: applied.cursor, label: `@${path}`, description: 'agent file' }
  })
}

const chat: ViewDefinition = {
  id: CHAT_VIEW,
  title: 'Chat',
  key: '1',
  group: 'agent',
  component: ChatView,
  prompt: {
    placeholder,
    onSubmit: async (text, ctx) => {
      const ask = pendingAskFor(ctx.state(), ctx.agentId, ctx.loop)
      if (!ask || !ctx.agentId) return false
      await ctx.actions.answerAsk(ctx.agentId, ask.requestId, text, ask.loop ?? ctx.loop)
      return true
    },
    historyKey: scope => (scope.agentId ? transcriptKey(scope.agentId, scope.loop) : 'none'),
    draftKey: scope => (scope.agentId ? `chat:${transcriptKey(scope.agentId, scope.loop)}` : 'chat'),
    complete: completeFiles,
  },
  // Hints follow the focused zone: the composer, or the transcript.
  keyHints: scope => {
    const state = scope.state()
    const agent = scope.agentId ? state.agents[scope.agentId] : undefined
    if (!agent && scope.stoppedKey) return state.focus === 'main' ? [{ keys: 's enter', label: 'start' }] : [{ keys: 'shift+tab', label: 'then s: start' }, { keys: '/', label: 'commands' }]
    if (!agent) return [{ keys: 'shift+tab', label: 'sidebar: pick an agent' }, { keys: '/', label: 'commands' }]
    const loopKeys = { keys: 'shift+left right', label: 'loop' }
    // Less is more: the rest is in /help. "Esc interrupts" shows in the turn
    // footer, the newline key in the composer placeholder.
    if (state.focus === 'main') {
      const pending = pendingTasksFor(agent, scope.loop).length > 0
      return [
        ...(pending ? [{ keys: 'y', label: 'approve' }] : []),
        { keys: 'up down', label: 'select' },
        { keys: 'enter', label: 'expand' },
        { keys: 'c', label: 'copy' },
        loopKeys,
      ]
    }
    return [
      loopKeys,
      // Digits type into the composer; say how to reach the other views.
      viewsHint(),
      { keys: 'ctrl+up down', label: 'history' },
    ]
  },
  helpKeys: [
    {
      keys: [
        { keys: 'enter', label: 'Send to the selected loop (queued while it runs)' },
        { keys: 'shift+left shift+right', label: 'Previous / next loop tab (also Ctrl+←/→ on an empty prompt; ← → in the transcript)' },
        { keys: 'up down', label: 'Select the previous / next transcript item (message, reply, thinking, tool call, notice, approval, marker): from an empty prompt or the transcript (j k). An item taller than the view scrolls inside first' },
        { keys: 'enter space', label: 'Expand / collapse the selected item (tool call input + result, thinking, context, approval, wake). Mouse mode: click the item' },
        { keys: 'esc', label: 'Let go of the selected item (before interrupting)' },
        { keys: 'pgup pgdn', label: 'Scroll by pages (also while typing); the mouse wheel scrolls by lines' },
        { keys: 'home end', label: 'With an empty prompt: top, loading older history · follow live (g G in the transcript)' },
        { keys: 'ctrl+up ctrl+down', label: 'Prompt history of this agent › loop (↑ ↓ too once the prompt has text, on its first / last line)' },
        { keys: 'shift+enter alt+enter', label: 'Newline in the prompt (Ctrl+J, or \\ then Enter; /terminal-setup for Shift+Enter)' },
        { keys: 't', label: 'Expand / collapse all thinking' },
        { keys: 'c', label: 'Copy the selected item, else the last reply' },
        { keys: 'w', label: 'Open the agent’s website (when it serves one; starts the web server if stopped)' },
        { keys: 'esc', label: 'Interrupt this loop’s running turn: it goes idle and keeps working (not a stop)' },
        { keys: 'esc esc', label: 'Clear the prompt' },
        { keys: 'tab shift+tab', label: 'Leave the prompt for the transcript / sidebar (Esc never does)' },
        { keys: '@', label: 'In the prompt: complete an agent file path (Tab)' },
      ],
    },
    {
      title: 'Approvals and questions (the card under the transcript)',
      keys: [
        { keys: 'y', label: 'Approve: press twice, or once on a selected approval · resume a suspended agent. Mouse mode: click the card’s buttons' },
        { keys: 'a', label: 'Always approve this tool for the agent (twice, then confirm; it won’t ask again). Not offered for protection overrides: those are one-time only · on a question card: answer it' },
        { keys: 'n', label: 'Reject · shut a suspended agent down (asks)' },
        { keys: 'f', label: 'Reject with feedback: the agent sees your text' },
        { keys: 'v', label: 'Full details of the tool call' },
        { keys: '/approve', label: '/approve [all|always] · /reject [feedback]: the same from the prompt' },
      ],
    },
  ],
  overlays: {
    [DENY_OVERLAY]: DenyOverlay,
    [DETAILS_OVERLAY]: ApprovalDetailsOverlay,
  },
  ...chatCommands,
}

export default chat
