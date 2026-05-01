import type { FileOperationResult, AgentStatusResult, AgentExecutionEvent, AppSettings, TrackedDirEntry, MeshStatusResult, MeshEvent, MeshDebugInfo, BackgroundAgentStatus, BackgroundAgentEvent, TokenUsageData, McpServerStatusEvent, McpCredentialFileInfo, AdapterStatusEvent, AdapterCredentialFileInfo, ProviderCredentialFileInfo, AgentConfigSummary } from '../shared/types/ipc.types'
import type { AgentConfig, AdfLogEntry, McpToolInfo, McpServerState, McpInstalledPackage, McpInstallProgress, McpServerLogEntry } from '../shared/types/adf-v02.types'
import type { AdapterState, AdapterLogEntry, AdapterInstallProgress } from '../shared/types/channel-adapter.types'
import type { ChatHistory, Inbox } from '../shared/types/adf.types'
import type { ContentBlock } from '../shared/types/provider.types'

export interface AdfApi {
  // File operations
  openFile: (filePath?: string) => Promise<FileOperationResult>
  saveFile: () => Promise<FileOperationResult>
  createFile: (name: string) => Promise<FileOperationResult>
  closeFile: () => Promise<FileOperationResult>
  deleteFile: (filePath: string) => Promise<FileOperationResult>
  listTables: (filePath: string) => Promise<{ tables: Array<{ name: string; row_count: number }>; error?: string }>
  cloneFile: (filePath: string, selectedTables: string[]) => Promise<FileOperationResult>
  renameFile: (filePath: string, newName: string) => Promise<FileOperationResult>

  // Document content
  getDocument: () => Promise<{ content: string }>
  setDocument: (content: string) => Promise<{ success: boolean }>
  getMind: () => Promise<{ content: string }>
  setMind: (content: string) => Promise<{ success: boolean }>
  getAgentConfig: () => Promise<AgentConfig | null>
  setAgentConfig: (config: unknown) => Promise<{ success: boolean }>
  getChat: () => Promise<{ chatHistory: ChatHistory | null }>
  setChat: (chatHistory: ChatHistory) => Promise<{ success: boolean }>
  clearChat: () => Promise<{ success: boolean }>
  getInbox: () => Promise<{ inbox: Inbox | null }>
  clearInbox: () => Promise<{ success: boolean }>
  getBatch: () => Promise<{
    document: string
    mind: string
    agentConfig: AgentConfig | null
    chat: ChatHistory | null
    statusText?: string
  }>

  // Agent runtime
  startAgent: (filePath?: string, hasUserMessage?: boolean) => Promise<{ success: boolean; sessionId?: string; error?: string; agentState?: string }>
  stopAgent: () => Promise<{ success: boolean }>
  invokeAgent: (userMessage?: string, filePath?: string, content?: ContentBlock[]) => Promise<{ success: boolean; error?: string }>
  getAgentStatus: () => Promise<AgentStatusResult>
  respondToolApproval: (requestId: string, approved: boolean) => Promise<{ success: boolean }>
  respondAsk: (requestId: string, answer: string) => Promise<{ success: boolean }>
  respondSuspend: (resume: boolean) => Promise<{ success: boolean }>

  // Models
  listModels: (provider: string, filePath?: string) => Promise<{ models: string[]; error?: string }>

  // Events
  onAgentEvent: (callback: (event: AgentExecutionEvent) => void) => () => void

