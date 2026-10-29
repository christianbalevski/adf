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
import type { AgentConfig, McpServerStatus } from '../../../shared/types/adf-v02.types'
import type { McpServerRegistration } from '../../../shared/types/ipc.types'

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
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({})
  /** Servers already shown for this file: the sheet opens by itself once per server. */
  const prompted = useRef(new Set<string>())

  useEffect(() => {
    prompted.current = new Set()
    setStatuses({})
    if (!filePath) return
    let cancelled = false
    void Promise.resolve(openApi()?.getMcpServerStatus?.()).then((res) => {
      if (cancelled || !res?.servers) return
      setStatuses(Object.fromEntries(res.servers.map((s) => [s.name, s.status])))
    }).catch(() => { /* no runtime for this agent */ })
    const unsub = openApi()?.onMcpServerStatusChanged?.((event) => {
      setStatuses((prev) => ({ ...prev, [event.name]: event.status }))
    })
    return () => { cancelled = true; unsub?.() }
  }, [filePath, openRuntime])

  useEffect(() => {
    if (!filePath) return
    const fresh = Object.entries(statuses).filter(([name, status]) => status === 'needs_compute' && !prompted.current.has(name)).map(([name]) => name)
    if (fresh.length === 0) return
    for (const name of fresh) prompted.current.add(name)
    const waiting = Object.entries(statuses).filter(([, status]) => status === 'needs_compute').map(([name]) => name)
    openSheet(filePath, waiting)
  }, [statuses, filePath, openSheet])

  const open = !!request && request.filePath === filePath
  const servers = open ? request.servers : []

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
    for (const name of servers) {
      const reg = registrations.find((r) => r.name === name)
      if (reg) {
        // A Settings-managed server runs where its registration says.
        nextRegistrations = (nextRegistrations ?? registrations).map((r) => (r.name === name ? { ...r, runLocation: 'host' as const } : r))
        const patch = allowHostPatch(name, registrationSourceIdentity(reg), true, runtime)
        runtime = { ...runtime, ...patch }
        computePatch = { ...computePatch, ...patch }
      } else {
        const server = config.mcp?.servers?.find((s) => s.name === name)
        if (!server) continue
        const patch = allowHostPatch(name, serverSourceIdentity(server), !config.compute?.host_access, runtime)
        runtime = { ...runtime, ...patch }
        computePatch = { ...computePatch, ...patch }
        agentOwned.push(name)
      }
    }
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
    const outcome = await writeSettings({ compute: { mcpOnHost: true } }, openApi())
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
      acceptMcpOnHost={acceptMcpOnHost}
    />
  )
}
