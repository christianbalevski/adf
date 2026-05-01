import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/app.store'
import { DEFAULT_BASE_PROMPT, DEFAULT_TOOL_PROMPTS, DEFAULT_COMPACTION_PROMPT, TOOL_PROMPT_LABELS, PROVIDER_TYPES } from '../../../shared/constants/adf-defaults'
import type { ProviderType } from '../../../shared/constants/adf-defaults'
import { invalidateConfigCaches } from '../agent/AgentConfig'
import type { ProviderConfig, McpServerRegistration, AdapterRegistration, MeshAgentStatus } from '../../../shared/types/ipc.types'
import { McpStatusDashboard } from '../mcp/McpStatusDashboard'
import { AdapterStatusDashboard } from '../adapters/AdapterStatusDashboard'
import { ProviderCredentialPanel } from '../providers/ProviderCredentialPanel'
import { useMeshStore } from '../../stores/mesh.store'

function getProviderMeta(type: ProviderType) {
  return PROVIDER_TYPES.find((pt) => pt.type === type) ?? PROVIDER_TYPES[0]
}

function generateProviderId(): string {
  return 'custom:' + Math.random().toString(36).slice(2, 8)
}

function TokenUsageSection() {
  const [tokenUsage, setTokenUsage] = useState<Record<string, Record<string, Record<string, { input: number; output: number }>>>>({})
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    window.adfApi?.getTokenUsage().then((data) => {
      setTokenUsage(data)
    })
  }, [])

  const handleClear = async () => {
    if (!window.confirm('Are you sure you want to clear all token usage data? This cannot be undone.')) {
      return
    }
    await window.adfApi?.clearTokenUsage()
    setTokenUsage({})
  }

  const dates = Object.keys(tokenUsage).sort().reverse()
  const totalInput = dates.reduce((sum, date) => {
    return sum + Object.values(tokenUsage[date]).reduce((providerSum, models) => {
      return providerSum + Object.values(models).reduce((modelSum, usage) => modelSum + usage.input, 0)
    }, 0)
  }, 0)
  const totalOutput = dates.reduce((sum, date) => {
    return sum + Object.values(tokenUsage[date]).reduce((providerSum, models) => {
      return providerSum + Object.values(models).reduce((modelSum, usage) => modelSum + usage.output, 0)
    }, 0)
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Token Usage
        </label>
        <div className="flex gap-2">
          {dates.length > 0 && (
            <button
              onClick={handleClear}
              className="text-xs text-red-500 hover:text-red-700"
            >
              Clear
            </button>
          )}
          {dates.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      </div>

      {dates.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          No token usage recorded yet.
        </p>
      ) : (
        <div className="border border-neutral-300 dark:border-neutral-600 rounded-lg p-3 bg-neutral-50 dark:bg-neutral-800">
          <div className="text-xs text-neutral-600 dark:text-neutral-300 mb-2">
            <strong>Total:</strong> {totalInput.toLocaleString()} input + {totalOutput.toLocaleString()} output = {(totalInput + totalOutput).toLocaleString()} tokens
          </div>

          {expanded && (
            <div className="space-y-3 mt-3">
              {dates.map((date) => (
                <div key={date} className="border-t border-neutral-200 dark:border-neutral-700 pt-2">
                  <div className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 mb-1">
                    {date}
                  </div>
                  {Object.entries(tokenUsage[date]).map(([provider, models]) => (
                    <div key={provider} className="ml-3 space-y-1">
                      <div className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        {provider}
                      </div>
                      {Object.entries(models).map(([model, usage]) => (
                        <div key={model} className="ml-3 text-xs text-neutral-500 dark:text-neutral-400 font-mono">
                          {model}: {usage.input.toLocaleString()} in + {usage.output.toLocaleString()} out
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Packages Tab — runtime packages + all installed on disk
// ---------------------------------------------------------------------------

function PackagesTab({
  sandboxPackages,
  setSandboxPackages
}: {
  sandboxPackages: Array<{ name: string; version: string }>
  setSandboxPackages: (pkgs: Array<{ name: string; version: string }>) => void
}) {
  const [newPkgName, setNewPkgName] = useState('')
  const [newPkgVersion, setNewPkgVersion] = useState('')
  const [pkgInstalling, setPkgInstalling] = useState<string | null>(null)
  const [pkgError, setPkgError] = useState<string | null>(null)
  const [installedOnDisk, setInstalledOnDisk] = useState<Array<{ name: string; version: string; installedAt: number; size_mb: number; installedBy?: string }>>([])

  // Fetch manifest on mount and after installs
  const refreshManifest = useCallback(() => {
    window.adfApi?.listInstalledSandboxPackages().then((r) => {
      setInstalledOnDisk(r?.packages ?? [])
    })
  }, [])

  useEffect(() => { refreshManifest() }, [refreshManifest])

  const runtimeNames = new Set(sandboxPackages.map((p) => p.name))
  const agentOnlyPackages = installedOnDisk.filter((p) => !runtimeNames.has(p.name))

  const handleInstall = async () => {
    if (!newPkgName.trim()) return
    if (sandboxPackages.some((p) => p.name === newPkgName.trim())) {
      setPkgError('Package already added')
      return
    }
    setPkgInstalling(newPkgName.trim())
    setPkgError(null)
    try {
      const result = await window.adfApi?.installSandboxPackages([
        { name: newPkgName.trim(), version: newPkgVersion.trim() || 'latest' }
      ])
      const r = result?.results?.[newPkgName.trim()]
      if (r?.success) {
        setSandboxPackages([...sandboxPackages, {
          name: newPkgName.trim(),
          version: r.version ?? (newPkgVersion.trim() || 'latest')
        }])
        setNewPkgName('')
        setNewPkgVersion('')
        refreshManifest()
      } else {
        setPkgError(r?.error ?? 'Install failed')
      }
    } catch (err) {
      setPkgError(String(err))
    }
    setPkgInstalling(null)
  }

  return (
    <>
      {/* Runtime packages — available to all agents */}
      <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Runtime Packages
          </label>
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            available to all agents
          </span>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
          Packages installed here are available to every agent on this Studio instance. Pure JS only — no native addons.
        </p>
        {sandboxPackages.length > 0 && (
          <div className="space-y-1 mb-4">
            {sandboxPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-700/50"
              >
                <span className="font-mono text-neutral-700 dark:text-neutral-300">
                  {pkg.name}<span className="text-neutral-400 dark:text-neutral-500">@{pkg.version}</span>
                </span>
                <button
                  onClick={() => setSandboxPackages(sandboxPackages.filter((p) => p.name !== pkg.name))}
                  className="text-xs text-red-400 hover:text-red-600 px-1"
                  title="Remove package"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 mb-0.5">Package name</label>
            <input
              type="text"
              value={newPkgName}
              onChange={(e) => { setNewPkgName(e.target.value); setPkgError(null) }}
              placeholder="e.g. vega-lite"
              className="w-full px-2 py-1.5 text-sm font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
            />
          </div>
          <div className="w-28">
            <label className="block text-[10px] text-neutral-400 dark:text-neutral-500 mb-0.5">Version</label>
            <input
              type="text"
              value={newPkgVersion}
              onChange={(e) => { setNewPkgVersion(e.target.value); setPkgError(null) }}
              placeholder="latest"
              className="w-full px-2 py-1.5 text-sm font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
            />
          </div>
          <button
            onClick={handleInstall}
            disabled={!newPkgName.trim() || !!pkgInstalling}
            className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {pkgInstalling ? 'Installing...' : 'Install'}
          </button>
        </div>
        {pkgError && (
          <p className="text-xs text-red-500 mt-1">{pkgError}</p>
        )}
      </div>

      {/* Agent-installed packages — installed on disk by agents via npm_install */}
      {agentOnlyPackages.length > 0 && (
        <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Agent-Installed Packages
            </label>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              installed by agents via npm_install
            </span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            These packages were installed by individual agents. They are on disk and visible to any agent that has them in its config.
          </p>
          <div className="space-y-1">
            {agentOnlyPackages.map((pkg) => (
              <div
                key={pkg.name}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-700/50"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-neutral-700 dark:text-neutral-300 truncate">
                    {pkg.name}<span className="text-neutral-400 dark:text-neutral-500">@{pkg.version}</span>
                  </span>
                  {pkg.installedBy && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-600 text-neutral-500 dark:text-neutral-400">
                      {pkg.installedBy}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                    {pkg.size_mb} MB
                  </span>
                  <button
                    onClick={() => {
                      setSandboxPackages([...sandboxPackages, { name: pkg.name, version: pkg.version }])
                    }}
                    className="text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap"
                    title="Make available to all agents"
                  >
                    Make Runtime
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Live list of agents declaring LAN-scope visibility. Reused by both the meshLan
 * toggle description and (future) the mDNS advertisement toggle — same predicate
 * drives both: any lan-tier agent flips binding/announcement on.
 */
function LanAgentsList({ agents }: { agents: MeshAgentStatus[] }) {
  const lanAgents = agents.filter((a) => a.visibility === 'lan')
  return (
    <div className="mt-2 ml-5 text-[10px]">
      {lanAgents.length === 0 ? (
        <p className="text-neutral-400 dark:text-neutral-500">
          No agents are set to <code>lan</code> visibility. The runtime will bind to loopback unless this toggle forces LAN binding.
        </p>
      ) : (
        <>
          <p className="text-neutral-500 dark:text-neutral-400 mb-1">
            {lanAgents.length === 1 ? '1 agent is' : `${lanAgents.length} agents are`} exposed on the LAN:
          </p>
          <ul className="space-y-0.5">
            {lanAgents.map((a) => (
              <li key={a.filePath} className="flex items-center gap-2 font-mono text-neutral-600 dark:text-neutral-300">
                {a.icon && <span>{a.icon}</span>}
                <span>{a.handle}</span>
                <span className="text-neutral-400 dark:text-neutral-500 truncate">{a.filePath}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface DiscoveredRuntime {
  runtime_id: string
  runtime_did?: string
  proto: string
  directory_path: string
  host: string
  port: number
  url: string
  first_seen: number
  last_seen: number
  agent_count: number
}

/**
 * Read-only list of ADF runtimes discovered via mDNS. Updates live via
 * MESH_EVENT. Sits directly below LanAgentsList in the Networking tab — the
 * matched pair is "what you expose" above / "what you can see" below.
 */
function DiscoveredRuntimesList() {
  const [peers, setPeers] = useState<DiscoveredRuntime[]>([])
  const refresh = useCallback(async () => {
    const list = await window.adfApi?.getDiscoveredRuntimes?.()
    if (list) setPeers(list)
  }, [])

  useEffect(() => {
    void refresh()
    const unsub = window.adfApi?.onMeshEvent?.((event: { type?: string }) => {
      if (event?.type === 'lan_peer_discovered' || event?.type === 'lan_peer_expired') {
        void refresh()
      }
    })
    return unsub
  }, [refresh])

  return (
    <div className="mt-3">
      <p className="text-xs text-neutral-600 dark:text-neutral-300 font-medium mb-1">Discovered on LAN</p>
      <div className="ml-5 text-[10px]">
        {peers.length === 0 ? (
          <p className="text-neutral-400 dark:text-neutral-500">
            No other ADF runtimes visible on your network.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {peers.map((p) => (
              <li key={p.runtime_id} className="flex items-center gap-2 font-mono text-neutral-600 dark:text-neutral-300">
                <span>{p.host}</span>
                <span className="text-neutral-400 dark:text-neutral-500">
                  {p.agent_count} {p.agent_count === 1 ? 'agent' : 'agents'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-neutral-400 dark:text-neutral-500">
          Tier changes take effect immediately for inbox enforcement. mDNS announcement updates on next runtime restart.
        </p>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [compactionPrompt, setCompactionPrompt] = useState('')
  const [toolPrompts, setToolPrompts] = useState<Record<string, string>>({})
  const [expandedPromptKey, setExpandedPromptKey] = useState<string | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerRegistration[]>([])
  const [adapterRegistrations, setAdapterRegistrations] = useState<AdapterRegistration[]>([])
  const [modelOptionsCache, setModelOptionsCache] = useState<Record<string, { models: string[]; error?: string; loading?: boolean }>>({})
  const [customModelEntry, setCustomModelEntry] = useState<Record<string, boolean>>({})
  const [activeTab, setActiveTab] = useState<'general' | 'providers' | 'packages' | 'mcps' | 'channels' | 'networking' | 'compute'>('general')
  const [computeHostAccessEnabled, setComputeHostAccessEnabled] = useState(false)
  const [computeHostApproved, setComputeHostApproved] = useState<string[]>([])
  const [computeEnvStatus, setComputeEnvStatus] = useState<{ status: string; activeAgents: string[] }>({ status: 'stopped', activeAgents: [] })
  const [computeContainerPackages, setComputeContainerPackages] = useState('python3, py3-pip, git, curl')
  const [computeMachineCpus, setComputeMachineCpus] = useState(2)
  const [computeMachineMemoryMb, setComputeMachineMemoryMb] = useState(2048)
  const [computeContainerImage, setComputeContainerImage] = useState('docker.io/library/node:20-alpine')
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })
  const [meshAutoStart, setMeshAutoStart] = useState(true)
  const [meshLan, setMeshLan] = useState(false)
  const [meshPort, setMeshPort] = useState(7295)
  const [meshAgents, setMeshAgents] = useState<MeshAgentStatus[]>([])
  const [lanInfo, setLanInfo] = useState<{ hostname: string; addresses: Array<{ iface: string; address: string; family: 'IPv4' | 'IPv6'; mac: string }> }>({ hostname: '', addresses: [] })
  const [meshRestarting, setMeshRestarting] = useState(false)
  const restartMeshServer = async () => {
    setMeshRestarting(true)
    try {
      const res = await window.adfApi?.restartMeshServer()
      if (res) {
        setMeshServerStatus({ running: res.running ?? false, port: res.port ?? meshPort, host: res.host ?? (meshLan ? '0.0.0.0' : '127.0.0.1') })
      }
    } finally {
      setMeshRestarting(false)
    }
  }
  const meshEnabled = useMeshStore((s) => s.enabled)
  const [newProviderIds, setNewProviderIds] = useState<Set<string>>(new Set())
  const [sandboxPackages, setSandboxPackages] = useState<Array<{ name: string; version: string }>>([])
  const [chatgptAuth, setChatgptAuth] = useState<{ authenticated: boolean; email?: string; expiresAt?: number }>({ authenticated: false })
  const [chatgptAuthLoading, setChatgptAuthLoading] = useState(false)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const hasLoaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const pendingSave = useRef<(() => void) | null>(null)

  useEffect(() => {
    window.adfApi?.getSettings().then((settings) => {
      setProviders((settings.providers as ProviderConfig[]) ?? [])
      setMcpServers((settings.mcpServers as McpServerRegistration[]) ?? [])
      setAdapterRegistrations((settings.adapters as AdapterRegistration[]) ?? [])
      setSystemPrompt(
        (settings.globalSystemPrompt as string) ?? DEFAULT_BASE_PROMPT
      )
      setCompactionPrompt(
        (settings.compactionPrompt as string) ?? DEFAULT_COMPACTION_PROMPT
      )
      setToolPrompts(
        (settings.toolPrompts as Record<string, string>) ?? { ...DEFAULT_TOOL_PROMPTS }
      )
      setMeshAutoStart(settings.meshEnabled !== false)
      setMeshLan(!!settings.meshLan)
      setMeshPort((settings.meshPort as number) ?? 7295)
      setSandboxPackages((settings.sandboxPackages as Array<{ name: string; version: string }>) ?? [])
      const compute = settings.compute as {
        hostAccessEnabled?: boolean; hostApproved?: string[];
        containerPackages?: string[]; machineCpus?: number; machineMemoryMb?: number; containerImage?: string;
      } | undefined
      if (compute) {
        setComputeHostAccessEnabled(!!compute.hostAccessEnabled)
        setComputeHostApproved(compute.hostApproved ?? [])
        if (compute.containerPackages) setComputeContainerPackages(compute.containerPackages.join(', '))
        if (compute.machineCpus) setComputeMachineCpus(compute.machineCpus)
        if (compute.machineMemoryMb) setComputeMachineMemoryMb(compute.machineMemoryMb)
        if (compute.containerImage) setComputeContainerImage(compute.containerImage)
      }
      hasLoaded.current = true
    })
  }, [])

  // Fetch mesh server status + agent list for "Networking" tab
  useEffect(() => {
    if (activeTab !== 'networking') return
    window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
    window.adfApi?.getMeshStatus().then((s) => setMeshAgents(s.agents))
    window.adfApi?.getMeshServerLanIps().then(setLanInfo)
    // Subscribe to mesh events for live updates
    const unsub = window.adfApi?.onMeshEvent(() => {
      window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
      window.adfApi?.getMeshStatus().then((s) => setMeshAgents(s.agents))
    })
    return unsub
  }, [activeTab, meshEnabled])

  // Auto-save on change (debounced) — flushes immediately on unmount
  useEffect(() => {
    if (!hasLoaded.current) return
    clearTimeout(saveTimer.current)
    const doSave = () => {
      pendingSave.current = null
      window.adfApi?.setSettings({
        providers,
        mcpServers,
        adapters: adapterRegistrations,
        globalSystemPrompt: systemPrompt,
        compactionPrompt,
        toolPrompts,
        sandboxPackages,
        compute: {
          hostAccessEnabled: computeHostAccessEnabled,
          hostApproved: computeHostApproved,
          containerPackages: computeContainerPackages.split(',').map((s: string) => s.trim()).filter(Boolean),
          machineCpus: computeMachineCpus,
          machineMemoryMb: computeMachineMemoryMb,
          containerImage: computeContainerImage,
        }
      })
      invalidateConfigCaches()
    }
    pendingSave.current = doSave
    saveTimer.current = setTimeout(doSave, 500)
    return () => clearTimeout(saveTimer.current)
  }, [providers, mcpServers, adapterRegistrations, systemPrompt, compactionPrompt, toolPrompts, sandboxPackages, computeHostAccessEnabled, computeHostApproved, computeContainerPackages, computeMachineCpus, computeMachineMemoryMb, computeContainerImage])

  // Flush pending save on unmount so changes aren't lost
  useEffect(() => {
    return () => {
      if (pendingSave.current) pendingSave.current()
    }
  }, [])

  const handleThemeChange = async (newTheme: 'light' | 'dark' | 'system') => {
    setTheme(newTheme)
    await window.adfApi?.setSettings({ theme: newTheme })
  }

  const handleResetPrompt = () => {
    setSystemPrompt(DEFAULT_BASE_PROMPT)
  }

  const handleResetCompactionPrompt = () => {
    setCompactionPrompt(DEFAULT_COMPACTION_PROMPT)
  }

  const fetchModelsForProvider = (providerId: string) => {
    if (modelOptionsCache[providerId]?.loading) return
    setModelOptionsCache((prev) => ({ ...prev, [providerId]: { models: [], loading: true } }))
    window.adfApi?.listModels(providerId).then((result) => {
      setModelOptionsCache((prev) => ({
        ...prev,
        [providerId]: { models: [...result.models].sort((a, b) => a.localeCompare(b)), error: result.error }
      }))
    }).catch((err) => {
      setModelOptionsCache((prev) => ({ ...prev, [providerId]: { models: [], error: String(err) } }))
    })
  }

  const refreshChatgptAuth = () => {
    window.adfApi?.chatgptAuthStatus().then(setChatgptAuth).catch(() => {})
  }

  const handleChatgptSignIn = async () => {
    setChatgptAuthLoading(true)
    try {
      const result = await window.adfApi?.chatgptAuthStart()
      if (result && !result.success) {
        console.warn('[ChatGPT Auth]', result.error)
      }
      refreshChatgptAuth()
    } catch (err) {
      console.warn('[ChatGPT Auth]', err)
    } finally {
      setChatgptAuthLoading(false)
    }
  }

  const handleChatgptSignOut = async () => {
    await window.adfApi?.chatgptAuthLogout()
    refreshChatgptAuth()
  }

  // Refresh ChatGPT auth status and auto-fetch models when a chatgpt-subscription provider is expanded
  useEffect(() => {
    if (expandedId && providers.find(p => p.id === expandedId)?.type === 'chatgpt-subscription') {
      refreshChatgptAuth()
      if (!modelOptionsCache[expandedId]?.models?.length) {
        fetchModelsForProvider(expandedId)
      }
    }
  }, [expandedId])

  const addProvider = () => {
    const defaultType = PROVIDER_TYPES[0]
    const newProvider: ProviderConfig = {
      id: generateProviderId(),
      type: defaultType.type,
      name: defaultType.label,
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
      params: []
    }
    setProviders([...providers, newProvider])
    setExpandedId(newProvider.id)
    setNewProviderIds((prev) => new Set(prev).add(newProvider.id))
  }

  const changeProviderType = (id: string, type: ProviderType) => {
    const meta = getProviderMeta(type)
    setProviders(providers.map((p) => {
      if (p.id !== id) return p
      return { ...p, type, name: meta.label, baseUrl: '', apiKey: '', defaultModel: '', params: [] }
    }))
  }

  const updateProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setProviders(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const removeProvider = (id: string) => {
    setProviders(providers.filter((p) => p.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  const addParam = (providerId: string) => {
    setProviders(providers.map((p) => {
      if (p.id !== providerId) return p
      return { ...p, params: [...(p.params ?? []), { key: '', value: '' }] }
    }))
  }

  const updateParam = (providerId: string, paramIndex: number, patch: Partial<{ key: string; value: string }>) => {
    setProviders(providers.map((p) => {
      if (p.id !== providerId) return p
      const params = [...(p.params ?? [])]
      params[paramIndex] = { ...params[paramIndex], ...patch }
      return { ...p, params }
    }))
  }

  const removeParam = (providerId: string, paramIndex: number) => {
    setProviders(providers.map((p) => {
      if (p.id !== providerId) return p
      return { ...p, params: (p.params ?? []).filter((_, j) => j !== paramIndex) }
    }))
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-900">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm">
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Settings</span>
        <button
          onClick={() => setShowSettings(false)}
          className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          title="Close settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 flex gap-1 px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80">
        {(['general', 'providers', 'packages', 'mcps', 'channels', 'networking', 'compute'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              activeTab === tab
                ? 'bg-blue-500 text-white'
                : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600'
            }`}
          >
            {{ general: 'General', providers: 'Providers', packages: 'Packages', mcps: 'MCPs', channels: 'Channels', networking: 'Networking', compute: 'Compute' }[tab]}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl space-y-6">
          {/* General tab */}
          {activeTab === 'general' && <>
          {/* Theme */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              Theme
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => handleThemeChange('light')}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                  theme === 'light'
                    ? 'bg-blue-500 text-white'
                    : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600'
                }`}
              >
                Light
              </button>
              <button
                onClick={() => handleThemeChange('dark')}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                  theme === 'dark'
                    ? 'bg-blue-500 text-white'
                    : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600'
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => handleThemeChange('system')}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                  theme === 'system'
                    ? 'bg-blue-500 text-white'
                    : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600'
                }`}
              >
                System
              </button>
            </div>
          </div>

          {/* Token Usage */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <TokenUsageSection />
          </div>

          {/* Global System Prompt */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Global System Prompt
              </label>
              <button
                onClick={handleResetPrompt}
                className="text-xs text-blue-500 hover:text-blue-700"
              >
                Reset to Default
              </button>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-lg focus:outline-none focus:border-blue-400 resize-y"
            />
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              Applied to every .adf agent before its per-file instructions. Explains the
              ADF paradigm to the model.
            </p>
          </div>

          {/* Compaction Prompt */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Compaction Prompt
              </label>
              {compactionPrompt !== DEFAULT_COMPACTION_PROMPT && (
                <button
                  onClick={handleResetCompactionPrompt}
                  className="text-xs text-blue-500 hover:text-blue-700"
                >
                  Reset to Default
                </button>
              )}
            </div>
            <textarea
              value={compactionPrompt}
              onChange={(e) => setCompactionPrompt(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-lg focus:outline-none focus:border-blue-400 resize-y"
            />
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              System prompt used when compacting conversation history. Controls how the
              loop_compact tool summarizes context.
            </p>
          </div>

          {/* Tool Instructions */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              Tool Instructions
            </label>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mb-3">
              Conditional prompt sections injected based on enabled tools and features. Shell mode replaces the Tool Best Practices section.
            </p>
            <div className="space-y-1">
              {Object.keys(DEFAULT_TOOL_PROMPTS).map((key) => {
                const label = TOOL_PROMPT_LABELS[key] ?? key
                const isExpanded = expandedPromptKey === key
                const currentValue = toolPrompts[key] ?? DEFAULT_TOOL_PROMPTS[key] ?? ''
                const isDefault = currentValue === (DEFAULT_TOOL_PROMPTS[key] ?? '')

                return (
                  <div key={key} className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedPromptKey(isExpanded ? null : key)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                          {isExpanded ? '\u25BC' : '\u25B6'}
                        </span>
                        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                          {label}
                        </span>
                        {!isDefault && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            modified
                          </span>
                        )}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 border-t border-neutral-100 dark:border-neutral-700">
                        <textarea
                          value={currentValue}
                          onChange={(e) => setToolPrompts({ ...toolPrompts, [key]: e.target.value })}
                          rows={10}
                          className="w-full mt-2 px-3 py-2 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-lg focus:outline-none focus:border-blue-400 resize-y"
                        />
                        {!isDefault && (
                          <button
                            onClick={() => setToolPrompts({ ...toolPrompts, [key]: DEFAULT_TOOL_PROMPTS[key] ?? '' })}
                            className="mt-1 text-xs text-blue-500 hover:text-blue-700"
                          >
                            Reset to Default
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex justify-center pb-4">
            <button
              onClick={() => {
                setShowSettings(false)
                useAppStore.getState().setShowAbout(true)
              }}
              className="px-3 py-1.5 text-sm text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg"
            >
              How it works
            </button>
          </div>
          </>}

          {/* Packages tab */}
          {activeTab === 'packages' && <PackagesTab
            sandboxPackages={sandboxPackages}
            setSandboxPackages={setSandboxPackages}
          />}

          {/* Providers tab */}
          {activeTab === 'providers' && <>
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Providers
              </label>
              <button
                onClick={addProvider}
                className="text-xs text-blue-500 hover:text-blue-700 font-medium"
              >
                + Add Provider
              </button>
            </div>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-3">
              ADF files with stored provider configurations will continue to work independently, even if the provider is not listed here.
            </p>
            {providers.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                No providers configured. Add one to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {providers.map((p) => {
                  const isExpanded = expandedId === p.id
                  const meta = getProviderMeta(p.type)

                  return (
                    <div key={p.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
                      {/* Collapsed header */}
                      <button
                        onClick={() => {
                          if (isExpanded) {
                            setNewProviderIds((prev) => {
                              const next = new Set(prev)
                              next.delete(p.id)
                              return next
                            })
                            setExpandedId(null)
                          } else {
                            setExpandedId(p.id)
                          }
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50 transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                            {isExpanded ? '\u25BC' : '\u25B6'}
                          </span>
                          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate">
                            {p.name || meta.label}
                          </span>
                          {!isExpanded && (
                            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 truncate">
                              {p.baseUrl || meta.label}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeProvider(p.id)
                          }}
                          className="text-xs text-red-400 hover:text-red-600 shrink-0 ml-2"
                        >
                          Remove
                        </button>
                      </button>

                      {/* Expanded content */}
                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-2 border-t border-neutral-100 dark:border-neutral-700">
                          <div className="mt-2">
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Provider</label>
                            <select
                              value={p.type}
                              onChange={(e) => changeProviderType(p.id, e.target.value as ProviderType)}
                              disabled={!newProviderIds.has(p.id)}
                              className={`w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400 ${
                                !newProviderIds.has(p.id) ? 'opacity-60 cursor-not-allowed' : ''
                              }`}
                            >
                              {PROVIDER_TYPES.map((pt) => (
                                <option key={pt.type} value={pt.type}>{pt.label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Name</label>
                            <input
                              type="text"
                              value={p.name}
                              onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                              placeholder={meta.label}
                              className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                          </div>
                          {p.type === 'openai-compatible' && (
                            <div>
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Base URL</label>
                              <input
                                type="text"
                                value={p.baseUrl}
                                onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                                placeholder="http://localhost:1234/v1"
                                className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                              />
                            </div>
                          )}
                          {p.type === 'chatgpt-subscription' ? (
                            <div className="space-y-2 mt-2">
                              <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Authentication</label>
                              {chatgptAuth.authenticated ? (
                                <div className="flex items-center justify-between px-2 py-1.5 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
                                  <span className="text-xs text-green-700 dark:text-green-400">
                                    Signed in{chatgptAuth.email ? ` as ${chatgptAuth.email}` : ''}
                                  </span>
                                  <button
                                    onClick={handleChatgptSignOut}
                                    className="text-[10px] text-red-500 hover:text-red-700 font-medium"
                                  >
                                    Sign Out
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={handleChatgptSignIn}
                                  disabled={chatgptAuthLoading}
                                  className="w-full px-3 py-2 text-sm bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white rounded-md font-medium transition-colors"
                                >
                                  {chatgptAuthLoading ? 'Signing in...' : 'Sign In with ChatGPT'}
                                </button>
                              )}
                            </div>
                          ) : (
                            <ProviderCredentialPanel
                              provider={p}
                              onProviderUpdate={(patch) => updateProvider(p.id, patch)}
                              apiKeyPlaceholder={meta.placeholder.apiKey}
                            />
                          )}
                          {(p.credentialStorage ?? 'app') !== 'agent' && <>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Default Model</label>
                            {(() => {
                              const cache = modelOptionsCache[p.id]
                              const isCustom = customModelEntry[p.id] ?? !cache?.models?.length
                              if (cache?.loading) {
                                return <div className="px-2 py-1.5 text-sm text-neutral-400 dark:text-neutral-500">Loading models...</div>
                              }
                              if (isCustom) {
                                return (
                                  <div className="flex gap-1">
                                    <input
                                      type="text"
                                      value={p.defaultModel ?? ''}
                                      onChange={(e) => updateProvider(p.id, { defaultModel: e.target.value })}
                                      placeholder={meta.placeholder.model}
                                      className="flex-1 px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                    />
                                    {cache?.models?.length ? (
                                      <button
                                        className="text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap"
                                        onClick={() => setCustomModelEntry((prev) => ({ ...prev, [p.id]: false }))}
                                      >
                                        Pick from list
                                      </button>
                                    ) : (
                                      <button
                                        className="text-[10px] text-blue-500 hover:text-blue-700 whitespace-nowrap"
                                        onClick={() => fetchModelsForProvider(p.id)}
                                      >
                                        Fetch models
                                      </button>
                                    )}
                                  </div>
                                )
                              }
                              return (
                                <select
                                  value={cache.models.includes(p.defaultModel ?? '') ? p.defaultModel : '__custom__'}
                                  onChange={(e) => {
                                    if (e.target.value === '__custom__') {
                                      setCustomModelEntry((prev) => ({ ...prev, [p.id]: true }))
                                    } else {
                                      updateProvider(p.id, { defaultModel: e.target.value })
                                    }
                                  }}
                                  className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                >
                                  {cache.models.map((m) => (
                                    <option key={m} value={m}>{m}</option>
                                  ))}
                                  {p.defaultModel && !cache.models.includes(p.defaultModel) && (
                                    <option value={p.defaultModel}>{p.defaultModel} (current)</option>
                                  )}
                                  <option value="__custom__">Custom...</option>
                                </select>
                              )
                            })()}
                            {modelOptionsCache[p.id]?.error && (
                              <p className="text-[10px] text-red-400 mt-0.5">{modelOptionsCache[p.id].error}</p>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-0.5">Request Delay (ms)</label>
                            <input
                              type="number"
                              min={0}
                              step={100}
                              value={p.requestDelayMs ?? 0}
                              onChange={(e) => updateProvider(p.id, { requestDelayMs: Math.max(0, parseInt(e.target.value) || 0) })}
                              placeholder="0"
                              className="w-full px-2 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                            />
                            <p className="text-[10px] text-neutral-400 mt-0.5">Delay before each LLM request to avoid rate limits (0 = no delay)</p>
                          </div>
                          {p.type === 'openai-compatible' && (
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="block text-xs text-neutral-500 dark:text-neutral-400">Parameters</label>
                                <button
                                  onClick={() => addParam(p.id)}
                                  className="text-[11px] text-blue-500 hover:text-blue-700 font-medium"
                                >
                                  + Add
                                </button>
                              </div>
                              {(p.params ?? []).length > 0 && (
                                <div className="space-y-1.5">
                                  {(p.params ?? []).map((param, j) => (
                                    <div key={j} className="flex gap-1.5 items-center">
                                      <input
                                        type="text"
                                        value={param.key}
                                        onChange={(e) => updateParam(p.id, j, { key: e.target.value })}
                                        placeholder="key"
                                        className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                      />
                                      <input
                                        type="text"
                                        value={param.value}
                                        onChange={(e) => updateParam(p.id, j, { value: e.target.value })}
                                        placeholder="blank = null"
                                        className="flex-1 px-2 py-1 text-xs font-mono border border-neutral-300 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-100 rounded-md focus:outline-none focus:border-blue-400"
                                      />
                                      <button
                                        onClick={() => removeParam(p.id, j)}
                                        className="text-xs text-red-400 hover:text-red-600 px-1"
                                      >
                                        &times;
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          </>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          </>}

          {/* MCPs tab */}
          {activeTab === 'mcps' && <>
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <McpStatusDashboard
              mcpServers={mcpServers}
              onServersChanged={setMcpServers}
            />
          </div>
          </>}

          {/* Channels tab */}
          {activeTab === 'channels' && <>
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <AdapterStatusDashboard
              adapters={adapterRegistrations}
              onAdaptersChanged={setAdapterRegistrations}
            />
          </div>
          </>}

          {/* Networking tab */}
          {activeTab === 'networking' && <>
          {/* Mesh auto-start */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Mesh
                </label>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">
                  Automatically enable the mesh network on startup
                </p>
              </div>
              <button
                onClick={async () => {
                  const next = !meshAutoStart
                  setMeshAutoStart(next)
                  await window.adfApi?.setSettings({ meshEnabled: next })
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  meshAutoStart
                    ? 'text-red-500 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20'
                    : 'text-blue-500 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/20'
                }`}
              >
                {meshAutoStart ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>

          {/* Server Status */}
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2 h-2 rounded-full ${meshServerStatus.running ? 'bg-green-500' : 'bg-red-400'}`} />
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {meshServerStatus.running
                  ? `Server running on ${meshServerStatus.host === '0.0.0.0' ? 'all interfaces' : meshServerStatus.host}, port ${meshServerStatus.port}`
                  : 'Server stopped'}
              </label>
              <button
                onClick={async () => {
                  const res = meshServerStatus.running
                    ? await window.adfApi?.stopMeshServer()
                    : await window.adfApi?.startMeshServer()
                  if (res) {
                    setMeshServerStatus({ running: res.running ?? false, port: res.port ?? meshServerStatus.port, host: res.host ?? meshServerStatus.host })
                  }
                }}
                className={`ml-auto text-xs px-3 py-1 rounded border ${
                  meshServerStatus.running
                    ? 'border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    : 'border-green-300 dark:border-green-700 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'
                }`}
              >
                {meshServerStatus.running ? 'Stop' : 'Start'}
              </button>
            </div>
            {meshServerStatus.running && (
              <p className="text-xs text-neutral-400 dark:text-neutral-500 font-mono">
                http://{meshServerStatus.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'}:{meshServerStatus.port}
              </p>
            )}

            {/* LAN addresses — reachable URLs when bound to 0.0.0.0 */}
            {lanInfo.addresses.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                    LAN addresses
                  </span>
                  {lanInfo.hostname && (
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono">
                      {lanInfo.hostname}
                    </span>
                  )}
                </div>
                {!meshLan && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mb-1">
                    Server is bound to 127.0.0.1 — enable "Allow LAN access" below to reach these from other devices.
                  </p>
                )}
                <div className="space-y-1">
                  {lanInfo.addresses.map((addr) => {
                    const display = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
                    const url = `http://${display}:${meshServerStatus.port}`
                    return (
                      <div key={`${addr.iface}-${addr.address}`} className="flex items-center gap-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 font-mono truncate max-w-[140px]" title={addr.iface}>
                          {addr.iface}
                        </span>
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-500 uppercase">
                          {addr.family}
                        </span>
                        {meshServerStatus.running && meshLan ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-500 hover:text-blue-700 font-mono truncate"
                          >
                            {url}
                          </a>
                        ) : (
                          <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono truncate">
                            {addr.address}
                          </span>
                        )}
                        <button
                          onClick={() => navigator.clipboard?.writeText(meshServerStatus.running && meshLan ? url : addr.address)}
                          className="text-[10px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 ml-auto"
                          title="Copy"
                        >
                          copy
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* LAN Access toggle */}
            <label className="flex items-center gap-2 cursor-pointer mt-3">
              <input
                type="checkbox"
                checked={meshLan}
                disabled={meshRestarting}
                onChange={async (e) => {
                  const lan = e.target.checked
                  setMeshLan(lan)
                  await window.adfApi?.setSettings({ meshLan: lan })
                  if (meshServerStatus.running) await restartMeshServer()
                }}
                className="rounded text-blue-500"
              />
              <span className="text-xs text-neutral-600 dark:text-neutral-300">Allow LAN access</span>
              {meshRestarting && (
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">restarting…</span>
              )}
            </label>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 ml-5">
              Binds to 0.0.0.0 instead of 127.0.0.1. Binding also flips to LAN automatically if any agent has <code>messaging.visibility = "lan"</code>.
            </p>

            {/* Agents currently declaring LAN visibility — live view, reused by mDNS toggle later. */}
            <LanAgentsList agents={meshAgents} />

            {/* Remote runtimes discovered via mDNS. Updates live via MESH_EVENT. */}
            <DiscoveredRuntimesList />

            {/* Port */}
            <label className="flex items-center gap-2 mt-3">
              <span className="text-xs text-neutral-600 dark:text-neutral-300">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={meshPort}
                disabled={meshRestarting}
                onChange={async (e) => {
                  const port = parseInt(e.target.value, 10)
                  if (!isNaN(port) && port >= 1 && port <= 65535) {
                    setMeshPort(port)
                    await window.adfApi?.setSettings({ meshPort: port })
                  }
                }}
                onBlur={async () => {
                  if (meshServerStatus.running && meshPort !== meshServerStatus.port) {
                    await restartMeshServer()
                  }
                }}
                className="w-20 px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
              />
            </label>
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-1 ml-0">
              Server restarts when you leave the field.
            </p>
          </div>

          {/* Agent Endpoints */}
          {meshEnabled && (
          <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
              Agent Endpoints ({meshAgents.length})
            </label>
            {meshAgents.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                No agents serving. Start agents in a tracked directory to see them here.
              </p>
            ) : (
              <div className="space-y-2">
                {meshAgents.map((agent) => {
                  const url = meshServerStatus.running
                    ? `http://127.0.0.1:${meshServerStatus.port}/${agent.handle ?? ''}`
                    : null
                  return (
                    <div
                      key={agent.filePath}
                      className="flex items-center justify-between gap-2 p-2 rounded-lg border border-neutral-100 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/50"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {agent.icon && <span className="text-sm">{agent.icon}</span>}
                          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate">
                            {agent.handle}
                          </span>
                        </div>
                        {url && (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-blue-500 hover:text-blue-700 font-mono truncate block"
                          >
                            {url}
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {agent.publicEnabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            public
                          </span>
                        )}
                        {(agent.apiRouteCount ?? 0) > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            {agent.apiRouteCount} route{agent.apiRouteCount !== 1 ? 's' : ''}
                          </span>
                        )}
                        {(agent.sharedCount ?? 0) > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                            {agent.sharedCount} shared
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          )}
          </>}

          {/* Compute tab */}
          {activeTab === 'compute' && <>
          <ComputeTab
            computeEnvStatus={computeEnvStatus}
            setComputeEnvStatus={setComputeEnvStatus}
            computeHostAccessEnabled={computeHostAccessEnabled}
            setComputeHostAccessEnabled={setComputeHostAccessEnabled}
            computeHostApproved={computeHostApproved}
            setComputeHostApproved={setComputeHostApproved}
            containerPackages={computeContainerPackages}
            setContainerPackages={setComputeContainerPackages}
            machineCpus={computeMachineCpus}
            setMachineCpus={setComputeMachineCpus}
            machineMemoryMb={computeMachineMemoryMb}
            setMachineMemoryMb={setComputeMachineMemoryMb}
            containerImage={computeContainerImage}
            setContainerImage={setComputeContainerImage}
          />
          </>}
        </div>
      </div>
    </div>
  )
}

interface InstallMethod {
  command: string
  label: string
  autoRunnable: boolean
}

interface Prerequisite {
  id: 'wsl'
  name: string
  installed: boolean
  installCommand?: string
  requiresReboot?: boolean
  description?: string
  docsUrl?: string
}

interface PodmanAvailability {
  available: boolean
  binPath?: string
  version?: string
  machineRequired: boolean
  machineRunning?: boolean
  machineExists?: boolean
  error?: string
  platform: string
  installMethods: InstallMethod[]
  prerequisites: Prerequisite[]
}

/** Compute settings tab — extracted for useEffect on mount. */
function ComputeTab({
  computeEnvStatus, setComputeEnvStatus,
  computeHostAccessEnabled, setComputeHostAccessEnabled,
  computeHostApproved, setComputeHostApproved,
  containerPackages, setContainerPackages,
  machineCpus, setMachineCpus,
  machineMemoryMb, setMachineMemoryMb,
  containerImage, setContainerImage,
}: {
  computeEnvStatus: { status: string; activeAgents: string[] }
  setComputeEnvStatus: (s: { status: string; activeAgents: string[] }) => void
  computeHostAccessEnabled: boolean
  setComputeHostAccessEnabled: (v: boolean) => void
  computeHostApproved: string[]
  setComputeHostApproved: React.Dispatch<React.SetStateAction<string[]>>
  containerPackages: string
  setContainerPackages: (v: string) => void
  machineCpus: number
  setMachineCpus: (v: number) => void
  machineMemoryMb: number
  setMachineMemoryMb: (v: number) => void
  containerImage: string
  setContainerImage: (v: string) => void
}) {
  const [availability, setAvailability] = useState<PodmanAvailability | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [setupLog, setSetupLog] = useState<string | null>(null)

  const [containers, setContainers] = useState<Array<{ name: string; status: string; running: boolean }>>([])
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null)

  const refreshAll = useCallback(() => {
    window.adfApi?.computeStatus?.().then((s: { status: string; activeAgents: string[] }) => {
      if (s) setComputeEnvStatus(s)
    })
    window.adfApi?.computeSetup?.({ step: 'check' }).then((r: { success: boolean; availability?: PodmanAvailability }) => {
      if (r?.availability) setAvailability(r.availability)
    })
    window.adfApi?.computeListContainers?.().then((r: { containers: Array<{ name: string; status: string; running: boolean }> }) => {
      if (r?.containers) setContainers(r.containers)
    })
  }, [])

  // Fetch on mount
  useEffect(() => { refreshAll() }, [])

  const runStep = async (step: 'install' | 'machine_init' | 'machine_start', label: string, installCommand?: string) => {
    setSetupBusy(true)
    setSetupError(null)
    setSetupLog(`Running: ${label}...`)
    try {
      const r = await window.adfApi?.computeSetup?.({ step, installCommand })
      if (r?.success) {
        setSetupLog(`${label} completed`)
        if (r.availability) setAvailability(r.availability)
        refreshAll()
      } else {
        setSetupError(r?.error ?? `${label} failed`)
        setSetupLog(null)
      }
    } catch (err) {
      setSetupError(String(err))
      setSetupLog(null)
    } finally {
      setSetupBusy(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setSetupLog(`Copied to clipboard: ${text}`)
  }

  // Determine setup state
  const prereqsSatisfied = (availability?.prerequisites ?? []).every((p) => p.installed)
  const needsInstall = availability && !availability.available
  const ready =
    availability?.available &&
    prereqsSatisfied &&
    (!availability.machineRequired || availability.machineRunning)

  return (
    <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4">
      <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 mb-1">Compute Environment</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        All MCP servers run inside containers for filesystem and process isolation.
        The shared container starts on app launch. Agents can optionally use an isolated container for separation from other agents.
        Installed packages persist across restarts. Use Rebuild to apply configuration changes or start fresh.
        Isolated containers are recreated when their agent restarts.
      </p>

      {/* Container list */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">Containers</h4>
          <button onClick={refreshAll} className="text-[10px] text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300">Refresh</button>
        </div>
        <div className="space-y-1.5">
          {containers.length === 0 && (
            <p className="text-[10px] text-neutral-400 dark:text-neutral-500 italic p-2">No containers running.</p>
          )}
          {containers.map((c) => {
            const isShared = c.name === 'adf-mcp'
            return (<React.Fragment key={c.name}>
              <div className="flex items-center gap-2 p-2 rounded bg-neutral-100 dark:bg-neutral-900/50">
                <span className={`w-2 h-2 shrink-0 rounded-full ${c.running ? 'bg-green-500' : 'bg-neutral-400 dark:bg-neutral-500'}`} />
                <button
                  onClick={() => setSelectedContainer(selectedContainer === c.name ? null : c.name)}
                  className="text-xs text-blue-600 dark:text-blue-400 font-mono hover:underline"
                >{c.name}</button>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${isShared ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'}`}>
                  {isShared ? 'shared' : 'isolated'}
                </span>
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{c.status}</span>
                <div className="ml-auto flex items-center gap-1">
                  {c.running ? (
                    <button
                      onClick={async () => {
                        setSetupBusy(true)
                        try { await window.adfApi?.computeStopContainer?.({ name: c.name }) }
                        finally { setSetupBusy(false); refreshAll() }
                      }}
                      disabled={setupBusy}
                      className="px-2 py-0.5 text-[10px] rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
                    >Stop</button>
                  ) : (
                    <button
                      onClick={async () => {
                        setSetupBusy(true)
                        try { await window.adfApi?.computeStartContainer?.({ name: c.name }) }
                        finally { setSetupBusy(false); refreshAll() }
                      }}
                      disabled={setupBusy}
                      className="px-2 py-0.5 text-[10px] rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                    >Start</button>
                  )}
                  <button
                    onClick={async () => {
                      setSetupBusy(true)
                      setSetupLog(`Rebuilding ${c.name}...`)
                      try {
                        if (isShared) {
                          await window.adfApi?.computeDestroy?.()
                          await window.adfApi?.computeInit?.()
                        } else {
                          await window.adfApi?.computeDestroyContainer?.({ name: c.name })
                        }
                        setSetupLog(isShared ? 'Container rebuilt' : 'Container removed. Restart the agent to recreate it.')
                      } catch { setSetupError('Rebuild failed') }
                      finally { setSetupBusy(false); refreshAll() }
                    }}
                    disabled={setupBusy}
                    className="px-2 py-0.5 text-[10px] rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                    title={isShared ? 'Destroy and recreate with current settings' : 'Destroy container. The agent will recreate it on next start.'}
                  >Rebuild</button>
                  {!isShared && !c.running && (
                    <button
                      onClick={async () => {
                        setSetupBusy(true)
                        try { await window.adfApi?.computeDestroyContainer?.({ name: c.name }) }
                        finally { setSetupBusy(false); refreshAll() }
                      }}
                      disabled={setupBusy}
                      className="px-2 py-0.5 text-[10px] rounded bg-neutral-500 text-white hover:bg-neutral-600 disabled:opacity-50"
                      title="Remove this isolated container permanently"
                    >Remove</button>
                  )}
                </div>
              </div>
            </React.Fragment>)
          })}
        </div>
      </div>

      {/* Status messages — for post-setup container operations (Rebuild etc).
          During setup, the wizard shows its own status block, so avoid duplication. */}
      {ready && setupLog && (
        <p className="mb-3 text-[10px] text-amber-600 dark:text-amber-400 font-mono">{setupLog}</p>
      )}
      {ready && setupError && (
        <p className="mb-3 text-[10px] text-red-600 dark:text-red-400 font-mono">{setupError}</p>
      )}

      {/* Setup wizard — shown when Podman needs installation or setup */}
      {availability && !ready && (
        <SetupWizard
          availability={availability}
          setupBusy={setupBusy}
          setupLog={setupLog}
          setupError={setupError}
          prereqsSatisfied={prereqsSatisfied}
          needsInstall={!!needsInstall}
          onRefresh={refreshAll}
          onInstall={(cmd) => runStep('install', cmd, cmd)}
          onMachineInit={() => runStep('machine_init', 'podman machine init')}
          onMachineStart={() => runStep('machine_start', 'podman machine start')}
          onCopy={copyToClipboard}
        />
      )}

      {/* Podman status */}
      {ready && (
        <p className="mb-3 text-[10px] text-green-700 dark:text-green-400">
          Podman v{availability?.version} ready
        </p>
      )}

      {/* Container configuration */}
      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3 mb-3">
        <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Container Configuration</h4>
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mb-3">
          Applies to new containers and rebuilds. Uses apt-get for Debian-based images, apk for Alpine.
        </p>

        <div className="space-y-3">
          {/* Base image */}
          <div>
            <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">Base image</label>
            <input
              type="text"
              value={containerImage}
              onChange={(e) => setContainerImage(e.target.value)}
              className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 font-mono"
              placeholder="docker.io/library/node:20-alpine"
            />
          </div>

          {/* Packages */}
          <div>
            <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">System packages (comma-separated)</label>
            <input
              type="text"
              value={containerPackages}
              onChange={(e) => setContainerPackages(e.target.value)}
              className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200 font-mono"
              placeholder="python3, py3-pip, git, curl"
            />
          </div>

          {/* Machine resources (macOS/Windows only) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">VM CPUs</label>
              <input
                type="number"
                min={1}
                max={16}
                value={machineCpus}
                onChange={(e) => setMachineCpus(Math.max(1, parseInt(e.target.value) || 2))}
                className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
              />
            </div>
            <div>
              <label className="text-[10px] text-neutral-600 dark:text-neutral-400 block mb-1">VM Memory (MB)</label>
              <input
                type="number"
                min={512}
                max={32768}
                step={256}
                value={machineMemoryMb}
                onChange={(e) => setMachineMemoryMb(Math.max(512, parseInt(e.target.value) || 2048))}
                className="w-full px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
              />
            </div>
          </div>
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
            VM resources apply to macOS/Windows (Podman machine). On Linux, containers use host resources directly.
          </p>

        </div>
      </div>

      {/* Host access toggle */}
      <div className="border-t border-neutral-200 dark:border-neutral-700 pt-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={computeHostAccessEnabled}
            onChange={(e) => setComputeHostAccessEnabled(e.target.checked)}
            className="rounded text-blue-500"
          />
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Enable host access</span>
        </label>
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-1 ml-5">
          When enabled, MCP servers that request host access can be individually approved below.
        </p>
      </div>

      {/* Approved servers list */}
      {computeHostAccessEnabled && (
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <h4 className="text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-2">Approved Host Servers</h4>
          {computeHostApproved.length === 0 ? (
            <p className="text-[10px] text-neutral-500 dark:text-neutral-400 italic">
              No servers approved for host access. Servers requesting host access will appear here when agents use them.
            </p>
          ) : (
            <div className="space-y-1">
              {computeHostApproved.map((name) => (
                <div key={name} className="flex items-center justify-between py-1 px-2 rounded bg-neutral-100 dark:bg-neutral-900/50">
                  <span className="text-xs text-neutral-700 dark:text-neutral-300 font-mono">{name}</span>
                  <button
                    onClick={() => setComputeHostApproved((prev) => prev.filter((n) => n !== name))}
                    className="text-[10px] text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Container detail modal */}
      {selectedContainer && (() => {
        const c = containers.find((x) => x.name === selectedContainer)
        if (!c) return null
        return <ContainerDetailPanel name={c.name} running={c.running} onClose={() => setSelectedContainer(null)} />
      })()}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Setup wizard — detect-and-guide for the compute environment.
// ────────────────────────────────────────────────────────────────────────────

type StepStatus = 'done' | 'pending' | 'blocked' | 'in_progress' | 'failed'

function StatusBadge({ status, index }: { status: StepStatus; index: number }) {
  const base = 'w-4 h-4 shrink-0 rounded-full text-[10px] flex items-center justify-center font-bold'
  if (status === 'done') return <span className={`${base} bg-green-500 text-white`}>{'\u2713'}</span>
  if (status === 'failed') return <span className={`${base} bg-red-500 text-white`}>{'\u00d7'}</span>
  if (status === 'in_progress')
    return <span className={`${base} bg-blue-500 text-white animate-pulse`}>{index}</span>
  if (status === 'blocked')
    return <span className={`${base} bg-neutral-200 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500`}>{index}</span>
  return <span className={`${base} bg-neutral-300 dark:bg-neutral-600 text-neutral-600 dark:text-neutral-300`}>{index}</span>
}

function SetupWizard({
  availability,
  setupBusy,
  setupLog,
  setupError,
  prereqsSatisfied,
  needsInstall,
  onRefresh,
  onInstall,
  onMachineInit,
  onMachineStart,
  onCopy,
}: {
  availability: PodmanAvailability
  setupBusy: boolean
  setupLog: string | null
  setupError: string | null
  prereqsSatisfied: boolean
  needsInstall: boolean
  onRefresh: () => void
  onInstall: (command: string) => void
  onMachineInit: () => Promise<void> | void
  onMachineStart: () => Promise<void> | void
  onCopy: (text: string) => void
}) {
  // Step status logic ----------------------------------------------------------
  const prereqs = availability.prerequisites ?? []

  // Map each step to its current status. Order: prerequisites → podman → machine init → machine start.
  const prereqStatuses: StepStatus[] = prereqs.map((p) => (p.installed ? 'done' : 'pending'))

  const podmanStatus: StepStatus = availability.available
    ? 'done'
    : !prereqsSatisfied
      ? 'blocked'
      : 'pending'

  const machineInitStatus: StepStatus = !availability.machineRequired
    ? 'done'
    : availability.machineExists
      ? 'done'
      : !availability.available || !prereqsSatisfied
        ? 'blocked'
        : 'pending'

  const machineStartStatus: StepStatus = !availability.machineRequired
    ? 'done'
    : availability.machineRunning
      ? 'done'
      : !availability.machineExists
        ? 'blocked'
        : 'pending'

  // Render ---------------------------------------------------------------------
  return (
    <div className="mb-4 p-3 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-amber-800 dark:text-amber-300">Setup Required</h4>
        <button
          onClick={onRefresh}
          className="text-[10px] text-amber-700 dark:text-amber-300 hover:underline"
          disabled={setupBusy}
          title="Re-check the environment (use after installing WSL + reboot, etc.)"
        >
          Re-check
        </button>
      </div>
      <p className="text-[10px] text-amber-700 dark:text-amber-400 mb-3">
        The compute environment runs MCP servers and agent code inside containers.
        {availability.machineRequired && ' On macOS/Windows, a lightweight Linux VM is also required.'}
      </p>

      <div className="space-y-2">
        {/* Prerequisite steps (Windows: WSL) */}
        {prereqs.map((p, i) => (
          <PrerequisiteRow
            key={p.id}
            index={i + 1}
            status={prereqStatuses[i]}
            prereq={p}
            onCopy={onCopy}
          />
        ))}

        {/* Podman install */}
        <PodmanStep
          index={prereqs.length + 1}
          status={podmanStatus}
          availability={availability}
          needsInstall={needsInstall}
          setupBusy={setupBusy}
          onInstall={onInstall}
          onCopy={onCopy}
        />

        {/* Machine init + start (macOS/Windows only) */}
        {availability.machineRequired && (
          <>
            <MachineInitStep
              index={prereqs.length + 2}
              status={machineInitStatus}
              setupBusy={setupBusy}
              onInit={onMachineInit}
            />
            <MachineStartStep
              index={prereqs.length + 3}
              status={machineStartStatus}
              setupBusy={setupBusy}
              onStart={onMachineStart}
            />
          </>
        )}
      </div>

      {/* Status / error */}
      {setupLog && (
        <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400 font-mono">{setupLog}</p>
      )}
      {setupError && (
        <div className="mt-2 p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-[10px] text-red-700 dark:text-red-400 font-mono break-words">{setupError}</p>
        </div>
      )}
    </div>
  )
}

function PrerequisiteRow({
  index,
  status,
  prereq,
  onCopy,
}: {
  index: number
  status: StepStatus
  prereq: Prerequisite
  onCopy: (text: string) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={status} index={index} />
        <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
          Install {prereq.name}
        </span>
        {status !== 'done' && prereq.installCommand && (
          <div className="flex items-center gap-1">
            <code className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded font-mono">
              {prereq.installCommand}
            </code>
            <button
              onClick={() => onCopy(prereq.installCommand!)}
              className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-200 dark:bg-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-300 dark:hover:bg-neutral-500"
            >
              Copy
            </button>
          </div>
        )}
      </div>
      {status !== 'done' && (
        <div className="ml-6 text-[10px] text-amber-700 dark:text-amber-400 space-y-0.5">
          {prereq.description && <p>{prereq.description}</p>}
          {prereq.requiresReboot && (
            <p className="font-semibold">Reboot required after installation, then click Re-check above.</p>
          )}
          {prereq.docsUrl && (
            <a
              href={prereq.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Installation docs →
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function PodmanStep({
  index,
  status,
  availability,
  needsInstall,
  setupBusy,
  onInstall,
  onCopy,
}: {
  index: number
  status: StepStatus
  availability: PodmanAvailability
  needsInstall: boolean
  setupBusy: boolean
  onInstall: (command: string) => void
  onCopy: (text: string) => void
}) {
  const autoMethod = availability.installMethods.find((m) => m.autoRunnable)
  const manualMethods = availability.installMethods.filter((m) => !m.autoRunnable)

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={status} index={index} />
        <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
          Install Podman
          {availability.available && availability.version && (
            <span className="text-neutral-400 dark:text-neutral-500 ml-1">v{availability.version}</span>
          )}
        </span>
        {needsInstall && status === 'pending' && autoMethod && (
          <button
            onClick={() => onInstall(autoMethod.command)}
            disabled={setupBusy}
            className="px-2 py-1 text-[10px] rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {setupBusy ? 'Installing...' : autoMethod.label}
          </button>
        )}
      </div>
      {status === 'pending' && !autoMethod && manualMethods.length > 0 && (
        <div className="ml-6 space-y-1">
          {manualMethods.map((m) => (
            <div key={m.command} className="flex items-center gap-1">
              <code className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded font-mono">
                {m.command}
              </code>
              <button
                onClick={() => onCopy(m.command)}
                className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-200 dark:bg-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-300 dark:hover:bg-neutral-500"
              >
                Copy
              </button>
            </div>
          ))}
        </div>
      )}
      {status === 'blocked' && (
        <p className="ml-6 text-[10px] text-neutral-500 dark:text-neutral-400">
          Complete the prerequisite above first.
        </p>
      )}
    </div>
  )
}

function MachineInitStep({
  index,
  status,
  setupBusy,
  onInit,
}: {
  index: number
  status: StepStatus
  setupBusy: boolean
  onInit: () => Promise<void> | void
}) {
  return (
    <div className="flex items-center gap-2">
      <StatusBadge status={status} index={index} />
      <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
        Initialize Podman machine
      </span>
      {status === 'pending' && (
        <button
          onClick={onInit}
          disabled={setupBusy}
          className="px-2 py-1 text-[10px] rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {setupBusy ? 'Initializing...' : 'Initialize'}
        </button>
      )}
    </div>
  )
}

function MachineStartStep({
  index,
  status,
  setupBusy,
  onStart,
}: {
  index: number
  status: StepStatus
  setupBusy: boolean
  onStart: () => Promise<void> | void
}) {
  return (
    <div className="flex items-center gap-2">
      <StatusBadge status={status} index={index} />
      <span className="text-xs text-neutral-700 dark:text-neutral-300 flex-1">
        Start Podman machine
      </span>
      {status === 'pending' && (
        <button
          onClick={onStart}
          disabled={setupBusy}
          className="px-2 py-1 text-[10px] rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {setupBusy ? 'Starting...' : 'Start'}
        </button>
      )}
    </div>
  )
}

/** Full-screen modal for container inspection — terminal-style. */
function ContainerDetailPanel({ name, running, onClose }: { name: string; running: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'processes' | 'exec' | 'packages' | 'workspace' | 'info'>('processes')
  const [detail, setDetail] = useState<{ processes: string; packages: string; workspace: string; info: string } | null>(null)
  const [execLog, setExecLog] = useState<Array<{ timestamp: number; command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }>>([])
  const [autoRefresh, setAutoRefresh] = useState(true)

  const refresh = useCallback(() => {
    Promise.all([
      window.adfApi?.computeContainerDetail?.({ name }),
      window.adfApi?.computeExecLog?.({ name }),
    ]).then(([d, l]: [any, any]) => {
      if (d?.success) setDetail(d)
      if (l?.entries) setExecLog(l.entries)
    })
  }, [name])

  // Initial load
  useEffect(() => { refresh() }, [name])

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(refresh, tab === 'processes' ? 3000 : 5000)
    return () => clearInterval(interval)
  }, [autoRefresh, tab, refresh])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tabs = [
    { id: 'processes' as const, label: 'Processes' },
    { id: 'exec' as const, label: `Exec Log (${execLog.length})` },
    { id: 'packages' as const, label: 'Packages' },
    { id: 'workspace' as const, label: 'Workspace' },
    { id: 'info' as const, label: 'Info' },
  ]

  const termClass = 'text-[11px] text-green-400 font-mono whitespace-pre-wrap p-3 min-h-[200px]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[90vw] max-w-4xl h-[80vh] flex flex-col rounded-lg overflow-hidden shadow-2xl border border-neutral-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center gap-3 px-4 py-2 bg-neutral-900 border-b border-neutral-700 shrink-0">
          <div className="flex items-center gap-1.5">
            <button onClick={onClose} className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-400" title="Close" />
            <span className="w-3 h-3 rounded-full bg-yellow-500" />
            <span className={`w-3 h-3 rounded-full ${running ? 'bg-green-500' : 'bg-neutral-600'}`} />
          </div>
          <span className="text-xs text-neutral-300 font-mono flex-1">{name}</span>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded text-green-500 w-3 h-3"
            />
            <span className="text-[10px] text-neutral-400">Auto-refresh</span>
          </label>
          <button
            onClick={refresh}
            className="text-[10px] text-green-400 hover:text-green-300 font-mono"
          >refresh</button>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 px-3 py-1.5 bg-neutral-900 border-b border-neutral-800 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-1 text-[10px] rounded font-mono ${
                tab === t.id
                  ? 'bg-neutral-700 text-green-400'
                  : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-black">
          {!running && !detail && (
            <p className="text-[11px] text-neutral-500 italic p-3 font-mono">Container is not running.</p>
          )}

          {tab === 'processes' && (
            <pre className={termClass}>{detail?.processes || 'Loading...'}</pre>
          )}

          {tab === 'exec' && (
            execLog.length === 0 ? (
              <p className="text-[11px] text-neutral-500 italic p-3 font-mono">No exec commands recorded this session.</p>
            ) : (
              <div className="p-2 space-y-1">
                {[...execLog].reverse().map((e, i) => (
                  <div key={i} className="p-2 rounded bg-neutral-900/80 border border-neutral-800">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${e.exitCode === 0 ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-[10px] text-neutral-500 font-mono">
                        {new Date(e.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-[10px] text-neutral-600 font-mono">{e.durationMs}ms</span>
                      {e.exitCode !== 0 && <span className="text-[10px] text-red-400 font-mono">exit {e.exitCode}</span>}
                    </div>
                    <pre className="text-[11px] text-cyan-400 font-mono whitespace-pre-wrap break-all">$ {e.command}</pre>
                    {e.stdout && (
                      <pre className="text-[11px] text-green-400/80 font-mono whitespace-pre-wrap mt-1 pl-2 border-l border-neutral-700">{e.stdout}</pre>
                    )}
                    {e.stderr && (
                      <pre className="text-[11px] text-red-400/80 font-mono whitespace-pre-wrap mt-1 pl-2 border-l border-red-900">{e.stderr}</pre>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'packages' && (
            <pre className={termClass}>{detail?.packages || 'Loading...'}</pre>
          )}

          {tab === 'workspace' && (
            <pre className={termClass}>{detail?.workspace || 'Loading...'}</pre>
          )}

          {tab === 'info' && (
            <pre className={termClass}>{detail?.info || 'Loading...'}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
