import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc-channels'
import type { AdfApi } from './api'

const api: AdfApi = {
  // File operations
  openFile: (filePath?: string) =>
    ipcRenderer.invoke(IPC.FILE_OPEN, { filePath }),
  saveFile: () => ipcRenderer.invoke(IPC.FILE_SAVE),
  createFile: (name: string) =>
    ipcRenderer.invoke(IPC.FILE_CREATE, { name }),
  closeFile: () => ipcRenderer.invoke(IPC.FILE_CLOSE),
  deleteFile: (filePath: string) =>
    ipcRenderer.invoke(IPC.FILE_DELETE, { filePath }),
  listTables: (filePath: string) =>
    ipcRenderer.invoke(IPC.FILE_LIST_TABLES, { filePath }),
  cloneFile: (filePath: string, selectedTables: string[]) =>
    ipcRenderer.invoke(IPC.FILE_CLONE, { filePath, selectedTables }),
  renameFile: (filePath: string, newName: string) =>
    ipcRenderer.invoke(IPC.FILE_RENAME, { filePath, newName }),

  // Document
  getDocument: () => ipcRenderer.invoke(IPC.DOC_GET_DOCUMENT),
  setDocument: (content: string) =>
    ipcRenderer.invoke(IPC.DOC_SET_DOCUMENT, { content }),
  getMind: () => ipcRenderer.invoke(IPC.DOC_GET_MIND),
  setMind: (content: string) =>
    ipcRenderer.invoke(IPC.DOC_SET_MIND, { content }),
  getAgentConfig: () => ipcRenderer.invoke(IPC.DOC_GET_AGENT_CONFIG),
  setAgentConfig: (config: unknown) =>
    ipcRenderer.invoke(IPC.DOC_SET_AGENT_CONFIG, config),
  getChat: () => ipcRenderer.invoke(IPC.DOC_GET_CHAT),
  setChat: (chatHistory: unknown) =>
    ipcRenderer.invoke(IPC.DOC_SET_CHAT, { chatHistory }),
  clearChat: () => ipcRenderer.invoke(IPC.DOC_CLEAR_CHAT),
  getInbox: () => ipcRenderer.invoke(IPC.DOC_GET_INBOX),
  clearInbox: () => ipcRenderer.invoke(IPC.DOC_CLEAR_INBOX),
  getOutbox: () => ipcRenderer.invoke(IPC.DOC_GET_OUTBOX),
  getBatch: () => ipcRenderer.invoke(IPC.DOC_GET_BATCH),

  // Agent
  startAgent: (filePath?: string, hasUserMessage?: boolean) => ipcRenderer.invoke(IPC.AGENT_START, { filePath, hasUserMessage }),
  stopAgent: () => ipcRenderer.invoke(IPC.AGENT_STOP),
  invokeAgent: (userMessage?: string, filePath?: string, content?: unknown) =>
    ipcRenderer.invoke(IPC.AGENT_INVOKE, { userMessage, filePath, content }),
  getAgentStatus: () => ipcRenderer.invoke(IPC.AGENT_STATUS),
  respondToolApproval: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke(IPC.AGENT_TOOL_APPROVAL_RESPOND, { requestId, approved }),
  respondAsk: (requestId: string, answer: string) =>
    ipcRenderer.invoke(IPC.AGENT_ASK_RESPOND, { requestId, answer }),
  respondSuspend: (resume: boolean) =>
    ipcRenderer.invoke(IPC.AGENT_SUSPEND_RESPOND, { resume }),

  // Models
  listModels: (provider: string, filePath?: string) =>
    ipcRenderer.invoke(IPC.MODELS_LIST, { provider, filePath }),

  // Events (main -> renderer)
  onAgentEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.AGENT_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_EVENT, handler)
  },

  // Settings
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, settings),

  // Tracked directories
  getTrackedDirectories: () => ipcRenderer.invoke(IPC.TRACKED_DIRS_GET),
  addTrackedDirectory: () => ipcRenderer.invoke(IPC.TRACKED_DIRS_ADD),
  removeTrackedDirectory: (dirPath: string) =>
    ipcRenderer.invoke(IPC.TRACKED_DIRS_REMOVE, { dirPath }),
  scanTrackedDirectory: (dirPath: string) =>
    ipcRenderer.invoke(IPC.TRACKED_DIRS_SCAN, { dirPath }),
  onTrackedDirsChanged: (callback: (event: { dirPath: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { dirPath: string }) =>
      callback(data)
    ipcRenderer.on(IPC.TRACKED_DIRS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.TRACKED_DIRS_CHANGED, handler)
  },

  // Mesh (inter-agent messaging)
  enableMesh: () => ipcRenderer.invoke(IPC.MESH_ENABLE),
  disableMesh: () => ipcRenderer.invoke(IPC.MESH_DISABLE),
  getMeshStatus: () => ipcRenderer.invoke(IPC.MESH_STATUS),
  onMeshEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.MESH_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.MESH_EVENT, handler)
  },
  getMeshDebug: () =>
    ipcRenderer.invoke(IPC.MESH_STATUS, { debug: true }),
  getMeshServerStatus: () =>
    ipcRenderer.invoke(IPC.MESH_SERVER_STATUS),
  restartMeshServer: () =>
    ipcRenderer.invoke(IPC.MESH_SERVER_RESTART),
  startMeshServer: () =>
    ipcRenderer.invoke(IPC.MESH_SERVER_START),
  stopMeshServer: () =>
    ipcRenderer.invoke(IPC.MESH_SERVER_STOP),
  getMeshServerLanIps: () =>
    ipcRenderer.invoke(IPC.MESH_SERVER_LAN_IPS),
  getDiscoveredRuntimes: () =>
    ipcRenderer.invoke(IPC.MESH_DISCOVERED_RUNTIMES),
  getMeshRecentTools: () =>
    ipcRenderer.invoke(IPC.MESH_GET_RECENT_TOOLS) as Promise<Record<string, { name: string; args?: string; isError?: boolean; timestamp: number }[]>>,

  // Background agents
  startBackgroundAgent: (filePath: string) =>
    ipcRenderer.invoke(IPC.BACKGROUND_AGENT_START, { filePath }),
  getBackgroundAgentStatus: () =>
    ipcRenderer.invoke(IPC.BACKGROUND_AGENT_STATUS),
  stopBackgroundAgent: (filePath: string) =>
    ipcRenderer.invoke(IPC.BACKGROUND_AGENT_STOP, { filePath }),
  onBackgroundAgentEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.BACKGROUND_AGENT_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.BACKGROUND_AGENT_EVENT, handler)
  },
  respondBackgroundAgentAsk: (filePath: string, requestId: string, answer: string) =>
    ipcRenderer.invoke(IPC.BACKGROUND_AGENT_ASK_RESPOND, { filePath, requestId, answer }),
  respondBackgroundAgentToolApproval: (filePath: string, requestId: string, approved: boolean) =>
    ipcRenderer.invoke(IPC.BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND, { filePath, requestId, approved }),

  // Directory bulk operations
  startAllInDirectory: (dirPath: string) =>
    ipcRenderer.invoke(IPC.DIRECTORY_START_ALL, { dirPath }),
  stopAllInDirectory: (dirPath: string) =>
    ipcRenderer.invoke(IPC.DIRECTORY_STOP_ALL, { dirPath }),

  // Tools
  getToolDescriptions: () => ipcRenderer.invoke(IPC.TOOLS_DESCRIPTIONS),

  // Token usage tracking
  getTokenUsage: () => ipcRenderer.invoke(IPC.TOKEN_USAGE_GET),
  clearTokenUsage: () => ipcRenderer.invoke(IPC.TOKEN_USAGE_CLEAR),
  countTokens: (text: string, provider?: string, model?: string) =>
    ipcRenderer.invoke(IPC.TOKEN_COUNT, { text, provider, model }),
  countTokensBatch: (texts: string[], provider?: string, model?: string) =>
    ipcRenderer.invoke(IPC.TOKEN_COUNT_BATCH, { texts, provider, model }),

  // Timers
  getTimers: () => ipcRenderer.invoke(IPC.DOC_GET_TIMERS),
  addTimer: (args: {
    mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
    at?: number; delay_ms?: number; every_ms?: number
    start_at?: number; end_at?: number; max_runs?: number
    cron?: string; scope: string[]; lambda?: string; warm?: boolean; payload?: string
  }) => ipcRenderer.invoke(IPC.DOC_ADD_TIMER, args),
  updateTimer: (args: {
    id: number
    mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
    at?: number; delay_ms?: number; every_ms?: number
    start_at?: number; end_at?: number; max_runs?: number
    cron?: string; scope: string[]; lambda?: string; warm?: boolean; payload?: string
  }) => ipcRenderer.invoke(IPC.DOC_UPDATE_TIMER, args),
  deleteTimer: (id: number) =>
    ipcRenderer.invoke(IPC.DOC_DELETE_TIMER, { id }),

  // Internal files
  getInternalFiles: () => ipcRenderer.invoke(IPC.DOC_GET_FILES),
  uploadFile: (path: string, data: number[], mimeType?: string) =>
    ipcRenderer.invoke(IPC.DOC_UPLOAD_FILE, { path, data, mimeType }),
  importPaths: (hostPaths: string[]) =>
    ipcRenderer.invoke(IPC.DOC_IMPORT_PATHS, { paths: hostPaths }),
  pickAndImport: () =>
    ipcRenderer.invoke(IPC.DOC_PICK_AND_IMPORT),
  deleteInternalFile: (path: string) =>
    ipcRenderer.invoke(IPC.DOC_DELETE_INTERNAL_FILE, { path }),
  renameInternalFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke(IPC.DOC_RENAME_INTERNAL_FILE, { oldPath, newPath }),
  renameFolder: (oldPrefix: string, newPrefix: string) =>
    ipcRenderer.invoke(IPC.DOC_RENAME_FOLDER, { oldPrefix, newPrefix }),
  setFileProtection: (path: string, protection: 'read_only' | 'no_delete' | 'none') =>
    ipcRenderer.invoke(IPC.DOC_SET_FILE_PROTECTION, { path, protection }),
  setFileAuthorized: (path: string, authorized: boolean) =>
    ipcRenderer.invoke(IPC.DOC_SET_FILE_AUTHORIZED, { path, authorized }),
  readInternalFile: (path: string) =>
    ipcRenderer.invoke(IPC.DOC_READ_INTERNAL_FILE, { path }),
  writeInternalFile: (path: string, content: string) =>
    ipcRenderer.invoke(IPC.DOC_WRITE_INTERNAL_FILE, { path, content }),
  downloadInternalFile: (path: string) =>
    ipcRenderer.invoke(IPC.DOC_DOWNLOAD_INTERNAL_FILE, { path }),

  // Meta
  getAllMeta: () => ipcRenderer.invoke(IPC.DOC_GET_ALL_META),
  setMeta: (key: string, value: string, protection?: string) =>
    ipcRenderer.invoke(IPC.DOC_SET_META, { key, value, protection }),
  deleteMeta: (key: string) =>
    ipcRenderer.invoke(IPC.DOC_DELETE_META, { key }),
  setMetaProtection: (key: string, protection: string) =>
    ipcRenderer.invoke(IPC.DOC_SET_META_PROTECTION, { key, protection }),

  // Logs
  getLogs: (limit?: number) =>
    ipcRenderer.invoke(IPC.DOC_GET_LOGS, { limit }),
  getLogsAfterId: (afterId: number) =>
    ipcRenderer.invoke(IPC.DOC_GET_LOGS_AFTER, { afterId }),
  clearLogs: () =>
    ipcRenderer.invoke(IPC.DOC_CLEAR_LOGS),

  // Tasks
  getTasks: (limit?: number) =>
    ipcRenderer.invoke(IPC.DOC_GET_TASKS, { limit }),

  // Local tables
  listLocalTables: () => ipcRenderer.invoke(IPC.DOC_LIST_LOCAL_TABLES),
  queryLocalTable: (table: string, limit?: number, offset?: number) =>
    ipcRenderer.invoke(IPC.DOC_QUERY_LOCAL_TABLE, { table, limit, offset }),
  dropLocalTable: (table: string) =>
    ipcRenderer.invoke(IPC.DOC_DROP_LOCAL_TABLE, { table }),

  // Inbox push updates (main -> renderer)
  onInboxUpdated: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.INBOX_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC.INBOX_UPDATED, handler)
  },

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
    ipcRenderer.invoke(IPC.MCP_PROBE_SERVER, args),
  installMcpPackage: (args: { package: string; name: string }) =>
    ipcRenderer.invoke(IPC.MCP_INSTALL_PACKAGE, args),
  uninstallMcpPackage: (args: { package: string }) =>
    ipcRenderer.invoke(IPC.MCP_UNINSTALL_PACKAGE, args),
  listMcpInstalled: () =>
    ipcRenderer.invoke(IPC.MCP_LIST_INSTALLED),
  getMcpServerStatus: () =>
    ipcRenderer.invoke(IPC.MCP_GET_SERVER_STATUS),
  restartMcpServer: (args: { name: string }) =>
    ipcRenderer.invoke(IPC.MCP_RESTART_SERVER, args),
  getMcpServerLogs: (args: { name: string }) =>
    ipcRenderer.invoke(IPC.MCP_GET_SERVER_LOGS, args),
  onMcpInstallProgress: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.MCP_INSTALL_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.MCP_INSTALL_PROGRESS, handler)
  },
  onMcpServerStatusChanged: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.MCP_SERVER_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.MCP_SERVER_STATUS_CHANGED, handler)
  },

  // Compute environment
  computeStatus: () =>
    ipcRenderer.invoke(IPC.COMPUTE_STATUS),
  computeInit: () =>
    ipcRenderer.invoke(IPC.COMPUTE_INIT),
  computeStop: () =>
    ipcRenderer.invoke(IPC.COMPUTE_STOP),
  computeDestroy: () =>
    ipcRenderer.invoke(IPC.COMPUTE_DESTROY),
  computeListContainers: () =>
    ipcRenderer.invoke(IPC.COMPUTE_LIST_CONTAINERS),
  computeStopContainer: (args: { name: string }) =>
    ipcRenderer.invoke(IPC.COMPUTE_STOP_CONTAINER, args),
  computeStartContainer: (args: { name: string }) =>
    ipcRenderer.invoke(IPC.COMPUTE_START_CONTAINER, args),
  computeDestroyContainer: (args: { name: string }) =>
    ipcRenderer.invoke(IPC.COMPUTE_DESTROY_CONTAINER, args),
  computeSetup: (args: { step: 'install' | 'machine_init' | 'machine_start' | 'check'; installCommand?: string }) =>
    ipcRenderer.invoke(IPC.COMPUTE_SETUP, args),
  computeContainerDetail: (args: { name: string }) =>
    ipcRenderer.invoke(IPC.COMPUTE_CONTAINER_DETAIL, args),
  computeExecLog: (args: { name?: string }) =>
    ipcRenderer.invoke(IPC.COMPUTE_EXEC_LOG, args),

  // Python MCP packages (uvx)
  installPythonMcpPackage: (args: { package: string; name: string }) =>
    ipcRenderer.invoke(IPC.MCP_INSTALL_PYTHON_PACKAGE, args),
  uninstallPythonMcpPackage: (args: { package: string }) =>
    ipcRenderer.invoke(IPC.MCP_UNINSTALL_PYTHON_PACKAGE, args),
  ensurePythonRuntime: () =>
    ipcRenderer.invoke(IPC.MCP_ENSURE_PYTHON_RUNTIME),

  // Sandbox packages
  checkMissingSandboxPackages: (packages: Array<{ name: string; version: string }>) =>
    ipcRenderer.invoke(IPC.SANDBOX_CHECK_MISSING, packages),
  installSandboxPackages: (packages: Array<{ name: string; version: string }>) =>
    ipcRenderer.invoke(IPC.SANDBOX_INSTALL_PACKAGES, packages),
  onSandboxInstallProgress: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.SANDBOX_INSTALL_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.SANDBOX_INSTALL_PROGRESS, handler)
  },
  listInstalledSandboxPackages: () =>
    ipcRenderer.invoke(IPC.SANDBOX_LIST_INSTALLED),

  // MCP Credential management (multi-ADF)
  setMcpCredential: (args: { filePath: string; npmPackage: string; envKey: string; value: string }) =>
    ipcRenderer.invoke(IPC.MCP_CREDENTIAL_SET, args),
  getMcpCredentials: (args: { filePath: string; npmPackage: string }) =>
    ipcRenderer.invoke(IPC.MCP_CREDENTIAL_GET, args),
  listMcpCredentialFiles: (args: { mcpServerName: string; npmPackage: string }) =>
    ipcRenderer.invoke(IPC.MCP_CREDENTIAL_LIST_FILES, args),
  attachMcpServer: (args: { filePath: string; serverConfig: { name: string; npmPackage?: string; command?: string; args?: string[]; envKeys?: string[] } }) =>
    ipcRenderer.invoke(IPC.MCP_ATTACH_SERVER, args),
  detachMcpServer: (args: { filePath: string; serverName: string; credentialNamespace: string }) =>
    ipcRenderer.invoke(IPC.MCP_DETACH_SERVER, args),
  pickAdfFile: () =>
    ipcRenderer.invoke(IPC.MCP_PICK_ADF_FILE),

  // Channel Adapters
  installAdapterPackage: (args: { package: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_INSTALL_PACKAGE, args),
  uninstallAdapterPackage: (args: { package: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_UNINSTALL_PACKAGE, args),
  listAdapterInstalled: () =>
    ipcRenderer.invoke(IPC.ADAPTER_LIST_INSTALLED),
  getAdapterStatus: () =>
    ipcRenderer.invoke(IPC.ADAPTER_GET_STATUS),
  restartAdapter: (args: { type: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_RESTART, args),
  getAdapterLogs: (args: { type: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_GET_LOGS, args),
  onAdapterInstallProgress: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.ADAPTER_INSTALL_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.ADAPTER_INSTALL_PROGRESS, handler)
  },
  onAdapterStatusChanged: (callback: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data)
    ipcRenderer.on(IPC.ADAPTER_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.ADAPTER_STATUS_CHANGED, handler)
  },
  setAdapterCredential: (args: { filePath: string; adapterType: string; envKey: string; value: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_CREDENTIAL_SET, args),
  getAdapterCredentials: (args: { filePath: string; adapterType: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_CREDENTIAL_GET, args),
  listAdapterCredentialFiles: (args: { adapterType: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_CREDENTIAL_LIST_FILES, args),
  attachAdapter: (args: { filePath: string; adapterType: string; config: { enabled: boolean; credential_key?: string; policy?: { dm?: string; groups?: string; allow_from?: string[] }; limits?: { max_attachment_size?: number } } }) =>
    ipcRenderer.invoke(IPC.ADAPTER_ATTACH, args),
  detachAdapter: (args: { filePath: string; adapterType: string }) =>
    ipcRenderer.invoke(IPC.ADAPTER_DETACH, args),

  // Provider Credentials (per-ADF)
  setProviderCredential: (args: { filePath: string; providerId: string; value: string }) =>
    ipcRenderer.invoke(IPC.PROVIDER_CREDENTIAL_SET, args),
  getProviderCredentials: (args: { filePath: string; providerId: string }) =>
    ipcRenderer.invoke(IPC.PROVIDER_CREDENTIAL_GET, args),
  listProviderCredentialFiles: (args: { providerId: string }) =>
    ipcRenderer.invoke(IPC.PROVIDER_CREDENTIAL_LIST_FILES, args),
  attachProvider: (args: { filePath: string; provider: { id: string; type: string; name: string; baseUrl: string; defaultModel?: string; params?: { key: string; value: string }[]; requestDelayMs?: number } }) =>
    ipcRenderer.invoke(IPC.PROVIDER_ATTACH, args),
  detachProvider: (args: { filePath: string; providerId: string }) =>
    ipcRenderer.invoke(IPC.PROVIDER_DETACH, args),

  // Identity / Keystore
  setIdentity: (purpose: string, value: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_SET, { purpose, value }),
  getIdentity: (purpose: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_GET, { purpose }),
  deleteIdentity: (purpose: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_DELETE, { purpose }),
  deleteIdentityByPrefix: (prefix: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_DELETE_PREFIX, { prefix }),
  listIdentityPurposes: (prefix?: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_LIST, { prefix }),

  // Identity password & encryption
  checkPassword: () =>
    ipcRenderer.invoke(IPC.IDENTITY_PASSWORD_CHECK),
  unlockPassword: (password: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password }),
  setPassword: (password: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_PASSWORD_SET, { password }),
  removePassword: () =>
    ipcRenderer.invoke(IPC.IDENTITY_PASSWORD_REMOVE),
  changePassword: (newPassword: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_PASSWORD_CHANGE, { newPassword }),
  listIdentityEntries: () =>
    ipcRenderer.invoke(IPC.IDENTITY_LIST_ENTRIES),
  setIdentityCodeAccess: (purpose: string, codeAccess: boolean) =>
    ipcRenderer.invoke(IPC.IDENTITY_SET_CODE_ACCESS, { purpose, codeAccess }),
  revealIdentity: (purpose: string) =>
    ipcRenderer.invoke(IPC.IDENTITY_REVEAL, { purpose }),
  wipeAllIdentity: () =>
    ipcRenderer.invoke(IPC.IDENTITY_WIPE_ALL),
  getDid: () =>
    ipcRenderer.invoke(IPC.IDENTITY_GET_DID),
  generateIdentityKeys: () =>
    ipcRenderer.invoke(IPC.IDENTITY_GENERATE_KEYS),
  claimAgent: () =>
    ipcRenderer.invoke(IPC.IDENTITY_CLAIM),

  // Agent review (file open flow)
  checkAgentReview: () =>
    ipcRenderer.invoke(IPC.FILE_CHECK_REVIEW),
  acceptAgentReview: () =>
    ipcRenderer.invoke(IPC.FILE_REVIEW_ACCEPT),

  // ChatGPT Subscription Auth
  chatgptAuthStart: () =>
    ipcRenderer.invoke(IPC.CHATGPT_AUTH_START),
  chatgptAuthStatus: () =>
    ipcRenderer.invoke(IPC.CHATGPT_AUTH_STATUS),
  chatgptAuthLogout: () =>
    ipcRenderer.invoke(IPC.CHATGPT_AUTH_LOGOUT),

  // Open file request (main -> renderer, e.g. double-click .adf in Finder)
  onOpenFileRequest: (callback: (data: { filePath: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { filePath: string }) =>
      callback(data)
    ipcRenderer.on(IPC.OPEN_FILE_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC.OPEN_FILE_REQUEST, handler)
  },

  // App lifecycle
  onShuttingDown: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.APP_SHUTTING_DOWN, handler)
    return () => ipcRenderer.removeListener(IPC.APP_SHUTTING_DOWN, handler)
  },

  // Emergency stop
  emergencyStop: () => ipcRenderer.invoke(IPC.EMERGENCY_STOP),

  // Platform identifier ('darwin' | 'win32' | 'linux' | ...)
  platform: process.platform
}

contextBridge.exposeInMainWorld('adfApi', api)
