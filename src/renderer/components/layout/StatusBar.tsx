import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { MAIN_LOOP, selectLoopSlice, useAgentStore, type TokenUsage } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useAppStore } from '../../stores/app.store'
import { Tooltip } from '../common/Tooltip'
import { loopColor } from '../../utils/loop-color'
import { ContextBreakdownModal, formatTokens, resolveLoopThreshold } from './ContextBreakdownModal'
import type { AppUpdateState } from '../../../shared/types/ipc.types'
import { CONNECTION_STATE_LABELS, type ConnectionCurrent, type RuntimeView } from '../../../shared/types/connection.types'
import { runtimeIndicator, useCurrentConnection } from '../../stores/connection.store'
import { runtimeHeader, useRuntimes } from '../../stores/runtimes.store'
import { selectMeshSlice } from '../../stores/mesh.store'
import { selectBackgroundAgents } from '../../stores/background-agents.store'
import { requestSettingsRuntime } from '../../stores/settings-runtime.store'
import { apiFor, openApi } from '../../utils/runtime-api'
import { isAgentWindow, windowRuntime } from '../../utils/window-kind'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'

function contextGaugeTooltip(u: TokenUsage, estimate: number | null, threshold: number): string {
  // The full breakdown lives in the click-through modal — keep the hover terse.
  const current = estimate ?? u.input + u.output
  return `${formatTokens(current)} / ${formatTokens(threshold)} tokens\nclick for details`
}

/** What Kill reports once it has stopped everything, so the action is never silent. */
export function killResultLabel(result: { success: boolean; stoppedAgents?: number } | null | undefined): string {
  if (result && result.success === false) return 'Partial stop'
  const n = result?.stoppedAgents
  const agents = n === undefined ? 'Stopped all agents' : `Stopped ${n} agent${n === 1 ? '' : 's'}`
  return `${agents} · Mesh off`
}

/** Kill's tooltip; it names the runtime it acts on only while runtime names show (more than one runtime). */
export function killTooltip(current: Pick<ConnectionCurrent, 'name'> | null, named: boolean): string {
  return named ? `Stops all agents and mesh on ${current?.name ?? 'This computer'}` : 'Stops all agents and mesh'
}

/**
 * The status bar's runtime groups fold when they do not fit (multi-runtime.md
 * §6.2): the remote groups become one Runtimes button. Folded at the width
 * the inline groups needed; unfolded once the bar is that wide again.
 */
export interface RuntimeGroupsFold { folded: boolean; needed: number }
export function foldRuntimeGroups(state: RuntimeGroupsFold, bar: { scrollWidth: number; clientWidth: number }): RuntimeGroupsFold {
  if (!state.folded) return bar.scrollWidth > bar.clientWidth + 1 ? { folded: true, needed: bar.scrollWidth } : state
  return bar.clientWidth >= state.needed ? { folded: false, needed: 0 } : state
}

/**
 * Measure the fold again whenever the bar or what it holds changes size: the
 * bar itself, every item in it (an agent opened, a runtime's state, a Kill
 * result) and items added later. While folded, the width the inline groups
 * need moves with the items beside them. Answers the teardown.
 */
export function watchRuntimeFold(
  bar: HTMLElement,
  groups: HTMLElement,
  setFold: (update: (state: RuntimeGroupsFold) => RuntimeGroupsFold) => void,
): () => void {
  const beside = (): number => {
    const items = Array.from(bar.children).filter((c) => c !== groups)
    const gap = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(bar).columnGap) || 0 : 0
    return items.reduce((w, c) => w + c.getBoundingClientRect().width, 0) + gap * items.length
  }
  let besideWidth = beside()
  const check = (): void => {
    const now = beside()
    const moved = now - besideWidth
    besideWidth = now
    setFold((state) => foldRuntimeGroups(state.folded && moved !== 0 ? { ...state, needed: state.needed + moved } : state, bar))
  }
  const resize = new ResizeObserver(check)
  const observeAll = (): void => {
    resize.observe(bar)
    for (const item of Array.from(bar.children)) resize.observe(item)
  }
  observeAll()
  const added = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { observeAll(); check() })
  added?.observe(bar, { childList: true })
  check()
  return () => {
    resize.disconnect()
    added?.disconnect()
  }
}

function MeshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M8.5 15.5a5 5 0 0 1 0-7" strokeLinecap="round" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" strokeLinecap="round" />
      <path d="M6 18a9 9 0 0 1 0-12" strokeLinecap="round" />
      <path d="M18 6a9 9 0 0 1 0 12" strokeLinecap="round" />
    </svg>
  )
}

export function StatusBar() {
  const config = useAgentStore((s) => s.config)
  // The gauge is about ONE context window, and each loop has its own — so it
  // follows the loop tab the user is looking at. `viewedLoop` is `main` until
  // the loops panel says otherwise, which is exactly the old behaviour.
  const viewedLoop = useAgentStore((s) => s.viewedLoop)
  const tokenUsage = useAgentStore((s) => selectLoopSlice(s, s.viewedLoop).tokenUsage)
  const tokenEstimate = useAgentStore((s) => selectLoopSlice(s, s.viewedLoop).tokenEstimate)
  const filePath = useDocumentStore((s) => s.filePath)
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  // Kill's result line, shown beside it for a few seconds.
  const [killResult, setKillResult] = useState<string | null>(null)
  useEffect(() => {
    if (!killResult) return
    const timer = setTimeout(() => setKillResult(null), 6000)
    return () => clearTimeout(timer)
  }, [killResult])
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    window.adfApi?.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])
  const isDirty = useDocumentStore((s) => s.isDirty)
  const agentState = useAgentStore((s) => s.state)
  const meshEnabled = useMeshStore((s) => s.enabled)
  const meshAgents = useMeshStore((s) => s.agents)
  const backgroundAgentCount = useBackgroundAgentsStore((s) => s.agents.length)
  // This window's connection (settings-scopes.md §4.1); main answers per window (#149).
  const connection = useCurrentConnection()
  // One runtime: one unnamed group. More: one group per runtime (§6.2).
  const runtimes = useRuntimes()
  const multi = runtimes.length > 1
  const showLogsPanel = useAppStore((s) => s.showLogsPanel)
  const toggleLogsPanel = useAppStore((s) => s.toggleLogsPanel)
  const bottomPanelTab = useAppStore((s) => s.bottomPanelTab)
  const setBottomPanelTab = useAppStore((s) => s.setBottomPanelTab)
  const activeAgentCount = meshAgents.filter((a) => a.participating).length
  const isAnythingRunning = agentState !== 'off' || backgroundAgentCount > 0 || meshEnabled

  // Same resolution order as the executor's pre-flight guard. The host figure
  // is passed to the modal as its baseline; the gauge itself scales against
  // whichever loop is on screen (an inner loop may compact at its own point).
  const compactThreshold = resolveLoopThreshold(config, MAIN_LOOP)
  const viewedThreshold = resolveLoopThreshold(config, viewedLoop)
  // Same follow-the-tab rule for the model: an inner loop may think with its
  // own, and inherits the host's when it declares none.
  const viewedModel =
    (viewedLoop !== MAIN_LOOP && config?.loops?.find((l) => l.name === viewedLoop)?.model) || config?.model

  const handleSave = async () => {
    // The open agent's runtime: in the main window, the agent it has open.
    const result = await openApi()?.saveFile()
    if (result?.success) {
      useDocumentStore.getState().setDirty(false)
    }
  }

  const handleEmergencyStop = async () => {
    try {
      const result = await window.adfApi.emergencyStop()
      setKillResult(killResultLabel(result))
      // A partial stop (daemon mode) may leave agents running: their own state events say which.
      if (result && result.success === false) return
    } catch (err) {
      // The stop did not happen (daemon mode: not reached); main shows why. Keep what the window shows.
      console.error('[StatusBar] Emergency stop failed:', err)
      return
    }
    useAgentStore.getState().setState('off')
    useMeshStore.getState().reset()
    useBackgroundAgentsStore.getState().reset()
  }

  return (
    <div className="h-7 bg-surface-0 border-t border-hairline flex items-center px-3 gap-4 text-xs text-[var(--adf-ui-text-subtle)]">
      {/* Everything left of the version describes the open agent's session; its
          name and state live in the titlebar. Home has no agent, so the group
          is absent there rather than a row of blank labels. */}
      {filePath && (
        <>
      <button
        onClick={handleSave}
        className="hover:text-[var(--adf-ui-text)]"
        title="Save"
      >
        {isDirty ? 'Unsaved changes' : 'Saved'}
      </button>
      <div className="w-px h-3.5 bg-[var(--adf-ui-border)]" />
      {/* The model sits beside the gauge: the percentage is of its window. */}
      <span>{viewedModel?.model_id ?? 'No model'}</span>
      <ContextGauge
        tokenUsage={tokenUsage}
        tokenEstimate={tokenEstimate}
        threshold={viewedThreshold}
        loop={viewedLoop}
        onOpenBreakdown={() => setBreakdownOpen(true)}
      />
      <ContextBreakdownModal
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        filePath={filePath}
        threshold={compactThreshold}
        initialLoop={viewedLoop}
      />
      <div className="w-px h-3.5 bg-[var(--adf-ui-border)]" />
      <button
        onClick={() => {
          if (showLogsPanel && bottomPanelTab === 'logs') {
            toggleLogsPanel()
          } else {
            setBottomPanelTab('logs')
            if (!showLogsPanel) toggleLogsPanel()
          }
        }}
        className={`flex items-center gap-1 hover:text-[var(--adf-ui-text)] ${showLogsPanel && bottomPanelTab === 'logs' ? 'text-[var(--adf-ui-text)]' : ''}`}
        title="Toggle Logs Panel"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        Logs
      </button>
      <button
        onClick={() => {
          if (showLogsPanel && bottomPanelTab === 'tasks') {
            toggleLogsPanel()
          } else {
            setBottomPanelTab('tasks')
            if (!showLogsPanel) toggleLogsPanel()
          }
        }}
        className={`flex items-center gap-1 hover:text-[var(--adf-ui-text)] ${showLogsPanel && bottomPanelTab === 'tasks' ? 'text-[var(--adf-ui-text)]' : ''}`}
        title="Toggle Tasks Panel"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        Tasks
      </button>
        </>
      )}
      <span className="ml-auto" />
      <UpdateBadge />
      <span
        className="flex items-center gap-1 tabular-nums"
        title={import.meta.env.DEV ? 'ADF Studio version (running from npm run dev)' : 'ADF Studio version'}
      >
        {appVersion ? `v${appVersion}` : ''}
        {/* Dev builds look identical to the installed app; this tells them apart. */}
        {import.meta.env.DEV && (
          <span className="rounded px-1 text-[10px] font-semibold uppercase tracking-wider bg-[var(--status-draft-bg)] text-[var(--status-draft)]">
            dev
          </span>
        )}
      </span>
      {/* The runtime this window uses, its mesh and its Kill: one group, as all three act on that runtime. */}
      {multi ? <RuntimeGroups runtimes={runtimes} /> : (
      <div className="flex items-center gap-2 rounded-full border border-[var(--adf-ui-separator)] py-px pl-2.5 pr-px" data-runtime-group>
      <RuntimeIndicator current={connection} showName={false} onOpen={() => useAppStore.getState().openSettingsAt('connection')} />
      {/* A readout, not a switch: the one Mesh switch is in Settings → Networking, which a click opens. */}
      <Tooltip tip={meshEnabled ? `Mesh on, ${activeAgentCount} participating agents` : 'Mesh off'} className="flex">
      <button
        role="status"
        onClick={() => useAppStore.getState().openSettingsAt('networking')}
        aria-label={meshEnabled ? `Mesh on, ${activeAgentCount} participating agents` : 'Mesh off'}
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
            meshEnabled
              ? 'bg-[var(--status-stable-bg)] text-[var(--status-stable)]'
              : 'text-[var(--adf-ui-text-subtle)] hover:text-[var(--adf-ui-text)]'
        }`}
      >
        <MeshIcon />
        {meshEnabled ? `Mesh (${activeAgentCount})` : 'Mesh off'}
      </button>
      </Tooltip>
      {killResult && (
        <span role="status" className="whitespace-nowrap text-[11px] text-[var(--adf-ui-text)]">
          {killResult}
        </span>
      )}
      <Tooltip tip={isAnythingRunning ? killTooltip(connection, false) : 'Nothing running'} className="flex">
      <button
        onClick={isAnythingRunning ? handleEmergencyStop : undefined}
        disabled={!isAnythingRunning}
        aria-label={isAnythingRunning ? killTooltip(connection, false) : 'Kill: nothing running'}
        className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
          isAnythingRunning
            ? 'text-[var(--adf-ui-danger)] hover:bg-[var(--adf-ui-danger-subtle)]'
            : 'cursor-default text-[var(--adf-ui-text-disabled)]'
        }`}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
        </svg>
        Kill
      </button>
      </Tooltip>
      </div>
      )}
    </div>
  )
}