  // Settings
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: Record<string, unknown>) => Promise<{ success: boolean }>

  // Tracked directories
  getTrackedDirectories: () => Promise<{ directories: string[] }>
  addTrackedDirectory: () => Promise<{ directories: string[] }>
  removeTrackedDirectory: (dirPath: string) => Promise<{ directories: string[] }>
  scanTrackedDirectory: (dirPath: string) => Promise<{ files: TrackedDirEntry[] }>
  onTrackedDirsChanged: (callback: (event: { dirPath: string }) => void) => () => void

  // Mesh (inter-agent messaging)
  enableMesh: () => Promise<{ success: boolean; error?: string }>
  disableMesh: () => Promise<{ success: boolean; error?: string }>
  getMeshStatus: () => Promise<MeshStatusResult>
  onMeshEvent: (callback: (event: MeshEvent) => void) => () => void
  getMeshDebug: () => Promise<MeshDebugInfo>
  getMeshServerStatus: () => Promise<{ running: boolean; port: number; host: string }>
  restartMeshServer: () => Promise<{ success: boolean; running?: boolean; port?: number; host?: string; error?: string }>
  startMeshServer: () => Promise<{ success: boolean; running?: boolean; port?: number; host?: string; error?: string }>
  stopMeshServer: () => Promise<{ success: boolean; running?: boolean; port?: number; host?: string; error?: string }>
  getMeshServerLanIps: () => Promise<{ hostname: string; addresses: Array<{ iface: string; address: string; family: 'IPv4' | 'IPv6'; mac: string }> }>
  getDiscoveredRuntimes: () => Promise<Array<{
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
  }>>
  getMeshRecentTools: () => Promise<Record<string, { name: string; args?: string; isError?: boolean; timestamp: number }[]>>

  // Background agents
  startBackgroundAgent: (filePath: string) => Promise<{ success: boolean; error?: string }>
  getBackgroundAgentStatus: () => Promise<{ agents: BackgroundAgentStatus[] }>
  stopBackgroundAgent: (filePath: string) => Promise<{ success: boolean }>
  onBackgroundAgentEvent: (callback: (event: BackgroundAgentEvent) => void) => () => void
  respondBackgroundAgentAsk: (filePath: string, requestId: string, answer: string) => Promise<{ success: boolean; error?: string }>
  respondBackgroundAgentToolApproval: (filePath: string, requestId: string, approved: boolean) => Promise<{ success: boolean; error?: string }>

  // Directory bulk operations
  startAllInDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>
  stopAllInDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>

  // Tools
  getToolDescriptions: () => Promise<Record<string, unknown>>

  // Token usage tracking
  getTokenUsage: () => Promise<TokenUsageData>
  clearTokenUsage: () => Promise<{ success: boolean }>
  countTokens: (text: string, provider?: string, model?: string) => Promise<{ count: number }>
  countTokensBatch: (texts: string[], provider?: string, model?: string) => Promise<{ counts: number[] }>

  // Timers
  getTimers: () => Promise<{ timers: Array<{
    id: number
    schedule: import('../shared/types/adf-v02.types').TimerSchedule
    next_wake_at: number
    payload?: string
    scope: string[]
    lambda?: string
    warm?: boolean
    run_count: number
    created_at: number
    last_fired_at?: number
  }> }>
  addTimer: (args: {
    mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
    at?: number
    delay_ms?: number
    every_ms?: number
    start_at?: number
    end_at?: number
    max_runs?: number
    cron?: string
    scope: string[]
    lambda?: string
    warm?: boolean
    payload?: string
  }) => Promise<{ success: boolean; id?: number; error?: string }>
  updateTimer: (args: {
    id: number
    mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
    at?: number
    delay_ms?: number
    every_ms?: number
    start_at?: number
    end_at?: number
    max_runs?: number
    cron?: string
    scope: string[]
    lambda?: string
    warm?: boolean
    payload?: string
  }) => Promise<{ success: boolean; error?: string }>
  deleteTimer: (id: number) => Promise<{ success: boolean }>

  // Internal files
  getInternalFiles: () => Promise<{ files: Array<{ path: string; size: number; mime_type?: string; protection: 'read_only' | 'no_delete' | 'none'; authorized: boolean; created_at: string; updated_at: string }> }>
  uploadFile: (path: string, data: number[], mimeType?: string) => Promise<{ success: boolean }>
  importPaths: (hostPaths: string[]) => Promise<{ success: boolean; count: number }>
  pickAndImport: () => Promise<{ success: boolean; count: number }>
  deleteInternalFile: (path: string) => Promise<{ success: boolean }>
  renameInternalFile: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
  renameFolder: (oldPrefix: string, newPrefix: string) => Promise<{ success: boolean; count: number }>
  setFileProtection: (path: string, protection: 'read_only' | 'no_delete' | 'none') => Promise<{ success: boolean }>
  setFileAuthorized: (path: string, authorized: boolean) => Promise<{ success: boolean }>
  readInternalFile: (path: string) => Promise<{ content: string | null; binary: boolean }>
  writeInternalFile: (path: string, content: string) => Promise<{ success: boolean }>
  downloadInternalFile: (path: string) => Promise<{ success: boolean; error?: string }>

  // Meta
  getAllMeta: () => Promise<{ entries: Array<{ key: string; value: string; protection: 'none' | 'readonly' | 'increment' }> }>
  setMeta: (key: string, value: string, protection?: string) => Promise<{ success: boolean }>
  deleteMeta: (key: string) => Promise<{ success: boolean }>
  setMetaProtection: (key: string, protection: string) => Promise<{ success: boolean }>

  // Local tables
  listLocalTables: () => Promise<{ tables: Array<{ name: string; row_count: number }> }>
  queryLocalTable: (table: string, limit?: number, offset?: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[]; error?: string }>
  dropLocalTable: (table: string) => Promise<{ success: boolean; error?: string }>

  // Logs
  getLogs: (limit?: number) => Promise<{ logs: AdfLogEntry[]; count: number }>
  getLogsAfterId: (afterId: number) => Promise<{ logs: AdfLogEntry[] }>
  clearLogs: () => Promise<{ success: boolean }>

  // Tasks
  getTasks: (limit?: number) => Promise<{ tasks: import('../shared/types/adf-v02.types').TaskEntry[] }>

  // Inbox push updates (main -> renderer)
  onInboxUpdated: (callback: (data: { inbox: import('../shared/types/adf.types').Inbox }) => void) => () => void

  // MCP
  probeMcpServer: (args: {
    transport?: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
    name: string
    env?: Record<string, string>
    headers?: Record<string, string>
    headerEnv?: { key: string; value: string }[]
    bearerTokenEnvVar?: string
  }) =>
    Promise<{ success: boolean; error?: string; tools: McpToolInfo[] }>
  installMcpPackage: (args: { package: string; name: string }) =>
    Promise<{ success: boolean; error?: string; installed?: McpInstalledPackage }>
  uninstallMcpPackage: (args: { package: string }) =>
    Promise<{ success: boolean; error?: string }>
  listMcpInstalled: () =>
    Promise<{ packages: McpInstalledPackage[] }>
  getMcpServerStatus: () =>
    Promise<{ servers: McpServerState[] }>
  restartMcpServer: (args: { name: string }) =>
    Promise<{ success: boolean; error?: string }>
  getMcpServerLogs: (args: { name: string }) =>
    Promise<{ logs: McpServerLogEntry[] }>
  onMcpInstallProgress: (callback: (event: McpInstallProgress) => void) => () => void
  onMcpServerStatusChanged: (callback: (event: McpServerStatusEvent) => void) => () => void

  // Python MCP packages (uvx)
  installPythonMcpPackage: (args: { package: string; name: string }) =>
    Promise<{ success: boolean; error?: string; installed?: McpInstalledPackage }>
  uninstallPythonMcpPackage: (args: { package: string }) =>
    Promise<{ success: boolean; error?: string }>
  ensurePythonRuntime: () =>
    Promise<{ success: boolean; error?: string; uvAvailable: boolean; pythonAvailable: boolean; uvVersion?: string | null; uvPath?: string }>

  // Sandbox packages
  checkMissingSandboxPackages: (packages: Array<{ name: string; version: string }>) =>
    Promise<{ success: boolean; missing: Array<{ name: string; version: string }>; error?: string }>
  installSandboxPackages: (packages: Array<{ name: string; version: string }>) =>
    Promise<{ success: boolean; results: Record<string, { success: boolean; version?: string; error?: string }> }>
  onSandboxInstallProgress: (callback: (event: { package: string; status: string; progress?: string; error?: string }) => void) => () => void
  listInstalledSandboxPackages: () =>
    Promise<{ packages: Array<{ name: string; version: string; installedAt: number; size_mb: number; installedBy?: string }> }>

  // MCP Credential management (multi-ADF)
  setMcpCredential: (args: { filePath: string; npmPackage: string; envKey: string; value: string }) =>
    Promise<{ success: boolean; error?: string }>
  getMcpCredentials: (args: { filePath: string; npmPackage: string }) =>
    Promise<{ credentials: Record<string, string>; error?: string }>
  listMcpCredentialFiles: (args: { mcpServerName: string; npmPackage: string }) =>
    Promise<{ files: McpCredentialFileInfo[] }>
  attachMcpServer: (args: {
    filePath: string
    serverConfig: {
      name: string
      type?: 'npm' | 'uvx' | 'pip' | 'custom' | 'http'
      npmPackage?: string
      pypiPackage?: string
      command?: string
      args?: string[]
      url?: string
      envKeys?: string[]
      headers?: { key: string; value: string }[]
      headerEnv?: { key: string; value: string }[]
      bearerTokenEnvVar?: string
      credentialStorage?: 'app' | 'agent'
    }
  }) => Promise<{ success: boolean; alreadyAttached?: boolean; error?: string }>
  detachMcpServer: (args: {
    filePath: string
    serverName: string
    credentialNamespace: string
  }) => Promise<{ success: boolean; error?: string }>
  pickAdfFile: () =>
    Promise<{ filePath: string | null; fileName?: string }>

  // Channel Adapters
  installAdapterPackage: (args: { package: string }) =>
    Promise<{ success: boolean; error?: string; installed?: McpInstalledPackage }>
  uninstallAdapterPackage: (args: { package: string }) =>
    Promise<{ success: boolean; error?: string }>
  listAdapterInstalled: () =>
    Promise<{ packages: McpInstalledPackage[] }>
  getAdapterStatus: () =>
    Promise<{ adapters: AdapterState[] }>
  restartAdapter: (args: { type: string }) =>
    Promise<{ success: boolean; error?: string }>
  getAdapterLogs: (args: { type: string }) =>
    Promise<{ logs: AdapterLogEntry[] }>
  onAdapterInstallProgress: (callback: (event: AdapterInstallProgress) => void) => () => void
  onAdapterStatusChanged: (callback: (event: AdapterStatusEvent) => void) => () => void
  setAdapterCredential: (args: { filePath: string; adapterType: string; envKey: string; value: string }) =>
    Promise<{ success: boolean; error?: string }>
  getAdapterCredentials: (args: { filePath: string; adapterType: string }) =>
    Promise<{ credentials: Record<string, string>; error?: string }>
  listAdapterCredentialFiles: (args: { adapterType: string }) =>
    Promise<{ files: AdapterCredentialFileInfo[] }>
  attachAdapter: (args: {
    filePath: string
    adapterType: string
    config: { enabled: boolean; credential_key?: string; policy?: { dm?: string; groups?: string; allow_from?: string[] }; limits?: { max_attachment_size?: number } }
  }) => Promise<{ success: boolean; alreadyAttached?: boolean; error?: string }>
  detachAdapter: (args: { filePath: string; adapterType: string }) =>
    Promise<{ success: boolean; error?: string }>

  // Provider Credentials (per-ADF)
  setProviderCredential: (args: { filePath: string; providerId: string; value: string }) =>
    Promise<{ success: boolean; error?: string }>
  getProviderCredentials: (args: { filePath: string; providerId: string }) =>
    Promise<{
      credentials: Record<string, string>
      providerConfig?: { defaultModel?: string; params?: { key: string; value: string }[]; requestDelayMs?: number }
      error?: string
    }>
  listProviderCredentialFiles: (args: { providerId: string }) =>
    Promise<{ files: ProviderCredentialFileInfo[] }>
  attachProvider: (args: {
    filePath: string
    provider: { id: string; type: string; name: string; baseUrl: string; defaultModel?: string; params?: { key: string; value: string }[]; requestDelayMs?: number }
  }) => Promise<{ success: boolean; alreadyAttached?: boolean; error?: string }>
  detachProvider: (args: { filePath: string; providerId: string }) =>
    Promise<{ success: boolean; error?: string }>

  // Identity / Keystore
  setIdentity: (purpose: string, value: string) => Promise<void>
  getIdentity: (purpose: string) => Promise<string | null>
  deleteIdentity: (purpose: string) => Promise<void>
  deleteIdentityByPrefix: (prefix: string) => Promise<number>
  listIdentityPurposes: (prefix?: string) => Promise<string[]>

  // Identity password & encryption
  checkPassword: () => Promise<{ needsPassword: boolean }>
  unlockPassword: (password: string) => Promise<{ success: boolean; error?: string }>
  setPassword: (password: string) => Promise<{ success: boolean; error?: string }>
  removePassword: () => Promise<{ success: boolean; error?: string }>
  changePassword: (newPassword: string) => Promise<{ success: boolean; error?: string }>
  listIdentityEntries: () => Promise<{ entries: Array<{ purpose: string; encrypted: boolean; code_access: boolean }> }>
  setIdentityCodeAccess: (purpose: string, codeAccess: boolean) => Promise<{ success: boolean }>
  revealIdentity: (purpose: string) => Promise<{ value: string | null }>
  wipeAllIdentity: () => Promise<{ success: boolean }>
  getDid: () => Promise<{ did: string | null }>
  generateIdentityKeys: () => Promise<{ success: boolean; did?: string; error?: string }>
  claimAgent: () => Promise<{ success: boolean; did?: string; error?: string }>

  // Agent review (file open flow)
  checkAgentReview: () => Promise<{ needsReview: boolean; configSummary?: AgentConfigSummary }>
  acceptAgentReview: () => Promise<{ success: boolean }>

  // ChatGPT Subscription Auth
  chatgptAuthStart: () => Promise<{ success: boolean; error?: string }>
  chatgptAuthStatus: () => Promise<{ authenticated: boolean; email?: string; expiresAt?: number }>
  chatgptAuthLogout: () => Promise<{ success: boolean }>

  // Open file request (main -> renderer)
  onOpenFileRequest: (callback: (data: { filePath: string }) => void) => () => void

  // App lifecycle
  onShuttingDown: (callback: () => void) => () => void

  // Emergency stop
  emergencyStop: () => Promise<{ success: boolean; error?: string }>

  // Platform ('darwin' | 'win32' | 'linux' | ...)
  platform: NodeJS.Platform
}

declare global {
  interface Window {
    adfApi: AdfApi
  }
}
