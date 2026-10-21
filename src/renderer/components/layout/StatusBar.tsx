import { useState, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { MAIN_LOOP, selectLoopSlice, useAgentStore, type TokenUsage } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useAppStore } from '../../stores/app.store'
import { Tooltip } from '../common/Tooltip'
import { ContextMenu } from '../common/ContextMenu'
import { IconButton } from '../ui/IconButton'
import { RemoteMark } from '../common/RemoteMark'
import { LOCAL_LABEL } from '../../../shared/runtime-name'
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
  return named ? `Stops all agents and mesh on ${current?.name ?? LOCAL_LABEL}` : 'Stops all agents and mesh'
}

/** Kill all's tooltip (multi-runtime.md §6.2). */
export const KILL_ALL_TIP = 'Stops all agents and mesh on every runtime'

/**
 * Kill results by runtime id ('all': Kill all), each shown for a few
 * seconds wherever that Kill is: the status bar group and the Runtimes
 * popover row show the same result, so a Kill is never silent.
 */
interface KillResultsState { results: Record<string, string> }
export const useKillResultsStore = create<KillResultsState>(() => ({ results: {} }))
const killTimers = new Map<string, ReturnType<typeof setTimeout>>()
export function showKillResult(key: string, text: string): void {
  useKillResultsStore.setState((s) => ({ results: { ...s.results, [key]: text } }))
  const previous = killTimers.get(key)
  if (previous) clearTimeout(previous)
  killTimers.set(key, setTimeout(() => {
    killTimers.delete(key)
    useKillResultsStore.setState((s) => { const { [key]: _gone, ...rest } = s.results; return { results: rest } })
  }, 6000))
}
const useKillResult = (key: string): string | null => useKillResultsStore((s) => s.results[key] ?? null)

/** A runtime's slice key in this window's stores; undefined: the window's own (This computer, or an agent window's runtime). */
function sliceOf(runtime: Pick<RuntimeView, 'id'>): RuntimeId | undefined {
  return runtime.id === LOCAL_RUNTIME || isAgentWindow ? undefined : runtime.id
}

/** The surface a runtime's Kill calls: the window's own, else the runtime's (tagged). */
function stopApi(runtime: Pick<RuntimeView, 'id'>) {
  return sliceOf(runtime) === undefined ? window.adfApi : apiFor(runtime.id)
}

/** After a stop that held: the runtime's slices show nothing running; their own events say otherwise. */
function clearStopped(runtime: Pick<RuntimeView, 'id'>): void {
  const slice = sliceOf(runtime)
  const open = useDocumentStore.getState()
  if (open.filePath && (isAgentWindow || (open.runtimeId || LOCAL_RUNTIME) === runtime.id)) useAgentStore.getState().setState('off')
  useMeshStore.getState().reset(slice)
  useBackgroundAgentsStore.getState().setAgents([], slice)
}

/**
 * Kill all (§6.2): emergencyStop on every connected runtime at once. The
 * result says what happened: what was stopped; "Partial stop" when a
 * runtime stopped only part; the runtimes not reached (down, or the call
 * failed) by name.
 */
