import { useState, useEffect, useCallback, useRef } from 'react'
import type { ProviderConfig, ProviderCredentialFileInfo, TrackedDirEntry } from '../../../shared/types/ipc.types'

/** Flatten a TrackedDirEntry tree into a list of .adf file entries. */
function flattenAdfFiles(entries: TrackedDirEntry[]): { filePath: string; fileName: string }[] {
  const result: { filePath: string; fileName: string }[] = []
  for (const e of entries) {
    if (e.isDirectory && e.children) {
      result.push(...flattenAdfFiles(e.children))
    } else if (!e.isDirectory && e.fileName.endsWith('.adf')) {
      result.push({ filePath: e.filePath, fileName: e.fileName })
    }
  }
  return result
}

interface ProviderCredentialPanelProps {
  provider: ProviderConfig
  onProviderUpdate: (patch: Partial<ProviderConfig>) => void
  /** Placeholder text for the API key input (e.g. "sk-ant-...") */
  apiKeyPlaceholder?: string
}

/**
 * Credential management panel for a provider.
 * Supports two storage modes:
 * - "app": API key stored in app-wide settings (current behavior)
 * - "agent": API key stored per-ADF file in adf_identity
 */
export function ProviderCredentialPanel({ provider, onProviderUpdate, apiKeyPlaceholder }: ProviderCredentialPanelProps) {
  // chatgpt-subscription uses OAuth, not API keys — hide this panel entirely
  if (provider.type === 'chatgpt-subscription') {
    return (
      <div className="mt-2">
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 italic">
          This provider uses OAuth authentication (app-wide). Configure via Sign In above.
        </p>
      </div>
    )
  }

  const storageMode = provider.credentialStorage ?? 'app'

  // --- Per-agent (ADF) credential state ---
  const [adfFiles, setAdfFiles] = useState<ProviderCredentialFileInfo[]>([])
  const [manualAdfFiles, setManualAdfFiles] = useState<ProviderCredentialFileInfo[]>([])
  const [adfCredentials, setAdfCredentials] = useState<Record<string, string>>({})
  const [adfConfigs, setAdfConfigs] = useState<Record<string, { defaultModel?: string; params?: { key: string; value: string }[]; requestDelayMs?: number }>>({})
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [savingFor, setSavingFor] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<Record<string, 'ok' | string>>({})

  // --- Tracked ADF files for inline select ---
  const [trackedAdfFiles, setTrackedAdfFiles] = useState<{ filePath: string; fileName: string }[]>([])
  const [loadingTracked, setLoadingTracked] = useState(false)
  const [pendingRows, setPendingRows] = useState<number[]>([])
  const pendingIdRef = useRef(0)

  // All files = auto-discovered + manually added
  const allAdfFiles = [...adfFiles, ...manualAdfFiles.filter(
    (m) => !adfFiles.some((a) => a.filePath === m.filePath)
  )]

  // Load known ADF files when in per-agent mode
  const loadAdfFiles = useCallback(async () => {
    if (storageMode !== 'agent') return
    setLoadingFiles(true)
    try {
      const result = await window.adfApi?.listProviderCredentialFiles({
        providerId: provider.id
      })
      setAdfFiles(result?.files ?? [])
    } catch {
      // Ignore
    } finally {
      setLoadingFiles(false)
    }
  }, [storageMode, provider.id])

  useEffect(() => {
    loadAdfFiles()
  }, [loadAdfFiles])

  // Load tracked ADF files when switching to agent mode
  const loadTrackedAdfFiles = useCallback(async () => {
    setLoadingTracked(true)
    try {
      const dirsResult = await window.adfApi?.getTrackedDirectories()
      const dirs = dirsResult?.directories ?? []
      const all: { filePath: string; fileName: string }[] = []
      for (const dir of dirs) {
        const scanResult = await window.adfApi?.scanTrackedDirectory(dir)
        if (scanResult?.files) {
          all.push(...flattenAdfFiles(scanResult.files))
        }
      }
      const seen = new Set<string>()
      setTrackedAdfFiles(all.filter((f) => {
        if (seen.has(f.filePath)) return false
        seen.add(f.filePath)
        return true
      }))
    } catch {
      // Ignore
    } finally {
      setLoadingTracked(false)
    }
  }, [])

  useEffect(() => {
    if (storageMode === 'agent') {
      loadTrackedAdfFiles()
    }
  }, [storageMode, loadTrackedAdfFiles])

  // Load credentials and provider config for a specific ADF file
  const loadCredentialsForFile = async (filePath: string) => {
    try {
      const result = await window.adfApi?.getProviderCredentials({
        filePath,
        providerId: provider.id
      })
      if (result?.credentials) {
        setAdfCredentials((prev) => ({ ...prev, [filePath]: result.credentials.apiKey ?? '' }))
      }
      if (result?.providerConfig) {
        setAdfConfigs((prev) => ({ ...prev, [filePath]: result.providerConfig! }))
      }
    } catch {
      // Ignore
    }
  }

  const handleToggleFile = (filePath: string) => {
    if (editingFile === filePath) {
      setEditingFile(null)
    } else {
      setEditingFile(filePath)
      loadCredentialsForFile(filePath)
    }
  }

  const handleSaveAdfCredential = async (filePath: string) => {
    setSavingFor(filePath)
    setSaveStatus((prev) => { const next = { ...prev }; delete next[filePath]; return next })
    try {
      const apiKey = adfCredentials[filePath] ?? ''
      const fileConfig = adfConfigs[filePath]

      // Attach/update the provider config on the ADF (includes per-ADF overrides)
      const { apiKey: _omit, credentialStorage: _omit2, ...providerWithoutKey } = provider
      const providerPayload = {
        ...providerWithoutKey,
        ...(fileConfig?.defaultModel !== undefined ? { defaultModel: fileConfig.defaultModel } : {}),
        ...(fileConfig?.params !== undefined ? { params: fileConfig.params } : {}),
        ...(fileConfig?.requestDelayMs !== undefined ? { requestDelayMs: fileConfig.requestDelayMs } : {})
      }
      const attachResult = await window.adfApi?.attachProvider({
        filePath,
        provider: providerPayload
      })
      if (attachResult && !attachResult.success) {
        setSaveStatus((prev) => ({ ...prev, [filePath]: attachResult.error ?? 'Failed to attach provider' }))
        setSavingFor(null)
        return
      }

      // Save the API key (if provided)
      if (apiKey) {
        const result = await window.adfApi?.setProviderCredential({
          filePath,
          providerId: provider.id,
          value: apiKey
        })
        if (result && !result.success) {
          setSaveStatus((prev) => ({ ...prev, [filePath]: result.error ?? 'Save failed' }))
          setSavingFor(null)
          return
        }
      }

      // Update local file state
      const updateFile = (f: ProviderCredentialFileInfo) =>
        f.filePath === filePath
          ? { ...f, hasCredentials: !!apiKey || f.hasCredentials, populatedKeys: apiKey ? ['apiKey'] : f.populatedKeys }
          : f
      setAdfFiles((prev) => prev.map(updateFile))
      setManualAdfFiles((prev) => prev.map(updateFile))
      setSaveStatus((prev) => ({ ...prev, [filePath]: 'ok' }))
    } catch (err) {
      setSaveStatus((prev) => ({ ...prev, [filePath]: String(err) }))
    } finally {
      setSavingFor(null)
    }
  }

  const handleAddRow = () => {
    pendingIdRef.current += 1
    setPendingRows((prev) => [...prev, pendingIdRef.current])
  }

  const handleRemovePendingRow = (rowId: number) => {
    setPendingRows((prev) => prev.filter((id) => id !== rowId))
  }

  const handleSelectAdf = (rowId: number, filePath: string) => {
    if (!filePath) return
    setPendingRows((prev) => prev.filter((id) => id !== rowId))
    if (allAdfFiles.some((f) => f.filePath === filePath)) return
    const tracked = trackedAdfFiles.find((f) => f.filePath === filePath)
    const newFile: ProviderCredentialFileInfo = {
      filePath,
      fileName: tracked?.fileName ?? filePath.split('/').pop() ?? 'unknown.adf',
      hasCredentials: false,
      populatedKeys: []
    }
    setManualAdfFiles((prev) => [...prev, newFile])
    setEditingFile(filePath)
  }

  const updateAdfConfig = (filePath: string, patch: Partial<{ defaultModel: string; params: { key: string; value: string }[]; requestDelayMs: number }>) => {
    setAdfConfigs((prev) => ({
      ...prev,
      [filePath]: { ...prev[filePath], ...patch }
    }))
  }

  const addAdfParam = (filePath: string) => {
    setAdfConfigs((prev) => {
      const cfg = prev[filePath] ?? {}
      return { ...prev, [filePath]: { ...cfg, params: [...(cfg.params ?? []), { key: '', value: '' }] } }
    })
  }

  const updateAdfParam = (filePath: string, index: number, patch: Partial<{ key: string; value: string }>) => {
    setAdfConfigs((prev) => {
      const cfg = prev[filePath] ?? {}
      const params = [...(cfg.params ?? [])]
      params[index] = { ...params[index], ...patch }
      return { ...prev, [filePath]: { ...cfg, params } }
    })
  }

  const removeAdfParam = (filePath: string, index: number) => {
    setAdfConfigs((prev) => {
      const cfg = prev[filePath] ?? {}
      return { ...prev, [filePath]: { ...cfg, params: (cfg.params ?? []).filter((_, j) => j !== index) } }
    })
  }

  const handleRemoveAdfFile = async (filePath: string) => {
    await window.adfApi?.detachProvider({
      filePath,
      providerId: provider.id
    })
    setManualAdfFiles((prev) => prev.filter((f) => f.filePath !== filePath))
    setAdfFiles((prev) => prev.filter((f) => f.filePath !== filePath))
    if (editingFile === filePath) setEditingFile(null)
    setAdfCredentials((prev) => {
      const next = { ...prev }
      delete next[filePath]
      return next
    })
    setAdfConfigs((prev) => {
      const next = { ...prev }
      delete next[filePath]
      return next
    })
    setSaveStatus((prev) => {
      const next = { ...prev }
      delete next[filePath]
      return next
    })
  }

  const handleStorageModeChange = (mode: 'app' | 'agent') => {
    onProviderUpdate({ credentialStorage: mode })
  }

  // Available tracked files (not yet in the list)
  const availableTrackedFiles = trackedAdfFiles.filter(
    (f) => !allAdfFiles.some((a) => a.filePath === f.filePath)
  )

  return (
    <div className="space-y-2 mt-2">
      {/* Storage location toggle */}
      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1.5">
          Credential Storage
        </label>
        <div className="flex gap-1">
          <button
            onClick={() => handleStorageModeChange('app')}
            className={`flex-1 px-2 py-1.5 text-[11px] rounded-md border transition-colors ${
              storageMode === 'app'
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                : 'border-neutral-200 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
            }`}
          >
            App-wide
          </button>
          <button
            onClick={() => handleStorageModeChange('agent')}
            className={`flex-1 px-2 py-1.5 text-[11px] rounded-md border transition-colors ${
              storageMode === 'agent'
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                : 'border-neutral-200 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
            }`}
          >
            Per-agent (ADF)
          </button>
        </div>
        <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mt-1">
          {storageMode === 'app'
            ? 'Credentials and settings stored in app settings, shared by all agents.'
            : 'Credentials and settings stored per ADF file. Each agent can have its own configuration.'}
        </p>
      </div>

      {/* App-wide mode: inline API key input */}
      {storageMode === 'app' && (
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">API Key</label>
          <input
            type="password"
            value={provider.apiKey}
            onChange={(e) => onProviderUpdate({ apiKey: e.target.value })}
            placeholder={apiKeyPlaceholder ?? 'Enter API key'}
            className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
          />
        </div>
      )}

      {/* Per-agent mode: ADF file credential list */}
      {storageMode === 'agent' && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">
              Agent Settings
            </label>
            <div className="flex gap-2">
              <button
                onClick={handleAddRow}
                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
              >
                + Add ADF
              </button>
              <button
                onClick={loadAdfFiles}
                className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                disabled={loadingFiles}
              >
                {loadingFiles ? 'Scanning...' : 'Refresh'}
              </button>
            </div>
          </div>

          {allAdfFiles.length === 0 && pendingRows.length === 0 ? (
            <div className="text-center py-3">
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {loadingFiles
                  ? 'Scanning tracked directories...'
                  : 'No ADF files found. Use + Add ADF to select a file.'}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {/* Existing ADF file rows */}
              {allAdfFiles.map((file) => {
                const isEditing = editingFile === file.filePath
                const apiKeyValue = adfCredentials[file.filePath] ?? ''
                const isSaving = savingFor === file.filePath

                return (
                  <div
                    key={file.filePath}
                    className="border border-neutral-200 dark:border-neutral-700 rounded-md overflow-hidden"
                  >
                    {/* File header */}
                    <button
                      onClick={() => handleToggleFile(file.filePath)}
                      className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-700/50 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300 truncate">
                          {file.fileName}
                        </span>
                        {file.hasCredentials ? (
                          <span
                            title="API key stored in ADF"
                            className="text-[11px] text-amber-500 dark:text-amber-400 shrink-0 cursor-help"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 inline-block">
                              <path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Zm-1 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" clipRule="evenodd" />
                            </svg>
                          </span>
                        ) : (
                          <span className="text-[9px] text-neutral-400 dark:text-neutral-500 shrink-0">
                            No key
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-neutral-400">
                          {isEditing ? 'Hide' : 'Edit'}
                        </span>
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); handleRemoveAdfFile(file.filePath) }}
                          className="text-xs text-red-400 hover:text-red-600 cursor-pointer"
                        >
                          &times;
                        </span>
                      </div>
                    </button>

                    {/* Credential & config form */}
                    {isEditing && (() => {
                      const fileConfig = adfConfigs[file.filePath] ?? {}
                      return (
                        <div className="px-2.5 pb-2 border-t border-neutral-100 dark:border-neutral-700 space-y-2">
                          <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mt-1.5 truncate" title={file.filePath}>
                            {file.filePath}
                          </p>
                          {/* API Key */}
                          <div>
                            <label className="block text-[10px] text-neutral-500 dark:text-neutral-400 mb-0.5">API Key</label>
                            <input
                              type="password"
                              value={apiKeyValue}
                              onChange={(e) => setAdfCredentials((prev) => ({ ...prev, [file.filePath]: e.target.value }))}
                              placeholder={apiKeyPlaceholder ?? 'Enter API key (optional for local providers)'}
                              className="w-full px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          {/* Default Model */}
                          <div>
                            <label className="block text-[10px] text-neutral-500 dark:text-neutral-400 mb-0.5">Default Model</label>
                            <input
                              type="text"
                              value={fileConfig.defaultModel ?? ''}
                              onChange={(e) => updateAdfConfig(file.filePath, { defaultModel: e.target.value })}
                              placeholder={provider.defaultModel || 'Same as app-wide'}
                              className="w-full px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          {/* Request Delay */}
                          <div>
                            <label className="block text-[10px] text-neutral-500 dark:text-neutral-400 mb-0.5">Request Delay (ms)</label>
                            <input
                              type="number"
                              min={0}
                              step={100}
                              value={fileConfig.requestDelayMs ?? 0}
                              onChange={(e) => updateAdfConfig(file.filePath, { requestDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
                              placeholder="0"
                              className="w-full px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          {/* Parameters (openai-compatible only) */}
                          {provider.type === 'openai-compatible' && (
                            <div>
                              <div className="flex items-center justify-between mb-0.5">
                                <label className="block text-[10px] text-neutral-500 dark:text-neutral-400">Parameters</label>
                                <button
                                  onClick={() => addAdfParam(file.filePath)}
                                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                                >
                                  + Add
                                </button>
                              </div>
                              {(fileConfig.params ?? []).length > 0 && (
                                <div className="space-y-1">
                                  {(fileConfig.params ?? []).map((param, j) => (
                                    <div key={j} className="flex gap-1 items-center">
                                      <input
                                        type="text"
                                        value={param.key}
                                        onChange={(e) => updateAdfParam(file.filePath, j, { key: e.target.value })}
                                        placeholder="key"
                                        className="flex-1 px-2 py-0.5 text-[10px] font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                      />
                                      <input
                                        type="text"
                                        value={param.value}
                                        onChange={(e) => updateAdfParam(file.filePath, j, { value: e.target.value })}
                                        placeholder="blank = null"
                                        className="flex-1 px-2 py-0.5 text-[10px] font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                      />
                                      <button
                                        onClick={() => removeAdfParam(file.filePath, j)}
                                        className="text-xs text-red-400 hover:text-red-600 px-0.5"
                                      >
                                        &times;
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {/* Save button */}
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleSaveAdfCredential(file.filePath)}
                              disabled={isSaving}
                              className="px-3 py-1 text-[11px] bg-blue-500 hover:bg-blue-600 disabled:bg-blue-400 text-white rounded-md font-medium transition-colors"
                            >
                              {isSaving ? 'Saving...' : 'Save to ADF'}
                            </button>
                            {saveStatus[file.filePath] === 'ok' && (
                              <span className="text-[10px] text-green-600 dark:text-green-400">Saved</span>
                            )}
                            {saveStatus[file.filePath] && saveStatus[file.filePath] !== 'ok' && (
                              <span className="text-[10px] text-red-500">{saveStatus[file.filePath]}</span>
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}

              {/* Pending rows with ADF select dropdown */}
              {pendingRows.map((rowId) => (
                <div
                  key={`pending-${rowId}`}
                  className="border border-neutral-200 dark:border-neutral-700 rounded-md overflow-hidden"
                >
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                    <select
                      defaultValue=""
                      onChange={(e) => handleSelectAdf(rowId, e.target.value)}
                      className="flex-1 px-2 py-1 text-[11px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400 bg-white"
                    >
                      <option value="" disabled>
                        {loadingTracked ? 'Loading...' : 'Select an ADF file...'}
                      </option>
                      {availableTrackedFiles.map((f) => (
                        <option key={f.filePath} value={f.filePath}>
                          {f.fileName}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleRemovePendingRow(rowId)}
                      className="text-xs text-red-400 hover:text-red-600 px-1"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
