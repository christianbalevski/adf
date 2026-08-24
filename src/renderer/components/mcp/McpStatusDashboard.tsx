import { useState, useEffect, useCallback, useRef } from 'react'
import type { McpServerState, McpServerLogEntry, McpInstallProgress } from '../../../shared/types/adf-v02.types'
import type { McpServerRegistration, McpServerStatusEvent } from '../../../shared/types/ipc.types'
import { findRegistryEntry } from '../../../shared/constants/mcp-registry'
import { BrandIcon } from './BrandIcon'
import { isRegistrationAgentVisible } from '../../../shared/utils/mcp-config'
import { McpServerLogs } from './McpServerLogs'
import { McpAddServerModal, HOST_BOUNDARY_TEXT } from './McpAddServerModal'
import { Tooltip } from '../common/Tooltip'

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  error: 'bg-red-500',
  stopped: 'bg-neutral-400',
  installing: 'bg-blue-500 animate-pulse'
}

const STATUS_LABELS: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  error: 'Error',
  stopped: 'Stopped',
  installing: 'Installing...'
}

interface McpStatusDashboardProps {
  mcpServers: McpServerRegistration[]
  onServersChanged: (servers: McpServerRegistration[]) => void
  /** Settings → Compute master toggle; used to surface host-location conflicts inline. */
  hostAccessEnabled?: boolean
  /** Invoked from the conflict note so the user can enable host access without tab-hopping. */
  onEnableHostAccess?: () => void
}

