import { Component, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { Box, Text, useApp, useBoxMetrics, useInput, useStdin, useStdout, useWindowSize, type DOMElement } from 'ink'
import { useTheme } from './theme'
import { useShell } from './shell-context'
import { elementRect, rectContains, useKeyRouter, useKeys } from './keys'
import { noteRawInput, noteShiftEnter, parseMouse } from './terminal'
import { createMouseController } from './selection'
import { getScreenText, setHighlight, setRepaint } from './screen'
import { copyToClipboard, readClipboard } from './clipboard'
import { insertIntoFocusedInput } from '../ui/TextInput'
import { readLayout, setSidebarHidden } from './layout'
import { Header, createHeaderHits } from './Header'
import { FleetSidebar } from '../views/fleet/Sidebar'
import { StatusBar } from './StatusBar'
import { Toasts } from './Toasts'
import { Prompt, insertIntoPrompt, isPromptEmpty, isPromptMenuOpen } from './Prompt'
import { OverlayHost } from './OverlayHost'
import { openPalette } from './palette'
import { createQuitGuard, QUIT_WINDOW_MS } from '../commands/builtin/quit'
import { useStore, useTuiSelector } from '../state/store'
import { useActiveView, useFocus, useOverlays, useToasts } from '../state/hooks'
import type { FocusZone } from '../state/types'
import { MAIN_LOOP } from '../api/types'
import { toggleWebServer } from '../web/ops'

/** Below this width the sidebar collapses (Tab still reaches main + prompt). Ctrl+B hides it at any width. */
export const SIDEBAR_MIN_COLUMNS = 70
const PROMPT_ROWS = 3
const RESIZE_SETTLE_MS = 150
const CLEAR_SCREEN = '\u001b[2J\u001b[H'
/** Two Esc presses within this window clear a prompt that has text. */
export const DOUBLE_ESC_MS = 600

class ViewErrorBoundary extends Component<{ viewId: string; children?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { viewId: string }) {
    if (prev.viewId !== this.props.viewId && this.state.error) this.setState({ error: null })
  }

  render() {
    if (this.state.error) return <ViewCrashed viewId={this.props.viewId} error={this.state.error} />
    return this.props.children
  }
}

function ViewCrashed({ viewId, error }: { viewId: string; error: Error }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.color.error} bold>View "{viewId}" crashed</Text>
      <Text wrap="wrap" color={theme.color.text}>{error.message}</Text>
      <Text color={theme.color.muted}>Switch views or press Ctrl+K. The rest of the TUI keeps running.</Text>
    </Box>
  )
}

/** Select the previous/next loop (main first, then inner loops) of the selected agent. */
function cycleLoop(store: ReturnType<typeof useStore>, delta: number): void {
  const state = store.getState()
  const agentId = state.selectedAgentId
  const loops = agentId ? state.agents[agentId]?.loops ?? [] : []
  if (!agentId || loops.length < 2) return
  const current = state.selectedLoop[agentId] ?? MAIN_LOOP
  const at = Math.max(0, loops.findIndex(l => l.info.name === current))
  store.actions.selectLoop(agentId, loops[(at + delta + loops.length) % loops.length].info.name)
}