export async function killAll(runtimes: readonly RuntimeView[]): Promise<string> {
  const reachable = runtimes.filter((r) => r.state === 'connected')
  const missed = runtimes.filter((r) => r.state !== 'connected').map((r) => r.name)
  const settled = await Promise.allSettled(reachable.map((r) => stopApi(r).emergencyStop()))
  let stopped = 0
  let counted = true
  let partial = false
  let reached = 0
  let firstError: string | null = null
  settled.forEach((outcome, i) => {
    const runtime = reachable[i]
    if (outcome.status === 'rejected') {
      console.error(`[StatusBar] Emergency stop on ${runtime.name} failed:`, outcome.reason)
      firstError ??= outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      missed.push(runtime.name)
      return
    }
    reached++
    const result = outcome.value
    if (result && result.success === false) { partial = true; return }
    if (result?.stoppedAgents === undefined) counted = false
    else stopped += result.stoppedAgents
    clearStopped(runtime)
  })
  if (reached === 0 && firstError) return `Not stopped: ${firstError}`
  if (missed.length > 0) return `Partial stop · Not reached: ${missed.join(', ')}`
  return killResultLabel({ success: !partial, stoppedAgents: counted ? stopped : undefined })
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
      {multi ? <FocusedRuntime runtimes={runtimes} /> : (
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
 * More than one runtime (multi-runtime.md §6.2): ONE group, the runtime of
 * the agent this window shows (the main window's open agent, else This
 * computer; an agent window's own): `( [name] [Mesh] [Kill] )`. In the main
 * window an up arrow beside it (tooltip "Servers") opens a popover of every
 * runtime in the set's order, each with its state, Mesh and Kill, and Kill
 * all above them. An agent window reaches its own runtime only: its group,
 * no arrow.
 */
export function FocusedRuntime({ runtimes }: { runtimes: RuntimeView[] }) {
  const focusedId = useDocumentStore((s) => (isAgentWindow ? windowRuntime : s.filePath ? s.runtimeId || LOCAL_RUNTIME : LOCAL_RUNTIME))
  const focused = runtimes.find((r) => r.id === focusedId) ?? (isAgentWindow ? null : runtimes[0] ?? null)
  const arrowRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const allResult = useKillResult('all')
  // The arrow turns red while a runtime not shown is down, as the group's name does for its own.
  const othersDown = runtimes.some((r) => r.id !== focused?.id && r.state !== 'connected')
  const toggle = () => {
    if (open) { setOpen(null); return }
    const rect = arrowRef.current?.getBoundingClientRect()
    setOpen(rect ? { x: rect.right, y: rect.top - 6 } : { x: 0, y: 0 })
  }
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {focused && <RuntimeGroup runtime={focused} />}
      {!isAgentWindow && (
        <>
          {allResult && !open && (
            <span role="status" className="whitespace-nowrap text-[11px] text-[var(--adf-ui-text)]">{allResult}</span>
          )}
          <Tooltip tip="Servers" className="flex">
            <IconButton
              ref={arrowRef}
              onClick={toggle}
              aria-label="Servers"
              aria-haspopup="menu"
              aria-expanded={open !== null}
              variant={open ? 'selected' : 'neutral'}
              className={`!size-5 ${open ? '' : '!border-transparent !bg-transparent'} ${othersDown ? '!text-[var(--adf-ui-danger)]' : ''}`}
              data-runtimes-arrow=""
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 6.5 5 3.5l3 3" />
              </svg>
            </IconButton>
          </Tooltip>
          <RuntimesPopover runtimes={runtimes} position={open} onClose={() => setOpen(null)} anchor={arrowRef} />
        </>
      )}
    </div>
  )
}

/**
 * The Servers popover (ContextMenu): Kill all, then one row per runtime in
 * the set's order (This computer first, then the remotes in the order
 * added): name (remote icon), state, Mesh, Kill. The arrow keys move between
 * the Kills; Escape closes it and gives the focus back to the arrow.
 */
export function RuntimesPopover({ runtimes, position, onClose, anchor }: {
  runtimes: RuntimeView[]
  position: { x: number; y: number } | null
  onClose: () => void
  anchor?: React.RefObject<HTMLElement | null>
}) {
  return (
    <ContextMenu position={position} onClose={onClose} placement={{ x: 'end', y: 'above' }} label="Servers" anchor={anchor}>
      <KillAllRow runtimes={runtimes} />
      <div className="my-1 border-t border-hairline" />
      {runtimes.map((r) => <RuntimeRow key={r.id} runtime={r} />)}
    </ContextMenu>
  )
}

/** A Kill of the popover: a menu item the arrow keys reach. */
function PopoverKill({ armed, tip, label, onClick, children }: { armed: boolean; tip: string; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip tip={tip} className="flex">
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={armed ? onClick : undefined}
        disabled={!armed}
        aria-label={label}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--adf-ui-focus)] ${
          armed
            ? 'text-[var(--adf-ui-danger)] hover:bg-[var(--adf-ui-danger-subtle)]'
            : 'cursor-default text-[var(--adf-ui-text-disabled)]'
        }`}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
        </svg>
        {children}
      </button>
    </Tooltip>
  )
}

/** Kill all: armed while anything runs on a connected runtime (an agent, a background agent, a mesh). */
function KillAllRow({ runtimes }: { runtimes: RuntimeView[] }) {
  const result = useKillResult('all')
  const live = runtimes.filter((r) => r.state === 'connected')
  const meshOn = useMeshStore((s) => live.some((r) => selectMeshSlice(s, sliceOf(r)).enabled))
  const background = useBackgroundAgentsStore((s) => live.some((r) => selectBackgroundAgents(s, sliceOf(r)).length > 0))
  const openLive = useDocumentStore((s) => !!s.filePath && live.some((r) => r.id === (s.runtimeId || LOCAL_RUNTIME)))
  const agentState = useAgentStore((s) => s.state)
  const armed = meshOn || background || (openLive && agentState !== 'off')
  return (
    <div role="none" className="flex items-center justify-between gap-3 px-3 py-1" data-kill-all="">
      <span role="status" className="whitespace-nowrap text-[11px]">{result ?? ''}</span>
      <PopoverKill
        armed={armed}
        tip={armed ? KILL_ALL_TIP : 'Nothing running'}
        label={armed ? KILL_ALL_TIP : 'Kill all: nothing running'}
        onClick={() => { void killAll(runtimes).then((text) => showKillResult('all', text)) }}
      >
        Kill all
      </PopoverKill>
    </div>
  )
}

/** One runtime in the popover: name (remote icon), state, Mesh, Kill. */
function RuntimeRow({ runtime }: { runtime: RuntimeView }) {
  const k = useRuntimeKill(runtime)
  return (
    <div role="none" className="flex items-center gap-3 px-3 py-1" data-runtime-row={runtime.id}>
      <span className="flex min-w-0 flex-1 items-center gap-1" title={runtime.url ?? undefined}>
        {runtime.kind === 'remote' && <RemoteMark />}
        <span className="max-w-[180px] truncate">{runtime.name}</span>
      </span>
      <span className={`whitespace-nowrap text-[11px] ${k.down ? 'text-[var(--adf-ui-danger)]' : 'text-[var(--adf-ui-text-muted)]'}`}>
        {CONNECTION_STATE_LABELS[runtime.state]}
      </span>
      <span
        role="status"
        aria-label={k.meshLabel}
        className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${
          k.mesh.enabled ? 'bg-[var(--status-stable-bg)] text-[var(--status-stable)]' : 'text-[var(--adf-ui-text-subtle)]'
        }`}
      >
        <MeshIcon />
        {k.mesh.enabled ? `Mesh (${k.participating})` : 'Mesh off'}
      </span>
      {k.result && <span role="status" className="whitespace-nowrap text-[11px]">{k.result}</span>}
      <PopoverKill armed={k.armed} tip={k.killTip} label={k.killLabel} onClick={() => void k.kill()}>Kill</PopoverKill>
    </div>
  )
}