export function McpStatusDashboard({ mcpServers, onServersChanged, hostAccessEnabled, onEnableHostAccess }: McpStatusDashboardProps) {
  // Ref to always access latest mcpServers inside async callbacks (avoids stale closures)
  const mcpServersRef = useRef(mcpServers)
  mcpServersRef.current = mcpServers

  const [serverStates, setServerStates] = useState<McpServerState[]>([])
  const [showLogsFor, setShowLogsFor] = useState<string | null>(null)
  const [logEntries, setLogEntries] = useState<McpServerLogEntry[]>([])
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  /** Add/Configure modal state: open + registration id being edited (null = add). */
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Reconnect results per server id */
  const [reconnectResults, setReconnectResults] = useState<Record<string, { loading: boolean; count?: number; error?: string }>>({})

  // Fetch server status on mount
  const refreshStatus = useCallback(async () => {
    const result = await window.adfApi?.getMcpServerStatus()
    if (result?.servers) {
      setServerStates(result.servers)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  // Listen for status change events
  useEffect(() => {
    const unsub = window.adfApi?.onMcpServerStatusChanged((event: McpServerStatusEvent) => {
      setServerStates((prev) => {
        const idx = prev.findIndex((s) => s.name === event.name)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = { ...updated[idx], status: event.status, error: event.error, toolCount: event.toolCount ?? updated[idx].toolCount }
          return updated
        }
        return [...prev, { name: event.name, status: event.status, error: event.error, restartCount: 0, toolCount: event.toolCount ?? 0, logs: [] }]
      })
    })
    return () => { unsub?.() }
  }, [])

  // Listen for install progress events
  useEffect(() => {
    const unsub = window.adfApi?.onMcpInstallProgress((event: McpInstallProgress) => {
      if (event.status === 'installed') {
        setInstalling((prev) => {
          const next = new Set(prev)
          next.delete(event.package)
          return next
        })
        setInstallErrors((prev) => {
          const next = { ...prev }
          delete next[event.package]
          return next
        })
      } else if (event.status === 'error') {
        setInstalling((prev) => {
          const next = new Set(prev)
          next.delete(event.package)
          return next
        })
        setInstallErrors((prev) => ({ ...prev, [event.package]: event.error ?? 'Unknown error' }))
      }
    })
    return () => { unsub?.() }
  }, [])

  const handleShowLogs = async (name: string) => {
    if (showLogsFor === name) {
      setShowLogsFor(null)
      return
    }
    const result = await window.adfApi?.getMcpServerLogs({ name })
    setLogEntries(result?.logs ?? [])
    setShowLogsFor(name)
  }

  const handleRemove = async (id: string) => {
    const server = mcpServers.find((s) => s.id === id)

    // Uninstall the managed package before removing the config entry
    if (server?.managed) {
      const isPython = server.type === 'uvx' || server.type === 'pip'
      const pkg = isPython ? server.pypiPackage : server.npmPackage
      if (pkg) {
        try {
          if (isPython) {
            await window.adfApi?.uninstallPythonMcpPackage({ package: pkg })
          } else {
            await window.adfApi?.uninstallMcpPackage({ package: pkg })
          }
        } catch (err) {
          console.warn(`[McpStatusDashboard] Uninstall failed for ${pkg}:`, err)
        }
      }
    }

    onServersChanged(mcpServersRef.current.filter((s) => s.id !== id))
  }

  /** Save from the Add/Configure modal: replace when editing, append when new. */
  const handleModalSave = async (reg: McpServerRegistration) => {
    const current = mcpServersRef.current
    const exists = current.some((s) => s.id === reg.id)
    onServersChanged(exists ? current.map((s) => (s.id === reg.id ? reg : s)) : [...current, reg])

    // New managed npm/pypi servers: download the package in the background
    // (parity with the old quick-install flow; progress events update the row).
    if (!exists && reg.managed) {
      const isPython = reg.type === 'uvx' || reg.type === 'pip'
      const pkg = isPython ? reg.pypiPackage : reg.npmPackage
      if (pkg) {
        setInstalling((prev) => new Set(prev).add(pkg))
        try {
          const result = isPython
            ? await window.adfApi?.installPythonMcpPackage({ package: pkg, name: reg.name })
            : await window.adfApi?.installMcpPackage({ package: pkg, name: reg.name })
          if (result?.success && result.installed) {
            onServersChanged(mcpServersRef.current.map((s) =>
              s.id === reg.id ? { ...s, version: result.installed!.version } : s
            ))
          }
        } catch {
          // Error handled via install progress event
        }
      }
    }
  }

  /**
   * Reconnect / Re-authorize: re-run the real connect pipeline for a saved
   * registration (auth preflight included when declared), then restart the
   * live server so agents pick the refreshed state up.
   */
  const handleReconnect = async (reg: McpServerRegistration) => {
    setReconnectResults((prev) => ({ ...prev, [reg.id]: { loading: true } }))
    try {
      const result = await window.adfApi?.testMcpRegistration({ registration: reg })
      if (result?.success) {
        setReconnectResults((prev) => ({ ...prev, [reg.id]: { loading: false, count: result.tools.length } }))
        onServersChanged(mcpServersRef.current.map((s) => (s.id === reg.id ? { ...s, lastVerifiedAt: Date.now() } : s)))
        const state = serverStates.find((s) => s.name === reg.name)
        if (state && state.status !== 'stopped') {
          await window.adfApi?.restartMcpServer({ name: reg.name })
          await refreshStatus()
        }
      } else {
        setReconnectResults((prev) => ({ ...prev, [reg.id]: { loading: false, error: result?.error ?? 'Failed' } }))
      }
    } catch (err) {
      setReconnectResults((prev) => ({ ...prev, [reg.id]: { loading: false, error: String(err) } }))
    }
  }

  // Merge registered servers with live status
  const serverList = mcpServers.map((reg) => {
    const state = serverStates.find((s) => s.name === reg.name)
    return { reg, state }
  })

  const editingServer = editingId ? mcpServers.find((s) => s.id === editingId) ?? null : null

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          MCP Servers
        </label>
        <button
          onClick={() => { setEditingId(null); setModalOpen(true) }}
          className="px-2.5 py-1 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
        >
          + Add MCP Server
        </button>
      </div>

      {/* Add / Configure modal */}
      <McpAddServerModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditingId(null) }}
        editing={editingServer}
        existingServers={mcpServers}
        hostAccessEnabled={hostAccessEnabled}
        onEnableHostAccess={onEnableHostAccess}
        onSave={handleModalSave}
      />

      {/* Server list */}
      {serverList.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          No MCP servers configured. Use “Add MCP Server” to pick a known server or configure your own.
        </p>
      ) : (
        <div className="space-y-2">
          {serverList.map(({ reg, state }) => {
            const regPkg = reg.npmPackage ?? reg.pypiPackage ?? ''
            const isInstalling = installing.has(regPkg)
            const installError = installErrors[regPkg]
            const status = isInstalling ? 'installing' : (state?.status ?? 'stopped')
            const isPythonServer = reg.type === 'uvx' || reg.type === 'pip'
            const registryEntry = reg.npmPackage ? findRegistryEntry(reg.npmPackage) : undefined
            const hasEmptyRequiredKeys = reg.credentialStorage !== 'agent' && (registryEntry?.requiredEnvKeys ?? []).some((rk) => {
              const envEntry = (reg.env ?? []).find((e) => e.key === rk)
              return !envEntry || !envEntry.value
            })
            const reconnect = reconnectResults[reg.id]
            const isCustom = reg.type === 'custom'
            const isHttp = reg.type === 'http'

            return (
              <div key={reg.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
                <div
                  onClick={() => { setEditingId(reg.id); setModalOpen(true) }}
                  className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Status indicator */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status] ?? 'bg-neutral-400'}`} />
                    <BrandIcon iconKey={registryEntry?.iconKey} category={registryEntry?.category ?? (isHttp ? 'web' : 'tools')} size={22} />
                    <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate">
                      {reg.name || '(unnamed)'}
                    </span>
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                      {STATUS_LABELS[status] ?? status}
                    </span>
                    {state?.toolCount ? (
                      <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                        ({state.toolCount} tools)
                      </span>
                    ) : null}
                    {isPythonServer && (
                      <span className="text-[9px] px-1 py-0.5 bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400 rounded font-medium">
                        Python
                      </span>
                    )}
                    {reg.managed && reg.version && (
                      <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded">
                        v{reg.version}
                      </span>
                    )}
                    {isCustom && (
                      <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded">
                        custom
                      </span>
                    )}
                    {isHttp ? (
                      <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded">
                        remote
                      </span>
                    ) : (
                      <Tooltip tip={reg.runLocation === 'host' ? HOST_BOUNDARY_TEXT : 'Runs isolated in the shared compute container (requires Podman).'}>
                        <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                          reg.runLocation === 'host'
                            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400'
                            : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                        }`}>
                          {reg.runLocation === 'host' ? 'Host' : 'Container'}
                        </span>
                      </Tooltip>
                    )}
                    {isRegistrationAgentVisible(reg) && (
                      <Tooltip tip="Available to agents — any agent may attach and use this server.">
                        <span className="text-[9px] px-1 py-0.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded font-medium">
                          Agents
                        </span>
                      </Tooltip>
                    )}
                    {!reg.lastVerifiedAt && (
                      <Tooltip tip="This server has not completed a successful Connect yet — open it and use Connect to verify.">
                        <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 rounded">
                          Not verified
                        </span>
                      </Tooltip>
                    )}
                    {hasEmptyRequiredKeys && (
                      <span className="text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded font-medium">
                        Needs keys
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingId(reg.id); setModalOpen(true) }}
                      className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    >
                      Configure
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleReconnect(reg) }}
                      disabled={reconnect?.loading || !reg.name}
                      className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 disabled:opacity-40"
                    >
                      {reconnect?.loading ? 'Working…' : reg.auth ? 'Re-authorize' : 'Reconnect'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleShowLogs(reg.name) }}
                      className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    >
                      Logs
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemove(reg.id) }}
                      className="text-[11px] text-red-400 hover:text-red-600"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Reconnect result */}
                {reconnect && !reconnect.loading && (
                  <div className="px-3 pb-1">
                    <span className={`text-[10px] ${reconnect.error ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                      {reconnect.error ? reconnect.error : `${reconnect.count} tools discovered`}
                    </span>
                  </div>
                )}

                {/* Error display */}
                {(state?.error || installError) && !reconnect && (
                  <div className="px-3 pb-2">
                    <p className="text-[10px] text-red-500">{state?.error || installError}</p>
                  </div>
                )}

                {/* Logs panel */}
                {showLogsFor === reg.name && (
                  <div className="px-3 pb-3">
                    <McpServerLogs
                      logs={logEntries}
                      serverName={reg.name}
                      onClose={() => setShowLogsFor(null)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