/** The frame: header, sidebar + main pane (+ prompt), toasts, status bar, overlays. */
export function Shell() {
  const theme = useTheme()
  const store = useStore()
  const router = useKeyRouter()
  const { views, exit, reserveRows = 0, reserveColumns = 0 } = useShell()
  const { columns: windowColumns, rows: windowRows } = useWindowSize()
  const columns = Math.max(20, windowColumns - reserveColumns)
  const rows = Math.max(6, windowRows - reserveRows)
  // A resize reflows the old frame in the terminal; incremental rendering
  // would then diff against lines that moved. Once the resizes settle and ink
  // has flushed the frame for the new size, repaint the whole frame from a
  // clean screen (ink's write path clears its line diff and replays the frame).
  const { write } = useStdout()
  const { waitUntilRenderFlush } = useApp()
  const sized = useRef(`${windowColumns}x${windowRows}`)
  useEffect(() => {
    const size = `${windowColumns}x${windowRows}`
    if (sized.current === size) return
    sized.current = size
    let cancelled = false
    const timer = setTimeout(() => {
      void waitUntilRenderFlush().then(() => { if (!cancelled) write(CLEAR_SCREEN) })
    }, RESIZE_SETTLE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [windowColumns, windowRows])
  const activeView = useActiveView()
  const focus = useFocus()
  const overlays = useOverlays()
  const toasts = useToasts()
  const viewRef = useRef<DOMElement>(null)
  const sidebarRef = useRef<DOMElement>(null)
  const promptRef = useRef<DOMElement>(null)
  const sidebarHidden = useTuiSelector(s => readLayout(s).sidebarHidden)
  const headerRef = useRef<DOMElement>(null)
  const headerHits = useMemo(() => createHeaderHits(), [])
  const metrics = useBoxMetrics(viewRef as RefObject<DOMElement>)
  const quitGuard = useMemo(() => createQuitGuard(), [])
  const lastEscAt = useRef(0)

  const view = views.find(v => v.id === activeView) ?? views[0]
  const showSidebar = !!view && !view.fullWidth && !sidebarHidden && columns >= SIDEBAR_MIN_COLUMNS
  const sidebarWidth = Math.max(22, Math.min(34, Math.floor(columns * 0.24)))
  const mainWidth = Math.max(10, columns - (showSidebar ? sidebarWidth : 0))
  const promptShown = !!view && view.prompt !== false
  const toastRows = Math.min(3, toasts.length)
  const bodyHeight = Math.max(3, rows - 2 - toastRows)
  const viewHeight = metrics.hasMeasured ? metrics.height : Math.max(1, bodyHeight - (promptShown ? PROMPT_ROWS : 0))
  const viewWidth = metrics.hasMeasured ? metrics.width : mainWidth
  const overlayOpen = overlays.length > 0

  const zones: FocusZone[] = [...(showSidebar ? ['sidebar' as const] : []), 'main', ...(promptShown ? ['input' as const] : [])]

  useEffect(() => {
    if (focus !== 'tabs' && !zones.includes(focus)) store.actions.setFocus('main')
  }, [focus, showSidebar, promptShown])

  /** Where a view is entered from the tab bar: Chat's prompt, else its main pane. */
  const enterZone = (id: string): FocusZone => (id === 'chat' && views.find(v => v.id === id)?.prompt !== false ? 'input' : 'main')

  const live = useRef({ columns: windowColumns, rows: windowRows, promptShown })
  live.current = { columns: windowColumns, rows: windowRows, promptShown }

  // Every keypress's raw bytes, recorded before any handler runs (ink folds
  // Backspace / Ctrl+Backspace together; see terminal.ts lastRawInput).
  const { internal_eventEmitter: stdinEvents } = useStdin() as unknown as { internal_eventEmitter?: NodeJS.EventEmitter }
  useLayoutEffect(() => {
    if (!stdinEvents) return
    const onInput = (data: unknown) => noteRawInput(typeof data === 'string' ? data : String(data))
    stdinEvents.prependListener('input', onInput)
    return () => { stdinEvents.removeListener('input', onInput) }
  }, [stdinEvents])

  // Clearing the selection highlight = ink writes its whole frame again.
  useEffect(() => {
    setRepaint(() => write(''))
    return () => setRepaint(null)
  }, [write])

  // Mouse mode: presses, drags and releases (the wheel is routed by the key router).
  const mouseCtl = useMemo(() => createMouseController({
    now: () => Date.now(),
    screen: getScreenText,
    paneAt: (x, y) => {
      const full = { x0: 0, y0: 0, x1: live.current.columns, y1: live.current.rows }
      if (store.getState().overlays.length > 0) return full
      for (const ref of [promptRef, sidebarRef, viewRef]) {
        const rect = elementRect(ref.current)
        if (rect && rectContains(rect, x, y)) return { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height }
      }
      return full
    },
    pressHandled: mouse => {
      if (store.getState().overlays.length > 0) return false
      // The header: a tab switches views, the web badge starts / stops the web server.
      const header = elementRect(headerRef.current)
      if (!header || mouse.y !== header.y) return false
      const x = mouse.x - header.x
      const tab = headerHits.tabs.find(t => x >= t.x0 && x < t.x1)
      if (tab) store.actions.setView(tab.id)
      else if (headerHits.web && x >= headerHits.web.x0 && x < headerHits.web.x1) void toggleWebServer(store)
      return true
    },
    click: mouse => {
      const state = store.getState()
      if (state.overlays.length > 0) return
      // A region under the pointer (a transcript item) may use the click; the
      // pane under it takes focus, except that the prompt keeps it for a used click.
      const used = router.click(mouse)
      const zone: FocusZone | null = rectContains(elementRect(promptRef.current), mouse.x, mouse.y) ? 'input'
        : rectContains(elementRect(sidebarRef.current), mouse.x, mouse.y) ? 'sidebar'
          : rectContains(elementRect(viewRef.current), mouse.x, mouse.y) ? 'main' : null
      if (zone && zone !== state.focus && !(used && state.focus === 'input')) store.actions.setFocus(zone)
    },
    rightClick: () => {
      void readClipboard().then(text => {
        if (!text) { store.actions.toast('Nothing to paste: the clipboard is empty or unreadable (Ctrl+V / Cmd+V pastes too)', 'warn', 2500); return }
        const clean = text.replace(/\r\n?/g, '\n')
        if (store.getState().overlays.length > 0) { insertIntoFocusedInput(clean); return }
        if (!promptShown) return
        if (store.getState().focus !== 'input') store.actions.setFocus('input')
        insertIntoPrompt(clean)
      })
    },
    highlight: setHighlight,
    copy: text => {
      void copyToClipboard(text).then(ok => {
        store.actions.toast(ok ? `Copied ${text.length} char${text.length === 1 ? '' : 's'}` : 'Clipboard unavailable', ok ? 'success' : 'warn', 1500)
      })
    },
  }), [])

  useInput((input, key) => {
    const state = store.getState()
    const overlayOpen = state.overlays.length > 0
    // Mouse reports never reach key handlers (no stray `[<64;…M` in a prompt).
    const mouse = input.startsWith('[<') ? parseMouse(input) : null
    if (mouse) {
      if (mouse.kind === 'wheel') router.wheel(mouse, { overlayOpen })
      else mouseCtl.handle(mouse)
      return
    }
    // Any key lets go of a mouse selection.
    mouseCtl.clear()
    if (key.return && key.shift) noteShiftEnter()
    router.dispatch(input, key, { focus: state.focus, overlayOpen })
  })

  // The tab bar (Esc from a view with nothing left to cancel): ←/→ switch views
  // as the cursor moves (like any tab strip), Enter / ↓ go into the view.
  useKeys((input, key) => {
    if (key.ctrl || key.meta || key.shift) return false
    const at = Math.max(0, views.findIndex(v => v.id === store.getState().activeView))
    const go = (index: number) => {
      const next = views[(index + views.length) % views.length]
      if (next) { store.actions.setView(next.id); store.actions.setFocus('tabs') }
      return true
    }
    if (key.leftArrow || input === 'h') return go(at - 1)
    if (key.rightArrow || input === 'l') return go(at + 1)
    if (key.home) return go(0)
    if (key.end) return go(views.length - 1)
    if (key.return || key.downArrow || input === 'j') { store.actions.setFocus(enterZone(views[at]?.id ?? '')); return true }
    if (key.upArrow || input === 'k') return true
    if (input === 'w') { void toggleWebServer(store); return true }
    if (key.escape) return true
    return false
  }, { layer: 'tabs' })

  useKeys((input, key) => {
    const state = store.getState()
    if (key.ctrl && input === 'c') {
      // A non-empty prompt clears itself (input layer). A dialog that did not
      // take Ctrl+C itself is cancelled here. Otherwise: twice to quit.
      const top = state.overlays.at(-1)
      if (top) { store.actions.popOverlay(top.id); return true }
      quitGuard(exit, text => store.actions.toast(text, 'warn', QUIT_WINDOW_MS))
      return true
    }
    if (state.overlays.length > 0) return false
    if (key.ctrl && (input === 'k' || input === 'p')) { openPalette(store); return true }
    if (key.ctrl && !key.meta && input === 'b') { setSidebarHidden(store); return true }
    if (key.tab) {
      // From the tab bar, Tab carries on into the panes as if it sat before the first one.
      if (state.focus === 'tabs') { store.actions.setFocus(key.shift ? zones[zones.length - 1] : zones[0]); return true }
      const at = zones.indexOf(state.focus)
      const next = zones[(at + (key.shift ? zones.length - 1 : 1)) % zones.length]
      store.actions.setFocus(next)
      return true
    }
    // Loop switch: Shift+←/→ everywhere (stock macOS keeps Ctrl+←/→ for
    // Spaces); Ctrl+←/→ too, except in a prompt with text (word jumps there).
    if ((key.ctrl || key.shift) && !key.meta && (key.leftArrow || key.rightArrow)) { cycleLoop(store, key.leftArrow ? -1 : 1); return true }
    // Esc that nothing before took (dialogs, menus, a view's own mode, chat's
    // interrupt): a prompt with text needs Esc twice to clear; otherwise focus
    // goes up to the tab bar.
    if (key.escape) {
      if (state.focus === 'input') {
        if (isPromptMenuOpen()) return false
        if (!isPromptEmpty()) {
          const now = Date.now()
          if (now - lastEscAt.current < DOUBLE_ESC_MS) { lastEscAt.current = 0; store.actions.prefillPrompt('') }
          else lastEscAt.current = now
          return true
        }
      }
      lastEscAt.current = 0
      store.actions.setFocus('tabs')
      return true
    }
    const hotkey = views.find(v => v.key === input)
    if (hotkey && key.meta) { store.actions.setView(hotkey.id); return true }
    if (state.focus === 'input') return false
    if (hotkey && !key.ctrl) { store.actions.setView(hotkey.id); return true }
    if (input === '?') { store.actions.pushOverlay({ id: 'help', kind: 'help' }); return true }
    if (input === ':') { openPalette(store); return true }
    if (input === '/' && promptShown) { store.actions.prefillPrompt('/'); return true }
    return false
  }, { layer: 'global' })

  if (!view) {
    return <Text color={theme.color.error}>No views registered.</Text>
  }
  const ViewComponent = view.component
  const SidebarComponent = view.sidebar ?? FleetSidebar

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box ref={headerRef} width={columns} height={1} flexShrink={0}>
        <Header width={columns} hits={headerHits} />
      </Box>
      <Box flexDirection="row" height={bodyHeight} width={columns}>
        {showSidebar ? (
          <Box ref={sidebarRef} width={sidebarWidth} height={bodyHeight} flexShrink={0}>
            <SidebarComponent width={sidebarWidth} height={bodyHeight} focused={focus === 'sidebar' && !overlayOpen} />
          </Box>
        ) : null}
        <Box flexDirection="column" width={mainWidth} height={bodyHeight}>
          <Box ref={viewRef} flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="column">
            <ViewErrorBoundary viewId={view.id}>
              <ViewComponent key={view.id} width={viewWidth} height={viewHeight} focused={focus === 'main' && !overlayOpen} />
            </ViewErrorBoundary>
          </Box>
          {promptShown ? (
            <Box ref={promptRef} flexDirection="column" width={mainWidth} flexShrink={0}>
              <Prompt width={mainWidth} focused={focus === 'input' && !overlayOpen} />
            </Box>
          ) : null}
        </Box>
        {overlayOpen ? <OverlayHost width={columns} height={bodyHeight} /> : null}
      </Box>
      <Toasts width={columns} />
      <StatusBar width={columns} />
    </Box>
  )
}
