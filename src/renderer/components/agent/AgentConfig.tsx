import { useState, useEffect, useCallback, useRef } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { START_IN_STATES, TRIGGER_TYPES_V3, MESSAGING_MODES, VISIBILITY_VALUES, LOG_LEVELS, CODE_EXECUTION_DEFAULTS, META_PROTECTION_LEVELS, TABLE_PROTECTION_LEVELS } from '../../../shared/types/adf-v02.types'
import type { AgentConfig as AgentConfigType, AdfProviderConfig, StartInState, ToolDeclaration, McpServerConfig, McpToolInfo, TriggerTypeV3, TriggerConfig, TriggerTarget, TriggerFilter, TriggersConfigV3, TriggerScopeV3, ServingApiRoute, MiddlewareRef, WsConnectionConfig, UmbilicalTapConfig, LoggingConfig, LoggingRule, CodeExecutionConfig, CodeExecutionPackage, MetaProtectionLevel, TableProtectionLevel, StreamBindingDeclaration, StreamBindTcpAllowRule } from '../../../shared/types/adf-v02.types'
import { buildMcpServerConfigFromRegistration } from '../../../shared/utils/mcp-config'
import { Dialog } from '../common/Dialog'

/**
 * All tools this runtime supports. Any tool listed here will appear
 * in every agent's config panel. Tools not already in the agent's
 * config are added as disabled so the user can opt in.
 */
const RUNTIME_TOOLS: ToolDeclaration[] = [
  // --- ADF Shell ---
  { name: 'adf_shell', enabled: false, visible: false },
  // --- Filesystem tools ---
  { name: 'fs_read', enabled: true, visible: true },
  { name: 'fs_write', enabled: true, visible: true },
  { name: 'fs_list', enabled: true, visible: true },
  { name: 'fs_delete', enabled: false, visible: false },
  // --- System tools ---
  { name: 'sys_get_config', enabled: true, visible: true },
  { name: 'sys_update_config', enabled: false, visible: false },
  { name: 'sys_code', enabled: false, visible: false },
  { name: 'sys_lambda', enabled: false, visible: false },
  { name: 'sys_create_adf', enabled: false, visible: false },
  { name: 'sys_get_meta', enabled: true, visible: true },
  { name: 'sys_set_meta', enabled: true, visible: true },
  { name: 'sys_delete_meta', enabled: true, visible: true },
  { name: 'sys_set_timer', enabled: false, visible: false },
  { name: 'sys_list_timers', enabled: false, visible: false },
  { name: 'sys_delete_timer', enabled: false, visible: false },
  // --- Package management tools ---
  { name: 'npm_install', enabled: false, visible: false },
  { name: 'npm_uninstall', enabled: false, visible: false },
  // --- MCP management tools ---
  { name: 'mcp_install', enabled: false, visible: false },
  { name: 'mcp_restart', enabled: false, visible: false },
  { name: 'mcp_uninstall', enabled: false, visible: false },
  // --- Compute environment tools ---
  { name: 'fs_transfer', enabled: false, visible: false },
  { name: 'compute_exec', enabled: false, visible: false, restricted: true },
  // --- Network tools ---
  { name: 'sys_fetch', enabled: false, visible: false },
  // --- Database tools ---
  { name: 'db_query', enabled: false, visible: false },
  { name: 'db_execute', enabled: false, visible: false },
  // --- Loop tools ---
  { name: 'loop_compact', enabled: false, visible: false },
  { name: 'loop_clear', enabled: false, visible: false },
  // --- Messaging tools (require messaging toggle) ---
  { name: 'msg_send', enabled: false, visible: false },
  { name: 'agent_discover', enabled: false, visible: false },
  // --- Inbox tools (require inbox mode) ---
  { name: 'msg_list', enabled: false, visible: false },
  { name: 'msg_read', enabled: false, visible: false },
  { name: 'msg_update', enabled: false, visible: false },
  { name: 'msg_delete', enabled: false, visible: false },
  // --- WebSocket tools ---
  { name: 'ws_connect', enabled: false, visible: false },
  { name: 'ws_disconnect', enabled: false, visible: false },
  { name: 'ws_connections', enabled: false, visible: false },
  { name: 'ws_send', enabled: false, visible: false },
  // --- Stream binding tools ---
  { name: 'stream_bind', enabled: false, visible: false },
  { name: 'stream_unbind', enabled: false, visible: false },
  { name: 'stream_bindings', enabled: false, visible: false },
  // --- Turn tools ---
  { name: 'say', enabled: true, visible: true },
  { name: 'ask', enabled: true, visible: true },
  { name: 'sys_set_state', enabled: true, visible: true }
]

/** Logical tool groups for the UI. Order matters — rendered top to bottom. */
const TOOL_GROUPS: { label: string; tools: Set<string>; note?: string }[] = [
  { label: 'ADF Shell', tools: new Set(['adf_shell']), note: 'Replaces individual tools with bash interface' },
  { label: 'Filesystem', tools: new Set(['fs_read', 'fs_write', 'fs_list', 'fs_delete']) },
  { label: 'System', tools: new Set(['sys_get_config', 'sys_update_config', 'sys_code', 'sys_lambda', 'sys_create_adf', 'sys_get_meta', 'sys_set_meta', 'sys_delete_meta']) },
  { label: 'Timers', tools: new Set(['sys_set_timer', 'sys_list_timers', 'sys_delete_timer']) },
  { label: 'Packages', tools: new Set(['npm_install', 'npm_uninstall']) },
  { label: 'MCP', tools: new Set(['mcp_install', 'mcp_restart', 'mcp_uninstall']) },
  { label: 'Compute', tools: new Set(['fs_transfer', 'compute_exec']) },
  { label: 'Network', tools: new Set(['sys_fetch']) },
  { label: 'Database', tools: new Set(['db_query', 'db_execute']) },
  { label: 'Loop', tools: new Set(['loop_compact', 'loop_clear']) },
  { label: 'WebSocket', tools: new Set(['ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send']) },
  { label: 'Stream Bind', tools: new Set(['stream_bind', 'stream_unbind', 'stream_bindings']) },
  { label: 'Messaging', tools: new Set(['msg_send', 'agent_discover']), note: 'Requires messaging' },
  { label: 'Inbox', tools: new Set(['msg_list', 'msg_read', 'msg_update', 'msg_delete']), note: 'Requires inbox mode' },
  { label: 'Turn', tools: new Set(['say', 'ask', 'sys_set_state']) },
]

/** Tools that require the messaging toggle to be enabled. */
const MESSAGING_TOOLS = new Set(['msg_send', 'agent_discover'])

/** Tools that require inbox mode to be enabled. */
const INBOX_TOOLS = new Set(['msg_list', 'msg_read', 'msg_update'])

/** All categorized tool names (anything not in here is uncategorized). */
const ALL_GROUPED_TOOLS = new Set(TOOL_GROUPS.flatMap(g => [...g.tools]))

/**
 * Ensure the config's tools array contains all runtime-supported tools.
 * Missing tools are appended as disabled. Existing entries are preserved.
 */
