import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdfApi } from '../../../preload/api'
import type { AgentConfig, ComputeConfig } from '../../../shared/types/adf-v02.types'
import type { ContainerPhaseEvent, ContainerSummary, ExecutionTarget, PodmanAvailability } from '../../../shared/types/compute.types'
import { resolveExecutionTargetAliases } from '../../../shared/utils/compute-targets'
import { HOST_ACCESS_CONFIRM, useConfirm } from '../common/ConfirmDialog'
import { InfoHint } from '../common/DocsLink'
import { writeSettings } from '../settings/settings-save'

interface Props {
  config: AgentConfig
  targets: ExecutionTarget[]
  api?: AdfApi
  machine: string
  template?: boolean
  onChange: (compute: ComputeConfig) => void
  onHostPermission: (enabled: boolean) => void
  onEnableCommands: () => void
  onSettings: () => void
}

interface Snapshot {
  availability: PodmanAvailability
  containers: ContainerSummary[]
  hostAllowed: boolean
}

export interface EnvironmentStatus {
  text: string
  detail?: string
  action?: 'settings' | 'start' | 'host' | 'agent'
  actionLabel?: string
  container?: string
}

/** Display state only. Permission comes from the existing config; readiness from the runtime. */
export function environmentStatus(id: string, allowed: boolean, agentId: string, snapshot: Snapshot | null, phase?: ContainerPhaseEvent, compute?: ComputeConfig): EnvironmentStatus {
  if (allowed && compute && ((id === 'host' && !compute.host_access) || (id === 'isolated' && !compute.enabled))) return { text: 'Disabled in agent config', action: 'agent', actionLabel: 'Enable for this agent' }
  if (!snapshot) return { text: 'Status unavailable' }
  if (id === 'host') return snapshot.hostAllowed
    ? { text: 'Available' }
    : { text: 'Blocked by runtime settings', action: 'host', actionLabel: 'Review host access' }
  if (id !== 'shared' && id !== 'isolated') return { text: 'User-managed', action: 'settings', actionLabel: 'Check in Settings' }
  const a = snapshot.availability
  if (!a.available) return { text: 'Podman unavailable', detail: a.error, action: 'settings', actionLabel: 'Set up Podman' }
  if (a.machineRequired && !a.machineRunning) return { text: a.machineExists ? 'Podman machine stopped' : 'Podman setup needed', action: 'settings', actionLabel: 'Open setup' }
  const container = snapshot.containers.find((c) => c.managed && (id === 'shared' ? c.scope === 'shared' : c.scope === 'dedicated' && c.agentId === agentId))
  if (phase?.phase === 'provisioning' || phase?.phase === 'starting') return { text: phase.phase === 'provisioning' ? 'Setting up' : 'Starting', detail: phase.detail }
  if (phase?.phase === 'failed' || container?.state === 'failed') return { text: 'Setup failed', detail: phase?.detail ?? container?.error, action: 'settings', actionLabel: 'Review in Settings' }
  if (phase?.phase === 'absent' || (!container && !phase)) return { text: 'Not created', detail: id === 'isolated' ? 'Created when this agent runs or requests compute.' : undefined, action: 'settings', actionLabel: 'Open Compute settings' }
  if (phase?.phase === 'ready' || (!phase && container?.running)) return { text: 'Running' }
  const name = phase?.containerName ?? container?.name
  if (phase?.phase === 'stopped' || ['stopped', 'exited', 'created'].includes(container?.state ?? '')) return { text: 'Stopped', action: 'start', actionLabel: 'Start', container: name }
  return { text: container?.state || 'Status unavailable', action: 'settings', actionLabel: 'Open Compute settings' }
}

/** Keep the form's existing write shape, including packages, browser and other options. */
export function withAllowedEnvironments(compute: ComputeConfig | undefined, next: string[], defaultTarget: string): ComputeConfig {
  const { target: _legacyTarget, ...current } = compute ?? { enabled: false }
  return { ...current, enabled: next.includes('isolated'), host_access: next.includes('host'), allowed_targets: next, default_target: next.includes(defaultTarget) ? defaultTarget : next[0] }
}