/**
 * More than one runtime (multi-runtime.md §6.2): one group per runtime in the
 * set's order, This computer first: `( [name] [Mesh] [Kill] )`. An agent
 * window shows its own runtime's group only. When the groups do not fit, the
 * remote groups fold into one Runtimes button whose popover lists them.
 */
export function RuntimeGroups({ runtimes }: { runtimes: RuntimeView[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fold, setFold] = useState<RuntimeGroupsFold>({ folded: false, needed: 0 })
  const [open, setOpen] = useState(false)
  const shown = isAgentWindow ? runtimes.filter((r) => r.id === windowRuntime) : runtimes
  const ids = shown.map((r) => r.id).join('\n')
  // Another set is measured again, inline first.
  useLayoutEffect(() => { setFold({ folded: false, needed: 0 }) }, [ids])
  useLayoutEffect(() => {
    const groups = ref.current
    const bar = groups?.parentElement
    if (!groups || !bar || typeof ResizeObserver === 'undefined') return
    return watchRuntimeFold(bar, groups, setFold)
  }, [ids, fold.folded])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const local = shown.filter((r) => r.id === LOCAL_RUNTIME || isAgentWindow)
  const remotes = shown.filter((r) => !local.includes(r))
  const folded = fold.folded && remotes.length > 0
  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-2">
      {local.map((r) => <RuntimeGroup key={r.id} runtime={r} />)}
      {!folded && remotes.map((r) => <RuntimeGroup key={r.id} runtime={r} />)}
      {folded && (
        <Tooltip tip={remotes.map((r) => runtimeHeader(r)).join(', ')} className="flex">
          <button
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className={`rounded-full border border-[var(--adf-ui-separator)] px-2.5 py-0.5 text-[11px] font-medium hover:text-[var(--adf-ui-text)] ${remotes.some((r) => r.state !== 'connected') ? 'text-[var(--adf-ui-danger)]' : ''}`}
          >
            Runtimes
          </button>
        </Tooltip>
      )}
      {folded && open && (
        <div role="dialog" aria-label="Runtimes" className="absolute bottom-full right-0 z-20 mb-1.5 flex flex-col items-end gap-1.5 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-2 shadow-lg">
          {remotes.map((r) => <RuntimeGroup key={r.id} runtime={r} />)}
        </div>
      )}
    </div>
  )
}