function ensureRuntimeTools(tools: ToolDeclaration[]): ToolDeclaration[] {
  // Deduplicate by name (keep first occurrence)
  const seen = new Set<string>()
  const deduped = tools.filter((t) => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
  const missing = RUNTIME_TOOLS.filter((rt) => !seen.has(rt.name))
  if (missing.length === 0 && deduped.length === tools.length) return tools
  return [...deduped, ...missing.map((t) => ({ ...t, enabled: false, visible: false }))]
}

function ToolVisibilityToggle({
  visible,
  disabled,
  onToggle
}: {
  visible: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={visible ? 'Hide from active LLM tool list' : 'Show in active LLM tool list'}
      title={visible ? 'Visible: shown in the active LLM tool list. Click to hide.' : 'Hidden: not shown in the active LLM tool list. Click to show.'}
      disabled={disabled}
      onClick={onToggle}
      className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
        disabled
          ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-700'
          : visible
            ? 'text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300'
            : 'text-neutral-300 hover:text-neutral-500 dark:text-neutral-600 dark:hover:text-neutral-400'
      }`}
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
        {!visible && <path d="M3 3l18 18" />}
      </svg>
    </button>
  )
}

function formatTcpAllowlist(rules?: StreamBindTcpAllowRule[]): string {
  return (rules ?? []).map(rule => {
    if (typeof rule.port === 'number') return `${rule.host}:${rule.port}`
    if (Array.isArray(rule.ports) && rule.ports.length > 0) return `${rule.host}:${rule.ports.join(',')}`
    if (typeof rule.min_port === 'number' || typeof rule.max_port === 'number') {
      return `${rule.host}:${rule.min_port ?? 1}-${rule.max_port ?? 65535}`
    }
    return rule.host
  }).join('\n')
}

function parseTcpAllowlist(value: string): StreamBindTcpAllowRule[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const colon = line.lastIndexOf(':')
    if (colon <= 0) return { host: line }
    const host = line.slice(0, colon).trim()
    const portSpec = line.slice(colon + 1).trim()
    if (portSpec.includes('-')) {
      const [minRaw, maxRaw] = portSpec.split('-', 2)
      const min = parseInt(minRaw, 10)
      const max = parseInt(maxRaw, 10)
      return {
        host,
        min_port: Number.isFinite(min) ? min : undefined,
        max_port: Number.isFinite(max) ? max : undefined,
      }
    }
    if (portSpec.includes(',')) {
      return {
        host,
        ports: portSpec.split(',').map(p => parseInt(p.trim(), 10)).filter(Number.isFinite),
      }
    }
    const port = parseInt(portSpec, 10)
    return Number.isFinite(port) ? { host, port } : { host }
  })
}

import type { ProviderConfig, McpServerRegistration, AdapterRegistration } from '../../../shared/types/ipc.types'
import type { AdapterInstanceConfig } from '../../../shared/types/channel-adapter.types'
import { findRegistryEntry } from '../../../shared/constants/mcp-registry'
import { findAdapterRegistryEntry } from '../../../shared/constants/adapter-registry'

// Module-level caches to avoid redundant IPC calls on every tab switch
let _cachedProviders: ProviderConfig[] | null = null
let _cachedMcpRegistrations: McpServerRegistration[] | null = null
let _cachedAdapterRegistrations: AdapterRegistration[] | null = null
let _cachedToolDefs: Record<string, unknown> | null = null
let _cachedModels: Map<string, { models: string[]; error?: string }> = new Map()

/** Call this when settings change (e.g. from SettingsPage) to bust stale caches */
export function invalidateConfigCaches(): void {
  _cachedProviders = null
  _cachedMcpRegistrations = null
  _cachedAdapterRegistrations = null
  _cachedModels = new Map()
}

// ---------------------------------------------------------------------------
// MCP Install Modal — configure & register an MCP server without leaving AgentConfig
// ---------------------------------------------------------------------------

interface McpInstallModalProps {
  open: boolean
  onClose: () => void
  serverConfig: McpServerConfig | null
  onInstalled: (reg: McpServerRegistration) => void
}

function McpInstallModal({ open, onClose, serverConfig, onInstalled }: McpInstallModalProps) {
  const [npmPackage, setNpmPackage] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; count?: number; error?: string } | null>(null)

  // Pre-fill from ADF config when modal opens
  useEffect(() => {
    if (open && serverConfig) {
      // Extract package name and custom args from args array: ["-y", "package", ...rest]
      const args = serverConfig.args ?? []
      const yIdx = args.indexOf('-y')
      if (yIdx !== -1 && args.length > yIdx + 1) {
        setNpmPackage(args[yIdx + 1])
        // Everything after -y and package name = custom args
        const rest = args.filter((_, i) => i !== yIdx && i !== yIdx + 1)
        setCustomArgs(rest.join(' '))
      } else {
        // No -y flag — try the whole args as-is
        setNpmPackage(args[0] ?? '')
        setCustomArgs(args.slice(1).join(' '))
      }

      // Pre-fill env vars from identity keystore (if env_keys exist)
      if (serverConfig.env_keys?.length && serverConfig.npm_package) {
        Promise.all(
          serverConfig.env_keys.map(async (key) => {
            const val = await window.adfApi?.getIdentity(`mcp:${serverConfig.npm_package}:${key}`)
            return { key, value: val ?? '' }
          })
        ).then(setEnvVars)
      } else {
        setEnvVars([])
      }

      setTesting(false)
      setTestResult(null)
    }
  }, [open, serverConfig])

  const handleTest = async () => {
    if (!npmPackage) return
    setTesting(true)
    setTestResult(null)
    try {
      const envRecord: Record<string, string> = {}
      for (const e of envVars) {
        if (e.key) envRecord[e.key] = e.value
      }
      const result = await window.adfApi?.probeMcpServer({
        command: 'npx',
        args: ['-y', npmPackage, ...(customArgs ? customArgs.split(' ') : [])],
        name: serverConfig?.name ?? '',
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined
      })
      if (result?.success) {
        setTestResult({ success: true, count: result.tools.length })
      } else {
        setTestResult({ success: false, error: result?.error ?? 'Failed' })
      }
    } catch (err) {
      setTestResult({ success: false, error: String(err) })
    }
    setTesting(false)
  }

  const handleSave = async () => {
    if (!npmPackage || !testResult?.success) return

    const reg: McpServerRegistration = {
      id: 'mcp:' + Math.random().toString(36).slice(2, 8),
      name: serverConfig?.name ?? '',
      type: 'npm',
      npmPackage,
      args: customArgs ? customArgs.split(' ') : [],
      env: envVars.filter((e) => e.key)
    }

    // Write env vars to identity keystore
    for (const e of envVars) {
      if (e.key) {
        await window.adfApi?.setIdentity(`mcp:${npmPackage}:${e.key}`, e.value)
      }
    }

    // Update ADF config: replace env with env_keys + npm_package
    if (serverConfig) {
      const envKeys = envVars.filter((e) => e.key).map((e) => e.key)
      serverConfig.env_keys = envKeys.length > 0 ? envKeys : undefined
      serverConfig.npm_package = npmPackage
      delete serverConfig.env
    }

    // Save to global settings
    const settings = await window.adfApi?.getSettings()
    const existingServers = (settings?.mcpServers as McpServerRegistration[]) ?? []
    await window.adfApi?.setSettings({
      mcpServers: [...existingServers, reg]
    })

    // Bust caches so AgentConfig picks up the new registration
    invalidateConfigCaches()
    _cachedMcpRegistrations = [...existingServers, reg]

    onInstalled(reg)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Install MCP: ${serverConfig?.name ?? ''}`}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">npm Package</label>
          <input
            type="text"
            value={npmPackage}
            onChange={(e) => { setNpmPackage(e.target.value); setTestResult(null) }}
            placeholder="e.g. mcp-telegram-claudecode"
            className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
          />
        </div>
        <div>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Custom Args (optional, space-separated)</label>
          <input
            type="text"
            value={customArgs}
            onChange={(e) => setCustomArgs(e.target.value)}
            placeholder="--port 3000"
            className="w-full px-2 py-1.5 text-sm font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Environment Variables</label>
            <button
              onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add
            </button>
          </div>
          {envVars.length > 0 && (
            <div className="space-y-1.5">
              {envVars.map((envVar, j) => (
                <div key={j} className="flex gap-1.5 items-center">
                  <input
                    type="text"
                    value={envVar.key}
                    onChange={(e) => {
                      const next = [...envVars]
                      next[j] = { ...next[j], key: e.target.value }
                      setEnvVars(next)
                    }}
                    placeholder="KEY"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <input
                    type="password"
                    value={envVar.value}
                    onChange={(e) => {
                      const next = [...envVars]
                      next[j] = { ...next[j], value: e.target.value }
                      setEnvVars(next)
                    }}
                    placeholder="value"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => setEnvVars(envVars.filter((_, i) => i !== j))}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Test + Result */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleTest}
            disabled={!npmPackage || testing}
            className="px-2.5 py-1 text-xs bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 rounded-md hover:bg-neutral-300 dark:hover:bg-neutral-600 disabled:opacity-50"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testResult && (
            <span className={`text-xs ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
              {testResult.success ? `${testResult.count} tools discovered` : testResult.error}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!npmPackage || !testResult?.success}
            className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Install
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Sandbox Package Install Modal — install missing packages on agent open
// ---------------------------------------------------------------------------

interface SandboxInstallModalProps {
  open: boolean
  onClose: () => void
  packages: CodeExecutionPackage[]
}

function SandboxInstallModal({ open, onClose, packages }: SandboxInstallModalProps) {
  const [installing, setInstalling] = useState(false)
  const [results, setResults] = useState<Record<string, { status: string; error?: string }>>({})

  useEffect(() => {
    if (open) {
      setInstalling(false)
      setResults({})
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const unsub = window.adfApi?.onSandboxInstallProgress((event: { package: string; status: string; progress?: string; error?: string }) => {
      setResults((prev) => ({
        ...prev,
        [event.package]: { status: event.status, error: event.error }
      }))
    })
    return () => { unsub?.() }
  }, [open])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await window.adfApi?.installSandboxPackages(packages)
    } catch { /* errors reported via progress events */ }
    setInstalling(false)
  }

  const allDone = packages.every((p) => results[p.name]?.status === 'installed' || results[p.name]?.status === 'error')

  return (
    <Dialog open={open} onClose={onClose} title="Install Sandbox Packages">
      <div className="space-y-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          This agent requires the following packages:
        </p>
        <div className="space-y-1">
          {packages.map((pkg) => {
            const r = results[pkg.name]
            return (
              <div key={pkg.name} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <span className="font-mono text-neutral-700 dark:text-neutral-300">
                  {pkg.name}@{pkg.version}
                </span>
                <span className={`text-[10px] ${
                  r?.status === 'installed' ? 'text-green-600 dark:text-green-400' :
                  r?.status === 'error' ? 'text-red-500' :
                  r?.status === 'installing' ? 'text-blue-500' :
                  'text-neutral-400'
                }`}>
                  {r?.status === 'installed' ? 'Installed' :
                   r?.status === 'error' ? (r.error?.slice(0, 40) ?? 'Failed') :
                   r?.status === 'installing' ? 'Installing...' :
                   'Pending'}
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg"
          >
            {allDone ? 'Close' : 'Skip'}
          </button>
          {!allDone && (
            <button
              onClick={handleInstall}
              disabled={installing}
              className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing ? 'Installing...' : 'Install All'}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export function AgentConfig() {
  const config = useAgentStore((s) => s.config)
  const setConfig = useAgentStore((s) => s.setConfig)
  const filePath = useDocumentStore((s) => s.filePath)
  const setFilePath = useDocumentStore((s) => s.setFilePath)
  const [local, setLocal] = useState<AgentConfigType | null>(null)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [customModelEntry, setCustomModelEntry] = useState(false)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [knownAgents, setKnownAgents] = useState<{ did: string; label: string }[]>([])
  const [allowListInput, setAllowListInput] = useState('')
  const [blockListInput, setBlockListInput] = useState('')
  const [allowListDropdown, setAllowListDropdown] = useState(false)
  const [blockListDropdown, setBlockListDropdown] = useState(false)
  const [toolDefs, setToolDefs] = useState<Record<string, unknown>>({})
  const [viewingTool, setViewingTool] = useState<string | null>(null)
  const [mcpRegistrations, setMcpRegistrations] = useState<McpServerRegistration[]>([])
  const [mcpProbing, setMcpProbing] = useState<Record<string, boolean>>({})
  const [mcpProbeErrors, setMcpProbeErrors] = useState<Record<string, string>>({})
  const [mcpInstallTarget, setMcpInstallTarget] = useState<McpServerConfig | null>(null) // server config for install modal
  /** Set of MCP server names that have identity keys stored in this ADF */
  const [mcpServersWithKeys, setMcpServersWithKeys] = useState<Set<string>>(new Set())
  const [unregMcpCollapsed, setUnregMcpCollapsed] = useState(true)
  const [adapterRegistrations, setAdapterRegistrations] = useState<AdapterRegistration[]>([])
  /** Set of adapter types that have identity keys stored in this ADF */
  const [adapterWithKeys, setAdapterWithKeys] = useState<Set<string>>(new Set())
  /** Map of adapter type → set of key names stored in this ADF's identity keystore */
  const [adapterIdentityKeys, setAdapterIdentityKeys] = useState<Record<string, Set<string>>>({})
  /** Email account identifier pulled from adf_identity when present */
  const [emailAccount, setEmailAccount] = useState<string | null>(null)
  /** Whether the current provider has credentials saved on this ADF */
  const [providerSavedOnAdf, setProviderSavedOnAdf] = useState(false)
  const [savingProviderToAdf, setSavingProviderToAdf] = useState(false)
  const [showDetachProviderDialog, setShowDetachProviderDialog] = useState(false)
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })
  const [hasSigningKeys, setHasSigningKeys] = useState(false)
  const [metaEntries, setMetaEntries] = useState<Array<{ key: string; value: string; protection: MetaProtectionLevel }>>([])
  const [viewingMeta, setViewingMeta] = useState<{ key: string; value: string; protection: MetaProtectionLevel } | null>(null)
  const [editingMetaValue, setEditingMetaValue] = useState('')
  const [addingMeta, setAddingMeta] = useState(false)
  const [newMetaKey, setNewMetaKey] = useState('')
  const [newMetaValue, setNewMetaValue] = useState('')
  const [newMetaProtection, setNewMetaProtection] = useState<MetaProtectionLevel>('none')
  const [localTables, setLocalTables] = useState<Array<{ name: string; row_count: number }>>([])
  const [newProtectedTable, setNewProtectedTable] = useState('')
  const [newTableProtection, setNewTableProtection] = useState<TableProtectionLevel>('append_only')
  const [missingPackages, setMissingPackages] = useState<CodeExecutionPackage[]>([])
  const [showPkgInstallModal, setShowPkgInstallModal] = useState(false)
  const [runtimeHostEnabled, setRuntimeHostEnabled] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)

  useEffect(() => {
    if (savingRef.current) {
      savingRef.current = false
      return
    }
    if (config) {
      const clone = structuredClone(config)
      clone.tools = ensureRuntimeTools(clone.tools)
      setLocal(clone)
    }
  }, [config])

  // Fetch custom providers from settings (cached — invalidated on settings save)
  useEffect(() => {
    const t0 = performance.now()
    // Always fetch runtime host setting (it can change between Settings visits)
    window.adfApi?.getSettings().then((s) => {
      setRuntimeHostEnabled(!!(s?.compute as Record<string, unknown>)?.hostAccessEnabled)
    })
    if (_cachedProviders && _cachedMcpRegistrations && _cachedAdapterRegistrations) {
      setProviders(_cachedProviders)
      setMcpRegistrations(_cachedMcpRegistrations)
      setAdapterRegistrations(_cachedAdapterRegistrations)
      // console.log(`[PERF:renderer] AgentConfig.getSettings: ${(performance.now() - t0).toFixed(1)}ms (cached)`)
    } else {
      window.adfApi?.getSettings().then((settings) => {
        _cachedProviders = (settings.providers as ProviderConfig[]) ?? []
        _cachedMcpRegistrations = (settings.mcpServers as McpServerRegistration[]) ?? []
        _cachedAdapterRegistrations = (settings.adapters as AdapterRegistration[]) ?? []
        setProviders(_cachedProviders)
        setMcpRegistrations(_cachedMcpRegistrations)
        setAdapterRegistrations(_cachedAdapterRegistrations)
        setRuntimeHostEnabled(!!(settings.compute as Record<string, unknown>)?.hostAccessEnabled)
        // console.log(`[PERF:renderer] AgentConfig.getSettings: ${(performance.now() - t0).toFixed(1)}ms (fetched)`)
      })
    }
  }, [])

  // Check for missing sandbox packages on config load
  useEffect(() => {
    const packages = config?.code_execution?.packages
    if (!packages?.length) return
    window.adfApi?.checkMissingSandboxPackages(packages).then((result) => {
      if (result?.missing?.length) {
        setMissingPackages(result.missing)
        setShowPkgInstallModal(true)
      }
    })
  }, [config?.code_execution?.packages])

  // Fetch mesh server status for Serving section URL preview
  useEffect(() => {
    window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
  }, [])

  // Fetch adf_meta entries
  const refreshMeta = useCallback(() => {
    window.adfApi?.getAllMeta().then((res) => {
      if (res?.entries) setMetaEntries(res.entries)
    })
  }, [])
  useEffect(() => { refreshMeta() }, [refreshMeta])

  useEffect(() => {
    window.adfApi?.listLocalTables().then((res) => {
      setLocalTables((res?.tables ?? []).filter((table) => table.name.startsWith('local_')))
    })
  }, [filePath])

  // Fetch known agents from the mesh for the allow/block list DID picker
  useEffect(() => {
    const fetchKnown = async () => {
      const agents: { did: string; label: string }[] = []
      const seen = new Set<string>()

      // Mesh agents (local)
      try {
        const meshResult = await window.adfApi?.getMeshStatus()
        if (meshResult?.agents) {
          for (const a of meshResult.agents) {
            if (a.did && !seen.has(a.did)) {
              seen.add(a.did)
              agents.push({ did: a.did, label: a.handle })
            }
          }
        }
      } catch { /* ignore */ }

      // Exclude self
      const selfDid = local?.id
      const filtered = selfDid ? agents.filter(a => a.did !== selfDid) : agents
      filtered.sort((a, b) => a.label.localeCompare(b.label))
      setKnownAgents(filtered)
    }
    fetchKnown()
  }, [local?.id])

  // Check which MCP servers have identity keys stored in this ADF
  useEffect(() => {
    if (!local?.mcp?.servers?.length) {
      setMcpServersWithKeys(new Set())
      return
    }
    window.adfApi?.listIdentityPurposes('mcp:').then((purposes) => {
      const namesWithKeys = new Set<string>()
      for (const srv of local.mcp!.servers) {
        const regType = mcpRegistrations.find((r) => r.name === srv.name)?.type ?? (srv.npm_package ? 'npm' : srv.pypi_package ? 'uvx' : 'custom')
        const pkg = srv.npm_package ?? srv.pypi_package
        const prefix = (regType === 'npm' || regType === 'uvx') && pkg
          ? `mcp:${pkg}:`
          : `mcp:${srv.name}:`
        if (purposes.some((p) => p.startsWith(prefix))) {
          namesWithKeys.add(srv.name)
        }
      }
      setMcpServersWithKeys(namesWithKeys)
    })
  }, [local?.mcp?.servers, mcpRegistrations])

  // Check which adapters have identity keys stored in this ADF
  useEffect(() => {
    if (adapterRegistrations.length === 0) {
      setAdapterWithKeys(new Set())
      return
    }
    window.adfApi?.listIdentityPurposes('adapter:').then((purposes) => {
      const typesWithKeys = new Set<string>()
      const keysByType: Record<string, Set<string>> = {}
      for (const reg of adapterRegistrations) {
        const prefix = `adapter:${reg.type}:`
        const keys = new Set<string>()
        for (const p of purposes) {
          if (p.startsWith(prefix)) keys.add(p.slice(prefix.length))
        }
        if (keys.size > 0) {
          typesWithKeys.add(reg.type)
          keysByType[reg.type] = keys
        }
      }
      setAdapterWithKeys(typesWithKeys)
      setAdapterIdentityKeys(keysByType)

      // Pull the email account identifier for display (non-sensitive)
      if (keysByType.email?.has('EMAIL_USERNAME')) {
        window.adfApi?.getIdentity('adapter:email:EMAIL_USERNAME').then((val) => {
          setEmailAccount(val ?? null)
        })
      } else {
        setEmailAccount(null)
      }
    })
  }, [local?.adapters, adapterRegistrations])

  // Check if this ADF has signing keys (DID exists iff keys were generated)
  useEffect(() => {
    const check = () => {
      window.adfApi?.getDid().then((r) => setHasSigningKeys(!!r?.did))
    }
    check()
    // Re-check when window gains focus (user may switch to Identity tab and generate keys)
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [filePath])

  // Check if current provider is saved on this ADF (config.providers[] or identity)
  useEffect(() => {
    if (!local?.model.provider) {
      setProviderSavedOnAdf(false)
      return
    }
    // Primary check: is the provider config stored in the ADF?
    const inConfig = local.providers?.some(p => p.id === local.model.provider) ?? false
    if (inConfig) {
      setProviderSavedOnAdf(true)
      return
    }
    // Fallback: check identity for credential entries
    window.adfApi?.listIdentityPurposes(`provider:${local.model.provider}:`).then((purposes) => {
      setProviderSavedOnAdf(purposes.length > 0)
    }).catch(() => setProviderSavedOnAdf(false))
  }, [local?.model.provider, local?.providers])

  // Fetch tool definitions (cached — tool registry doesn't change at runtime)
  useEffect(() => {
    const t0 = performance.now()
    if (_cachedToolDefs) {
      setToolDefs(_cachedToolDefs)
      // console.log(`[PERF:renderer] AgentConfig.getToolDefs: ${(performance.now() - t0).toFixed(1)}ms (cached)`)
    } else {
      window.adfApi?.getToolDescriptions().then((defs) => {
        _cachedToolDefs = defs
        setToolDefs(defs)
        // console.log(`[PERF:renderer] AgentConfig.getToolDefs: ${(performance.now() - t0).toFixed(1)}ms (fetched)`)
      })
    }
  }, [])

  // Fetch available models when provider changes (cached per provider)
  useEffect(() => {
    if (!local) return
    const provider = local.model.provider
    const cached = _cachedModels.get(provider)
    if (cached) {
      setModelOptions(cached.models)
      setModelsError(cached.error ?? null)
      if (cached.models.length > 0 && !cached.models.includes(local.model.model_id)) {
        setCustomModelEntry(true)
      }
      // console.log(`[PERF:renderer] AgentConfig.listModels: 0ms (cached, provider=${provider})`)
      return
    }
    const t0 = performance.now()
    setModelsLoading(true)
    setModelsError(null)
    setCustomModelEntry(false)
    // Pass filePath when provider is ADF-stored so backend resolves the API key from identity
    const isAdfProvider = local.providers?.some(p => p.id === provider)
    window.adfApi?.listModels(provider, isAdfProvider ? filePath ?? undefined : undefined).then((result) => {
      _cachedModels.set(provider, result)
      setModelOptions(result.models)
      setModelsError(result.error ?? null)
      // If current model_id is not in the list, show custom entry
      if (result.models.length > 0 && !result.models.includes(local.model.model_id)) {
        setCustomModelEntry(true)
      }
    }).catch((err) => {
      setModelsError(String(err))
      setModelOptions([])
    }).finally(() => {
      setModelsLoading(false)
      // console.log(`[PERF:renderer] AgentConfig.listModels: ${(performance.now() - t0).toFixed(1)}ms (fetched, provider=${provider})`)
    })
  }, [local?.model.provider])

  const updateFileEntry = useTrackedDirsStore((s) => s.updateFileEntry)

  const save = useCallback(
    (updated: AgentConfigType) => {
      savingRef.current = true
      setLocal(updated)
      setConfig(updated)
      window.adfApi?.setAgentConfig(updated)

      // Sync sidebar-visible fields to tracked dirs store so they
      // persist when this file is no longer the foreground agent
      if (filePath) {
        updateFileEntry(filePath, {
          autonomous: updated.autonomous ?? false,
          canReceive: updated.triggers?.on_inbox?.enabled ?? false,
          sendMode: updated.messaging?.mode
        })
      }
    },
    [setConfig, filePath, updateFileEntry]
  )

  const isSectionLocked = useCallback(
    (key: string) => local?.locked_fields?.includes(key) ?? false,
    [local?.locked_fields]
  )

  const toggleSectionLock = useCallback(
    (key: string) => {
      if (!local) return
      const fields = [...(local.locked_fields ?? [])]
      const idx = fields.indexOf(key)
      if (idx >= 0) fields.splice(idx, 1)
      else fields.push(key)
      save({ ...local, locked_fields: fields.length > 0 ? fields : undefined })
    },
    [local, save]
  )

  const toggleFieldLock = useCallback(
    (key: string, alsoKeys?: string[]) => {
      if (!local) return
      const fields = [...(local.locked_fields ?? [])]
      const allKeys = [key, ...(alsoKeys ?? [])]
      if (fields.includes(key)) {
        const toRemove = new Set(allKeys)
        const next = fields.filter(f => !toRemove.has(f))
        save({ ...local, locked_fields: next.length > 0 ? next : undefined })
      } else {
        for (const k of allKeys) {
          if (!fields.includes(k)) fields.push(k)
        }
        save({ ...local, locked_fields: fields })
      }
    },
    [local, save]
  )

  const setTableProtection = useCallback(
    (table: string, protection: TableProtectionLevel) => {
      if (!local) return
      const tableName = table.trim()
      if (!tableName.startsWith('local_')) return
      const protections = { ...(local.security?.table_protections ?? {}) }
      if (protection === 'none') delete protections[tableName]
      else protections[tableName] = protection
      save({
        ...local,
        security: {
          ...local.security,
          table_protections: Object.keys(protections).length > 0 ? protections : undefined
        }
      })
    },
    [local, save]
  )

  const handleRename = useCallback(async () => {
    if (editingName === null || !filePath || !local) return
    const trimmed = editingName.trim()
    if (!trimmed || trimmed === local.name) {
      setEditingName(null)
      setNameError(null)
      return
    }
    const result = await window.adfApi.renameFile(filePath, trimmed)
    if (result.success && result.filePath) {
      setFilePath(result.filePath)
      setLocal({ ...local, name: trimmed })
      setConfig({ ...local, name: trimmed })
      setEditingName(null)
      setNameError(null)
    } else {
      setNameError(result.error ?? 'Rename failed')
    }
  }, [editingName, filePath, local, setFilePath, setConfig])

  if (!local) {
    return (
      <div className="p-4 text-sm text-neutral-400 dark:text-neutral-500 text-center mt-8">
        Open a file to view agent configuration.
      </div>
    )
  }

  const tableProtectionEntries = Object.entries(local.security?.table_protections ?? {})
    .filter(([, protection]) => protection && protection !== 'none')
    .sort(([a], [b]) => a.localeCompare(b)) as Array<[string, Exclude<TableProtectionLevel, 'none'>]>
  const protectedTableNames = new Set(tableProtectionEntries.map(([table]) => table))
  const availableTablesForProtection = localTables.filter((table) => !protectedTableNames.has(table.name))

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 space-y-4">
        {/* Identity */}
        <Section title="Identity">
          <Field label="Name">
            <input
              ref={nameInputRef}
              type="text"
              value={editingName !== null ? editingName : local.name}
              onChange={(e) => {
                setEditingName(e.target.value)
                setNameError(null)
              }}
              onFocus={() => setEditingName(local.name)}
              onBlur={() => handleRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  nameInputRef.current?.blur()
                } else if (e.key === 'Escape') {
                  setEditingName(null)
                  setNameError(null)
                  nameInputRef.current?.blur()
                }
              }}
              className="field-input"
            />
            {nameError ? (
              <p className="text-[10px] text-red-400 mt-0.5">{nameError}</p>
            ) : (
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">Press Enter to rename.</p>
            )}
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={local.description}
              onChange={(e) => save({ ...local, description: e.target.value })}
              className="field-input"
            />
          </Field>
          <Field label="Icon">
            <input
              type="text"
              value={local.icon ?? ''}
              onChange={(e) =>
                save({ ...local, icon: e.target.value || undefined })
              }
              placeholder="e.g. \u{1F916}"
              className="field-input w-16"
            />
          </Field>
          <Field label="Start in state">
            <select
              value={local.start_in_state ?? 'active'}
              onChange={(e) => {
                const val = e.target.value as StartInState
                save({ ...local, start_in_state: val === 'active' ? undefined : val })
              }}
              className="field-input w-32"
            >
              {START_IN_STATES.map((s) => (
                <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              State the agent boots into on startup. Runtime state is not persisted.
            </p>
          </Field>
          <Field label="Autostart">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={local.autostart ?? false}
                onChange={(e) => {
                  save({ ...local, autostart: e.target.checked || undefined })
                }}
              />
              <span className="text-neutral-700 dark:text-neutral-300">Start as background agent on boot</span>
            </label>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Automatically start this agent when the app launches. Password-protected agents are skipped.
            </p>
          </Field>
          <Field label="Autonomous">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={local.autonomous ?? false}
                onChange={(e) => {
                  save({ ...local, autonomous: e.target.checked })
                }}
              />
              <span className="text-neutral-700 dark:text-neutral-300">Operate continuously without stopping after each response</span>
            </label>
          </Field>
          {local.autonomous && (
            <>
              <div className="p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
                <p className="text-[10px] text-amber-700 dark:text-amber-400">
                  <strong>Warning:</strong> An autonomous agent will keep making LLM calls
                  without pausing between turns. This will consume tokens and incur API costs.
                  If the agent loops (e.g. repeated read/write cycles), costs can escalate quickly.
                  Ensure your instructions have clear stopping conditions and that{' '}
                  <strong>sys_set_state</strong> is enabled so the agent can idle or stop itself.
                </p>
              </div>
              <Field label="Max active turns">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={0}
                    step={1}
                    value={local.limits?.max_active_turns ?? 0}
                    placeholder="0"
                    onChange={(v) =>
                      save({
                        ...local,
                        limits: { ...local.limits, max_active_turns: v > 0 ? v : null }
                      })
                    }
                  />
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                    {local.limits?.max_active_turns ? `Suspends after ${local.limits.max_active_turns} turns` : '0 = unlimited'}
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                  Pauses the agent after this many LLM loop iterations and asks you to resume or stop.
                </p>
              </Field>
              <Field label="Suspend timeout (minutes)">
                <div className="flex items-center gap-2">
                  <NumberInput
                    min={1}
                    step={1}
                    value={Math.round((local.limits?.suspend_timeout_ms ?? 1_200_000) / 60_000)}
                    onChange={(v) =>
                      save({
                        ...local,
                        limits: { ...local.limits, suspend_timeout_ms: v * 60_000 }
                      })
                    }
                  />
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                    {Math.round((local.limits?.suspend_timeout_ms ?? 1_200_000) / 60_000)} min
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                  If no response within this time, the agent shuts down automatically.
                </p>
              </Field>
            </>
          )}
        </Section>

        {/* Model */}
        <Section title="Model" locked={isSectionLocked('model')} onToggleLock={() => toggleSectionLock('model')} summary={`${local.model.provider ?? 'none'} / ${local.model.model ?? 'default'}`}>
          <Field label="Provider">
            {(() => {
              // Merge app-wide providers with ADF-stored providers (ADF takes priority)
              const adfProviders: AdfProviderConfig[] = local.providers ?? []
              const adfIds = new Set(adfProviders.map(p => p.id))
              const mergedProviders: { id: string; label: string }[] = [
                ...adfProviders.map(p => ({ id: p.id, label: p.name || p.baseUrl || p.id })),
                ...providers.filter(p => !adfIds.has(p.id)).map(p => ({ id: p.id, label: p.name || p.baseUrl || p.id }))
              ]

              const handleSaveToAdf = async () => {
                if (!filePath || !local.model.provider) return
                const providerId = local.model.provider
                // Find the provider config from app settings
                const appProvider = providers.find(p => p.id === providerId)
                if (!appProvider) return
                setSavingProviderToAdf(true)
                try {
                  const { apiKey: _omit, credentialStorage: _omit2, ...providerWithoutKey } = appProvider
                  // Attach the provider config to the ADF
                  await window.adfApi?.attachProvider({ filePath, provider: providerWithoutKey })
                  // Save the API key to ADF identity
                  if (appProvider.apiKey) {
                    await window.adfApi?.setProviderCredential({ filePath, providerId, value: appProvider.apiKey })
                  }
                  setProviderSavedOnAdf(true)
                  // Update local config to include the ADF provider
                  const existingProviders = local.providers ?? []
                  if (!existingProviders.some(p => p.id === providerId)) {
                    save({ ...local, providers: [...existingProviders, providerWithoutKey] })
                  }
                  // Update app settings provider to per-agent storage mode
                  if (appProvider.credentialStorage !== 'agent') {
                    const updatedProviders = providers.map(p =>
                      p.id === providerId ? { ...p, credentialStorage: 'agent' as const } : p
                    )
                    setProviders(updatedProviders)
                    _cachedProviders = updatedProviders
                    await window.adfApi?.setSettings({ providers: updatedProviders })
                  }
                } catch {
                  // Ignore errors
                } finally {
                  setSavingProviderToAdf(false)
                }
              }

              return (
                <div className="flex gap-1.5 items-center">
                  <select
                    value={local.model.provider}
                    onChange={async (e) => {
                      const newProvider = e.target.value
                      // Check if it's an ADF-stored provider
                      const adfMatch = adfProviders.find(p => p.id === newProvider)
                      if (adfMatch) {
                        _cachedModels.delete(newProvider)
                        save({
                          ...local,
                          model: {
                            ...local.model,
                            provider: newProvider,
                            model_id: adfMatch.defaultModel || '',
                            params: adfMatch.params?.length ? adfMatch.params.map((p) => ({ ...p })) : undefined
                          }
                        })
                        return
                      }

                      // Re-fetch settings to get the latest defaults (invalidate cache)
                      _cachedProviders = null
                      const settings = await window.adfApi?.getSettings()
                      const freshProviders = (settings?.providers as ProviderConfig[]) ?? []
                      _cachedProviders = freshProviders
                      setProviders(freshProviders)

                      const selected = freshProviders.find((p) => p.id === newProvider)
                      save({
                        ...local,
                        model: {
                          ...local.model,
                          provider: newProvider,
                          model_id: selected?.defaultModel || '',
                          params: selected?.params?.length ? selected.params.map((p) => ({ ...p })) : undefined
                        }
                      })
                    }}
                    className="field-input flex-1"
                  >
                    {!mergedProviders.some((p) => p.id === local.model.provider) && (
                      <option value={local.model.provider}>
                        {local.model.provider || '— Select a provider —'}
                      </option>
                    )}
                    {mergedProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {/* Save/remove provider credentials on this ADF */}
                  {local.model.provider && filePath && (
                    <button
                      onClick={() => {
                        if (providerSavedOnAdf) {
                          setShowDetachProviderDialog(true)
                        } else {
                          handleSaveToAdf()
                        }
                      }}
                      disabled={savingProviderToAdf}
                      title={providerSavedOnAdf ? 'Credentials saved on ADF — click to remove' : 'Save credentials to ADF'}
                      className={`shrink-0 p-1 rounded transition-colors ${
                        providerSavedOnAdf
                          ? 'text-amber-500 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300'
                          : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300'
                      } ${savingProviderToAdf ? 'opacity-50 cursor-wait' : ''}`}
                    >
                      {providerSavedOnAdf ? (
                        /* Floppy disk saved icon */
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V4.621a1.5 1.5 0 0 0-.44-1.06l-1.12-1.122A1.5 1.5 0 0 0 11.378 2H3.5ZM5 3.5h4v2H5v-2Zm3 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
                        </svg>
                      ) : (
                        /* Floppy disk unsaved icon */
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" className="w-4 h-4">
                          <path d="M3.5 2.5h7.878a1 1 0 0 1 .707.293l1.122 1.122a1 1 0 0 1 .293.707V12.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
                          <path d="M5 2.5v2.5h4V2.5" />
                          <circle cx="8" cy="9.5" r="1.5" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
              )
            })()}
          </Field>
          <Field label="Model ID">
            {modelsLoading ? (
              <div className="field-input text-neutral-400 dark:text-neutral-500 text-xs flex items-center">Loading models...</div>
            ) : customModelEntry ? (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={local.model.model_id}
                  onChange={(e) =>
                    save({
                      ...local,
                      model: { ...local.model, model_id: e.target.value }
                    })
                  }
                  className="field-input flex-1"
                  placeholder="Enter model ID"
                />
                {modelOptions.length > 0 && (
                  <button
                    className="text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap"
                    onClick={() => setCustomModelEntry(false)}
                  >
                    Pick from list
                  </button>
                )}
              </div>
            ) : (
              <select
                value={modelOptions.includes(local.model.model_id) ? local.model.model_id : '__custom__'}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setCustomModelEntry(true)
                  } else {
                    save({
                      ...local,
                      model: { ...local.model, model_id: e.target.value }
                    })
                  }
                }}
                className="field-input"
              >
                {[...modelOptions].sort((a, b) => a.localeCompare(b)).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                {!modelOptions.includes(local.model.model_id) && local.model.model_id && (
                  <option value={local.model.model_id}>{local.model.model_id} (current)</option>
                )}
                <option value="__custom__">Custom...</option>
              </select>
            )}
            {modelsError && (
              <p className="text-[10px] text-red-400 mt-0.5">{modelsError}</p>
            )}
          </Field>
          <div className="flex gap-3">
            <Field label="Temperature">
              <NumberInput
                float
                min={0}
                max={2}
                step={0.1}
                value={local.model.temperature ?? 0.7}
                onChange={(v) =>
                  save({
                    ...local,
                    model: { ...local.model, temperature: v }
                  })
                }
                className="field-input w-20"
              />
            </Field>
            <Field label="Max Tokens">
              <NumberInput
                min={0}
                step={256}
                value={local.model.max_tokens ?? 4096}
                onChange={(v) =>
                  save({
                    ...local,
                    model: { ...local.model, max_tokens: v }
                  })
                }
                className="field-input w-24"
              />
              {(local.model.max_tokens ?? 4096) === 0 && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500 ml-1">0 = model default</span>
              )}
            </Field>
          </div>
          <Field label="Thinking Budget">
            <div className="flex items-center gap-2">
              <NumberInput
                min={0}
                step={1024}
                value={local.model.thinking_budget ?? 0}
                onChange={(v) =>
                  save({
                    ...local,
                    model: { ...local.model, thinking_budget: v > 0 ? v : undefined }
                  })
                }
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {local.model.thinking_budget ? 'Enabled' : '0 = off'}
              </span>
            </div>
          </Field>
          <Field label="Multimodal">
            <div className="flex flex-col gap-1">
              {(['image', 'audio', 'video'] as const).map((modality) => (
                <label key={modality} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={modality === 'image'
                      ? (local.model.multimodal?.image ?? local.model.vision ?? false)
                      : (local.model.multimodal?.[modality] ?? false)}
                    onChange={(e) => {
                      save({
                        ...local,
                        model: {
                          ...local.model,
                          vision: undefined,
                          multimodal: { ...local.model.multimodal, [modality]: e.target.checked }
                        }
                      })
                    }}
                    className="accent-blue-500"
                  />
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400 capitalize">
                    {modality}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              When enabled, media files read via fs_read or returned by MCP tools are sent as native content blocks to the LLM.
            </p>
          </Field>
          <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-neutral-500 dark:text-neutral-400">Parameters</label>
                <button
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                  onClick={() => {
                    const params = [...(local.model.params ?? [])]
                    params.push({ key: '', value: '' })
                    save({ ...local, model: { ...local.model, params } })
                  }}
                >
                  + Add
                </button>
              </div>
              {(local.model.params ?? []).length > 0 ? (
                <div className="space-y-1.5">
                  {(local.model.params ?? []).map((param, j) => (
                    <div key={j} className="flex gap-1 items-center">
                      <input
                        type="text"
                        value={param.key}
                        onChange={(e) => {
                          const params = [...(local.model.params ?? [])]
                          params[j] = { ...params[j], key: e.target.value }
                          save({ ...local, model: { ...local.model, params } })
                        }}
                        placeholder="key"
                        className="field-input flex-1 !text-xs font-mono"
                      />
                      <input
                        type="text"
                        value={param.value}
                        onChange={(e) => {
                          const params = [...(local.model.params ?? [])]
                          params[j] = { ...params[j], value: e.target.value }
                          save({ ...local, model: { ...local.model, params } })
                        }}
                        placeholder="blank = null"
                        className="field-input flex-1 !text-xs font-mono"
                      />
                      <button
                        onClick={() => {
                          const params = (local.model.params ?? []).filter((_, k) => k !== j)
                          save({ ...local, model: { ...local.model, params } })
                        }}
                        className="text-xs text-red-400 hover:text-red-600 px-0.5"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                  Override provider params for this file. Blank value = remove key.
                </p>
              )}
          </div>
        </Section>

        {/* Instructions */}
        <Section title="Instructions" locked={isSectionLocked('instructions')} onToggleLock={() => toggleSectionLock('instructions')}>
          <label className="flex items-center gap-2 text-xs mb-2">
            <input
              type="checkbox"
              checked={local.include_base_prompt !== false}
              onChange={(e) => save({ ...local, include_base_prompt: e.target.checked ? undefined : false })}
            />
            Include application base system prompt
          </label>
          <textarea
            value={local.instructions}
            onChange={(e) => save({ ...local, instructions: e.target.value })}
            rows={6}
            className="field-input resize-none font-mono text-xs"
          />
        </Section>

        {/* Context */}
        <Section title="Context" locked={isSectionLocked('context')} onToggleLock={() => toggleSectionLock('context')}>
          <Field label="Compact Threshold">
            <div className="flex items-center gap-2">
              <NumberInput
                min={0}
                step={10000}
                value={local.context?.compact_threshold ?? 0}
                placeholder="100000"
                onChange={(v) =>
                  save({
                    ...local,
                    context: {
                      ...local.context,
                      compact_threshold: v > 0 ? v : undefined
                    }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {local.context?.compact_threshold ? `${local.context.compact_threshold.toLocaleString()} tokens` : 'Default: 100k'}
              </span>
            </div>
          </Field>
          <Field label="Max Tool Result">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1000}
                step={1000}
                value={local.limits?.max_tool_result_tokens ?? 16000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_tool_result_tokens: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {(local.limits?.max_tool_result_tokens ?? 16000).toLocaleString()} tokens
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Truncates tool results exceeding this token limit to protect the context window.
            </p>
          </Field>
          <Field label="Tool Result Preview">
            <div className="flex items-center gap-2">
              <NumberInput
                min={500}
                step={500}
                value={local.limits?.max_tool_result_preview_chars ?? 5000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_tool_result_preview_chars: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {(local.limits?.max_tool_result_preview_chars ?? 5000).toLocaleString()} chars
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Characters shown when a tool result is truncated. Split evenly between the start and end.
            </p>
          </Field>
          <Field label="Max File Read">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1000}
                step={5000}
                value={local.limits?.max_file_read_tokens ?? 30000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_file_read_tokens: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {(local.limits?.max_file_read_tokens ?? 30000).toLocaleString()} tokens
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Token limit for text file reads. Binary files always return metadata only.
            </p>
          </Field>
          <Field label="Max File Write">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={524288}
                value={local.limits?.max_file_write_bytes ?? 5000000}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_file_write_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {((local.limits?.max_file_write_bytes ?? 5000000) / 1024).toFixed(0)} KB
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Max file write size in bytes. Does not apply to document.md or mind.md.
            </p>
          </Field>
          <Field label="Max Image Size">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={1048576}
                value={local.limits?.max_image_size_bytes ?? 5242880}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_image_size_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {((local.limits?.max_image_size_bytes ?? 5242880) / 1048576).toFixed(1)} MB
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Max image size (bytes) for multimodal inlining. Larger images are skipped.
            </p>
          </Field>
          <Field label="Max Audio Size">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={1048576}
                value={local.limits?.max_audio_size_bytes ?? 10485760}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_audio_size_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {((local.limits?.max_audio_size_bytes ?? 10485760) / 1048576).toFixed(1)} MB
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Max audio size (bytes) for multimodal inlining. Larger audio files are skipped.
            </p>
          </Field>
          <Field label="Max Video Size">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1024}
                step={1048576}
                value={local.limits?.max_video_size_bytes ?? 20971520}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, max_video_size_bytes: v }
                  })
                }
                className="field-input w-32"
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {((local.limits?.max_video_size_bytes ?? 20971520) / 1048576).toFixed(1)} MB
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Max video size (bytes) for multimodal inlining. Larger video files are skipped.
            </p>
          </Field>
          <Field label="Max Loop Messages">
            <div className="flex items-center gap-2">
              <NumberInput
                min={0}
                step={10}
                value={local.context?.max_loop_messages ?? 0}
                placeholder="0"
                onChange={(v) =>
                  save({
                    ...local,
                    context: {
                      ...local.context,
                      max_loop_messages: v > 0 ? v : undefined
                    }
                  })
                }
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {local.context?.max_loop_messages ? `Keep last ${local.context.max_loop_messages}` : '0 = unlimited'}
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Prunes older loop messages to save memory. Useful for long-running agents.
            </p>
          </Field>
          <Field label="Dynamic Instructions">
            <div className="space-y-1">
              {([
                { key: 'inbox_hints' as const, label: 'Inbox hints', desc: 'Notify agent of unread messages and reply guidance' },
                { key: 'context_warning' as const, label: 'Context warning', desc: 'Warn agent when approaching token limit' },
                { key: 'idle_reminder' as const, label: 'Idle reminder', desc: 'Remind agent to call sys_set_state idle when done working' },
                { key: 'mesh_updates' as const, label: 'Mesh updates', desc: 'Notify agent when other agents join or leave the mesh' }
              ]).map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={local.context?.dynamic_instructions?.[key] !== false}
                    onChange={(e) => {
                      const current = local.context?.dynamic_instructions ?? {}
                      save({
                        ...local,
                        context: {
                          ...local.context,
                          dynamic_instructions: { ...current, [key]: e.target.checked }
                        }
                      })
                    }}
                    className="rounded"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Per-turn hints injected alongside the system prompt. Disable to reduce noise in the loop.
            </p>
          </Field>
          <Field label="Audit Control">
            <div className="space-y-1">
              {(['loop', 'inbox', 'outbox', 'files'] as const).map((key) => (
                <label key={key} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={local.context?.audit?.[key] ?? false}
                    onChange={(e) => {
                      const current = local.context?.audit ?? { loop: false, inbox: false, outbox: false, files: false }
                      save({
                        ...local,
                        context: {
                          ...local.context,
                          audit: { ...current, [key]: e.target.checked }
                        }
                      })
                    }}
                    className="rounded"
                  />
                  <span className="capitalize">{key}</span>
                </label>
              ))}
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              When enabled, data is compressed and saved to the audit log before clearing or deleting.
            </p>
          </Field>
        </Section>

        {/* Tools */}
        <Section title="Tools" locked={isSectionLocked('tools')} onToggleLock={() => toggleSectionLock('tools')} summary={`${local.tools.filter(t => t.enabled).length}/${local.tools.length} enabled`}>
          {/* Column legend */}
          <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mb-1">
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="inline -mt-px mr-0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            restricted — authorized callers only. Enable + restrict for HIL. Agent can't toggle restricted. Visible controls the active LLM tool list.
          </p>
          <div className="space-y-1.5">
            {TOOL_GROUPS.map((group, gi) => {
              const groupTools = local.tools.filter((t) => group.tools.has(t.name))
              if (groupTools.length === 0) return null

              // Determine group-level disabled state
              const isMessaging = group.label === 'Messaging'
              const isInbox = group.label === 'Inbox'
              const isTurn = group.label === 'Turn'
              const groupDisabled = (isMessaging && !(local.triggers as TriggersConfigV3)?.on_inbox?.enabled) ||
                (isInbox && !(local.messaging?.inbox_mode === true))

              return (
                <div key={group.label}>
                  {gi > 0 && <div className="border-t border-neutral-200 dark:border-neutral-700 my-1" />}
                  <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-0.5">
                    {group.label}
                    {group.note && <span className="ml-1 italic">({group.note})</span>}
                  </p>
                  {groupTools.map((tool) => {
                    const i = local.tools.findIndex((t) => t.name === tool.name)
                    const disabled = groupDisabled
                    const showRestricted = !isTurn
                    const isRestricted = tool.restricted ?? false
                    const isLocked = tool.locked ?? false

                    return (
                      <div key={tool.name}>
                        <div
                          className={`group flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${isLocked ? 'bg-amber-50/60 dark:bg-amber-900/10 border-l-2 border-amber-400 dark:border-amber-600' : isRestricted ? 'bg-violet-50/60 dark:bg-violet-900/10 border-l-2 border-violet-400 dark:border-violet-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'} ${disabled ? 'cursor-not-allowed' : ''}`}
                        >
                          <span
                            className={`font-mono cursor-pointer hover:underline truncate ${disabled ? 'text-neutral-400 dark:text-neutral-500 hover:text-blue-400' : 'text-neutral-700 dark:text-neutral-300 hover:text-blue-500 dark:hover:text-blue-400'}`}
                            onClick={() => setViewingTool(tool.name)}
                          >
                            {tool.name}
                          </span>
                          <span className="flex items-center gap-3 shrink-0">
                            {/* Per-tool lock: visible when locked or on row hover */}
                            <button
                              className={`transition-colors ${isLocked ? 'text-amber-500 dark:text-amber-400' : 'opacity-0 group-hover:opacity-100 text-neutral-300 dark:text-neutral-600 hover:!text-neutral-400 dark:hover:!text-neutral-500'}`}
                              title={isLocked ? 'Locked: agent cannot modify this tool. Click to unlock.' : 'Unlocked: agent can modify this tool. Click to lock.'}
                              onClick={() => {
                                const tools = [...local.tools]
                                tools[i] = { ...tools[i], locked: !isLocked || undefined }
                                save({ ...local, tools })
                              }}
                            >
                              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                {isLocked ? (
                                  <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>
                                ) : (
                                  <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></>
                                )}
                              </svg>
                            </button>
                            {showRestricted ? (
                              <button
                                className={`flex items-center justify-center rounded transition-colors ${isRestricted ? 'text-violet-600 dark:text-violet-400' : 'text-neutral-300 dark:text-neutral-600 hover:text-neutral-400 dark:hover:text-neutral-500'}`}
                                title="Restricted: requires trust. Only authorized code can call directly. If enabled, agent calls require human approval."
                                onClick={() => {
                                  const tools = [...local.tools]
                                  tools[i] = { ...tools[i], restricted: !isRestricted || undefined }
                                  save({ ...local, tools })
                                }}
                              >
                                <svg width={14} height={14} viewBox="0 0 24 24" fill={isRestricted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                </svg>
                              </button>
                            ) : (
                              <span className="w-[14px]" />
                            )}
                            <ToolVisibilityToggle
                              visible={tool.enabled && tool.visible}
                              disabled={!tool.enabled || disabled || isLocked}
                              onToggle={() => {
                                const tools = [...local.tools]
                                tools[i] = { ...tools[i], visible: !tool.visible }
                                save({ ...local, tools })
                              }}
                            />
                            <input
                              type="checkbox"
                              title="Enabled: allowed to be used by the runtime and lambdas."
                              checked={disabled ? false : tool.enabled}
                              disabled={disabled || isLocked}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                const tools = [...local.tools]
                                tools[i] = { ...tools[i], enabled, visible: enabled ? true : tools[i].visible }
                                save({ ...local, tools })
                              }}
                            />
                          </span>
                        </div>
                        {tool.name === 'ask' && tool.enabled && local.autonomous && (
                          <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5 ml-1">
                            Enabling ask in autonomous mode allows the agent to pause and request human input when critically blocked.
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </Section>

        {/* Code Execution */}
        <Section title="Code Execution" locked={isSectionLocked('code_execution')} onToggleLock={() => toggleSectionLock('code_execution')}>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">
            Methods available to lambdas and sys_code via the adf proxy object.
          </p>
          {/* Column legend */}
          <p className="text-[9px] text-neutral-400 dark:text-neutral-500 mb-0.5">
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="inline -mt-px mr-0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            restricted — authorized callers only. Enable + restrict for HIL. Agent can't toggle restricted.
          </p>
          <div className="space-y-0.5">
            {(Object.keys(CODE_EXECUTION_DEFAULTS) as (keyof CodeExecutionConfig)[])
              .filter((k) => k !== 'network' && k !== 'packages')
              .map((method) => {
              const ce = { ...CODE_EXECUTION_DEFAULTS, ...local.code_execution }
              const enabled = ce[method]
              const isRestricted = local.code_execution?.restricted_methods?.includes(method) ?? false
              return (
                <div
                  key={method}
                  className={`flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${isRestricted ? 'bg-violet-50/60 dark:bg-violet-900/10 border-l-2 border-violet-400 dark:border-violet-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'}`}
                >
                  <span
                    className="font-mono cursor-pointer hover:underline text-neutral-700 dark:text-neutral-300 hover:text-blue-500 dark:hover:text-blue-400"
                    onClick={() => setViewingTool(method)}
                  >
                    {method}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <button
                      className={`flex items-center justify-center rounded transition-colors ${isRestricted ? 'text-violet-600 dark:text-violet-400' : 'text-neutral-300 dark:text-neutral-600 hover:text-neutral-400 dark:hover:text-neutral-500'}`}
                      title="Restricted: only callable from authorized files."
                      onClick={() => {
                        const rm = local.code_execution?.restricted_methods ?? []
                        const updated = isRestricted
                          ? rm.filter(m => m !== method)
                          : [...rm, method]
                        save({
                          ...local,
                          code_execution: { ...ce, restricted_methods: updated.length > 0 ? updated : undefined }
                        })
                      }}
                    >
                      <svg width={14} height={14} viewBox="0 0 24 24" fill={isRestricted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                    </button>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        save({
                          ...local,
                          code_execution: { ...ce, [method]: e.target.checked }
                        })
                      }}
                    />
                  </span>
                </div>
              )
            })}
          </div>
          <div className="border-t border-neutral-200 dark:border-neutral-700" />
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">
            Sandbox permissions
          </p>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50">
              <div>
                <span className="font-mono text-neutral-700 dark:text-neutral-300">network</span>
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                  Allow fetch/http/https in code execution
                </p>
              </div>
              <input
                type="checkbox"
                checked={local.code_execution?.network ?? CODE_EXECUTION_DEFAULTS.network ?? false}
                onChange={(e) => {
                  const ce = { ...CODE_EXECUTION_DEFAULTS, ...local.code_execution }
                  save({
                    ...local,
                    code_execution: { ...ce, network: e.target.checked }
                  })
                }}
              />
            </div>
          </div>
          <div className="border-t border-neutral-200 dark:border-neutral-700" />
          <Field label="Execution timeout (seconds)">
            <div className="flex items-center gap-2">
              <NumberInput
                min={1}
                step={1}
                value={Math.round((local.limits?.execution_timeout_ms ?? 5000) / 1000)}
                onChange={(v) =>
                  save({
                    ...local,
                    limits: { ...local.limits, execution_timeout_ms: v * 1000 }
                  })
                }
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {Math.round((local.limits?.execution_timeout_ms ?? 5000) / 1000)}s
              </span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Max time for sys_code and sys_lambda. Minimum 1 second.
            </p>
          </Field>
          {/* Installed packages */}
          {(local.code_execution?.packages?.length ?? 0) > 0 && (
            <>
              <div className="border-t border-neutral-200 dark:border-neutral-700" />
              <div>
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">
                  Installed packages ({local.code_execution!.packages!.length})
                </p>
                <div className="space-y-0.5">
                  {local.code_execution!.packages!.map((pkg) => (
                    <div
                      key={pkg.name}
                      className="flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50"
                    >
                      <span className="font-mono text-neutral-700 dark:text-neutral-300">
                        {pkg.name}<span className="text-neutral-400 dark:text-neutral-500">@{pkg.version}</span>
                      </span>
                      <button
                        onClick={() => {
                          const updated = local.code_execution!.packages!.filter((p) => p.name !== pkg.name)
                          save({
                            ...local,
                            code_execution: { ...local.code_execution!, packages: updated }
                          })
                        }}
                        className="text-[10px] text-red-400 hover:text-red-600 px-1"
                        title="Remove package"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Section>

        {/* Compute */}
        <Section title="Compute" locked={isSectionLocked('compute')} onToggleLock={() => toggleSectionLock('compute')}>
          <div className="space-y-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={local.compute?.enabled ?? false}
                onChange={(e) => {
                  save({
                    ...local,
                    compute: { ...local.compute, enabled: e.target.checked }
                  })
                }}
                className="rounded text-blue-500"
              />
              <span className="text-xs text-neutral-600 dark:text-neutral-300">Isolated container</span>
            </label>
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400 ml-5">
              When enabled, this agent's MCP servers run in a dedicated container instead of the shared one. Provides isolation between agents.
            </p>

            <label className="flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                checked={local.compute?.host_access ?? false}
                onChange={(e) => {
                  save({
                    ...local,
                    compute: { ...local.compute, enabled: local.compute?.enabled ?? false, host_access: e.target.checked }
                  })
                }}
                className="rounded text-blue-500"
              />
              <span className="text-xs text-neutral-600 dark:text-neutral-300">Allow host access</span>
            </label>
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400 ml-5">
              When enabled, the agent can install and run MCP servers directly on the host machine.
            </p>
            {(local.compute?.host_access && !runtimeHostEnabled) && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 ml-5 mt-1">
                Host access must also be enabled in Settings &gt; Compute to take effect at runtime.
              </p>
            )}

            {/* Per-server execution location */}
            {(local.mcp?.servers ?? []).length > 0 && (() => {
              const hasIsolated = local.compute?.enabled ?? false
              const hasHost = (local.compute?.host_access ?? false) && runtimeHostEnabled
              // Build ordered list of available locations
              const availableLocations: ('Isolated' | 'Shared' | 'Host')[] = []
              if (hasIsolated) availableLocations.push('Isolated')
              availableLocations.push('Shared')
              if (hasHost) availableLocations.push('Host')
              const canCycle = availableLocations.length > 1

              return (
                <div className="mt-2">
                  <h4 className="text-[10px] font-medium text-neutral-600 dark:text-neutral-400 mb-1">MCP Server Execution</h4>
                  <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">
                    {canCycle ? 'Click to change where each server runs. Restart agent to apply.' : 'All servers run in the shared container.'}
                  </p>
                  <div className="space-y-1">
                    {(local.mcp?.servers ?? []).map((s) => {
                      // Resolve display location from run_location (with legacy host_requested fallback)
                      const effectiveRL = s.run_location ?? (s.host_requested ? 'host' : undefined)
                      let location: 'Isolated' | 'Shared' | 'Host'
                      if (effectiveRL === 'host' && hasHost) location = 'Host'
                      else if (effectiveRL === 'shared' || !hasIsolated) location = 'Shared'
                      else location = 'Isolated'

                      const colorClass = location === 'Host'
                        ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                        : location === 'Isolated'
                          ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                          : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      return (
                        <div key={s.name} className="flex items-center justify-between py-1 px-2 rounded bg-neutral-100 dark:bg-neutral-900/50">
                          <span className="text-xs text-neutral-700 dark:text-neutral-300 font-mono">{s.name}</span>
                          <button
                            className={`text-[10px] px-2 py-0.5 rounded ${canCycle ? 'cursor-pointer hover:opacity-80' : 'cursor-default'} ${colorClass}`}
                            disabled={!canCycle}
                            onClick={async () => {
                              if (!canCycle) return
                              // Cycle to next available location
                              const currentIdx = availableLocations.indexOf(location)
                              const nextLocation = availableLocations[(currentIdx + 1) % availableLocations.length]
                              // Map display location to run_location value
                              const newRunLocation: 'host' | 'shared' | undefined =
                                nextLocation === 'Host' ? 'host' :
                                nextLocation === 'Shared' ? 'shared' :
                                undefined  // Isolated = default when compute.enabled

                              const updated = { ...local }
                              const servers = [...(updated.mcp?.servers ?? [])]
                              const idx = servers.findIndex((srv) => srv.name === s.name)
                              if (idx >= 0) {
                                const { host_requested: _, ...rest } = servers[idx]
                                servers[idx] = { ...rest, run_location: newRunLocation }
                                updated.mcp = { ...updated.mcp!, servers }
                                save(updated)

                                // Auto-update Settings host approval list
                                try {
                                  const allSettings = await window.adfApi?.getSettings()
                                  const compute = { ...(allSettings?.compute ?? {}) } as Record<string, unknown>
                                  const approved = [...((compute.hostApproved as string[]) ?? [])]
                                  if (newRunLocation === 'host' && !approved.includes(s.name)) {
                                    approved.push(s.name)
                                  } else if (newRunLocation !== 'host') {
                                    const i = approved.indexOf(s.name)
                                    if (i >= 0) approved.splice(i, 1)
                                  }
                                  compute.hostApproved = approved
                                  await window.adfApi?.setSettings({ compute })
                                } catch { /* settings update is best-effort */ }
                              }
                            }}
                            title={canCycle ? `Running on ${location.toLowerCase()}. Click to cycle.` : `Running on ${location.toLowerCase()}.`}
                          >{location}</button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}

            {local.compute?.enabled && (
              <>

                {/* Packages */}
                <div className="mt-2">
                  <h4 className="text-[10px] font-medium text-neutral-600 dark:text-neutral-400 mb-1">Packages (pre-installed on start)</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] text-neutral-500 dark:text-neutral-400">npm</span>
                      <div className="text-xs text-neutral-600 dark:text-neutral-400 font-mono">
                        {(local.compute?.packages?.npm ?? []).length > 0
                          ? (local.compute!.packages!.npm!).join(', ')
                          : <span className="italic text-neutral-400 dark:text-neutral-500">none</span>}
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] text-neutral-500 dark:text-neutral-400">pip</span>
                      <div className="text-xs text-neutral-600 dark:text-neutral-400 font-mono">
                        {(local.compute?.packages?.pip ?? []).length > 0
                          ? (local.compute!.packages!.pip!).join(', ')
                          : <span className="italic text-neutral-400 dark:text-neutral-500">none</span>}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </Section>

        {/* MCP Servers */}
        {(() => {
          const validRegistrations = mcpRegistrations.filter((r) => r.name)
          const registeredNames = new Set(validRegistrations.map((r) => r.name))
          const attachedNames = new Set((local.mcp?.servers ?? []).map((s) => s.name))
          const myServers = local.mcp?.servers ?? []
          // Unattached registry servers available to add
          const availableToAdd = validRegistrations.filter((r) => !attachedNames.has(r.name))
          // Servers attached to this agent but missing from the app-level runtime
          const orphanedServers = myServers.filter((s) => !registeredNames.has(s.name))
          const hasAnything = myServers.length > 0 || availableToAdd.length > 0

          if (!hasAnything) return null

          // Seed a new app-level registration from the agent's server config so
          // the user can fill in shared credentials in Settings.
          const handleAddToRuntime = async (srv: typeof myServers[0]) => {
            const appKeys: string[] = []
            const schema = srv.env_schema ?? []
            for (const entry of schema) {
              if (entry.scope === 'app' && entry.key) appKeys.push(entry.key)
            }
            // Legacy fallback: if no schema, we don't know scope — seed env_keys
            // as empty app entries so the user can decide in Settings.
            if (!schema.length && srv.env_keys?.length) {
              for (const k of srv.env_keys) appKeys.push(k)
            }

            const regType: 'npm' | 'uvx' | 'custom' | 'http' = srv.transport === 'http'
              ? 'http'
              : srv.npm_package
              ? 'npm'
              : srv.pypi_package ? 'uvx' : 'custom'

            const reg: McpServerRegistration = {
              id: 'mcp:' + Math.random().toString(36).slice(2, 8),
              name: srv.name,
              type: regType,
              ...(srv.npm_package ? { npmPackage: srv.npm_package } : {}),
              ...(srv.pypi_package ? { pypiPackage: srv.pypi_package } : {}),
              ...(srv.command ? { command: srv.command } : {}),
              ...(srv.args?.length ? { args: [...srv.args] } : {}),
              ...(srv.url ? { url: srv.url } : {}),
              ...(srv.headers ? { headers: Object.entries(srv.headers).map(([key, value]) => ({ key, value })) } : {}),
              ...(srv.header_env?.length ? { headerEnv: srv.header_env.map((entry) => ({ key: entry.header, value: entry.env })) } : {}),
              ...(srv.bearer_token_env_var ? { bearerTokenEnvVar: srv.bearer_token_env_var } : {}),
              env: appKeys.map((k) => ({ key: k, value: '' })),
            }

            const currentSettings = await window.adfApi?.getSettings()
            const existingServers = (currentSettings?.mcpServers as McpServerRegistration[]) ?? []
            if (existingServers.some((r) => r.name === srv.name)) return
            await window.adfApi?.setSettings({
              mcpServers: [...existingServers, reg],
            })
            invalidateConfigCaches()
            _cachedMcpRegistrations = [...existingServers, reg]
            setMcpRegistrations(_cachedMcpRegistrations)
          }

          // Remove a server and its tools
          const handleRemoveServer = (serverName: string) => {
            if (!window.confirm(`Remove "${serverName}"? Its tools will be removed from this agent.`)) return
            const servers = myServers.filter((s) => s.name !== serverName)
            const toolPrefix = `mcp_${serverName}_`
            const tools = local.tools.filter((t) => !t.name.startsWith(toolPrefix))
            // Clean up identity entries
            window.adfApi?.deleteIdentityByPrefix(`mcp:${serverName}:`)
            save({ ...local, mcp: servers.length > 0 ? { servers } : undefined, tools })
          }

          // Add a server from the registry
          const handleAddFromRegistry = (reg: typeof validRegistrations[0]) => {
            const serverCfg = buildMcpServerConfigFromRegistration(reg)
            const servers = [...myServers, serverCfg]
            save({ ...local, mcp: { servers } })
          }

          return (
            <Section title="MCP Servers" locked={isSectionLocked('mcp')} onToggleLock={() => toggleSectionLock('mcp')}>
              <div className="space-y-3">
                {/* My Servers — from config.mcp.servers */}
                {myServers.map((srv) => {
                  const cachedTools = srv.available_tools ?? []
                  const sourceBadge = srv.transport === 'http' || srv.source?.startsWith('http:')
                    ? 'http'
                    : srv.source?.startsWith('npm:') ? 'npm' : srv.source?.startsWith('uvx:') ? 'uvx' : srv.source === 'custom' ? 'custom' : srv.npm_package ? 'npm' : srv.pypi_package ? 'uvx' : 'custom'

                  return (
                    <div key={srv.name} className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-2 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-1.5">
                          {srv.name}
                          <span className="text-[9px] px-1 py-0.5 bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 rounded">{sourceBadge}</span>
                        </span>
                        <button
                          onClick={() => handleRemoveServer(srv.name)}
                          className="text-[10px] text-red-400 hover:text-red-600 font-medium"
                        >Remove</button>
                      </div>
                      {srv.npm_package && (
                        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">{srv.npm_package}</p>
                      )}
                      {srv.pypi_package && (
                        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">{srv.pypi_package}</p>
                      )}
                      {srv.url && (
                        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">{srv.url}</p>
                      )}
                      {cachedTools.length > 0 ? (
                        <div className="pl-2 space-y-1">
                          {cachedTools.map((ct) => {
                            const toolName = `mcp_${srv.name}_${ct.name}`
                            const toolDecl = local.tools.find((t) => t.name === toolName)
                            if (!toolDecl) return null
                            const ti = local.tools.findIndex((t) => t.name === toolName)

                            const mcpRestricted = toolDecl.restricted ?? false

                            return (
                              <div key={toolName} className={`flex items-center justify-between text-xs px-1.5 py-0.5 -mx-1.5 rounded ${mcpRestricted ? 'bg-violet-50/60 dark:bg-violet-900/10 border-l-2 border-violet-400 dark:border-violet-600' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/50'}`}>
                                <span
                                  className="font-mono text-neutral-600 dark:text-neutral-400 text-[10px] truncate cursor-pointer hover:text-blue-500 dark:hover:text-blue-400 hover:underline"
                                  onClick={() => {
                                    setToolDefs((prev) => ({ ...prev, [ct.name]: { name: ct.name, description: ct.description, input_schema: ct.input_schema } }))
                                    setViewingTool(ct.name)
                                  }}
                                >
                                  {ct.name}
                                </span>
                                <span className="flex items-center gap-3 shrink-0">
                                  <button
                                    className={`flex items-center justify-center rounded transition-colors ${mcpRestricted ? 'text-violet-600 dark:text-violet-400' : 'text-neutral-300 dark:text-neutral-600 hover:text-neutral-400 dark:hover:text-neutral-500'}`}
                                    title="Restricted: requires trust. Only authorized code can call directly. If enabled, agent calls require human approval."
                                    onClick={() => {
                                      const tools = [...local.tools]
                                      tools[ti] = { ...tools[ti], restricted: !mcpRestricted || undefined }
                                      save({ ...local, tools })
                                    }}
                                  >
                                    <svg width={14} height={14} viewBox="0 0 24 24" fill={mcpRestricted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                    </svg>
                                  </button>
                                  <ToolVisibilityToggle
                                    visible={toolDecl.enabled && toolDecl.visible}
                                    disabled={!toolDecl.enabled}
                                    onToggle={() => {
                                      const tools = [...local.tools]
                                      tools[ti] = { ...tools[ti], visible: !toolDecl.visible }
                                      save({ ...local, tools })
                                    }}
                                  />
                                  <input
                                    type="checkbox"
                                    title="Enabled: allowed to be used by the runtime and lambdas."
                                    checked={toolDecl.enabled}
                                    onChange={(e) => {
                                      const enabled = e.target.checked
                                      const tools = [...local.tools]
                                      tools[ti] = { ...tools[ti], enabled, visible: enabled ? true : tools[ti].visible }
                                      save({ ...local, tools })
                                    }}
                                  />
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 pl-2">
                          Tools will be discovered when the agent connects.
                        </p>
                      )}
                    </div>
                  )
                })}

                {myServers.length === 0 && (
                  <p className="text-[10px] text-neutral-400 dark:text-neutral-500 italic">
                    No MCP servers configured. Add from the registry below or use the mcp_install tool.
                  </p>
                )}

                {/* Servers attached to the agent but not registered in this runtime */}
                {orphanedServers.length > 0 && (
                  <div className="pt-2 border-t border-amber-200 dark:border-amber-800">
                    <label className="text-[10px] text-amber-700 dark:text-amber-400 block mb-1 font-medium">
                      Not registered in this runtime
                    </label>
                    <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mb-1.5">
                      These servers exist on the agent but have no app-level registration,
                      so they can't start. Add them to the runtime to configure credentials.
                    </p>
                    <div className="space-y-1.5">
                      {orphanedServers.map((srv) => {
                        const schema = srv.env_schema ?? []
                        const appKeys = schema.filter((e) => e.scope === 'app').map((e) => e.key)
                        const agentKeys = schema.filter((e) => e.scope === 'agent').map((e) => e.key)
                        const legacyKeys = !schema.length ? (srv.env_keys ?? []) : []
                        return (
                          <div key={srv.name} className="border border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-900/10 rounded p-1.5 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-neutral-700 dark:text-neutral-200 truncate">{srv.name}</div>
                              {(srv.npm_package || srv.pypi_package || srv.command) && (
                                <div className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">
                                  {srv.npm_package ?? srv.pypi_package ?? srv.command}
                                </div>
                              )}
                              {(appKeys.length > 0 || agentKeys.length > 0 || legacyKeys.length > 0) && (
                                <div className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                                  {appKeys.length > 0 && <>App: <span className="font-mono">{appKeys.join(', ')}</span></>}
                                  {appKeys.length > 0 && agentKeys.length > 0 && ' · '}
                                  {agentKeys.length > 0 && <>Agent: <span className="font-mono">{agentKeys.join(', ')}</span></>}
                                  {legacyKeys.length > 0 && <>Keys: <span className="font-mono">{legacyKeys.join(', ')}</span></>}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => handleAddToRuntime(srv)}
                              className="text-[11px] px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-medium shrink-0"
                            >Add to runtime</button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Add from registry */}
                {availableToAdd.length > 0 && (
                  <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
                    <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">Add from runtime</label>
                    <select
                      className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
                      value=""
                      onChange={(e) => {
                        const reg = availableToAdd.find((r) => r.name === e.target.value)
                        if (reg) handleAddFromRegistry(reg)
                      }}
                    >
                      <option value="">Select a server to add...</option>
                      {availableToAdd.map((reg) => (
                        <option key={reg.id} value={reg.name}>
                          {reg.name} ({reg.type ?? 'npm'}{reg.npmPackage ? `: ${reg.npmPackage}` : reg.pypiPackage ? `: ${reg.pypiPackage}` : ''})
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
                      Servers from your runtime registry. App-wide credentials are inherited automatically.
                    </p>
                  </div>
                )}
              </div>
            </Section>
          )
        })()}

        {/* Channel Adapters */}
        {adapterRegistrations.length > 0 && (
          <Section title="Channel Adapters">
            <div className="space-y-3">
              {adapterRegistrations.map((reg) => {
                const adapterConfig = local.adapters?.[reg.type]
                const enabled = adapterConfig?.enabled ?? false
                const registryEntry = findAdapterRegistryEntry(reg.type)
                const hasKeys = adapterWithKeys.has(reg.type)
                const agentKeys = adapterIdentityKeys[reg.type]
                const hasEmptyRequiredKeys = (registryEntry?.requiredEnvKeys ?? []).some((rk) => {
                  // Satisfied if the agent has this key in adf_identity…
                  if (agentKeys?.has(rk)) return false
                  // …or the app-level registration carries a non-empty value.
                  const envEntry = (reg.env ?? []).find((e) => e.key === rk)
                  return !envEntry || !envEntry.value
                })

                const handleEnable = async () => {
                  // Copy app-level credentials to identity keystore
                  const identityPrefix = `adapter:${reg.type}:`
                  for (const e of reg.env ?? []) {
                    if (e.key && e.value) {
                      await window.adfApi?.setIdentity(`${identityPrefix}${e.key}`, e.value)
                    }
                  }

                  const newConfig: AdapterInstanceConfig = {
                    enabled: true,
                    policy: { dm: 'all', groups: 'mention' }
                  }
                  const adapters = { ...(local.adapters ?? {}), [reg.type]: newConfig }
                  save({ ...local, adapters })
                }

                const handleDisable = () => {
                  const msg = hasKeys
                    ? `Disable "${registryEntry?.displayName ?? reg.type}"? Its stored credentials in this ADF will also be deleted.`
                    : `Disable "${registryEntry?.displayName ?? reg.type}"?`
                  if (!window.confirm(msg)) return

                  // Clean up identity keys
                  window.adfApi?.deleteIdentityByPrefix(`adapter:${reg.type}:`)

                  const adapters = { ...(local.adapters ?? {}) }
                  delete adapters[reg.type]
                  save({ ...local, adapters: Object.keys(adapters).length > 0 ? adapters : undefined })
                }

                return (
                  <div key={reg.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-2 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-1.5">
                        {registryEntry?.displayName ?? reg.type}
                        {hasKeys && (
                          <span
                            className="text-[9px] text-amber-600 dark:text-amber-400"
                            title="Credentials stored in this ADF"
                          >
                            <svg className="inline w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 0a4.5 4.5 0 0 0-4.2 6.1L0 13.4V16h2.6l.7-.7v-1.7h1.7l.7-.7v-1.7h1.7l1-1 .7.3a4.5 4.5 0 1 0 2.4-9.5zm1 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
                          </span>
                        )}
                        {hasEmptyRequiredKeys && (
                          <span className="text-[9px] px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 rounded font-medium">
                            Needs keys
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        {enabled ? (
                          <button
                            onClick={handleDisable}
                            className="text-[10px] text-red-400 hover:text-red-600 font-medium"
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            onClick={handleEnable}
                            className="text-[10px] text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 font-medium"
                          >
                            Enable
                          </button>
                        )}
                      </span>
                    </div>
                    <p className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono truncate">
                      {reg.type}
                    </p>
                    {enabled && adapterConfig && reg.type === 'email' && (
                      <div className="pl-2 space-y-1.5 pt-1 border-t border-neutral-100 dark:border-neutral-700">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-500 dark:text-neutral-400">Account</span>
                          <span className="text-neutral-700 dark:text-neutral-200 font-mono text-[10px] truncate ml-2">
                            {emailAccount || reg.env?.find(e => e.key === 'EMAIL_USERNAME')?.value || '—'}
                          </span>
                        </div>
                      </div>
                    )}
                    {enabled && adapterConfig && reg.type !== 'email' && (
                      <div className="pl-2 space-y-1.5 pt-1 border-t border-neutral-100 dark:border-neutral-700">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-500 dark:text-neutral-400">DM mode</span>
                          <select
                            value={adapterConfig.policy?.dm ?? 'all'}
                            onChange={(e) => {
                              const adapters = { ...(local.adapters ?? {}) }
                              adapters[reg.type] = {
                                ...adapters[reg.type],
                                policy: { ...(adapters[reg.type]?.policy ?? {}), dm: e.target.value as 'all' | 'allowlist' | 'none' }
                              }
                              save({ ...local, adapters })
                            }}
                            className="text-[10px] px-1.5 py-0.5 border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                          >
                            <option value="all">All</option>
                            <option value="allowlist">Allowlist</option>
                            <option value="none">None</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-neutral-500 dark:text-neutral-400">Group mode</span>
                          <select
                            value={adapterConfig.policy?.groups ?? 'mention'}
                            onChange={(e) => {
                              const adapters = { ...(local.adapters ?? {}) }
                              adapters[reg.type] = {
                                ...adapters[reg.type],
                                policy: { ...(adapters[reg.type]?.policy ?? {}), groups: e.target.value as 'all' | 'mention' | 'none' }
                              }
                              save({ ...local, adapters })
                            }}
                            className="text-[10px] px-1.5 py-0.5 border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                          >
                            <option value="all">All</option>
                            <option value="mention">Mention only</option>
                            <option value="none">None</option>
                          </select>
                        </div>
                      </div>
                    )}
                    {!enabled && (
                      <p className="text-[10px] text-neutral-400 dark:text-neutral-500 pl-2">
                        Not enabled
                      </p>
                    )}
                    {hasEmptyRequiredKeys && (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400 pl-2">
                        Missing required credentials — configure in Settings
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-2">
              Configure channel adapters in Settings. Enable them here to bridge external messages.
            </p>
          </Section>
        )}

        {/* Messaging */}
        <Section title="Messaging" locked={isSectionLocked('messaging')} onToggleLock={() => toggleSectionLock('messaging')} summary={local.messaging?.receive ? `${local.messaging?.visibility ?? 'localhost'} · ${local.messaging?.mode ?? 'respond_only'}${local.messaging?.inbox_mode ? ' · inbox' : ''}` : 'off'}>
          <label className="flex items-center justify-between text-xs">
            <span className="text-neutral-700 dark:text-neutral-300">Receive messages</span>
            <input
              type="checkbox"
              checked={local.messaging?.receive ?? false}
              onChange={(e) => {
                const receive = e.target.checked
                const ALL_MSG_TOOLS = new Set([...MESSAGING_TOOLS, ...INBOX_TOOLS])
                save({
                  ...local,
                  messaging: {
                    ...(local.messaging ?? { receive: false, mode: 'respond_only' as const }),
                    receive
                  },
                  tools: local.tools.map((t) =>
                    ALL_MSG_TOOLS.has(t.name) ? { ...t, enabled: receive ? t.enabled : false, visible: receive ? t.visible : false } : t
                  )
                })
              }}
            />
          </label>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
            Whether this agent participates in the mesh and can receive messages from other agents.
          </p>
          {local.messaging?.receive && (
            <>
              <label className="flex items-center justify-between text-xs mt-2">
                <span className="text-neutral-700 dark:text-neutral-300">Inbox mode</span>
                <input
                  type="checkbox"
                  checked={local.messaging?.inbox_mode ?? false}
                  onChange={(e) => {
                    const inboxMode = e.target.checked
                    save({
                      ...local,
                      messaging: {
                        ...(local.messaging ?? { receive: false, mode: 'respond_only' as const }),
                        inbox_mode: inboxMode
                      },
                      tools: local.tools.map((t) =>
                        INBOX_TOOLS.has(t.name) ? { ...t, enabled: inboxMode, visible: inboxMode } : t
                      )
                    })
                  }}
                />
              </label>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {local.messaging?.inbox_mode
                  ? (local.autonomous
                      ? 'Messages are stored in an inbox. The agent is notified immediately when new messages arrive.'
                      : 'Messages are stored in an inbox. The agent is notified on a periodic schedule when idle.')
                  : 'Messages trigger the agent immediately (default behavior).'}
              </p>
              <Field label="Allow list">
                <DidListPicker
                  dids={local.messaging?.allow_list ?? []}
                  knownAgents={knownAgents}
                  inputValue={allowListInput}
                  onInputChange={setAllowListInput}
                  dropdownOpen={allowListDropdown}
                  onDropdownChange={setAllowListDropdown}
                  onChange={(dids) => save({
                    ...local,
                    messaging: {
                      ...local.messaging!,
                      allow_list: dids.length > 0 ? dids : undefined
                    }
                  })}
                  placeholder={knownAgents.length > 0
                    ? 'Search known agents...'
                    : 'Paste a DID (did:key:...) or discover agents first'}
                />
              </Field>
              <Field label="Block list">
                <DidListPicker
                  dids={local.messaging?.block_list ?? []}
                  knownAgents={knownAgents}
                  inputValue={blockListInput}
                  onInputChange={setBlockListInput}
                  dropdownOpen={blockListDropdown}
                  onDropdownChange={setBlockListDropdown}
                  onChange={(dids) => save({
                    ...local,
                    messaging: {
                      ...local.messaging!,
                      block_list: dids.length > 0 ? dids : undefined
                    }
                  })}
                  placeholder={knownAgents.length > 0
                    ? 'Search known agents...'
                    : 'Paste a DID (did:key:...) or discover agents first'}
                />
              </Field>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                Allow list takes priority. If set, only listed DIDs can send/receive. Leave both empty for no restriction.
              </p>
              <Field label="Visibility">
                <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
                  {VISIBILITY_VALUES.map((tier, i) => (
                    <button
                      key={tier}
                      className={`flex-1 px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        (local.messaging?.visibility ?? 'localhost') === tier
                          ? 'bg-blue-500 text-white'
                          : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                      } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
                      onClick={() => {
                        save({
                          ...local,
                          messaging: {
                            ...local.messaging!,
                            visibility: tier
                          }
                        })
                      }}
                    >
                      {tier === 'directory' ? 'Directory' : tier === 'localhost' ? 'Localhost' : tier === 'lan' ? 'LAN' : tier === 'public' ? 'Public' : 'Off'}
                    </button>
                  ))}
                </div>
              </Field>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
                <strong>Directory:</strong> Only ancestor-directory agents on this runtime.{' '}
                <strong>Localhost:</strong> Any agent on this machine.{' '}
                <strong>LAN:</strong> Any agent on the local network (binds 0.0.0.0).{' '}
                <strong>Public:</strong> Any agent reachable over the public internet (binds 0.0.0.0).{' '}
                <strong>Off:</strong> Nobody — no inbound, sends still allowed.
              </p>
              <Field label="Send mode">
                <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
                  {MESSAGING_MODES.map((mode, i) => (
                    <button
                      key={mode}
                      className={`flex-1 px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        (local.messaging?.mode ?? 'respond_only') === mode
                          ? 'bg-blue-500 text-white'
                          : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                      } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
                      onClick={() => {
                        const sendEnabled = mode !== 'listen_only'
                        const listEnabled = mode === 'proactive'
                        save({
                          ...local,
                          messaging: {
                            ...local.messaging!,
                            mode: mode
                          },
                          tools: local.tools.map((t) => {
                            if (t.name === 'msg_send') return { ...t, enabled: sendEnabled, visible: sendEnabled }
                            if (t.name === 'agent_discover') return { ...t, enabled: listEnabled, visible: listEnabled }
                            return t
                          })
                        })
                      }}
                    >
                      {mode === 'respond_only' ? 'Respond Only' : mode === 'proactive' ? 'Proactive' : 'None'}
                    </button>
                  ))}
                </div>
              </Field>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
                <strong>Proactive:</strong> Can send anytime.{' '}
                <strong>Respond Only:</strong> Only when message-triggered.{' '}
                <strong>None:</strong> Listen only.
              </p>
            </>
          )}
        </Section>

        {/* Security */}
        <Section title="Security" locked={isSectionLocked('security')} onToggleLock={() => toggleSectionLock('security')} summary={(['Open', 'Signed', 'Encrypted'] as const)[local.security?.level ?? 0]}>
          <div className="flex items-center justify-between mb-0.5">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Security level</label>
            {!isSectionLocked('security') && (
              <LockButton
                locked={isSectionLocked('security.level')}
                size="xs"
                onClick={() => toggleFieldLock('security.level', ['security.allow_unsigned', 'security.require_signature', 'security.require_payload_signature'])}
              />
            )}
          </div>
          <div className={isSectionLocked('security.level') ? 'opacity-60 pointer-events-none' : ''}>
            <div className="flex rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              {([0, 1, 2] as const).map((lvl, i) => {
                const labels = ['Open', 'Signed', 'Encrypted'] as const
                const currentLevel = local.security?.level ?? 0
                const disabled = lvl === 2
                return (
                  <button
                    key={lvl}
                    disabled={disabled}
                    title={disabled ? 'Coming soon' : undefined}
                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      currentLevel === lvl
                        ? 'bg-blue-500 text-white'
                        : disabled
                          ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
                          : 'bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                    } ${i > 0 ? 'border-l border-neutral-200 dark:border-neutral-700' : ''}`}
                    onClick={() => {
                      if (disabled) return
                      const requireSig = lvl === 0 ? false : (local.security?.require_signature ?? false)
                      const requirePayloadSig = lvl === 0 ? false : (local.security?.require_payload_signature ?? false)
                      save({
                        ...local,
                        security: {
                          ...local.security,
                          level: lvl,
                          allow_unsigned: lvl === 0 ? true : !requireSig,
                          require_signature: requireSig,
                          require_payload_signature: requirePayloadSig
                        }
                      })
                    }}
                  >
                    {labels[lvl]}
                  </button>
                )
              })}
            </div>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
            <strong>Open:</strong> No signing.{' '}
            <strong>Signed:</strong> Messages are cryptographically signed.{' '}
            <strong>Encrypted:</strong> Signed + encrypted (coming soon).
          </p>

          {(local.security?.level ?? 0) >= 1 && !hasSigningKeys && (
            <div className="p-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 mt-2">
              <p className="text-[10px] text-amber-700 dark:text-amber-400">
                <strong>Warning:</strong> Signing requires identity keys. Go to the{' '}
                <button
                  className="underline font-medium hover:text-amber-900 dark:hover:text-amber-300"
                  onClick={() => useAppStore.getState().setAgentSubTab('identity')}
                >
                  Identity tab
                </button>{' '}
                to generate a DID and signing keys.
              </p>
            </div>
          )}

          {(local.security?.level ?? 0) >= 1 && (
            <>
              <label className="flex items-center justify-between text-xs mt-2">
                <span className="text-neutral-700 dark:text-neutral-300">Require message signature</span>
                <input
                  type="checkbox"
                  checked={local.security?.require_signature ?? false}
                  onChange={(e) => {
                    const requireSig = e.target.checked
                    save({
                      ...local,
                      security: {
                        ...local.security,
                        level: local.security?.level ?? 1,
                        allow_unsigned: !requireSig,
                        require_signature: requireSig,
                        require_payload_signature: local.security?.require_payload_signature ?? false
                      }
                    })
                  }}
                />
              </label>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                Reject incoming messages without a valid message signature.
              </p>

              <label className="flex items-center justify-between text-xs mt-2">
                <span className="text-neutral-700 dark:text-neutral-300">Require payload signature</span>
                <input
                  type="checkbox"
                  checked={local.security?.require_payload_signature ?? false}
                  onChange={(e) => {
                    save({
                      ...local,
                      security: {
                        ...local.security,
                        level: local.security?.level ?? 1,
                        allow_unsigned: !(local.security?.require_signature ?? false),
                        require_signature: local.security?.require_signature ?? false,
                        require_payload_signature: e.target.checked
                      }
                    })
                  }}
                />
              </label>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                Reject incoming messages without a valid payload signature.
              </p>
            </>
          )}
          </div>

          {/* Table permissions */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Table Permissions</label>
              {!isSectionLocked('security') && (
                <LockButton
                  locked={isSectionLocked('security.table_protections')}
                  size="xs"
                  onClick={() => toggleFieldLock('security.table_protections')}
                />
              )}
            </div>
            <div className={isSectionLocked('security.table_protections') ? 'opacity-60 pointer-events-none' : ''}>
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
                Limit writes to selected local tables. Unlisted tables allow normal reads and writes.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-1.5 mb-2">
                <select
                  value={newProtectedTable}
                  onChange={(e) => setNewProtectedTable(e.target.value)}
                  className="min-w-0 w-full px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                >
                  <option value="">Select local table</option>
                  {availableTablesForProtection.map((table) => (
                    <option key={table.name} value={table.name}>
                      {table.name} ({table.row_count})
                    </option>
                  ))}
                </select>
                <select
                  value={newTableProtection}
                  onChange={(e) => setNewTableProtection(e.target.value as TableProtectionLevel)}
                  className="w-full sm:w-28 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                >
                  <option value="append_only">Append-only</option>
                  <option value="authorized">Authorized</option>
                </select>
                <button
                  disabled={!newProtectedTable}
                  onClick={() => {
                    if (!newProtectedTable) return
                    setTableProtection(newProtectedTable, newTableProtection)
                    setNewProtectedTable('')
                  }}
                  className="w-full sm:w-auto px-2 py-1 text-xs bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
              {tableProtectionEntries.length > 0 ? (
                <div className="space-y-1">
                  {tableProtectionEntries.map(([table, protection]) => (
                    <div key={table} className="flex flex-wrap sm:flex-nowrap items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-xs font-mono text-neutral-700 dark:text-neutral-300" title={table}>
                        {table}
                      </span>
                      <select
                        value={protection}
                        onChange={(e) => setTableProtection(table, e.target.value as TableProtectionLevel)}
                        className="w-full sm:w-32 min-w-0 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                      >
                        {TABLE_PROTECTION_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level === 'none' ? 'No protection' : level === 'append_only' ? 'Append-only' : 'Authorized'}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setTableProtection(table, 'none')}
                        className="text-xs text-red-400 hover:text-red-600 px-1"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                  No protected local tables.
                </p>
              )}
            </div>
          </div>

          {/* Custom Middleware */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Custom Middleware</label>
              {!isSectionLocked('security') && (
                <LockButton
                  locked={isSectionLocked('security.middleware')}
                  size="xs"
                  onClick={() => toggleFieldLock('security.middleware')}
                />
              )}
            </div>
            <div className={isSectionLocked('security.middleware') ? 'opacity-60 pointer-events-none' : ''}>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
              Lambda functions executed in order on each message. Format: path/file.ts:functionName
            </p>

            {/* Inbox Middleware */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Inbox</span>
                <button
                  onClick={() => {
                    const mw = [...(local.security?.middleware?.inbox ?? []), { lambda: '' }]
                    save({
                      ...local,
                      security: { ...local.security, middleware: { ...local.security?.middleware, inbox: mw } }
                    })
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  + Add
                </button>
              </div>
              {(local.security?.middleware?.inbox ?? []).map((ref, i) => (
                <div key={i} className="flex gap-1 items-center mb-1">
                  <input
                    type="text"
                    value={ref.lambda}
                    onChange={(e) => {
                      const mw = [...(local.security?.middleware?.inbox ?? [])]
                      mw[i] = { lambda: e.target.value }
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, inbox: mw } }
                      })
                    }}
                    placeholder="lib/middleware.ts:onInbox"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => {
                      const mw = (local.security?.middleware?.inbox ?? []).filter((_, j) => j !== i)
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, inbox: mw.length > 0 ? mw : undefined } }
                      })
                    }}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            {/* Outbox Middleware */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Outbox</span>
                <button
                  onClick={() => {
                    const mw = [...(local.security?.middleware?.outbox ?? []), { lambda: '' }]
                    save({
                      ...local,
                      security: { ...local.security, middleware: { ...local.security?.middleware, outbox: mw } }
                    })
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  + Add
                </button>
              </div>
              {(local.security?.middleware?.outbox ?? []).map((ref, i) => (
                <div key={i} className="flex gap-1 items-center mb-1">
                  <input
                    type="text"
                    value={ref.lambda}
                    onChange={(e) => {
                      const mw = [...(local.security?.middleware?.outbox ?? [])]
                      mw[i] = { lambda: e.target.value }
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, outbox: mw } }
                      })
                    }}
                    placeholder="lib/middleware.ts:onOutbox"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => {
                      const mw = (local.security?.middleware?.outbox ?? []).filter((_, j) => j !== i)
                      save({
                        ...local,
                        security: { ...local.security, middleware: { ...local.security?.middleware, outbox: mw.length > 0 ? mw : undefined } }
                      })
                    }}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            </div>
            {/* Fetch Middleware */}
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Fetch</span>
                  {!isSectionLocked('security') && (
                    <LockButton
                      locked={isSectionLocked('security.fetch_middleware')}
                      size="xs"
                      onClick={() => toggleFieldLock('security.fetch_middleware')}
                    />
                  )}
                </div>
                <button
                  disabled={isSectionLocked('security.fetch_middleware')}
                  onClick={() => {
                    const mw = [...(local.security?.fetch_middleware ?? []), { lambda: '' }]
                    save({
                      ...local,
                      security: { ...local.security, fetch_middleware: mw }
                    })
                  }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                >
                  + Add
                </button>
              </div>
              <div className={isSectionLocked('security.fetch_middleware') ? 'opacity-60 pointer-events-none' : ''}>
              {(local.security?.fetch_middleware ?? []).map((ref, i) => (
                <div key={i} className="flex gap-1 items-center mb-1">
                  <input
                    type="text"
                    value={ref.lambda}
                    onChange={(e) => {
                      const mw = [...(local.security?.fetch_middleware ?? [])]
                      mw[i] = { lambda: e.target.value }
                      save({
                        ...local,
                        security: { ...local.security, fetch_middleware: mw }
                      })
                    }}
                    placeholder="lib/middleware.ts:onFetch"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                  <button
                    onClick={() => {
                      const mw = (local.security?.fetch_middleware ?? []).filter((_, j) => j !== i)
                      save({
                        ...local,
                        security: { ...local.security, fetch_middleware: mw.length > 0 ? mw : undefined }
                      })
                    }}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
              </div>
            </div>
          </div>

          {/* Middleware authorization */}
          <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between gap-2">
              <div>
                <span className="text-xs text-neutral-700 dark:text-neutral-300">Require middleware authorization</span>
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
                  Skip middleware lambdas that are not from authorized files.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {!isSectionLocked('security') && (
                  <LockButton
                    locked={isSectionLocked('security.require_middleware_authorization')}
                    size="xs"
                    onClick={() => toggleFieldLock('security.require_middleware_authorization')}
                  />
                )}
                <input
                  type="checkbox"
                  checked={local.security?.require_middleware_authorization ?? true}
                  disabled={isSectionLocked('security.require_middleware_authorization')}
                  onChange={(e) => {
                    save({
                      ...local,
                      security: { ...local.security, require_middleware_authorization: e.target.checked }
                    })
                  }}
                  className="w-4 h-4 accent-blue-500"
                />
              </div>
            </div>
          </div>
        </Section>

        {/* Triggers */}
        <Section title={<>Triggers <span className="text-[10px] font-normal normal-case tracking-normal text-neutral-400 dark:text-neutral-500 cursor-help select-none" title="Timing modes: Immediate fires instantly. Debounce resets a timer on each event, fires once after events stop. Interval fires the first event, drops others until the interval elapses. Batch collects events in a window, fires once when it expires. Values are in milliseconds.">?</span></>} locked={isSectionLocked('triggers')} onToggleLock={() => toggleSectionLock('triggers')} summary={(() => { const t = local.triggers as TriggersConfigV3 | undefined; if (!t) return 'none'; const active = Object.values(t).filter((v: any) => v?.enabled).length; return `${active} active`; })()}>
          <Field label="Hibernate nudge">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={local.limits?.hibernate_nudge?.enabled ?? true}
                  onChange={(e) => {
                    save({
                      ...local,
                      limits: {
                        ...local.limits,
                        hibernate_nudge: {
                          enabled: e.target.checked,
                          interval_ms: local.limits?.hibernate_nudge?.interval_ms ?? 86_400_000
                        }
                      }
                    })
                  }}
                  className="accent-blue-500"
                />
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">Enabled</span>
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={Math.round((local.limits?.hibernate_nudge?.interval_ms ?? 86_400_000) / 3_600_000)}
                onChange={(e) => {
                  const hours = parseInt(e.target.value)
                  if (isNaN(hours) || hours < 1) return
                  save({
                    ...local,
                    limits: {
                      ...local.limits,
                      hibernate_nudge: {
                        enabled: local.limits?.hibernate_nudge?.enabled ?? true,
                        interval_ms: hours * 3_600_000
                      }
                    }
                  })
                }}
                className="field-input w-16"
                disabled={!(local.limits?.hibernate_nudge?.enabled ?? true)}
              />
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">hours</span>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Ping the agent after this many hours without a trigger while hibernating.
            </p>
          </Field>

          <div className="border-t border-neutral-200 dark:border-neutral-700" />

          {/* Trigger rows — v3 target-based */}
          {([
            { key: 'on_startup' as TriggerTypeV3, label: 'On startup', desc: 'Fires once when the agent starts.' },
            { key: 'on_inbox' as TriggerTypeV3, label: 'On inbox message', desc: 'Fires when a message arrives in the inbox.' },
            { key: 'on_outbox' as TriggerTypeV3, label: 'On outbox message', desc: 'Fires when a message is sent.' },
            { key: 'on_file_change' as TriggerTypeV3, label: 'On file change', desc: 'Fires when a watched file is modified.' },
            { key: 'on_chat' as TriggerTypeV3, label: 'On user chat', desc: 'Fires when the user sends a chat message.' },
            { key: 'on_timer' as TriggerTypeV3, label: 'On timer', desc: 'Kill switch for timer-based triggers.' },
            { key: 'on_tool_call' as TriggerTypeV3, label: 'On tool call', desc: 'Fires after a matching tool executes (observational).' },
            { key: 'on_task_create' as TriggerTypeV3, label: 'On task create', desc: 'Fires when a task is created (HIL approval, async dispatch).' },
            { key: 'on_task_complete' as TriggerTypeV3, label: 'On task complete', desc: 'Fires when a matching async task completes.' },
            { key: 'on_logs' as TriggerTypeV3, label: 'On log entry', desc: 'Fires when a matching log entry is written.' },
            { key: 'on_llm_call' as TriggerTypeV3, label: 'On LLM call', desc: 'Fires after model calls with tokens, latency, model, and cost metadata.' }
          ]).map(({ key, label, desc }) => {
            const triggerCfg: TriggerConfig = (local.triggers as TriggersConfigV3)?.[key] ?? { enabled: false, targets: [] }
            const noTimingTypes: TriggerTypeV3[] = ['on_timer', 'on_startup']
            const showTiming = !noTimingTypes.includes(key)

            const updateTriggerCfg = (patch: Partial<TriggerConfig>) => {
              save({
                ...local,
                triggers: {
                  ...local.triggers,
                  [key]: { ...triggerCfg, ...patch }
                }
              })
            }

            const updateTarget = (idx: number, patch: Partial<TriggerTarget>) => {
              const newTargets = [...(triggerCfg.targets ?? [])]
              newTargets[idx] = { ...newTargets[idx], ...patch }
              updateTriggerCfg({ targets: newTargets })
            }

            const updateTargetFilter = (idx: number, filterPatch: Partial<TriggerFilter>) => {
              const newTargets = [...(triggerCfg.targets ?? [])]
              const existing = newTargets[idx].filter ?? {}
              const merged = { ...existing, ...filterPatch }
              // Remove undefined/empty values
              const cleaned: TriggerFilter = {}
              if (Array.isArray(merged.source) ? merged.source.length : merged.source) cleaned.source = merged.source
              if (merged.sender) cleaned.sender = merged.sender
              if (merged.to) cleaned.to = merged.to
              if (merged.watch) cleaned.watch = merged.watch
              if (merged.tools?.length) cleaned.tools = merged.tools
              if (merged.status) cleaned.status = merged.status
              if (merged.level?.length) cleaned.level = merged.level
              if (merged.origin?.length) cleaned.origin = merged.origin
              if (merged.event?.length) cleaned.event = merged.event
              if (merged.provider?.length) cleaned.provider = merged.provider
              newTargets[idx] = { ...newTargets[idx], filter: Object.keys(cleaned).length > 0 ? cleaned : undefined }
              updateTriggerCfg({ targets: newTargets })
            }

            const addTarget = () => {
              const defaultFilter: TriggerFilter | undefined =
                key === 'on_file_change' ? { watch: 'document.*' } :
                key === 'on_tool_call' ? { tools: ['*'] } :
                key === 'on_task_create' ? { tools: ['*'] } :
                key === 'on_task_complete' ? { tools: ['*'] } :
                key === 'on_logs' ? { level: ['error'] } :
                undefined
              const newTarget: TriggerTarget = { scope: 'agent' as TriggerScopeV3, ...(defaultFilter ? { filter: defaultFilter } : {}) }
              const newTargets = [...(triggerCfg.targets ?? []), newTarget]
              updateTriggerCfg({ targets: newTargets })
            }

            const removeTarget = (idx: number) => {
              const newTargets = (triggerCfg.targets ?? []).filter((_, i) => i !== idx)
              updateTriggerCfg({ targets: newTargets })
            }

            return (
              <div key={key} className="space-y-1.5 pb-3 border-b border-neutral-200 dark:border-neutral-700 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <span className="text-neutral-700 dark:text-neutral-300 font-medium">{label}</span>
                    </label>
                    <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">{desc}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {!isSectionLocked('triggers') && (
                      <LockButton
                        locked={!!triggerCfg.locked}
                        size="xs"
                        onClick={() => updateTriggerCfg({ locked: !triggerCfg.locked || undefined })}
                      />
                    )}
                    <input
                      type="checkbox"
                      checked={triggerCfg.enabled}
                      onChange={(e) => updateTriggerCfg({ enabled: e.target.checked })}
                      disabled={!!triggerCfg.locked}
                    />
                  </div>
                </div>
                {triggerCfg.enabled && (
                  <div className={`pl-3 space-y-2 mt-1 ${triggerCfg.locked ? 'opacity-60 pointer-events-none' : ''}`}>
                    {(triggerCfg.targets ?? []).map((target, ti) => {
                      const activeTimingModifier = target.debounce_ms !== undefined ? 'debounce'
                        : target.interval_ms !== undefined ? 'interval'
                        : target.batch_ms !== undefined ? 'batch'
                        : 'none'
                      const timingValue = target.debounce_ms ?? target.interval_ms ?? target.batch_ms ?? 0

                      return (
                        <div key={ti} className={`rounded-md border p-2 space-y-1.5 ${target.locked ? 'border-amber-300 dark:border-amber-600 bg-amber-50/30 dark:bg-amber-900/10' : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50'}`}>
                          {/* Target header: scope + lock + remove */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Scope</span>
                            <select
                              className="field-input text-[10px] w-20"
                              value={target.scope}
                              onChange={(e) => updateTarget(ti, { scope: e.target.value as TriggerScopeV3, lambda: e.target.value === 'agent' ? undefined : target.lambda, warm: e.target.value === 'agent' ? undefined : target.warm })}
                              disabled={!!target.locked}
                            >
                              <option value="agent">Agent</option>
                              <option value="system">System</option>
                            </select>
                            <div className="ml-auto flex items-center gap-1">
                              {!triggerCfg.locked && (
                                <LockButton
                                  locked={!!target.locked}
                                  size="xs"
                                  onClick={() => updateTarget(ti, { locked: !target.locked || undefined })}
                                />
                              )}
                            </div>
                            <button
                              className={`text-[10px] shrink-0 ${target.locked ? 'text-neutral-300 dark:text-neutral-600 cursor-not-allowed' : 'text-red-400 hover:text-red-600 dark:hover:text-red-300'}`}
                              onClick={() => !target.locked && removeTarget(ti)}
                              title={target.locked ? 'Target is locked' : 'Remove target'}
                            >
                              ×
                            </button>
                          </div>
                          {/* Lambda — system scope only, not for on_timer (kill switch only) */}
                          {target.scope === 'system' && key !== 'on_timer' && (
                            <>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Lambda</span>
                                <input
                                  type="text"
                                  className="field-input text-[10px] flex-1"
                                  placeholder="path/file.ts:functionName"
                                  value={target.lambda ?? ''}
                                  onChange={(e) => updateTarget(ti, { lambda: e.target.value || undefined })}
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Warm</span>
                                <label className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={target.warm ?? false}
                                    onChange={(e) => updateTarget(ti, { warm: e.target.checked || undefined })}
                                    className="rounded border-neutral-300 dark:border-neutral-600"
                                  />
                                  Keep sandbox worker alive between invocations
                                </label>
                              </div>
                            </>
                          )}

                          {/* Filter fields — vary by trigger type */}
                          {key === 'on_inbox' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Filter</span>
                              <input
                                type="text"
                                className="field-input text-[10px] w-24"
                                placeholder="sender"
                                value={target.filter?.sender ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { sender: e.target.value || undefined })}
                              />
                              <input
                                type="text"
                                className="field-input text-[10px] w-24"
                                placeholder="source"
                                value={typeof target.filter?.source === 'string' ? target.filter.source : ''}
                                onChange={(e) => updateTargetFilter(ti, { source: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_outbox' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Filter</span>
                              <input
                                type="text"
                                className="field-input text-[10px] flex-1"
                                placeholder="to (recipient)"
                                value={target.filter?.to ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { to: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_file_change' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Watch</span>
                              <input
                                type="text"
                                className="field-input text-[10px] flex-1"
                                placeholder="glob pattern, e.g. document.*"
                                value={target.filter?.watch ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { watch: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_tool_call' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Tools</span>
                              <CommaSepInput
                                className="field-input text-[10px] flex-1"
                                placeholder="tool globs, comma-separated (e.g. fs_*, msg_send)"
                                value={target.filter?.tools ?? []}
                                onChange={(tools) => updateTargetFilter(ti, { tools: tools.length > 0 ? tools : undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_task_create' && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Tools</span>
                              <CommaSepInput
                                className="field-input text-[10px] flex-1"
                                placeholder="tool globs, comma-separated (e.g. fs_*, msg_send)"
                                value={target.filter?.tools ?? []}
                                onChange={(tools) => updateTargetFilter(ti, { tools: tools.length > 0 ? tools : undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_task_complete' && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Filter</span>
                              <CommaSepInput
                                className="field-input text-[10px] w-36"
                                placeholder="tools (comma-sep globs)"
                                value={target.filter?.tools ?? []}
                                onChange={(tools) => updateTargetFilter(ti, { tools: tools.length > 0 ? tools : undefined })}
                              />
                              <input
                                type="text"
                                className="field-input text-[10px] w-24"
                                placeholder="status"
                                value={target.filter?.status ?? ''}
                                onChange={(e) => updateTargetFilter(ti, { status: e.target.value || undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_logs' && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Filter</span>
                              <CommaSepInput
                                className="field-input text-[10px] w-28"
                                placeholder="level (comma-sep)"
                                value={target.filter?.level ?? []}
                                onChange={(level) => updateTargetFilter(ti, { level: level.length > 0 ? level : undefined })}
                              />
                              <CommaSepInput
                                className="field-input text-[10px] w-28"
                                placeholder="origin (globs)"
                                value={target.filter?.origin ?? []}
                                onChange={(origin) => updateTargetFilter(ti, { origin: origin.length > 0 ? origin : undefined })}
                              />
                              <CommaSepInput
                                className="field-input text-[10px] w-28"
                                placeholder="event (globs)"
                                value={target.filter?.event ?? []}
                                onChange={(event) => updateTargetFilter(ti, { event: event.length > 0 ? event : undefined })}
                              />
                            </div>
                          )}

                          {key === 'on_llm_call' && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Filter</span>
                              <CommaSepInput
                                className="field-input text-[10px] w-36"
                                placeholder="sources (turn, compaction)"
                                value={Array.isArray(target.filter?.source) ? target.filter.source : []}
                                onChange={(source) => updateTargetFilter(ti, { source: source.length > 0 ? source : undefined })}
                              />
                              <CommaSepInput
                                className="field-input text-[10px] w-36"
                                placeholder="providers (comma-sep)"
                                value={target.filter?.provider ?? []}
                                onChange={(provider) => updateTargetFilter(ti, { provider: provider.length > 0 ? provider : undefined })}
                              />
                            </div>
                          )}

                          {/* Timing modifier */}
                          {showTiming && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-10 shrink-0">Timing</span>
                              <select
                                className="field-input text-[10px] w-20"
                                value={activeTimingModifier}
                                onChange={(e) => {
                                  const mod = e.target.value
                                  const patch: Partial<TriggerTarget> = {
                                    debounce_ms: undefined,
                                    interval_ms: undefined,
                                    batch_ms: undefined,
                                    batch_count: undefined
                                  }
                                  if (mod === 'debounce') patch.debounce_ms = 2000
                                  else if (mod === 'interval') patch.interval_ms = 30000
                                  else if (mod === 'batch') patch.batch_ms = 50
                                  updateTarget(ti, patch)
                                }}
                              >
                                <option value="none">Immediate</option>
                                <option value="debounce">Debounce</option>
                                <option value="interval">Interval</option>
                                <option value="batch">Batch</option>
                              </select>
                              {activeTimingModifier !== 'none' && (
                                <>
                                  <input
                                    type="number"
                                    min={0}
                                    step={500}
                                    value={timingValue}
                                    onChange={(e) => {
                                      const val = parseInt(e.target.value)
                                      const msKey = `${activeTimingModifier}_ms` as keyof TriggerTarget
                                      updateTarget(ti, { debounce_ms: undefined, interval_ms: undefined, batch_ms: undefined, batch_count: undefined, [msKey]: isNaN(val) ? undefined : val })
                                    }}
                                    className="field-input w-16 text-[10px]"
                                  />
                                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500">ms</span>
                                  {activeTimingModifier === 'batch' && (
                                    <>
                                      <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        value={target.batch_count ?? ''}
                                        placeholder="N"
                                        onChange={(e) => {
                                          const val = parseInt(e.target.value)
                                          updateTarget(ti, { batch_count: isNaN(val) || val < 1 ? undefined : val })
                                        }}
                                        className="field-input w-12 text-[10px]"
                                        title="Fire batch early when N events accumulate"
                                      />
                                      <span className="text-[10px] text-neutral-400 dark:text-neutral-500">count</span>
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    <button
                      className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                      onClick={addTarget}
                    >
                      + Add target
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </Section>

        {/* Serving (HTTP) */}
        <Section title="Serving" locked={isSectionLocked('serving')} onToggleLock={() => toggleSectionLock('serving')} summary={`${(local.serving?.api ?? []).length} routes${local.serving?.public?.enabled ? ', public' : ''}`} defaultCollapsed>
          {/* Handle */}
          <Field label="Handle">
            <input
              type="text"
              value={local.handle ?? ''}
              onChange={(e) => {
                const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                save({ ...local, handle: val || undefined })
              }}
              placeholder={filePath ? filePath.replace(/.*[\\/]/, '').replace(/\.adf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'agent'}
              className="field-input w-full"
            />
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              URL slug — defaults to filename if blank
            </p>
          </Field>

          {/* Reply-To URL */}
          <Field label="Reply-To URL">
            <input
              type="text"
              value={local.reply_to ?? ''}
              onChange={(e) => {
                save({ ...local, reply_to: e.target.value || undefined })
              }}
              placeholder="http://host:port/handle/mesh/inbox"
              className="field-input w-full font-mono"
            />
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Override the default reply address for outbound messages
            </p>
          </Field>

          {/* Public serving */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={local.serving?.public?.enabled ?? false}
              onChange={(e) => {
                const enabled = e.target.checked
                save({
                  ...local,
                  serving: {
                    ...(local.serving ?? {}),
                    public: { ...(local.serving?.public ?? { enabled: false }), enabled }
                  }
                })
              }}
              className="rounded text-blue-500"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-300">Serve public/ folder</span>
          </label>
          {local.serving?.public?.enabled && (
            <Field label="Index file">
              <input
                type="text"
                value={local.serving?.public?.index ?? ''}
                onChange={(e) => {
                  save({
                    ...local,
                    serving: {
                      ...(local.serving ?? {}),
                      public: { ...(local.serving?.public ?? { enabled: true }), index: e.target.value || undefined }
                    }
                  })
                }}
                placeholder="index.html"
                className="field-input w-full"
              />
            </Field>
          )}

          {/* Shared files */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={local.serving?.shared?.enabled ?? false}
              onChange={(e) => {
                const enabled = e.target.checked
                save({
                  ...local,
                  serving: {
                    ...(local.serving ?? {}),
                    shared: { ...(local.serving?.shared ?? { enabled: false }), enabled }
                  }
                })
              }}
              className="rounded text-blue-500"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-300">Enable shared file serving</span>
          </label>
          {local.serving?.shared?.enabled && (
            <Field label="Shared patterns">
              <textarea
                value={(local.serving?.shared?.patterns ?? []).join('\n')}
                onChange={(e) => {
                  const patterns = e.target.value.split('\n').map(s => s.trim()).filter(Boolean)
                  save({
                    ...local,
                    serving: {
                      ...(local.serving ?? {}),
                      shared: { ...(local.serving?.shared ?? { enabled: true }), patterns: patterns.length > 0 ? patterns : undefined }
                    }
                  })
                }}
                rows={3}
                placeholder="data/*.json&#10;reports/**/*.csv"
                className="w-full px-2 py-1.5 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400 resize-y"
              />
              <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                Files accessible over HTTP (glob patterns, one per line)
              </p>
            </Field>
          )}

          {/* API Routes */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">API Routes</label>
              <button
                onClick={() => {
                  const api = [...(local.serving?.api ?? []), { method: 'GET' as const, path: '/', lambda: '', warm: false }]
                  save({
                    ...local,
                    serving: { ...(local.serving ?? {}), api }
                  })
                }}
                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
              >
                + Add route
              </button>
            </div>
            {(local.serving?.api ?? []).map((route, i) => (
              <div key={i} className={`mb-2 p-2 rounded border space-y-1.5 ${route.locked ? 'border-amber-300 dark:border-amber-600 bg-amber-50/30 dark:bg-amber-900/10' : 'border-neutral-200 dark:border-neutral-700'}`}>
                <div className="flex gap-1.5 items-center min-w-0">
                  <select
                    value={route.method}
                    onChange={(e) => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], method: e.target.value as ServingApiRoute['method'] }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                    className="shrink-0 px-1.5 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                    disabled={!!route.locked}
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS'].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={route.path}
                    onChange={(e) => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], path: e.target.value }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                    placeholder="/status"
                    className="flex-1 min-w-0 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                    disabled={!!route.locked}
                  />
                  <LockButton
                    locked={!!route.locked}
                    size="xs"
                    onClick={() => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], locked: !route.locked || undefined }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                  />
                  <button
                    onClick={() => {
                      if (route.locked) return
                      const api = (local.serving?.api ?? []).filter((_, j) => j !== i)
                      save({ ...local, serving: { ...(local.serving ?? {}), api: api.length > 0 ? api : undefined } })
                    }}
                    className={`text-xs shrink-0 px-1 ${route.locked ? 'text-neutral-300 dark:text-neutral-600 cursor-not-allowed' : 'text-red-400 hover:text-red-600'}`}
                  >
                    &times;
                  </button>
                </div>
                <div className="flex gap-1.5 items-center">
                  <input
                    type="text"
                    value={route.lambda}
                    onChange={(e) => {
                      const api = [...(local.serving?.api ?? [])]
                      api[i] = { ...api[i], lambda: e.target.value }
                      save({ ...local, serving: { ...(local.serving ?? {}), api } })
                    }}
                    placeholder="lib/api.ts:handler"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
                {route.method === 'WS' && (
                  <div className="text-[10px] text-amber-500 dark:text-amber-400">
                    WebSocket route — lambda is required. Receives WsLambdaEvent on open/message/close/error.
                  </div>
                )}
                {route.method !== 'WS' && (
                  <>
                    <div className="flex gap-3 items-center">
                      <label className="flex items-center gap-1 cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={route.warm ?? false}
                          onChange={(e) => {
                            const api = [...(local.serving?.api ?? [])]
                            api[i] = { ...api[i], warm: e.target.checked || undefined }
                            save({ ...local, serving: { ...(local.serving ?? {}), api } })
                          }}
                          className="rounded text-blue-500"
                        />
                        <span className="text-[10px] text-neutral-400">warm</span>
                      </label>
                      {route.method === 'GET' && (
                        <label className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-neutral-400">cache</span>
                          <input
                            type="number"
                            min={0}
                            value={route.cache_ttl_ms ?? ''}
                            onChange={(e) => {
                              const api = [...(local.serving?.api ?? [])]
                              const val = parseInt(e.target.value, 10)
                              api[i] = { ...api[i], cache_ttl_ms: val > 0 ? val : undefined }
                              save({ ...local, serving: { ...(local.serving ?? {}), api } })
                            }}
                            placeholder="TTL ms"
                            className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                          />
                        </label>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-neutral-400">middleware</span>
                        <button
                          onClick={() => {
                            const api = [...(local.serving?.api ?? [])]
                            const mw = [...(route.middleware ?? []), { lambda: '' }]
                            api[i] = { ...api[i], middleware: mw }
                            save({ ...local, serving: { ...(local.serving ?? {}), api } })
                          }}
                          className="text-[10px] text-blue-500 hover:text-blue-700 font-medium"
                        >
                          + Add
                        </button>
                      </div>
                      {(route.middleware ?? []).map((ref, j) => (
                        <div key={j} className="flex gap-1 items-center mb-1">
                          <input
                            type="text"
                            value={ref.lambda}
                            onChange={(e) => {
                              const api = [...(local.serving?.api ?? [])]
                              const mw = [...(route.middleware ?? [])]
                              mw[j] = { lambda: e.target.value }
                              api[i] = { ...api[i], middleware: mw }
                              save({ ...local, serving: { ...(local.serving ?? {}), api } })
                            }}
                            placeholder="lib/auth.ts:checkToken"
                            className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                          />
                          <button
                            onClick={() => {
                              const api = [...(local.serving?.api ?? [])]
                              const mw = (route.middleware ?? []).filter((_, k) => k !== j)
                              api[i] = { ...api[i], middleware: mw.length > 0 ? mw : undefined }
                              save({ ...local, serving: { ...(local.serving ?? {}), api } })
                            }}
                            className="text-xs text-red-400 hover:text-red-600 px-1"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* URL preview */}
          {meshServerStatus.running && (() => {
            const derivedHandle = local.handle || (filePath ? filePath.replace(/.*[\\/]/, '').replace(/\.adf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'agent')
            const displayHost = meshServerStatus.host === '0.0.0.0' ? '127.0.0.1' : meshServerStatus.host
            const url = `http://${displayHost}:${meshServerStatus.port}/${derivedHandle}`
            return (
              <div className="mt-1">
                <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Endpoint URL</label>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-700 font-mono break-all"
                >
                  {url}
                </a>
              </div>
            )
          })()}
        </Section>

        {/* WebSocket Connections (outbound) */}
        <Section title="WebSocket Connections" summary={`${(local.ws_connections ?? []).length} connections`} defaultCollapsed>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
            Outbound WebSocket connections to remote agents. Useful for NAT traversal and persistent messaging.
          </p>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Connections</label>
            <button
              onClick={() => {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                const suffix = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                const wsConns = [...(local.ws_connections ?? []), {
                  id: `ws-${suffix}`,
                  url: '',
                  enabled: true
                } as WsConnectionConfig]
                save({ ...local, ws_connections: wsConns })
              }}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add connection
            </button>
          </div>
          {(local.ws_connections ?? []).map((conn, i) => (
            <div key={i} className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={conn.enabled}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      wsConns[i] = { ...wsConns[i], enabled: e.target.checked }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    className="rounded text-blue-500"
                  />
                </label>
                <input
                  type="text"
                  value={conn.id}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], id: e.target.value }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="connection-id"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={() => {
                    const wsConns = (local.ws_connections ?? []).filter((_, j) => j !== i)
                    save({ ...local, ws_connections: wsConns.length > 0 ? wsConns : undefined })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={conn.url}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], url: e.target.value }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="wss://host/agent/mesh/ws"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={conn.did ?? ''}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], did: e.target.value || undefined }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="did:key:z6Mk... (expected remote DID, optional)"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={conn.lambda ?? ''}
                  onChange={(e) => {
                    const wsConns = [...(local.ws_connections ?? [])]
                    wsConns[i] = { ...wsConns[i], lambda: e.target.value || undefined }
                    save({ ...local, ws_connections: wsConns })
                  }}
                  placeholder="lib/ws-handler.ts:onEvent (hot-path lambda, optional)"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={conn.auto_reconnect ?? true}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      wsConns[i] = { ...wsConns[i], auto_reconnect: e.target.checked }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-neutral-400">auto-reconnect</span>
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-neutral-400">reconnect</span>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={conn.reconnect_delay_ms ?? ''}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      const val = parseInt(e.target.value, 10)
                      wsConns[i] = { ...wsConns[i], reconnect_delay_ms: val > 0 ? val : undefined }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    placeholder="5000"
                    className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-neutral-400">ms</span>
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-neutral-400">keepalive</span>
                  <input
                    type="number"
                    min={5000}
                    step={5000}
                    value={conn.keepalive_interval_ms ?? ''}
                    onChange={(e) => {
                      const wsConns = [...(local.ws_connections ?? [])]
                      const val = parseInt(e.target.value, 10)
                      wsConns[i] = { ...wsConns[i], keepalive_interval_ms: val > 0 ? val : undefined }
                      save({ ...local, ws_connections: wsConns })
                    }}
                    placeholder="30000"
                    className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-neutral-400">ms</span>
                </label>
              </div>
            </div>
          ))}
        </Section>

        {/* Stream Bindings */}
        <Section
          title="Stream Bindings"
          locked={isSectionLocked('stream_bind') || isSectionLocked('stream_bindings')}
          onToggleLock={() => toggleFieldLock('stream_bind', ['stream_bindings'])}
          summary={`${(local.stream_bindings ?? []).length} declarations`}
          defaultCollapsed
        >
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            Runtime-managed byte pipes between WebSocket, TCP, process, and umbilical endpoints. Imperative binds are ephemeral; declared binds materialize when their dependencies are available.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            {([
              ['host_process_bind', 'host processes'],
              ['container_shared_bind', 'shared container'],
              ['container_isolated_bind', 'isolated containers'],
              ['allow_tcp_bind', 'TCP targets'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={local.stream_bind?.[key] ?? false}
                  onChange={(e) => {
                    save({
                      ...local,
                      stream_bind: {
                        ...(local.stream_bind ?? {}),
                        [key]: e.target.checked,
                      }
                    })
                  }}
                  className="rounded text-blue-500"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {local.stream_bind?.allow_tcp_bind && (
            <div className="mb-2">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">TCP allowlist</label>
              <textarea
                defaultValue={formatTcpAllowlist(local.stream_bind?.tcp_allowlist)}
                onBlur={(e) => {
                  const rules = parseTcpAllowlist(e.target.value)
                  save({
                    ...local,
                    stream_bind: {
                      ...(local.stream_bind ?? {}),
                      allow_tcp_bind: true,
                      tcp_allowlist: rules.length > 0 ? rules : undefined,
                    }
                  })
                }}
                placeholder={'127.0.0.1:9000\nexample.com:8000-9000'}
                className="w-full min-h-[56px] px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
              />
            </div>
          )}

          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Declarations</label>
            <button
              onClick={() => {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
                const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                const bindings = [...(local.stream_bindings ?? []), {
                  id: `binding-${suffix}`,
                  a: { kind: 'umbilical', filter: { event_types: ['tool.failed'] } },
                  b: { kind: 'ws', connection_id: 'observatory' },
                  bidirectional: false,
                  reconnect: true,
                  options: { flow_summary_interval_ms: 5000 },
                } as StreamBindingDeclaration]
                save({ ...local, stream_bindings: bindings })
              }}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add binding
            </button>
          </div>

          {(local.stream_bindings ?? []).map((binding, i) => (
            <div key={i} className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={binding.id}
                  onChange={(e) => {
                    const bindings = [...(local.stream_bindings ?? [])]
                    bindings[i] = { ...bindings[i], id: e.target.value }
                    save({ ...local, stream_bindings: bindings })
                  }}
                  placeholder="binding-id"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={() => {
                    const bindings = (local.stream_bindings ?? []).filter((_, j) => j !== i)
                    save({ ...local, stream_bindings: bindings.length > 0 ? bindings : undefined })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[10px] text-neutral-400 mb-0.5">a</label>
                  <textarea
                    defaultValue={JSON.stringify(binding.a, null, 2)}
                    onBlur={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value) as StreamBindingDeclaration['a']
                        const bindings = [...(local.stream_bindings ?? [])]
                        bindings[i] = { ...bindings[i], a: parsed }
                        save({ ...local, stream_bindings: bindings })
                      } catch { /* keep previous valid value */ }
                    }}
                    className="w-full min-h-[96px] px-2 py-1 text-[11px] font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-neutral-400 mb-0.5">b</label>
                  <textarea
                    defaultValue={JSON.stringify(binding.b, null, 2)}
                    onBlur={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value) as StreamBindingDeclaration['b']
                        const bindings = [...(local.stream_bindings ?? [])]
                        bindings[i] = { ...bindings[i], b: parsed }
                        save({ ...local, stream_bindings: bindings })
                      } catch { /* keep previous valid value */ }
                    }}
                    className="w-full min-h-[96px] px-2 py-1 text-[11px] font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={binding.bidirectional ?? false}
                    disabled={binding.a.kind === 'umbilical'}
                    onChange={(e) => {
                      const bindings = [...(local.stream_bindings ?? [])]
                      bindings[i] = { ...bindings[i], bidirectional: e.target.checked }
                      save({ ...local, stream_bindings: bindings })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-neutral-400">bidirectional</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={binding.reconnect ?? false}
                    onChange={(e) => {
                      const bindings = [...(local.stream_bindings ?? [])]
                      bindings[i] = { ...bindings[i], reconnect: e.target.checked }
                      save({ ...local, stream_bindings: bindings })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-neutral-400">reconnect</span>
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-neutral-400">summary</span>
                  <input
                    type="number"
                    min={100}
                    step={100}
                    value={binding.options?.flow_summary_interval_ms ?? ''}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      const bindings = [...(local.stream_bindings ?? [])]
                      bindings[i] = {
                        ...bindings[i],
                        options: {
                          ...(bindings[i].options ?? {}),
                          flow_summary_interval_ms: val > 0 ? val : undefined,
                        }
                      }
                      save({ ...local, stream_bindings: bindings })
                    }}
                    placeholder="1000"
                    className="w-20 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-neutral-400">ms</span>
                </label>
              </div>
            </div>
          ))}
        </Section>

        {/* Umbilical Taps */}
        <Section
          title="Umbilical Taps"
          locked={isSectionLocked('umbilical_taps')}
          onToggleLock={() => toggleSectionLock('umbilical_taps')}
          summary={`${(local.umbilical_taps ?? []).length} taps`}
          defaultCollapsed
        >
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
            Warm lambdas that subscribe to this agent's runtime events (tool calls, DB writes, turns, messages, etc.). See{' '}
            <span className="font-mono">docs/guides/umbilical.md</span> for filter syntax and the canonical durable-tap recipe.
          </p>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">Taps</label>
            <button
              onClick={() => {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
                const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
                const taps = [...(local.umbilical_taps ?? []), {
                  name: `tap-${suffix}`,
                  lambda: 'lib/tap.ts:onEvent',
                  filter: { event_types: ['tool.completed'], allow_wildcard: false },
                  exclude_own_origin: true,
                  max_rate_per_sec: 100,
                } as UmbilicalTapConfig]
                save({ ...local, umbilical_taps: taps })
              }}
              className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
            >
              + Add tap
            </button>
          </div>
          {(local.umbilical_taps ?? []).map((tap, i) => (
            <div key={i} className="mb-2 p-2 rounded border border-neutral-200 dark:border-neutral-700 space-y-1.5">
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={tap.name}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    taps[i] = { ...taps[i], name: e.target.value }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="tap-name"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={() => {
                    const taps = (local.umbilical_taps ?? []).filter((_, j) => j !== i)
                    save({ ...local, umbilical_taps: taps.length > 0 ? taps : undefined })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={tap.lambda}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    taps[i] = { ...taps[i], lambda: e.target.value }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="lib/tap.ts:onEvent"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={(tap.filter?.event_types ?? []).join(', ')}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    const types = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    taps[i] = { ...taps[i], filter: { ...taps[i].filter, event_types: types } }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="db.write, tool.completed, custom.*"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  title="Event types to match. Exact (db.write) or prefix (tool.*). Comma-separated."
                />
              </div>
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={tap.filter?.when ?? ''}
                  onChange={(e) => {
                    const taps = [...(local.umbilical_taps ?? [])]
                    taps[i] = { ...taps[i], filter: { ...taps[i].filter, when: e.target.value || undefined } }
                    save({ ...local, umbilical_taps: taps })
                  }}
                  placeholder="event.payload.sql.includes('local_orders')  — optional"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                  title="JS expression over `event`. Evaluated per event; only matching events dispatch to the lambda."
                />
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                <label className="flex items-center gap-1 cursor-pointer shrink-0" title="Suppress redelivery when this tap's own lambda caused the event. Prevents direct self-trigger loops.">
                  <input
                    type="checkbox"
                    checked={tap.exclude_own_origin ?? true}
                    onChange={(e) => {
                      const taps = [...(local.umbilical_taps ?? [])]
                      taps[i] = { ...taps[i], exclude_own_origin: e.target.checked }
                      save({ ...local, umbilical_taps: taps })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-neutral-400">exclude own origin</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer shrink-0" title="Required if event_types uses '*' or bare-prefix (tool.*). Code-review signal.">
                  <input
                    type="checkbox"
                    checked={tap.filter?.allow_wildcard ?? false}
                    onChange={(e) => {
                      const taps = [...(local.umbilical_taps ?? [])]
                      taps[i] = { ...taps[i], filter: { ...taps[i].filter, allow_wildcard: e.target.checked } }
                      save({ ...local, umbilical_taps: taps })
                    }}
                    className="rounded text-blue-500"
                  />
                  <span className="text-[10px] text-neutral-400">allow wildcard</span>
                </label>
                <label className="flex items-center gap-1 shrink-0" title="Per-tap token bucket cap. Overruns are dropped and logged.">
                  <span className="text-[10px] text-neutral-400">rate</span>
                  <input
                    type="number"
                    min={1}
                    step={10}
                    value={tap.max_rate_per_sec ?? 100}
                    onChange={(e) => {
                      const taps = [...(local.umbilical_taps ?? [])]
                      const val = parseInt(e.target.value, 10)
                      taps[i] = { ...taps[i], max_rate_per_sec: val > 0 ? val : 100 }
                      save({ ...local, umbilical_taps: taps })
                    }}
                    className="w-16 px-1 py-0.5 text-[10px] border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded focus:outline-none focus:border-blue-400"
                  />
                  <span className="text-[10px] text-neutral-400">/sec</span>
                </label>
              </div>
            </div>
          ))}
        </Section>

        {/* Logging */}
        <Section title="Logging" locked={isSectionLocked('logging')} onToggleLock={() => toggleSectionLock('logging')} summary={local.logging?.default_level ?? 'info'} defaultCollapsed>
          <Field label="Default level">
            <select
              value={local.logging?.default_level ?? 'info'}
              onChange={(e) => {
                save({
                  ...local,
                  logging: {
                    ...(local.logging ?? { default_level: 'info' as const }),
                    default_level: e.target.value as typeof LOG_LEVELS[number]
                  }
                })
              }}
              className="field-input w-28"
            >
              {LOG_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>{lvl}</option>
              ))}
            </select>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Global minimum log level. Messages below this level are discarded.
            </p>
          </Field>
          <Field label="Max rows">
            <input
              type="number"
              min={0}
              step={1000}
              value={local.logging?.max_rows ?? 10000}
              onChange={(e) => {
                const val = parseInt(e.target.value)
                save({
                  ...local,
                  logging: {
                    ...(local.logging ?? { default_level: 'info' as const }),
                    max_rows: isNaN(val) || val <= 0 ? null : val
                  }
                })
              }}
              className="field-input w-24"
            />
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">
              Ring buffer size. Set to 0 for unlimited.
            </p>
          </Field>

          {/* Per-origin rules */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-neutral-500 dark:text-neutral-400">Per-origin rules</label>
              <button
                onClick={() => {
                  const rules = [...(local.logging?.rules ?? []), { origin: '*', min_level: 'info' as const }]
                  save({
                    ...local,
                    logging: {
                      ...(local.logging ?? { default_level: 'info' as const }),
                      rules
                    }
                  })
                }}
                className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
              >
                + Add rule
              </button>
            </div>
            {(local.logging?.rules ?? []).map((rule, i) => (
              <div key={i} className="flex gap-1.5 items-center mb-1">
                <input
                  type="text"
                  value={rule.origin}
                  onChange={(e) => {
                    const rules = [...(local.logging?.rules ?? [])]
                    rules[i] = { ...rules[i], origin: e.target.value }
                    save({
                      ...local,
                      logging: { ...(local.logging ?? { default_level: 'info' as const }), rules }
                    })
                  }}
                  placeholder="serving, lambda*"
                  className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                />
                <select
                  value={rule.min_level}
                  onChange={(e) => {
                    const rules = [...(local.logging?.rules ?? [])]
                    rules[i] = { ...rules[i], min_level: e.target.value as typeof LOG_LEVELS[number] }
                    save({
                      ...local,
                      logging: { ...(local.logging ?? { default_level: 'info' as const }), rules }
                    })
                  }}
                  className="px-1.5 py-1 text-xs border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                >
                  {LOG_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const rules = (local.logging?.rules ?? []).filter((_, j) => j !== i)
                    save({
                      ...local,
                      logging: {
                        ...(local.logging ?? { default_level: 'info' as const }),
                        rules: rules.length > 0 ? rules : undefined
                      }
                    })
                  }}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                >
                  &times;
                </button>
              </div>
            ))}
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1">
              First matching rule wins. Use glob patterns for origin (e.g. "serving", "lambda*").
            </p>
          </div>
        </Section>

        {/* Metadata (read-only) */}
        <Section title="Metadata" defaultCollapsed>
          <div className="text-xs text-neutral-400 dark:text-neutral-500 space-y-1">
            <div>Created: {new Date(local.metadata.created_at).toLocaleString()}</div>
            <div>Updated: {new Date(local.metadata.updated_at).toLocaleString()}</div>
            {local.metadata.author && <div>Author: {local.metadata.author}</div>}
            <div>ADF Version: {local.adf_version}</div>
          </div>
        </Section>

        {/* Meta Keys */}
        <Section title="Meta Keys" summary={`${metaEntries.length} keys`} defaultCollapsed>
          <div className="space-y-1">
            {metaEntries.length === 0 ? (
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">No metadata entries.</p>
            ) : (
              <div className="border border-neutral-200 dark:border-neutral-700 rounded-md overflow-hidden">
                {metaEntries.map((entry) => (
                  <button
                    key={entry.key}
                    onClick={() => { setViewingMeta(entry); setEditingMetaValue(entry.value) }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-700/40 border-b border-neutral-100 dark:border-neutral-700 last:border-b-0 cursor-pointer"
                  >
                    <span className="font-mono text-neutral-700 dark:text-neutral-300 truncate min-w-0 shrink-0" style={{ maxWidth: '40%' }}>{entry.key}</span>
                    <span className="text-neutral-400 dark:text-neutral-500 truncate min-w-0 flex-1">{entry.value || '\u00A0'}</span>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
                      entry.protection === 'readonly'
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                        : entry.protection === 'increment'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                    }`}>{entry.protection}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => { setAddingMeta(true); setNewMetaKey(''); setNewMetaValue(''); setNewMetaProtection('none') }}
              className="text-[11px] text-blue-500 dark:text-blue-400 hover:underline cursor-pointer mt-1"
            >
              + Add key
            </button>
          </div>
        </Section>

        {/* Clear Agent State */}
        <div className="border border-red-200 dark:border-red-900/50 rounded-lg p-3">
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-2">
            Resets document, mind, loop (conversation), and inbox to empty. Agent config and additional files are kept.
          </p>
          <button
            className="w-full px-3 py-1.5 text-xs font-medium text-red-500 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            onClick={async () => {
              // Clear frontend state immediately
              useDocumentStore.getState().setDocumentContent('')
              useDocumentStore.getState().setMindContent('')
              useAgentStore.getState().clearLog()
              useDocumentStore.getState().setDirty(false)

              // Clear backend state
              await Promise.all([
                window.adfApi?.setDocument(''),
                window.adfApi?.setMind(''),
                window.adfApi?.clearChat(),
                window.adfApi?.clearInbox()
              ])

              // Force immediate save to disk (don't wait for autosave)
              await window.adfApi?.saveFile()
            }}
          >
            Clear Agent State
          </button>
        </div>
      </div>

      {/* Tool definition modal */}
      <Dialog
        open={viewingTool !== null}
        onClose={() => setViewingTool(null)}
        title={viewingTool ?? ''}
        wide
      >
        <pre className="text-xs font-mono bg-neutral-100 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 p-3 rounded-lg overflow-auto max-h-[60vh] whitespace-pre-wrap">
          {viewingTool && toolDefs[viewingTool]
            ? JSON.stringify(toolDefs[viewingTool], null, 2)
            : 'Loading...'}
        </pre>
        <div className="mt-3 flex justify-end">
          <button
            className="px-3 py-1.5 text-xs bg-neutral-200 dark:bg-neutral-700 rounded hover:bg-neutral-300 dark:hover:bg-neutral-600"
            onClick={() => setViewingTool(null)}
          >
            Close
          </button>
        </div>
      </Dialog>

      {/* Provider Detach Confirmation Dialog */}
      <Dialog
        open={showDetachProviderDialog}
        onClose={() => setShowDetachProviderDialog(false)}
        title="Remove Provider Credentials"
      >
        <p className="text-sm text-neutral-600 dark:text-neutral-300 mb-4">
          Any credentials associated with this provider saved on this ADF will be removed. The provider will still be available from app-wide settings.
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 rounded hover:bg-neutral-300 dark:hover:bg-neutral-600"
            onClick={() => setShowDetachProviderDialog(false)}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs bg-red-500 text-white rounded hover:bg-red-600"
            disabled={savingProviderToAdf}
            onClick={async () => {
              if (!filePath || !local?.model.provider) return
              const providerId = local.model.provider
              setSavingProviderToAdf(true)
              try {
                await window.adfApi?.detachProvider({ filePath, providerId })
                setProviderSavedOnAdf(false)
                const updatedProviders = (local.providers ?? []).filter(p => p.id !== providerId)
                save({ ...local, providers: updatedProviders.length > 0 ? updatedProviders : undefined as any })
              } catch {
                // Ignore errors
              } finally {
                setSavingProviderToAdf(false)
                setShowDetachProviderDialog(false)
              }
            }}
          >
            {savingProviderToAdf ? 'Removing...' : 'Remove'}
          </button>
        </div>
      </Dialog>

      {/* MCP Install Modal */}
      <McpInstallModal
        open={mcpInstallTarget !== null}
        onClose={() => setMcpInstallTarget(null)}
        serverConfig={mcpInstallTarget}
        onInstalled={(reg) => {
          // Update local registrations so the server transitions from
          // "not installed" to "registered" immediately without a page reload
          setMcpRegistrations((prev) => [...prev, reg])
        }}
      />

      {/* Sandbox Package Install Modal */}
      <SandboxInstallModal
        open={showPkgInstallModal}
        onClose={() => setShowPkgInstallModal(false)}
        packages={missingPackages}
      />

      {/* Meta key viewer/editor modal */}
      <Dialog
        open={viewingMeta !== null}
        onClose={() => setViewingMeta(null)}
        title={viewingMeta?.key ?? ''}
      >
        {viewingMeta && (
          <>
            {/* Protection badge */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400 mb-3 pb-3 border-b border-neutral-200 dark:border-neutral-700">
              <span>
                <span className="text-neutral-400 dark:text-neutral-500">Protection</span>{' '}
                <span className={
                  viewingMeta.protection === 'readonly'
                    ? 'text-red-600 dark:text-red-400'
                    : viewingMeta.protection === 'increment'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-neutral-700 dark:text-neutral-300'
                }>{viewingMeta.protection}</span>
              </span>
            </div>

            {/* Value editor */}
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Value</label>
            <textarea
              value={editingMetaValue}
              onChange={(e) => setEditingMetaValue(e.target.value)}
              rows={3}
              className="field-input w-full font-mono text-xs resize-y"
            />

            {/* Actions */}
            <div className="flex items-center gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
              {/* Protection cycle button */}
              <button
                onClick={async () => {
                  const levels: MetaProtectionLevel[] = ['none', 'readonly', 'increment']
                  const idx = levels.indexOf(viewingMeta.protection)
                  const next = levels[(idx + 1) % levels.length]
                  await window.adfApi?.setMetaProtection(viewingMeta.key, next)
                  setViewingMeta({ ...viewingMeta, protection: next })
                  refreshMeta()
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${
                  viewingMeta.protection === 'readonly'
                    ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                    : viewingMeta.protection === 'increment'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800'
                    : 'text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                }`}
                title={`Click to cycle protection (current: ${viewingMeta.protection})`}
              >
                Protection: {viewingMeta.protection}
              </button>

              <div className="flex-1" />

              {/* Save */}
              <button
                onClick={async () => {
                  await window.adfApi?.setMeta(viewingMeta.key, editingMetaValue, viewingMeta.protection)
                  setViewingMeta(null)
                  refreshMeta()
                }}
                disabled={editingMetaValue === viewingMeta.value}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                  editingMetaValue === viewingMeta.value
                    ? 'text-neutral-300 dark:text-neutral-600 border border-neutral-200 dark:border-neutral-700 cursor-not-allowed'
                    : 'text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer'
                }`}
              >
                Save
              </button>

              {/* Delete */}
              <button
                onClick={async () => {
                  await window.adfApi?.deleteMeta(viewingMeta.key)
                  setViewingMeta(null)
                  refreshMeta()
                }}
                className="px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg cursor-pointer"
              >
                Delete
              </button>

              <button
                onClick={() => setViewingMeta(null)}
                className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
              >
                Close
              </button>
            </div>
          </>
        )}
      </Dialog>

      {/* Add new meta key modal */}
      <Dialog
        open={addingMeta}
        onClose={() => setAddingMeta(false)}
        title="Add Meta Key"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Key</label>
            <input
              value={newMetaKey}
              onChange={(e) => setNewMetaKey(e.target.value)}
              placeholder="my_key"
              className="field-input w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Value</label>
            <input
              value={newMetaValue}
              onChange={(e) => setNewMetaValue(e.target.value)}
              placeholder=""
              className="field-input w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Protection</label>
            <select
              value={newMetaProtection}
              onChange={(e) => setNewMetaProtection(e.target.value as MetaProtectionLevel)}
              className="field-input w-full text-xs"
            >
              {META_PROTECTION_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={() => setAddingMeta(false)}
            className="px-3 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              if (!newMetaKey.trim()) return
              await window.adfApi?.setMeta(newMetaKey.trim(), newMetaValue, newMetaProtection)
              setAddingMeta(false)
              refreshMeta()
            }}
            disabled={!newMetaKey.trim()}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
              !newMetaKey.trim()
                ? 'text-neutral-300 dark:text-neutral-600 border border-neutral-200 dark:border-neutral-700 cursor-not-allowed'
                : 'text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer'
            }`}
          >
            Create
          </button>
        </div>
      </Dialog>
    </div>
  )
}

/** Comma-separated input that holds local string state so commas don't vanish mid-edit. */
function CommaSepInput({ value, onChange, className, placeholder }: {
  value: string[]
  onChange: (v: string[]) => void
  className?: string
  placeholder?: string
}) {
  const [local, setLocal] = useState(value.join(', '))
  const committed = useRef(value)

  // Sync from parent only when the underlying array actually changed
  useEffect(() => {
    const joined = value.join(', ')
    if (joined !== committed.current.join(', ')) {
      committed.current = value
      setLocal(joined)
    }
  }, [value])

  const commit = (raw: string) => {
    const parsed = raw.split(',').map(s => s.trim()).filter(Boolean)
    committed.current = parsed
    onChange(parsed)
  }

  return (
    <input
      type="text"
      className={className}
      placeholder={placeholder}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }}
    />
  )
}

function truncateDid(did: string): string {
  if (did.length <= 24) return did
  return `${did.slice(0, 16)}...${did.slice(-6)}`
}

function DidListPicker({
  dids,
  knownAgents,
  inputValue,
  onInputChange,
  dropdownOpen,
  onDropdownChange,
  onChange,
  placeholder
}: {
  dids: string[]
  knownAgents: { did: string; label: string }[]
  inputValue: string
  onInputChange: (v: string) => void
  dropdownOpen: boolean
  onDropdownChange: (open: boolean) => void
  onChange: (dids: string[]) => void
  placeholder: string
}) {
  const didSet = new Set(dids)
  const resolveLabel = (did: string) => knownAgents.find(a => a.did === did)?.label

  const filtered = knownAgents.filter(a =>
    !didSet.has(a.did) &&
    (inputValue === '' || a.label.toLowerCase().includes(inputValue.toLowerCase()) || a.did.includes(inputValue))
  )

  return (
    <div className="space-y-1">
      {/* Selected chips */}
      {dids.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {dids.map((did) => {
            const label = resolveLabel(did)
            return (
              <span
                key={did}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full border border-blue-200 dark:border-blue-800"
                title={did}
              >
                {label ? label : truncateDid(did)}
                <button
                  type="button"
                  onClick={() => onChange(dids.filter(d => d !== did))}
                  className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-200 ml-0.5"
                >
                  &times;
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Input + dropdown */}
      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onFocus={() => onDropdownChange(true)}
          onBlur={() => setTimeout(() => onDropdownChange(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && inputValue.startsWith('did:')) {
              e.preventDefault()
              const trimmed = inputValue.trim()
              if (trimmed && !didSet.has(trimmed)) {
                onChange([...dids, trimmed])
                onInputChange('')
              }
            }
          }}
          className="field-input"
          placeholder={placeholder}
        />
        {dropdownOpen && filtered.length > 0 && (
          <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg">
            {filtered.map((agent) => (
              <button
                key={agent.did}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange([...dids, agent.did])
                  onInputChange('')
                }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
              >
                <span className="font-medium text-neutral-700 dark:text-neutral-200">{agent.label}</span>
                <span className="text-neutral-400 dark:text-neutral-500 font-mono text-[10px] truncate">{truncateDid(agent.did)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  locked,
  onToggleLock,
  summary,
  defaultCollapsed = false,
  children
}: {
  title: React.ReactNode
  locked?: boolean
  onToggleLock?: () => void
  summary?: React.ReactNode
  defaultCollapsed?: boolean
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <div className={`bg-white dark:bg-neutral-800 rounded-lg border ${locked ? 'border-amber-300 dark:border-amber-600' : 'border-neutral-200 dark:border-neutral-700'} ${collapsed ? 'p-2.5' : 'p-3'}`}>
      <h4
        className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider flex items-center gap-1.5 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <svg
          width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {title}
        {onToggleLock && (
          <LockButton locked={!!locked} onClick={onToggleLock} />
        )}
        {collapsed && summary && (
          <span className="ml-auto font-normal normal-case tracking-normal text-[10px] text-neutral-400 dark:text-neutral-500 truncate">{summary}</span>
        )}
      </h4>
      {!collapsed && (
        <div className={`space-y-2 mt-2 ${locked ? 'opacity-60 pointer-events-none' : ''}`}>{children}</div>
      )}
    </div>
  )
}

function LockButton({ locked, onClick, size = 'sm' }: { locked: boolean; onClick: () => void; size?: 'sm' | 'xs' }) {
  const px = size === 'xs' ? 12 : 14
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`shrink-0 transition-colors ${locked ? 'text-amber-500 dark:text-amber-400' : 'text-neutral-300 dark:text-neutral-600 hover:text-neutral-400 dark:hover:text-neutral-500'}`}
      title={locked ? 'Locked — click to unlock' : 'Unlocked — click to lock'}
    >
      {locked ? (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ) : (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        </svg>
      )}
    </button>
  )
}

/** Number input that allows empty field while typing; commits on blur. */
function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className,
  float
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  placeholder?: string
  className?: string
  float?: boolean
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={focused ? text : value}
      placeholder={placeholder}
      onFocus={() => { setFocused(true); setText(String(value)) }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false)
        const parsed = float ? parseFloat(text) : parseInt(text)
        if (!isNaN(parsed)) {
          onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed)))
        }
      }}
      className={className ?? 'field-input w-24'}
    />
  )
}

function Field({
  label,
  children
}: {
  label: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">{label}</label>
      {children}
    </div>
  )
}