/** The existing Compute form, with runtime status alongside its permission controls. */
export function AgentComputeEnvironments({ config, targets, api, machine, template, onChange, onHostPermission, onEnableCommands, onSettings }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [phases, setPhases] = useState<Record<string, ContainerPhaseEvent>>({})
  const [loading, setLoading] = useState(!template)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, confirm] = useConfirm()
  const alive = useRef(false)
  const inFlight = useRef(false)
  const onHostRef = useRef(onHostPermission)
  onHostRef.current = onHostPermission

  const refresh = useCallback(async () => {
    if (!api || template || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setPhases({})
    try {
      const [setup, inventory, settings] = await Promise.all([
        api.computeSetup({ step: 'check' }), api.computeListContainers(), api.getSettings(),
      ])
      if (!alive.current) return
      if (!setup.availability) throw new Error(setup.error || 'Compute status is unavailable.')
      const hostAllowed = settings.compute?.hostAccessEnabled ?? false
      setSnapshot({ availability: setup.availability, containers: inventory.containers, hostAllowed })
      onHostRef.current(hostAllowed)
      setError(null)
    } catch (err) {
      if (alive.current) { setSnapshot(null); setError(err instanceof Error ? err.message : String(err)) }
    } finally {
      inFlight.current = false
      if (alive.current) setLoading(false)
    }
  }, [api, template])

  // This component mounts only while Compute is expanded. No periodic Podman probes.
  useEffect(() => {
    alive.current = true
    const visible = () => { if (!document.hidden) void refresh() }
    visible()
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    const unsubscribe = !template ? api?.onContainerPhase((event) => {
      if (event.agentId !== config.id && event.containerName !== 'adf-mcp') return
      setPhases((prev) => ({ ...prev, [event.containerName === 'adf-mcp' ? 'shared' : 'isolated']: event }))
    }) : undefined
    return () => {
      alive.current = false
      unsubscribe?.()
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [api, config.id, refresh, template])

  const allowed = config.compute?.allowed_targets ?? (config.compute?.target ? [config.compute.target] : [
    ...(config.compute?.enabled ? ['isolated'] : []), 'shared', ...(config.compute?.host_access ? ['host'] : []),
  ])
  const defaultTarget = config.compute?.default_target ?? config.compute?.target ?? (config.compute?.enabled ? 'isolated' : 'shared')
  const managed = [
    { id: 'shared', label: 'Shared Podman container', detail: 'ADF-managed MCP runtime' },
    { id: 'isolated', label: 'Dedicated Podman container', detail: 'ADF-managed private environment' },
  ]
  const host = { id: 'host', label: 'Host machine', detail: `Direct access to ${machine}` }
  const external = resolveExecutionTargetAliases(targets).map(({ target, alias }) => ({ id: target.id, label: target.name, detail: `${alias} · user-managed ${target.engine} · ${target.containerRef}` }))
  const options = [...managed, host, ...external]
  const missing = allowed.filter((id) => !options.some((o) => o.id === id))

  const updateAllowed = (next: string[]) => {
    if (!next.length) return
    onChange(withAllowedEnvironments(config.compute, next, defaultTarget))
  }
  const act = async (id: string, status: EnvironmentStatus) => {
    if (status.action === 'agent') { updateAllowed(allowed); return }
    if (status.action === 'settings') { onSettings(); return }
    if (!api || busy) return
    setBusy(id)
    setError(null)
    try {
      if (status.action === 'host') {
        if (!await confirm({ ...HOST_ACCESS_CONFIRM, title: `Allow host access on ${machine}` })) return
        if (!alive.current) return
        const result = await writeSettings({ compute: { hostAccessEnabled: true } }, api)
        if (!result.ok) throw new Error(result.error)
        if (!alive.current) return
        setSnapshot((current) => current ? { ...current, hostAllowed: true } : current)
        onHostRef.current(true)
      } else if (status.action === 'start' && status.container) {
        const result = await api.computeStartContainer({ name: status.container })
        if (!result.success) throw new Error(result.error || 'The container could not be started.')
        if (alive.current) await refresh()
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally { if (alive.current) setBusy(null) }
  }
  const renderOption = (option: typeof host) => {
    const checked = allowed.includes(option.id)
    const status = environmentStatus(option.id, checked, config.id, snapshot, phases[option.id], config.compute)
    return <div key={option.id} className="rounded px-1 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">
      <div className="flex items-start gap-2">
        <label className="flex min-w-0 flex-1 items-start gap-2">
          <input type="checkbox" checked={checked} disabled={checked && allowed.length === 1}
            onChange={(e) => updateAllowed(e.target.checked ? [...allowed, option.id] : allowed.filter((id) => id !== option.id))}
            className="mt-0.5 rounded text-blue-500" />
          <span className="min-w-0">
            <span className="block text-xs text-neutral-700 dark:text-neutral-300">{option.label}</span>
            <span className="block break-words text-[11px] text-[var(--adf-ui-text-subtle)]">{option.detail}</span>
          </span>
        </label>
        {!template && <span className="max-w-[45%] text-right text-[11px] text-[var(--adf-ui-text-muted)]">{loading ? 'Checking…' : status.text}</span>}
      </div>
      {!template && !loading && <div className="ml-6">
        {status.detail && <p className="break-words text-[11px] text-[var(--adf-ui-text-muted)]">{status.detail}</p>}
        {status.action && <button type="button" disabled={busy !== null} onClick={() => void act(option.id, status)} className="text-[11px] text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400">{busy === option.id ? 'Working…' : status.actionLabel}</button>}
      </div>}
    </div>
  }

  return <>
    {!template && <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--adf-ui-text-muted)]">
      <span>Runs on {machine}</span>
      <button type="button" disabled={loading || busy !== null} onClick={() => void refresh()} className="text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400">Refresh status</button>
    </div>}
    <div>
      <div className="mb-1.5 flex items-center gap-2"><span className="text-[10px] font-medium text-neutral-600 dark:text-neutral-400">Managed Podman environments</span><span className="rounded bg-green-50 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wide text-green-700 dark:bg-green-950/40 dark:text-green-400">Recommended</span></div>
      <div className="space-y-1 rounded-md border border-neutral-200 p-2 dark:border-neutral-700">{managed.map(renderOption)}</div>
      <p className="mt-1 text-[9px] text-[var(--adf-ui-text-subtle)]">ADF manages lifecycle, assignment, workspaces, packages, and rebuilds.</p>
    </div>
    <div className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">{renderOption(host)}<p className="ml-6 text-[11px] text-[var(--adf-ui-text-subtle)]">Host commands use your permissions and bypass container isolation.</p></div>
    {external.length > 0 && <details className="rounded-md border border-neutral-200 dark:border-neutral-700">
      <summary className="flex cursor-pointer list-none items-center justify-between px-2 py-2 text-[10px] font-medium text-neutral-600 dark:text-neutral-400"><span>Advanced · External containers</span><span className="font-normal text-[var(--adf-ui-text-subtle)]">{external.filter((o) => allowed.includes(o.id)).length} enabled</span></summary>
      <div className="space-y-1 border-t border-neutral-200 p-2 dark:border-neutral-700">{external.map(renderOption)}<p className="px-1 text-[11px] text-[var(--adf-ui-text-subtle)]">External containers are registered in Settings &gt; Compute and remain user-managed.</p></div>
    </details>}
    <label className="block"><span className="mb-1 block text-[10px] font-medium text-neutral-600 dark:text-neutral-400">Default environment<InfoHint tip="compute_exec uses the default when no target is specified. With multiple environments, the agent may select only from this allowlist." /></span>
      <select value={defaultTarget} onChange={(e) => { const { target: _legacyTarget, ...current } = config.compute ?? { enabled: false }; onChange({ ...current, allowed_targets: allowed, default_target: e.target.value }) }} className="field-input text-xs">
        {allowed.map((id) => <option key={id} value={id}>{options.find((o) => o.id === id)?.label ?? 'Unavailable target'}</option>)}
      </select>
    </label>
    {!config.tools.some((t) => t.name === 'compute_exec' && t.enabled && t.visible) && <p className="text-[11px] text-[var(--adf-ui-text-muted)]">{config.tools.some((t) => t.name === 'compute_exec' && t.enabled) ? 'Command tool is hidden from the agent.' : 'Command tool is off.'} <button type="button" onClick={onEnableCommands} className="text-blue-600 hover:underline dark:text-blue-400">Enable and show compute_exec</button></p>}
    {missing.length > 0 && <p className="text-[11px] text-red-500">An allowed target was removed from Settings. Choose an available default.</p>}
    {error && <p role="alert" className="break-words text-[11px] text-red-500">{error}</p>}
    {confirmation}
  </>
}