/**
 * One runtime's group: its name (remote icon for a remote; its state while
 * down; the address as tooltip; a click opens Settings → Connections), its
 * mesh and its Kill, which act on that runtime only (§12 item 4). This
 * computer's group, and an agent window's, read the window's own slices.
 */
function RuntimeGroup({ runtime }: { runtime: RuntimeView }) {
  const own = runtime.id === LOCAL_RUNTIME || isAgentWindow
  // The slice key of this runtime in this window's stores; undefined: the window's own.
  const slice: RuntimeId | undefined = own ? undefined : runtime.id
  const mesh = useMeshStore((s) => selectMeshSlice(s, slice))
  const backgroundCount = useBackgroundAgentsStore((s) => selectBackgroundAgents(s, slice).length)
  const openHere = useDocumentStore((s) => !!s.filePath && (isAgentWindow || (s.runtimeId || LOCAL_RUNTIME) === runtime.id))
  const agentState = useAgentStore((s) => s.state)
  const [killResult, setKillResult] = useState<string | null>(null)
  useEffect(() => {
    if (!killResult) return
    const timer = setTimeout(() => setKillResult(null), 6000)
    return () => clearTimeout(timer)
  }, [killResult])
  const down = runtime.state !== 'connected'
  const running = (openHere && agentState !== 'off') || backgroundCount > 0 || mesh.enabled
  const participating = mesh.agents.filter((a) => a.participating).length
  const header = runtimeHeader(runtime)
  const meshLabel = mesh.enabled ? `Mesh on, ${participating} participating agents` : 'Mesh off'
  const killTip = down ? CONNECTION_STATE_LABELS[runtime.state] : running ? killTooltip(runtime, true) : 'Nothing running'

  const kill = async () => {
    try {
      const result = await (own ? window.adfApi : apiFor(runtime.id)).emergencyStop()
      setKillResult(killResultLabel(result))
      // A partial stop may leave agents running: their own state events say which.
      if (result && result.success === false) return
    } catch (err) {
      // The stop did not happen (the runtime was not reached); keep what the window shows.
      console.error(`[StatusBar] Emergency stop on ${runtime.name} failed:`, err)
      setKillResult(`Not stopped: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (openHere) useAgentStore.getState().setState('off')
    useMeshStore.getState().reset(slice)
    useBackgroundAgentsStore.getState().setAgents([], slice)
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-[var(--adf-ui-separator)] py-px pl-2.5 pr-px" data-runtime-group={runtime.id}>
      <button
        onClick={() => useAppStore.getState().openSettingsAt('connection')}
        title={runtime.url ?? undefined}
        aria-label={`Runtime: ${header}`}
        className={`flex items-center gap-1 hover:text-[var(--adf-ui-text)] ${down ? 'text-[var(--adf-ui-danger)]' : ''}`}
      >
        {runtime.kind === 'remote' && <RemoteIcon />}
        <span className="max-w-[180px] truncate">{header}</span>
      </button>
      <Tooltip tip={meshLabel} className="flex">
      <button
        role="status"
        onClick={() => { requestSettingsRuntime(runtime.id); useAppStore.getState().openSettingsAt('networking') }}
        aria-label={meshLabel}
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
            mesh.enabled
              ? 'bg-[var(--status-stable-bg)] text-[var(--status-stable)]'
              : 'text-[var(--adf-ui-text-subtle)] hover:text-[var(--adf-ui-text)]'
        }`}
      >
        <MeshIcon />
        {mesh.enabled ? `Mesh (${participating})` : 'Mesh off'}
      </button>
      </Tooltip>
      {killResult && (
        <span role="status" className="whitespace-nowrap text-[11px] text-[var(--adf-ui-text)]">
          {killResult}
        </span>
      )}
      <Tooltip tip={killTip} className="flex">
      <button
        onClick={running && !down ? () => void kill() : undefined}
        disabled={!running || down}
        aria-label={running && !down ? killTooltip(runtime, true) : `Kill on ${runtime.name}: ${down ? CONNECTION_STATE_LABELS[runtime.state] : 'nothing running'}`}
        className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
          running && !down
            ? 'text-[var(--adf-ui-danger)] hover:bg-[var(--adf-ui-danger-subtle)]'
            : 'cursor-default text-[var(--adf-ui-text-disabled)]'
        }`}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
        </svg>
        Kill
      </button>
      </Tooltip>
    </div>
  )
}

function RemoteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
      <path d="m15 8-3 3-3-3" />
    </svg>
  )
}

/**
 * The runtime this window uses (settings-scopes.md §4.1), first in the
 * runtime group right of the version, before its mesh and Kill. Nothing for
 * This computer while it is connected; a remote's name with the remote icon;
 * the state while not connected. The tooltip is the address. A click opens
 * Settings → Connections.
 */
export function RuntimeIndicator({ current, showName = true, onOpen }: { current: ConnectionCurrent | null; showName?: boolean; onOpen: () => void }) {
  const shown = runtimeIndicator(current, showName)
  if (!shown) return null
  return (
    <button
      onClick={onOpen}
      title={shown.tooltip ?? undefined}
      aria-label={showName ? `Runtime: ${shown.text}` : shown.text}
      className={`flex items-center gap-1 hover:text-[var(--adf-ui-text)] ${shown.problem ? 'text-[var(--adf-ui-danger)]' : ''}`}
    >
      {shown.remote && <RemoteIcon />}
      <span className="max-w-[220px] truncate">{shown.text}</span>
    </button>
  )
}

function UpdateIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12" />
      <path d="M6 10l6 6 6-6" />
      <path d="M4 20h16" />
    </svg>
  )
}

/**
 * Sits just left of the version number (so the version never shifts).
 * Invisible until main reports an update; one click downloads it (with a
 * percent readout) and the app restarts on its own once the download lands.
 */
function UpdateBadge() {
  const [update, setUpdate] = useState<AppUpdateState>({ status: 'idle' })
  useEffect(() => {
    window.adfApi?.getUpdateState().then(setUpdate).catch(() => {})
    return window.adfApi?.onUpdateState(setUpdate)
  }, [])

  if (update.status === 'idle') return null

  const clickable = update.status === 'available' || update.status === 'error'
  const tip =
    update.status === 'available' ? `v${update.version} is available — click to download and restart`
    : update.status === 'downloading' ? `Downloading v${update.version}…`
    : update.status === 'ready' || update.status === 'installing' ? `Restarting into v${update.version}…`
    : `Update failed: ${update.message}${update.version ? ' — click to retry' : ''}`
  const label =
    update.status === 'downloading' ? `${update.percent}%`
    : update.status === 'ready' || update.status === 'installing' ? 'Restarting…'
    : update.status === 'error' ? 'Update failed'
    : 'Update'
  const tone =
    update.status === 'error' ? 'text-[var(--status-deprecated)] hover:bg-[var(--status-deprecated-bg)]'
    : 'text-[var(--status-info)] hover:bg-[var(--status-info-bg)]'

  return (
    <Tooltip tip={tip}>
      <button
        onClick={clickable ? () => void window.adfApi.downloadUpdate() : undefined}
        disabled={!clickable}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${tone} ${clickable ? '' : 'cursor-default'}`}
      >
        <UpdateIcon />
        {label}
      </button>
    </Tooltip>
  )
}

