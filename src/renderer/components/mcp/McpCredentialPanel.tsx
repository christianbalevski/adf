import { useState, useEffect, useCallback, useRef } from 'react'
import type { McpServerRegistration, McpCredentialFileInfo, TrackedDirEntry } from '../../../shared/types/ipc.types'
import type { McpRegistryEntry } from '../../../shared/constants/mcp-registry'

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

interface McpCredentialPanelProps {
  server: McpServerRegistration
  registryEntry?: McpRegistryEntry
  onServerUpdate: (patch: Partial<McpServerRegistration>) => void
}

/**
 * Credential management panel for an MCP server.
 * Works for both managed (npm) and custom servers.
 * Supports two storage modes:
 * - "app": credentials stored in app-wide settings (env vars on the registration)
 * - "agent": credentials stored per-ADF file in adf_identity
 */
export function McpCredentialPanel({ server, registryEntry, onServerUpdate }: McpCredentialPanelProps) {
  const storageMode = server.credentialStorage ?? 'app'

  // Credential namespace: npmPackage or pypiPackage for managed, server name for custom
  const credentialNamespace = server.npmPackage || server.pypiPackage || server.name

  // Env keys: from registry for managed servers, from server.env for custom
  const httpEnvKeys = [
    ...(server.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : []),
    ...(server.headerEnv ?? []).map((entry) => entry.value).filter(Boolean)
  ]
  const allEnvKeys = [...new Set(registryEntry
    ? [...(registryEntry.requiredEnvKeys ?? []), ...(registryEntry.optionalEnvKeys ?? []), ...httpEnvKeys]
    : [...(server.env ?? []).map((e) => e.key).filter(Boolean), ...httpEnvKeys]
  )]
  const requiredKeys = registryEntry?.requiredEnvKeys ?? []

  // --- App-wide env vars ---
  const addEnvVar = () => {
    onServerUpdate({ env: [...(server.env ?? []), { key: '', value: '' }] })
  }

  const updateEnvVar = (index: number, patch: Partial<{ key: string; value: string }>) => {
    const env = [...(server.env ?? [])]
    env[index] = { ...env[index], ...patch }
    onServerUpdate({ env })
  }

  const removeEnvVar = (index: number) => {
    onServerUpdate({ env: (server.env ?? []).filter((_, i) => i !== index) })
  }

  // --- Per-agent (ADF) credential state ---
  const [adfFiles, setAdfFiles] = useState<McpCredentialFileInfo[]>([])
  const [manualAdfFiles, setManualAdfFiles] = useState<McpCredentialFileInfo[]>([])
  const [adfCredentials, setAdfCredentials] = useState<Record<string, Record<string, string>>>({})
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [savingFor, setSavingFor] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<Record<string, 'ok' | string>>({})
  const [extraKeys, setExtraKeys] = useState<Record<string, string[]>>({})

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
    if (storageMode !== 'agent' || !credentialNamespace) return
    setLoadingFiles(true)
    try {
      const result = await window.adfApi?.listMcpCredentialFiles({
        mcpServerName: server.name,
        npmPackage: credentialNamespace
      })
      setAdfFiles(result?.files ?? [])
    } catch {
      // Ignore
    } finally {
      setLoadingFiles(false)
    }
  }, [storageMode, server.name, credentialNamespace])

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

  // Load credentials for a specific ADF file
  const loadCredentialsForFile = async (filePath: string) => {
    if (!credentialNamespace) return
    try {
      const result = await window.adfApi?.getMcpCredentials({
        filePath,
        npmPackage: credentialNamespace
      })
      if (result?.credentials) {
        setAdfCredentials((prev) => ({ ...prev, [filePath]: result.credentials }))
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
      if (!adfCredentials[filePath]) {
        loadCredentialsForFile(filePath)
      }
    }
  }

  const handleAdfCredentialChange = (filePath: string, envKey: string, value: string) => {
    setAdfCredentials((prev) => ({
      ...prev,
      [filePath]: { ...(prev[filePath] ?? {}), [envKey]: value }
    }))
  }

  const handleSaveAdfCredentials = async (filePath: string) => {
    if (!credentialNamespace) return
    setSavingFor(filePath)
    setSaveStatus((prev) => { const next = { ...prev }; delete next[filePath]; return next })
    try {
      const creds = adfCredentials[filePath] ?? {}
      const keysToSave = Object.entries(creds).filter(([, v]) => v)
      if (keysToSave.length === 0) {
        setSaveStatus((prev) => ({ ...prev, [filePath]: 'No credential values to save' }))
        setSavingFor(null)
        return
      }

      // Attach the MCP server config to the ADF (idempotent)
      const attachResult = await window.adfApi?.attachMcpServer({
        filePath,
        serverConfig: {
          name: server.name,
          type: server.type,
          npmPackage: server.npmPackage,
          pypiPackage: server.pypiPackage,
          command: server.command,
          args: server.args,
          url: server.url,
          envKeys: allEnvKeys.length > 0 ? allEnvKeys : keysToSave.map(([k]) => k),
          headers: server.headers,
          headerEnv: server.headerEnv,
          bearerTokenEnvVar: server.bearerTokenEnvVar,
          credentialStorage: server.credentialStorage
        }
      })
      if (attachResult && !attachResult.success) {
        setSaveStatus((prev) => ({ ...prev, [filePath]: attachResult.error ?? 'Failed to attach server' }))
        setSavingFor(null)
        return
      }

      // Save credential values
      for (const [envKey, value] of keysToSave) {
        const result = await window.adfApi?.setMcpCredential({
          filePath,
          npmPackage: credentialNamespace,
          envKey,
          value
        })
        if (result && !result.success) {
          setSaveStatus((prev) => ({ ...prev, [filePath]: result.error ?? 'Save failed' }))
          setSavingFor(null)
          return
        }
      }
      // Update local file state to reflect saved credentials
      const savedKeys = keysToSave.map(([k]) => k)
      const updateFile = (f: McpCredentialFileInfo) =>
        f.filePath === filePath
          ? { ...f, hasCredentials: true, populatedKeys: [...new Set([...f.populatedKeys, ...savedKeys])] }
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
    // Remove the pending row
    setPendingRows((prev) => prev.filter((id) => id !== rowId))
    // Don't add if already present
    if (allAdfFiles.some((f) => f.filePath === filePath)) return
    const tracked = trackedAdfFiles.find((f) => f.filePath === filePath)
    const newFile: McpCredentialFileInfo = {
      filePath,
      fileName: tracked?.fileName ?? filePath.split('/').pop() ?? 'unknown.adf',
      hasCredentials: false,
      populatedKeys: []
    }
    setManualAdfFiles((prev) => [...prev, newFile])
    setEditingFile(filePath)
  }

  const handleAddExtraKey = (filePath: string) => {
    setExtraKeys((prev) => ({
      ...prev,
      [filePath]: [...(prev[filePath] ?? []), '']
    }))
  }

  const handleUpdateExtraKeyName = (filePath: string, index: number, name: string) => {
    setExtraKeys((prev) => {
      const keys = [...(prev[filePath] ?? [])]
      keys[index] = name
      return { ...prev, [filePath]: keys }
    })
  }

  const handleRemoveExtraKey = (filePath: string, index: number) => {
    const keyName = (extraKeys[filePath] ?? [])[index]
    setExtraKeys((prev) => {
      const keys = [...(prev[filePath] ?? [])]
      keys.splice(index, 1)
      return { ...prev, [filePath]: keys }
    })
    if (keyName) {
      setAdfCredentials((prev) => {
        const fileCreds = { ...(prev[filePath] ?? {}) }
        delete fileCreds[keyName]
        return { ...prev, [filePath]: fileCreds }
      })
    }
  }

  const handleRemoveAdfFile = async (filePath: string) => {
    // Detach: remove server config + credentials from the ADF
    if (credentialNamespace) {
      await window.adfApi?.detachMcpServer({
        filePath,
        serverName: server.name,
        credentialNamespace
      })
    }
    setManualAdfFiles((prev) => prev.filter((f) => f.filePath !== filePath))
    setAdfFiles((prev) => prev.filter((f) => f.filePath !== filePath))
    if (editingFile === filePath) setEditingFile(null)
    setAdfCredentials((prev) => {
      const next = { ...prev }
      delete next[filePath]
      return next
    })
    setExtraKeys((prev) => {
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
    onServerUpdate({ credentialStorage: mode })
  }

  // Available tracked files (not yet in the list)
  const availableTrackedFiles = trackedAdfFiles.filter(
    (f) => !allAdfFiles.some((a) => a.filePath === f.filePath)
  )

  return (
    <div className="space-y-3">
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
            ? 'Credentials stored in app settings, shared by all agents using this server.'
            : 'Credentials stored inside each ADF file. Different agents can have different keys.'}
        </p>
      </div>

      {/* App-wide mode: env var editing */}
      {storageMode === 'app' && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">
              Environment Variables
            </label>
            <button
              onClick={addEnvVar}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add
            </button>
          </div>
          {requiredKeys.length > 0 && (
            <p className="text-[9px] text-amber-600 dark:text-amber-400 mb-1.5">
              Required: {requiredKeys.join(', ')}
            </p>
          )}
          {(server.env ?? []).length > 0 ? (
            <div className="space-y-1.5">
              {(server.env ?? []).map((envVar, j) => {
                const isRequired = requiredKeys.includes(envVar.key)
                return (
                  <div key={j} className="flex gap-1.5 items-center">
                    <input
                      type="text"
                      value={envVar.key}
                      onChange={(e) => updateEnvVar(j, { key: e.target.value })}
                      placeholder="KEY"
                      className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                    />
                    <input
                      type="password"
                      value={envVar.value}
                      onChange={(e) => updateEnvVar(j, { value: e.target.value })}
                      placeholder={isRequired ? '(required)' : 'value'}
                      className={`flex-1 px-2 py-1 text-xs font-mono border rounded-md focus:outline-none focus:border-blue-400 ${
                        isRequired && !envVar.value
                          ? 'border-amber-400 dark:border-amber-600 dark:bg-neutral-700 dark:text-neutral-100'
                          : 'border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100'
                      }`}
                    />
                    <button
                      onClick={() => removeEnvVar(j)}
                      className="text-xs text-red-400 hover:text-red-600 px-1"
                    >
                      &times;
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
              No environment variables. Click + Add to configure.
            </p>
          )}
        </div>
      )}

      {/* Per-agent mode: ADF file credential list */}
      {storageMode === 'agent' && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">
              Agent Credentials
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

          {allEnvKeys.length > 0 && (
            <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mb-1.5">
              Keys: {allEnvKeys.join(', ')}
              {requiredKeys.length > 0 && (
                <span className="text-amber-500"> (required: {requiredKeys.join(', ')})</span>
              )}
            </p>
          )}

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
                const creds = adfCredentials[file.filePath] ?? {}
                const isSaving = savingFor === file.filePath
                const fileExtraKeys = extraKeys[file.filePath] ?? []
                const extraKeySet = new Set(fileExtraKeys)
                const envKeysForForm = allEnvKeys.length > 0
                  ? allEnvKeys
                  : Object.keys(creds).filter((k) => !extraKeySet.has(k))

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
                            title={`Credentials stored in ADF: ${file.populatedKeys.join(', ')}`}
                            className="text-[11px] text-amber-500 dark:text-amber-400 shrink-0 cursor-help"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 inline-block">
                              <path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Zm-1 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" clipRule="evenodd" />
                            </svg>
                            <span className="text-[9px] ml-0.5">{file.populatedKeys.length}</span>
                          </span>
                        ) : (
                          <span className="text-[9px] text-neutral-400 dark:text-neutral-500 shrink-0">
                            No keys
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

                    {/* Credential form */}
                    {isEditing && (
                      <div className="px-2.5 pb-2 border-t border-neutral-100 dark:border-neutral-700">
                        <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mt-1.5 mb-1 truncate" title={file.filePath}>
                          {file.filePath}
                        </p>
                        <div className="space-y-1.5">
                          {/* Registry / known env keys */}
                          {envKeysForForm.map((envKey) => {
                            const isRequired = requiredKeys.includes(envKey)
                            return (
                              <div key={envKey} className="flex gap-1.5 items-center">
                                <span className="text-[10px] font-mono text-neutral-500 dark:text-neutral-400 w-[120px] shrink-0 truncate" title={envKey}>
                                  {envKey}
                                </span>
                                <input
                                  type="password"
                                  value={creds[envKey] ?? ''}
                                  onChange={(e) => handleAdfCredentialChange(file.filePath, envKey, e.target.value)}
                                  placeholder={isRequired ? '(required)' : '(optional)'}
                                  className={`flex-1 px-2 py-1 text-xs font-mono border rounded-md focus:outline-none focus:border-blue-400 ${
                                    isRequired && !creds[envKey]
                                      ? 'border-amber-400 dark:border-amber-600 dark:bg-neutral-700 dark:text-neutral-100'
                                      : 'border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100'
                                  }`}
                                />
                              </div>
                            )
                          })}
                          {/* Extra custom keys */}
                          {fileExtraKeys.map((keyName, idx) => (
                            <div key={`extra-${idx}`} className="flex gap-1.5 items-center">
                              <input
                                type="text"
                                value={keyName}
                                onChange={(e) => handleUpdateExtraKeyName(file.filePath, idx, e.target.value)}
                                placeholder="KEY"
                                className="text-[10px] font-mono px-2 py-1 border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md w-[120px] shrink-0 focus:outline-none focus:border-blue-400"
                              />
                              <input
                                type="password"
                                value={keyName ? (creds[keyName] ?? '') : ''}
                                onChange={(e) => keyName && handleAdfCredentialChange(file.filePath, keyName, e.target.value)}
                                placeholder="value"
                                disabled={!keyName}
                                className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400 disabled:opacity-50"
                              />
                              <button
                                onClick={() => handleRemoveExtraKey(file.filePath, idx)}
                                className="text-xs text-red-400 hover:text-red-600 px-1"
                              >
                                &times;
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={() => handleSaveAdfCredentials(file.filePath)}
                            disabled={isSaving}
                            className="px-3 py-1 text-[11px] bg-blue-500 hover:bg-blue-600 disabled:bg-blue-400 text-white rounded-md font-medium transition-colors"
                          >
                            {isSaving ? 'Saving...' : 'Save to ADF'}
                          </button>
                          <button
                            onClick={() => handleAddExtraKey(file.filePath)}
                            className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                          >
                            + Add Key
                          </button>
                          {saveStatus[file.filePath] === 'ok' && (
                            <span className="text-[10px] text-green-600 dark:text-green-400">Saved</span>
                          )}
                          {saveStatus[file.filePath] && saveStatus[file.filePath] !== 'ok' && (
                            <span className="text-[10px] text-red-500">{saveStatus[file.filePath]}</span>
                          )}
                        </div>
                      </div>
                    )}
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