/**
 * A runtime's Kill, wherever it shows: armed while something runs there
 * (the open agent, a background agent, its mesh) and the runtime is
 * connected. It stops that runtime only (§12 item 4); its result shows.
 */
function useRuntimeKill(runtime: RuntimeView) {
  const slice = sliceOf(runtime)
  const mesh = useMeshStore((s) => selectMeshSlice(s, slice))
  const backgroundCount = useBackgroundAgentsStore((s) => selectBackgroundAgents(s, slice).length)
  const openHere = useDocumentStore((s) => !!s.filePath && (isAgentWindow || (s.runtimeId || LOCAL_RUNTIME) === runtime.id))
  const agentState = useAgentStore((s) => s.state)
  const result = useKillResult(runtime.id)
  const down = runtime.state !== 'connected'
  const running = (openHere && agentState !== 'off') || backgroundCount > 0 || mesh.enabled
  const participating = mesh.agents.filter((a) => a.participating).length
  const armed = running && !down
  const kill = async () => {
    try {
      const outcome = await stopApi(runtime).emergencyStop()
      showKillResult(runtime.id, killResultLabel(outcome))
      // A partial stop may leave agents running: their own state events say which.
      if (outcome && outcome.success === false) return
    } catch (err) {
      // The stop did not happen (the runtime was not reached); keep what the window shows.
      console.error(`[StatusBar] Emergency stop on ${runtime.name} failed:`, err)
      showKillResult(runtime.id, `Not stopped: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    clearStopped(runtime)
  }
  return {
    mesh, participating, down, armed, result, kill,
    meshLabel: mesh.enabled ? `Mesh on, ${participating} participating agents` : 'Mesh off',
    killTip: down ? CONNECTION_STATE_LABELS[runtime.state] : running ? killTooltip(runtime, true) : 'Nothing running',
    killLabel: armed ? killTooltip(runtime, true) : `Kill on ${runtime.name}: ${down ? CONNECTION_STATE_LABELS[runtime.state] : 'nothing running'}`,
  }
}

/**
 * One runtime's group: its name (remote icon for a remote; its state while
 * down; the address as tooltip; a click opens Settings → Connections), its
 * mesh and its Kill, which act on that runtime only (§12 item 4). This
 * computer's group, and an agent window's, read the window's own slices.
 */
function RuntimeGroup({ runtime }: { runtime: RuntimeView }) {
  const { mesh, participating, down, armed, result: killResult, kill, meshLabel, killTip, killLabel } = useRuntimeKill(runtime)
  const header = runtimeHeader(runtime)

  return (
    <div className="flex items-center gap-2 rounded-full border border-[var(--adf-ui-separator)] py-px pl-2.5 pr-px" data-runtime-group={runtime.id}>
      <button
        onClick={() => useAppStore.getState().openSettingsAt('connection')}
        title={runtime.url ?? undefined}
        aria-label={`Server: ${header}`}
        className={`flex items-center gap-1 hover:text-[var(--adf-ui-text)] ${down ? 'text-[var(--adf-ui-danger)]' : ''}`}
      >
        {runtime.kind === 'remote' && <RemoteMark />}
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
        onClick={armed ? () => void kill() : undefined}
        disabled={!armed}
        aria-label={killLabel}
        className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
          armed
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

/**
 * The runtime this window uses (settings-scopes.md §4.1), first in the
 * runtime group right of the version, before its mesh and Kill. Nothing for
 * the local runtime while it is connected; a remote's name with the remote icon;
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
      aria-label={showName ? `Server: ${shown.text}` : shown.text}
      className={`flex items-center gap-1 hover:text-[var(--adf-ui-text)] ${shown.problem ? 'text-[var(--adf-ui-danger)]' : ''}`}
    >
      {shown.remote && <RemoteMark />}
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