function ContextGauge({
  tokenUsage,
  tokenEstimate,
  threshold,
  loop,
  onOpenBreakdown
}: {
  tokenUsage: TokenUsage
  tokenEstimate: number | null
  threshold: number
  /** Which loop's window this is. Labelled only when it is NOT the host loop —
   *  an unprefixed gauge always means main, as it always has. */
  loop: string
  onOpenBreakdown: () => void
}) {
  // A pre-flight estimate already includes overhead + messages for the whole
  // outgoing request, so it stands alone — never add the last call's output
  // on top of it.
  const used = tokenEstimate ?? tokenUsage.input + tokenUsage.output
  const hasData = used > 0
  const pct = hasData ? (used / threshold) * 100 : 0
  const fillColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-green-500'
  const isMain = !loop || loop === MAIN_LOOP

  return (
    <Tooltip
      tip={`${isMain ? '' : `${loop}: `}${contextGaugeTooltip(tokenUsage, tokenEstimate, threshold)}`}
      className="flex"
    >
      <span
        role="button"
        tabIndex={0}
        onClick={onOpenBreakdown}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpenBreakdown()
          }
        }}
        className="flex cursor-pointer items-center gap-1.5"
      >
        {!isMain && (
          <span className={`max-w-20 truncate text-[10px] font-medium ${loopColor(loop).label}`}>{loop}</span>
        )}
        <span className="relative w-16 h-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600 overflow-hidden">
          <span
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${fillColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </span>
        <span className="tabular-nums">
          {hasData ? `${tokenEstimate != null ? '~' : ''}${Math.round(pct)}%` : '–%'}
        </span>
      </span>
    </Tooltip>
  )
}
