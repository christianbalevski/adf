import { useCallback, useEffect, useRef, useState } from 'react'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { useComputeSetupStore } from '../../stores/compute-setup.store'
import { openApi, useOpenRuntime } from '../../utils/runtime-api'
import { changeAgentConfig } from '../../utils/edit-conflict'
import { writeSettings } from '../settings/settings-save'
import { ComputeNeededSheet } from '../mcp/ComputeNeededSheet'
import { allowHostPatch, serverSourceIdentity, type RuntimeHostApproval } from '../../../shared/utils/mcp-host-placement'
import { registrationSourceIdentity } from '../../../shared/utils/mcp-config'
import { LOCAL_RUNTIME } from '../../../shared/runtime-tag'
import type { AgentConfig, McpServerStatus } from '../../../shared/types/adf-v02.types'
import type { AppSettings, McpServerRegistration } from '../../../shared/types/ipc.types'

/**
 * Compute at the moment of need, for the open agent. Mounted once in
 * AppShell. When one of the agent's MCP servers can't start because Podman
 * isn't set up (status `needs_compute`, from an mcp_install or the agent's
 * start), the sheet opens once for that server; the config panel's "Set up"
 * opens it again. Once Podman is ready or a host choice is saved, the
 * servers reconnect.
 */
export function ComputeSetupDialog() {
  const filePath = useDocumentStore((s) => s.filePath)
  const openRuntime = useOpenRuntime()
  const request = useComputeSetupStore((s) => s.request)
  const openSheet = useComputeSetupStore((s) => s.open)
  const closeSheet = useComputeSetupStore((s) => s.close)
  /** Statuses with the file they belong to: a switch never shows the last agent's servers. */
  const [statuses, setStatuses] = useState<{ filePath: string | null; byName: Record<string, McpServerStatus> }>({ filePath: null, byName: {} })
  /** Servers already shown for this file: the sheet opens by itself once per server. */
  const prompted = useRef<{ filePath: string | null; names: Set<string> }>({ filePath: null, names: new Set() })

  useEffect(() => {
    setStatuses({ filePath, byName: {} })
    if (!filePath) return
    let cancelled = false
    void Promise.resolve(openApi()?.getMcpServerStatus?.()).then((res) => {
      if (cancelled || !res?.servers) return
      setStatuses({ filePath, byName: Object.fromEntries(res.servers.map((s) => [s.name, s.status])) })
    }).catch(() => { /* no runtime for this agent */ })
    const unsub = openApi()?.onMcpServerStatusChanged?.((event) => {
      if (cancelled) return
      setStatuses((prev) => (prev.filePath === filePath ? { filePath, byName: { ...prev.byName, [event.name]: event.status } } : prev))
    })
    return () => { cancelled = true; unsub?.() }
  }, [filePath, openRuntime])

  useEffect(() => {
    if (!filePath || statuses.filePath !== filePath) return
    if (prompted.current.filePath !== filePath) prompted.current = { filePath, names: new Set() }
    const waiting = Object.entries(statuses.byName).filter(([, status]) => status === 'needs_compute').map(([name]) => name)
    const fresh = waiting.filter((name) => !prompted.current.names.has(name))
    if (fresh.length === 0) return
    for (const name of fresh) prompted.current.names.add(name)
    openSheet(filePath, waiting)
  }, [statuses, filePath, openSheet])

  const open = !!request && request.filePath === filePath
  const servers = open ? request.servers : []

  // The open agent's runtime settings, read when the sheet opens: whether
  // "run all on the host" would move any of these servers.
  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSettings(null)
    void Promise.resolve(openApi()?.getSettings()).then((s) => { if (!cancelled) setSettings(s ?? null) }).catch(() => {})
    return () => { cancelled = true }
  }, [open])
  const config = useAgentStore((s) => s.config) as AgentConfig | null
  const mcpOnHostWouldHelp = (() => {
    if (!settings || !config) return false
    if (settings.compute?.mcpOnHost === true && settings.compute.hostAccessEnabled === true) return false
    // An agent with its own container keeps its servers in it (container-routing.ts).
    if (config.compute?.enabled) return false
    const registrations = settings.mcpServers ?? []
    return servers.some((name) => {
      const reg = registrations.find((r) => r.name === name)
      const location = reg ? reg.runLocation : config.mcp?.servers?.find((s) => s.name === name)?.run_location
      return location !== 'shared'
    })
  })()

  const reconnect = useCallback(() => {
    closeSheet()
    for (const name of servers) void openApi()?.restartMcpServer?.({ name })
  }, [servers, closeSheet])

  const runOnHost = useCallback(async (): Promise<boolean> => {
    const api = openApi()
    const settings = await api?.getSettings()
    const config = useAgentStore.getState().config as AgentConfig | null
    if (!settings || !config) return false
    const compute = settings.compute
    let runtime: RuntimeHostApproval = { hostAccessEnabled: compute?.hostAccessEnabled === true, hostApproved: compute?.hostApproved ?? [], hostApprovedSources: compute?.hostApprovedSources }
    let computePatch: Record<string, unknown> = {}
    const registrations = settings.mcpServers ?? []
    let nextRegistrations: McpServerRegistration[] | null = null
    const agentOwned: string[] = []
    let matched = 0
    for (const name of servers) {
      const reg = registrations.find((r) => r.name === name)
      if (reg) {
        // A Settings-managed server runs where its registration says.
        nextRegistrations = (nextRegistrations ?? registrations).map((r) => (r.name === name ? { ...r, runLocation: 'host' as const } : r))
        const patch = allowHostPatch(name, registrationSourceIdentity(reg), true, runtime)
        runtime = { ...runtime, ...patch }
        computePatch = { ...computePatch, ...patch }
        matched++
      } else {
        const server = config.mcp?.servers?.find((s) => s.name === name)
        if (!server) continue
        const patch = allowHostPatch(name, serverSourceIdentity(server), !config.compute?.host_access, runtime)
        runtime = { ...runtime, ...patch }
        computePatch = { ...computePatch, ...patch }
        agentOwned.push(name)
        matched++
      }
    }
    if (matched === 0) return false
    const outcome = await writeSettings({ compute: computePatch, ...(nextRegistrations ? { mcpServers: nextRegistrations } : {}) }, api)
    if (!outcome.ok) return false
    if (agentOwned.length) {
      const saved = await changeAgentConfig<AgentConfig>((c) => ({
        ...c,
        mcp: c.mcp && {
          ...c.mcp,
          servers: c.mcp.servers.map((s) => {
            if (!agentOwned.includes(s.name)) return s
            const { host_requested: _, ...rest } = s
            return { ...rest, run_location: 'host' as const }
          }),
        },
      }))
      if (!saved) return false
    }
    return true
  }, [servers])

  const acceptMcpOnHost = useCallback(async (): Promise<boolean> => {
    // MCP servers on the host apply only while Host access is on; the acceptance covers both.
    const outcome = await writeSettings({ compute: { hostAccessEnabled: true, mcpOnHost: true } }, openApi())
    return outcome.ok
  }, [])

  return (
    <ComputeNeededSheet
      open={open}
      servers={servers}
      api={openApi()}
      onClose={closeSheet}
      onResolved={reconnect}
      runOnHost={runOnHost}
      acceptMcpOnHost={mcpOnHostWouldHelp ? acceptMcpOnHost : undefined}
      remote={openRuntime !== LOCAL_RUNTIME}
    />
  )
}
