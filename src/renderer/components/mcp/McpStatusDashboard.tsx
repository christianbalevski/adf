import { useState, useEffect, useCallback, useRef } from 'react'
import type { McpServerState, McpServerLogEntry, McpInstallProgress, McpToolInfo } from '../../../shared/types/adf-v02.types'
import type { McpServerRegistration, McpServerStatusEvent } from '../../../shared/types/ipc.types'
import { MCP_REGISTRY, findRegistryEntry, type McpRegistryEntry } from '../../../shared/constants/mcp-registry'
import { isSensitiveMcpHeader } from '../../../shared/utils/mcp-config'
import { McpServerLogs } from './McpServerLogs'
import { McpCredentialPanel } from './McpCredentialPanel'

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
}

export function McpStatusDashboard({ mcpServers, onServersChanged }: McpStatusDashboardProps) {
  // Ref to always access latest mcpServers inside async callbacks (avoids stale closures)
  const mcpServersRef = useRef(mcpServers)
  mcpServersRef.current = mcpServers

  const [serverStates, setServerStates] = useState<McpServerState[]>([])
  const [showLogsFor, setShowLogsFor] = useState<string | null>(null)
  const [logEntries, setLogEntries] = useState<McpServerLogEntry[]>([])
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  /** Server id that has its configure panel expanded */
  const [configureId, setConfigureId] = useState<string | null>(null)
  /** Test connection results per server id */
  const [testResults, setTestResults] = useState<Record<string, { loading: boolean; count?: number; error?: string }>>({})

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

  const handleRestart = async (name: string) => {
    await window.adfApi?.restartMcpServer({ name })
    await refreshStatus()
  }

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
    if (configureId === id) setConfigureId(null)

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

    onServersChanged(mcpServers.filter((s) => s.id !== id))
  }

  const updateServer = (id: string, patch: Partial<McpServerRegistration>) => {
    if (patch.headers) {
      patch = {
        ...patch,
        headers: patch.headers.map((header) => ({
          ...header,
          value: isSensitiveMcpHeader(header.key) ? '' : header.value
        }))
      }
    }
    onServersChanged(mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const handleTestConnection = async (server: McpServerRegistration) => {
    const serverType = server.type ?? 'npm'
    if (!server.name) return
    if (serverType === 'npm' && !server.npmPackage) return
    if ((serverType === 'uvx' || serverType === 'pip') && !server.pypiPackage) return
    if (serverType === 'custom' && !server.command) return
    if (serverType === 'http' && !server.url) return

    setTestResults((prev) => ({ ...prev, [server.id]: { loading: true } }))
    try {
      const envRecord: Record<string, string> = {}
      for (const e of server.env ?? []) {
        if (e.key) envRecord[e.key] = e.value
      }

      if (serverType === 'http') {
        const sensitiveStaticHeader = (server.headers ?? []).find((header) => header.key && isSensitiveMcpHeader(header.key) && header.value)
        if (sensitiveStaticHeader) {
          setTestResults((prev) => ({
            ...prev,
            [server.id]: { loading: false, error: `${sensitiveStaticHeader.key} must use an env-backed header or bearer token env var.` }
          }))
          return
        }
        const headers: Record<string, string> = {}
        for (const h of server.headers ?? []) {
          if (h.key && h.value) headers[h.key] = h.value
        }
        const result = await window.adfApi?.probeMcpServer({
          transport: 'http',
          url: server.url,
          name: server.name,
          env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          headerEnv: server.headerEnv?.filter((entry) => entry.key && entry.value),
          bearerTokenEnvVar: server.bearerTokenEnvVar || undefined
        })
        if (result?.success) {
          setTestResults((prev) => ({ ...prev, [server.id]: { loading: false, count: (result.tools as McpToolInfo[]).length } }))
        } else {
          setTestResults((prev) => ({ ...prev, [server.id]: { loading: false, error: result?.error ?? 'Failed' } }))
        }
        return
      }

      let command: string
      let args: string[]
      const userArgs = (server.args ?? []).filter(Boolean)

      if (serverType === 'uvx') {
        command = 'uvx'
        args = [server.pypiPackage!, ...userArgs]
      } else if (serverType === 'npm') {
        command = 'npx'
        args = ['-y', server.npmPackage!, ...userArgs]
      } else {
        command = server.command!
        args = userArgs
      }

      const result = await window.adfApi?.probeMcpServer({
        command,
        args,
        name: server.name,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined
      })
      if (result?.success) {
        setTestResults((prev) => ({ ...prev, [server.id]: { loading: false, count: (result.tools as McpToolInfo[]).length } }))
      } else {
        setTestResults((prev) => ({ ...prev, [server.id]: { loading: false, error: result?.error ?? 'Failed' } }))
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [server.id]: { loading: false, error: String(err) } }))
    }
  }

  const handleQuickInstall = async (entry: McpRegistryEntry) => {
    const isPython = entry.runtime === 'python'
    const pkg = isPython ? entry.pypiPackage : entry.npmPackage
    if (!pkg) return

    // Check if already registered
    if (mcpServers.some((s) => (s.npmPackage === pkg || s.pypiPackage === pkg))) return

    setInstalling((prev) => new Set(prev).add(pkg))
    setShowQuickAdd(false)

    // Add a placeholder entry immediately so it shows in the list
    const placeholderId = 'mcp:' + Math.random().toString(36).slice(2, 8)
    const allEnvKeys = [
      ...entry.requiredEnvKeys,
      ...(entry.optionalEnvKeys ?? [])
    ]
    const placeholder: McpServerRegistration = {
      id: placeholderId,
      name: entry.name,
      type: isPython ? 'uvx' : 'npm',
      npmPackage: isPython ? undefined : pkg,
      pypiPackage: isPython ? pkg : undefined,
      managed: true,
      env: allEnvKeys.map((k) => ({ key: k, value: '' })),
      repo: entry.repo
    }
    onServersChanged([...mcpServers, placeholder])

    try {
      const result = isPython
        ? await window.adfApi?.installPythonMcpPackage({ package: pkg, name: entry.name })
        : await window.adfApi?.installMcpPackage({ package: pkg, name: entry.name })

      if (result?.success && result.installed) {
        // Use ref to get latest servers (avoids stale closure after await)
        const current = mcpServersRef.current
        onServersChanged(current.map((s) =>
          s.id === placeholderId ? { ...s, version: result.installed!.version } : s
        ))

        // Auto-expand configure panel if the server needs env keys
        if (entry.requiredEnvKeys.length > 0) {
          setConfigureId(placeholderId)
        }
      }
    } catch {
      // Error handled via install progress event
    }
  }

  const handleAddCustomServer = () => {
    const newReg: McpServerRegistration = {
      id: 'mcp:' + Math.random().toString(36).slice(2, 8),
      name: '',
      type: 'custom',
      command: '',
      args: [],
      env: []
    }
    onServersChanged([...mcpServers, newReg])
    setConfigureId(newReg.id)
  }

  const handleAddHttpServer = () => {
    const newReg: McpServerRegistration = {
      id: 'mcp:' + Math.random().toString(36).slice(2, 8),
      name: '',
      type: 'http',
      url: '',
      headers: [],
      headerEnv: [],
      env: []
    }
    onServersChanged([...mcpServers, newReg])
    setConfigureId(newReg.id)
  }

  // Merge registered servers with live status
  const serverList = mcpServers.map((reg) => {
    const state = serverStates.find((s) => s.name === reg.name)
    return { reg, state }
  })

  // Registry entries not yet installed
  const availableServers = MCP_REGISTRY.filter(
    (entry) => !mcpServers.some((s) =>
      (entry.npmPackage && s.npmPackage === entry.npmPackage) ||
      (entry.pypiPackage && s.pypiPackage === entry.pypiPackage)
    )
  )

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          MCP Servers
        </label>
        <div className="flex gap-2">
          <button
            onClick={handleAddCustomServer}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            + Custom
          </button>
          <button
            onClick={handleAddHttpServer}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            + HTTP
          </button>
          {availableServers.length > 0 && (
            <button
              onClick={() => setShowQuickAdd(!showQuickAdd)}
              className="text-xs text-blue-500 hover:text-blue-700 font-medium"
            >
              {showQuickAdd ? 'Hide' : '+ Quick Add'}
            </button>
          )}
        </div>
      </div>

      {/* Quick-add panel */}
      {showQuickAdd && (
        <div className="grid grid-cols-2 gap-2 p-3 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg border border-neutral-200 dark:border-neutral-700">
          {availableServers.map((entry) => {
            const entryPkg = entry.npmPackage ?? entry.pypiPackage ?? entry.name
            const isPython = entry.runtime === 'python'
            return (
            <div
              key={entryPkg}
              className="flex items-start gap-2 p-2 rounded-md border border-neutral-200 dark:border-neutral-700 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                    {entry.displayName}
                  </span>
                  {isPython && (
                    <span className="text-[9px] px-1 py-0.5 bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400 rounded font-medium">
                      Python
                    </span>
                  )}
                  {entry.verified && (
                    <span className="text-[9px] px-1 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded font-medium">
                      Official
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5 line-clamp-2">
                  {entry.description}
                </p>
                {entry.requiredEnvKeys.length > 0 && (
                  <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-0.5">
                    Requires: {entry.requiredEnvKeys.join(', ')}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <button
                    onClick={() => handleQuickInstall(entry)}
                    disabled={installing.has(entryPkg)}
                    className="text-[10px] text-blue-500 hover:text-blue-700 font-medium disabled:opacity-50"
                  >
                    {installing.has(entryPkg) ? 'Installing...' : 'Install'}
                  </button>
                  {entry.repo && (
                    <a
                      href={entry.repo}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Repo
                    </a>
                  )}
                </div>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {/* Server list — unified: all servers (managed + custom) */}
      {serverList.length === 0 && !showQuickAdd ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          No MCP servers configured. Use Quick Add to install popular servers or + Custom to add your own.
        </p>
      ) : (
        <div className="space-y-2">
          {serverList.map(({ reg, state }) => {
            const regPkg = reg.npmPackage ?? reg.pypiPackage ?? ''
            const isInstalling = installing.has(regPkg)
            const installError = installErrors[regPkg]
            const status = isInstalling ? 'installing' : (state?.status ?? 'stopped')
            const isConfiguring = configureId === reg.id
            const isPythonServer = reg.type === 'uvx' || reg.type === 'pip'
            const registryEntry = reg.npmPackage ? findRegistryEntry(reg.npmPackage) : undefined
            const hasEmptyRequiredKeys = reg.credentialStorage !== 'agent' && (registryEntry?.requiredEnvKeys ?? []).some((rk) => {
              const envEntry = (reg.env ?? []).find((e) => e.key === rk)
              return !envEntry || !envEntry.value
            })
            const testResult = testResults[reg.id]
            const isCustom = reg.type === 'custom'
            const isHttp = reg.type === 'http'

            return (
              <div key={reg.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
                <div
                  onClick={() => setConfigureId(isConfiguring ? null : reg.id)}
                  className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Status indicator */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status] ?? 'bg-neutral-400'}`} />
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
                    {isHttp && (
                      <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded">
                        HTTP
                      </span>
                    )}
                    {hasEmptyRequiredKeys && !isConfiguring && (
                      <span className="text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded font-medium">
                        Needs keys
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleTestConnection(reg) }}
                      disabled={testResult?.loading || (!reg.name) || (isHttp ? !reg.url : isCustom ? !reg.command : isPythonServer ? !reg.pypiPackage : !reg.npmPackage)}
                      className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 disabled:opacity-40"
                    >
                      {testResult?.loading ? 'Testing...' : 'Test'}
                    </button>
                    {(state?.status === 'error' || state?.status === 'connected') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRestart(reg.name) }}
                        className={`text-[11px] font-medium ${
                          state.status === 'error'
                            ? 'text-blue-500 hover:text-blue-700'
                            : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200'
                        }`}
                      >
                        Restart
                      </button>
                    )}
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

                {/* Test result */}
                {testResult && !testResult.loading && (
                  <div className="px-3 pb-1">
                    <span className={`text-[10px] ${testResult.error ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                      {testResult.error ? testResult.error : `${testResult.count} tools discovered`}
                    </span>
                  </div>
                )}

                {/* Error display */}
                {(state?.error || installError) && !isConfiguring && !testResult && (
                  <div className="px-3 pb-2">
                    <p className="text-[10px] text-red-500">{state?.error || installError}</p>
                  </div>
                )}

                {/* Configure panel */}
                {isConfiguring && (
                  <div className="px-3 pb-3 border-t border-neutral-100 dark:border-neutral-700">
                    <div className="mt-2 space-y-3">
                      {/* Server info */}
                      <div className="text-[10px] text-neutral-500 dark:text-neutral-400 space-y-0.5">
                        {reg.npmPackage && (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">Package:</span>
                            <span className="font-mono text-neutral-600 dark:text-neutral-300">{reg.npmPackage}</span>
                          </div>
                        )}
                        {isCustom && reg.command && (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">Command:</span>
                            <span className="font-mono text-neutral-600 dark:text-neutral-300">
                              {reg.command}{(reg.args ?? []).length > 0 ? ` ${(reg.args ?? []).join(' ')}` : ''}
                            </span>
                          </div>
                        )}
                        {isHttp && reg.url && (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">URL:</span>
                            <span className="font-mono text-neutral-600 dark:text-neutral-300 truncate">{reg.url}</span>
                          </div>
                        )}
                        {reg.managed && reg.version && (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">Version:</span>
                            <span className="text-neutral-600 dark:text-neutral-300">{reg.version}</span>
                          </div>
                        )}
                        {registryEntry?.description && (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">Description:</span>
                            <span className="text-neutral-600 dark:text-neutral-300">{registryEntry.description}</span>
                          </div>
                        )}
                        {state?.toolCount ? (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">Tools:</span>
                            <span className="text-neutral-600 dark:text-neutral-300">{state.toolCount}</span>
                          </div>
                        ) : null}
                        {(reg.repo || registryEntry?.repo) && (
                          <div className="flex gap-1.5">
                            <span className="text-neutral-400 dark:text-neutral-500 shrink-0">Repo:</span>
                            <a
                              href={reg.repo || registryEntry?.repo}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:text-blue-700 truncate"
                            >
                              {reg.repo || registryEntry?.repo}
                            </a>
                          </div>
                        )}
                      </div>

                      {/* Custom server fields */}
                      {(isCustom || isHttp) && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-1 rounded-md border border-neutral-300 dark:border-neutral-600 p-0.5">
                            <button
                              onClick={() => updateServer(reg.id, { type: 'custom' })}
                              className={`py-1 text-[11px] rounded ${isCustom ? 'bg-neutral-200 dark:bg-neutral-600 text-neutral-800 dark:text-neutral-100 font-medium' : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
                            >
                              STDIO
                            </button>
                            <button
                              onClick={() => updateServer(reg.id, { type: 'http' })}
                              className={`py-1 text-[11px] rounded ${isHttp ? 'bg-neutral-200 dark:bg-neutral-600 text-neutral-800 dark:text-neutral-100 font-medium' : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
                            >
                              Streamable HTTP
                            </button>
                          </div>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Name</label>
                            <input
                              type="text"
                              value={reg.name}
                              onChange={(e) => updateServer(reg.id, { name: e.target.value.replace(/[^a-z0-9_]/g, '') })}
                              placeholder="e.g. my_server"
                              className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                            <p className="text-[9px] text-neutral-400 mt-0.5">Lowercase letters, numbers, underscores</p>
                          </div>
                          {isCustom && (
                            <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Command</label>
                            <input
                              type="text"
                              value={reg.command ?? ''}
                              onChange={(e) => updateServer(reg.id, { command: e.target.value })}
                              placeholder="e.g. node, python, /path/to/binary"
                              className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                            </div>
                          )}
                          {isHttp && (
                            <div>
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">URL</label>
                              <input
                                type="url"
                                value={reg.url ?? ''}
                                onChange={(e) => updateServer(reg.id, { url: e.target.value })}
                                placeholder="https://mcp.example.com/mcp"
                                className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Args — available for all server types */}
                      {!isHttp && (
                        <div>
                        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">
                          Args {!isCustom && <span className="text-neutral-400 dark:text-neutral-500">(appended after package)</span>}
                        </label>
                        <div className="space-y-1">
                          {(reg.args ?? []).map((arg, argIdx) => (
                            <div key={argIdx} className="flex items-center gap-1">
                              <input
                                type="text"
                                value={arg}
                                onChange={(e) => {
                                  const next = [...(reg.args ?? [])]
                                  next[argIdx] = e.target.value
                                  updateServer(reg.id, { args: next })
                                }}
                                placeholder={isCustom ? '--port 3000' : '/path/to/directory'}
                                className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                              />
                              <button
                                onClick={() => {
                                  const next = (reg.args ?? []).filter((_, i) => i !== argIdx)
                                  updateServer(reg.id, { args: next })
                                }}
                                className="text-neutral-400 hover:text-red-500 text-xs px-1"
                              >
                                x
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={() => updateServer(reg.id, { args: [...(reg.args ?? []), ''] })}
                            className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                          >
                            + Add arg
                          </button>
                        </div>
                        </div>
                      )}

                      {isHttp && (
                        <div className="space-y-3">
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Bearer token env var</label>
                            <input
                              type="text"
                              value={reg.bearerTokenEnvVar ?? ''}
                              onChange={(e) => updateServer(reg.id, { bearerTokenEnvVar: e.target.value })}
                              placeholder="MCP_BEARER_TOKEN"
                              className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Headers</label>
                              <button
                                onClick={() => updateServer(reg.id, { headers: [...(reg.headers ?? []), { key: '', value: '' }] })}
                                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                              >
                                + Add
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              {(reg.headers ?? []).map((header, idx) => (
                                <div key={idx} className="flex gap-1.5 items-center">
                                  <input
                                    type="text"
                                    value={header.key}
                                    onChange={(e) => {
                                      const next = [...(reg.headers ?? [])]
                                      next[idx] = { ...next[idx], key: e.target.value, value: isSensitiveMcpHeader(e.target.value) ? '' : next[idx].value }
                                      updateServer(reg.id, { headers: next })
                                    }}
                                    placeholder="Header"
                                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                  />
                                  <input
                                    type="password"
                                    value={header.value}
                                    onChange={(e) => {
                                      const next = [...(reg.headers ?? [])]
                                      next[idx] = { ...next[idx], value: e.target.value }
                                      updateServer(reg.id, { headers: next })
                                    }}
                                    placeholder={isSensitiveMcpHeader(header.key) ? 'Use env-backed headers' : 'Value'}
                                    disabled={isSensitiveMcpHeader(header.key)}
                                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                  />
                                  <button
                                    onClick={() => updateServer(reg.id, { headers: (reg.headers ?? []).filter((_, i) => i !== idx) })}
                                    className="text-xs text-red-400 hover:text-red-600 px-1"
                                  >
                                    x
                                  </button>
                                </div>
                              ))}
                            </div>
                            {(reg.headers ?? []).some((header) => header.key && isSensitiveMcpHeader(header.key)) && (
                              <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-1">
                                Secret-bearing headers should use bearer token env var or headers from environment variables.
                              </p>
                            )}
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Headers from environment variables</label>
                              <button
                                onClick={() => updateServer(reg.id, { headerEnv: [...(reg.headerEnv ?? []), { key: '', value: '' }] })}
                                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                              >
                                + Add
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              {(reg.headerEnv ?? []).map((header, idx) => (
                                <div key={idx} className="flex gap-1.5 items-center">
                                  <input
                                    type="text"
                                    value={header.key}
                                    onChange={(e) => {
                                      const next = [...(reg.headerEnv ?? [])]
                                      next[idx] = { ...next[idx], key: e.target.value }
                                      updateServer(reg.id, { headerEnv: next })
                                    }}
                                    placeholder="Header"
                                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                  />
                                  <input
                                    type="text"
                                    value={header.value}
                                    onChange={(e) => {
                                      const next = [...(reg.headerEnv ?? [])]
                                      next[idx] = { ...next[idx], value: e.target.value }
                                      updateServer(reg.id, { headerEnv: next })
                                    }}
                                    placeholder="ENV_VAR"
                                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                  />
                                  <button
                                    onClick={() => updateServer(reg.id, { headerEnv: (reg.headerEnv ?? []).filter((_, i) => i !== idx) })}
                                    className="text-xs text-red-400 hover:text-red-600 px-1"
                                  >
                                    x
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Tool call timeout */}
                      <div>
                        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">
                          Tool Timeout (seconds)
                        </label>
                        <input
                          type="number"
                          min={1}
                          value={reg.toolCallTimeout ?? ''}
                          onChange={(e) => {
                            const val = e.target.value ? parseInt(e.target.value, 10) : undefined
                            updateServer(reg.id, { toolCallTimeout: val && val > 0 ? val : undefined })
                          }}
                          placeholder="60"
                          className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                        />
                        <p className="text-[9px] text-neutral-400 mt-0.5">Override the default 60s timeout for tool calls on this server</p>
                      </div>

                      {/* Credential panel — same for both managed and custom */}
                      <McpCredentialPanel
                        server={reg}
                        registryEntry={registryEntry}
                        onServerUpdate={(patch) => updateServer(reg.id, patch)}
                      />

                      {/* Error from state */}
                      {(state?.error || installError) && (
                        <p className="text-[10px] text-red-500">{state?.error || installError}</p>
                      )}
                    </div>
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
