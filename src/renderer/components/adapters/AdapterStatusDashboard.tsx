import { useState, useEffect, useCallback, useRef } from 'react'
import type { AdapterRegistration, AdapterStatusEvent } from '../../../shared/types/ipc.types'
import type { AdapterState, AdapterLogEntry, AdapterInstallProgress } from '../../../shared/types/channel-adapter.types'
import { ADAPTER_REGISTRY, findAdapterRegistryEntry } from '../../../shared/constants/adapter-registry'
import { AdapterLogs } from './AdapterLogs'
import { AdapterCredentialPanel } from './AdapterCredentialPanel'

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  error: 'bg-red-500',
  disconnected: 'bg-neutral-400'
}

const STATUS_LABELS: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  error: 'Error',
  disconnected: 'Disconnected'
}

interface AdapterStatusDashboardProps {
  adapters: AdapterRegistration[]
  onAdaptersChanged: (adapters: AdapterRegistration[]) => void
}

export function AdapterStatusDashboard({ adapters, onAdaptersChanged }: AdapterStatusDashboardProps) {
  const adaptersRef = useRef(adapters)
  adaptersRef.current = adapters

  const [adapterStates, setAdapterStates] = useState<AdapterState[]>([])
  const [showLogsFor, setShowLogsFor] = useState<string | null>(null)
  const [logEntries, setLogEntries] = useState<AdapterLogEntry[]>([])
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [configureId, setConfigureId] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    const result = await window.adfApi?.getAdapterStatus()
    if (result?.adapters) {
      setAdapterStates(result.adapters)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  // Listen for status change events
  useEffect(() => {
    const unsub = window.adfApi?.onAdapterStatusChanged((event: AdapterStatusEvent) => {
      setAdapterStates((prev) => {
        const idx = prev.findIndex((s) => s.type === event.type)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = { ...updated[idx], status: event.status, error: event.error }
          return updated
        }
        return [...prev, { type: event.type, status: event.status, error: event.error, restartCount: 0, logs: [] }]
      })
    })
    return () => { unsub?.() }
  }, [])

  // Listen for install progress events
  useEffect(() => {
    const unsub = window.adfApi?.onAdapterInstallProgress((event: AdapterInstallProgress) => {
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

  const handleRestart = async (type: string) => {
    await window.adfApi?.restartAdapter({ type })
    await refreshStatus()
  }

  const handleShowLogs = async (type: string) => {
    if (showLogsFor === type) {
      setShowLogsFor(null)
      return
    }
    const result = await window.adfApi?.getAdapterLogs({ type })
    setLogEntries(result?.logs ?? [])
    setShowLogsFor(type)
  }

  const handleInstall = async (type: string) => {
    const entry = findAdapterRegistryEntry(type)
    if (!entry) return

    // Built-in adapters don't need npm install — just register them
    if (entry.builtIn) {
      const currentAdapters = adaptersRef.current
      if (!currentAdapters.find(a => a.type === type)) {
        const newRegistration: AdapterRegistration = {
          id: type,
          type,
          managed: false
        }
        onAdaptersChanged([...currentAdapters, newRegistration])
      }
      setShowQuickAdd(false)
      return
    }

    // npm-based adapters need package install
    const npmPackage = entry.npmPackage!
    setInstalling(prev => new Set(prev).add(npmPackage))
    try {
      const result = await window.adfApi?.installAdapterPackage({ package: npmPackage })
      if (result?.success) {
        const currentAdapters = adaptersRef.current
        if (!currentAdapters.find(a => a.type === type)) {
          const newRegistration: AdapterRegistration = {
            id: type,
            type,
            npmPackage,
            managed: true,
            version: result.installed?.version
          }
          onAdaptersChanged([...currentAdapters, newRegistration])
        }
      }
    } catch (error) {
      setInstallErrors(prev => ({ ...prev, [npmPackage]: String(error) }))
    }
  }

  const handleRemove = async (adapter: AdapterRegistration) => {
    if (findAdapterRegistryEntry(adapter.type)?.builtIn) return
    if (adapter.npmPackage && adapter.managed) {
      await window.adfApi?.uninstallAdapterPackage({ package: adapter.npmPackage })
    }
    onAdaptersChanged(adaptersRef.current.filter(a => a.id !== adapter.id))
  }

  const handleAdapterUpdate = (id: string, patch: Partial<AdapterRegistration>) => {
    const updated = adaptersRef.current.map(a =>
      a.id === id ? { ...a, ...patch } : a
    )
    onAdaptersChanged(updated)
  }

  // Compute available adapters from registry that aren't installed yet
  const installedTypes = new Set(adapters.map(a => a.type))
  const availableAdapters = ADAPTER_REGISTRY.filter(e => !installedTypes.has(e.type))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Channel Adapters
        </h3>
        {availableAdapters.length > 0 && (
          <button
            onClick={() => setShowQuickAdd(!showQuickAdd)}
            className="text-xs px-2 py-0.5 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
          >
            + Add
          </button>
        )}
      </div>

      {/* Quick-add from registry */}
      {showQuickAdd && availableAdapters.length > 0 && (
        <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 space-y-2">
          <p className="text-xs text-neutral-500">Available adapters:</p>
          {availableAdapters.map((entry) => (
            <div key={entry.type} className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">{entry.displayName}</span>
                <span className="text-xs text-neutral-500 ml-2">{entry.description}</span>
              </div>
              <button
                onClick={() => handleInstall(entry.type)}
                disabled={!!(entry.npmPackage && installing.has(entry.npmPackage))}
                className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {entry.npmPackage && installing.has(entry.npmPackage) ? 'Installing...' : entry.builtIn ? 'Enable' : 'Install'}
              </button>
            </div>
          ))}
          {Object.entries(installErrors).map(([pkg, error]) => (
            <p key={pkg} className="text-xs text-red-500">{pkg}: {error}</p>
          ))}
        </div>
      )}

      {/* Installed adapters */}
      {adapters.length === 0 ? (
        <p className="text-xs text-neutral-500 italic">
          No channel adapters installed. Click "+ Add" to install one.
        </p>
      ) : (
        <div className="space-y-2">
          {adapters.map((adapter) => {
            const state = adapterStates.find(s => s.type === adapter.type)
            const status = state?.status ?? 'disconnected'
            const registryEntry = findAdapterRegistryEntry(adapter.type)

            return (
              <div key={adapter.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg">
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? 'bg-neutral-400'}`} />
                    <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                      {registryEntry?.displayName ?? adapter.type}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {STATUS_LABELS[status] ?? status}
                    </span>
                    {state?.error && (
                      <span className="text-xs text-red-500 truncate max-w-[200px]" title={state.error}>
                        {state.error}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setConfigureId(configureId === adapter.id ? null : adapter.id)}
                      className="text-xs px-2 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
                    >
                      Configure
                    </button>
                    <button
                      onClick={() => handleRestart(adapter.type)}
                      className="text-xs px-2 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
                    >
                      Restart
                    </button>
                    <button
                      onClick={() => handleShowLogs(adapter.type)}
                      className="text-xs px-2 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
                    >
                      Logs
                    </button>
                    {!registryEntry?.builtIn && (
                      <button
                        onClick={() => handleRemove(adapter)}
                        className="text-xs px-2 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {/* Configure panel */}
                {configureId === adapter.id && (
                  <div className="border-t border-neutral-200 dark:border-neutral-700">
                    <AdapterCredentialPanel
                      adapter={adapter}
                      registryEntry={registryEntry}
                      onAdapterUpdate={(patch) => handleAdapterUpdate(adapter.id, patch)}
                    />
                  </div>
                )}

                {/* Logs panel */}
                {showLogsFor === adapter.type && (
                  <div className="border-t border-neutral-200 dark:border-neutral-700">
                    <AdapterLogs
                      logs={logEntries}
                      onClose={() => setShowLogsFor(null)}
                      adapterType={adapter.type}
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
