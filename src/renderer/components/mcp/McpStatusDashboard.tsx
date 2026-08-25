import { useState, useEffect, useCallback, useRef } from 'react'
import type { McpServerState, McpInstallProgress } from '../../../shared/types/adf-v02.types'
import type { McpServerRegistration, McpServerStatusEvent } from '../../../shared/types/ipc.types'
import { findEntryIn } from '../../../shared/constants/mcp-registry'
import { useMcpRegistryStore } from '../../stores/mcp-registry.store'
import { BrandIcon } from './BrandIcon'
import { isRegistrationAgentVisible, sameExecutableIdentity } from '../../../shared/utils/mcp-config'
import { McpAddServerModal, HOST_BOUNDARY_TEXT, hasEmptyRequiredKeys, isOAuthEntry, oauthNeedsSignIn } from './McpAddServerModal'
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
  // Dynamic registry: bundled snapshot until the remote-first fetch lands.
  const registryEntries = useMcpRegistryStore((s) => s.entries)
  const refreshRegistry = useMcpRegistryStore((s) => s.refresh)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  /** Add/Configure modal state: open + registration id being edited (null = add). */
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Reconnect results per server id */
  const [reconnectResults, setReconnectResults] = useState<Record<string, { loading: boolean; count?: number; error?: string }>>({})
  /**
   * OAuth sign-in state per server id (main-side truth = whether a valid token
   * is stored). Missing key = unknown (status call failed or not an oauth row)
   * → render nothing rather than a wrong state.
   */
  const [oauthSignedIn, setOauthSignedIn] = useState<Record<string, boolean>>({})
  /**
   * Monotonic generation for OAuth-status refreshes. Each refreshOAuthStatus
   * call claims the next number; only the batch whose generation is still
   * current when it resolves may merge its result. This keeps a stale in-flight
   * read (e.g. one that observed signedIn:true just before a Sign out) from
   * resolving late and overwriting the fresh post-signout false.
   */
  const oauthRefreshGen = useRef(0)

  /** Whether a row authenticates via OAuth (registration flag or registry entry). */
  const oauthEntryFor = useCallback((reg: McpServerRegistration) => {
    const entry = reg.url ? findEntryIn(registryEntries, { url: reg.url }) : undefined
    return isOAuthEntry(reg, entry)
  }, [registryEntries])

  // Fetch sign-in status for every OAuth http row (keyed by id). Resilient:
  // a failed status call leaves the id unknown (no chip), never a wrong one.
  const refreshOAuthStatus = useCallback(async () => {
    const gen = ++oauthRefreshGen.current
    const oauthRows = mcpServersRef.current.filter((s) => s.type === 'http' && !!s.url && oauthEntryFor(s))
    const results = await Promise.all(oauthRows.map(async (s) => {
      try {
        const r = await window.adfApi?.mcpOAuthStatus({ url: s.url! })
        return [s.id, r?.signedIn] as const
      } catch {
        return [s.id, undefined] as const
      }
    }))
    // A newer refresh (e.g. the one handleOAuthSignOut fires after invalidating
    // the token) superseded this batch — drop our now-stale read.
    if (gen !== oauthRefreshGen.current) return
    setOauthSignedIn((prev) => {
      const next = { ...prev }
      for (const [id, signedIn] of results) {
        if (signedIn === undefined) delete next[id]
        else next[id] = signedIn
      }
      return next
    })
  }, [oauthEntryFor])

  /** Sign out of an OAuth server (clears the stored token), then refresh state. */
  const handleOAuthSignOut = async (reg: McpServerRegistration) => {
    if (!reg.url) return
    try {
      await window.adfApi?.mcpOAuthSignOut({ url: reg.url })
    } catch {
      // Low-stakes: re-sign-in is one click. Surface nothing on failure.
    }
    await refreshOAuthStatus()
  }

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

  // OAuth sign-in state follows the server list and the resolved registry.
  useEffect(() => {
    void refreshOAuthStatus()
  }, [refreshOAuthStatus, mcpServers])

  // Pull the live registry (remote-first with cached/bundled fallback) when
  // the MCP settings surface opens — quick-add cards and entry lookups follow.
  useEffect(() => {
    void refreshRegistry()
  }, [refreshRegistry])

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
            // Identity guard: the install ran for `reg` — don't stamp its
            // version onto a registration edited+saved while it downloaded.
            onServersChanged(mcpServersRef.current.map((s) =>
              s.id === reg.id && sameExecutableIdentity(s, reg) ? { ...s, version: result.installed!.version } : s
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
        // Identity guard: the test ran against `reg` as captured at click
        // time — a stamp must never vouch for a registration whose executable
        // identity was edited+saved while the reconnect was in flight.
        onServersChanged(mcpServersRef.current.map((s) => (s.id === reg.id && sameExecutableIdentity(s, reg)
          ? { ...s, lastVerifiedAt: Date.now(), ...(result.serverVersion ? { version: result.serverVersion } : {}) }
          : s)))
        const state = serverStates.find((s) => s.name === reg.name)
        if (state && state.status !== 'stopped') {
          await window.adfApi?.restartMcpServer({ name: reg.name })
          await refreshStatus()
        }
        // A reconnect can complete an interactive sign-in — refresh oauth state.
        void refreshOAuthStatus()
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
        onRemove={handleRemove}
        onOAuthChanged={refreshOAuthStatus}
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
            // Resolve across all three identity fields (mirrors the modal) so
            // pypi/uvx and remote HTTP rows get their brand icon and the
            // "Needs keys" chip, not just npm rows.
            const registryEntry = reg.npmPackage ? findEntryIn(registryEntries, { npmPackage: reg.npmPackage })
              : reg.pypiPackage ? findEntryIn(registryEntries, { pypiPackage: reg.pypiPackage })
              : reg.url ? findEntryIn(registryEntries, { url: reg.url }) : undefined
            // OAuth servers need a sign-in, not env keys — the helper returns
            // false for them, so the "Needs keys" chip never fires.
            const needsKeys = hasEmptyRequiredKeys(reg, registryEntry)
            const reconnect = reconnectResults[reg.id]
            const isHttp = reg.type === 'http'
            const isOAuthRow = isOAuthEntry(reg, registryEntry)
            const signedIn = oauthSignedIn[reg.id] // boolean | undefined (unknown)

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
                      {STATUS_LABELS[status] ?? status}{state?.toolCount ? ` · ${state.toolCount} tools` : ''}
                    </span>
                    {/* Chip slot 1: placement */}
                    {isHttp ? (
                      <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 rounded font-medium">
                        Remote
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
                    {/* Chip slot 2: exposure */}
                    {isRegistrationAgentVisible(reg) && (
                      <Tooltip tip="Available to agents — any agent may attach and use this server.">
                        <span className="text-[9px] px-1 py-0.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded font-medium">
                          Agents
                        </span>
                      </Tooltip>
                    )}
                    {/* Chip slot 3: health. An OAuth row signed in via browser
                        shows "Signed in"; an OAuth row still needing a sign-in
                        (and NOT configured with a pasted token) shows "Sign in
                        needed". A dual-mode row running on a pasted token, or
                        any non-OAuth row, falls through to the keys/verified
                        logic below; unknown status shows nothing. */}
                    {isOAuthRow && signedIn === true ? (
                      <Tooltip tip="Signed in via browser OAuth. Use Sign out to clear the stored token.">
                        <span className="text-[9px] px-1 py-0.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded font-medium">
                          Signed in
                        </span>
                      </Tooltip>
                    ) : oauthNeedsSignIn(reg, registryEntry, signedIn) ? (
                      <Tooltip tip="This server needs a browser sign-in — open it and click “Sign in & Connect”.">
                        <span className="text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded font-medium">
                          Sign in needed
                        </span>
                      </Tooltip>
                    ) : needsKeys ? (
                      <span className="text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded font-medium">
                        Needs keys
                      </span>
                    ) : !reg.lastVerifiedAt ? (
                      <Tooltip tip="This server has not completed a successful Connect yet — open it and use Connect to verify.">
                        <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 rounded">
                          Not verified
                        </span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div className="flex items-center shrink-0">
                    {isOAuthRow && signedIn === true && (
                      <Tooltip tip="Sign out — clears the stored token (re-sign-in is one click).">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleOAuthSignOut(reg) }}
                          className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                          aria-label="Sign out"
                        >
                          <svg
                            width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          >
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                            <polyline points="16 17 21 12 16 7" />
                            <line x1="21" y1="12" x2="9" y2="12" />
                          </svg>
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip tip={reg.auth ? 'Re-authorize' : 'Reconnect'}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleReconnect(reg) }}
                        disabled={reconnect?.loading || !reg.name}
                        className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 disabled:opacity-40"
                      >
                        <svg
                          width="14" height="14" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          className={reconnect?.loading ? 'animate-spin' : undefined}
                        >
                          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                          <polyline points="21 3 21 9 15 9" />
                        </svg>
                      </button>
                    </Tooltip>
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

              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
