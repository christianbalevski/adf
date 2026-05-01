export const IPC = {
  // File operations
  FILE_OPEN: 'adf:file:open',
  FILE_SAVE: 'adf:file:save',
  FILE_CREATE: 'adf:file:create',
  FILE_CLOSE: 'adf:file:close',
  FILE_DELETE: 'adf:file:delete',
  FILE_CLONE: 'adf:file:clone',
  FILE_LIST_TABLES: 'adf:file:list-tables',
  FILE_RENAME: 'adf:file:rename',

  // Document content
  DOC_GET_DOCUMENT: 'adf:doc:get-document',
  DOC_SET_DOCUMENT: 'adf:doc:set-document',
  DOC_GET_MIND: 'adf:doc:get-mind',
  DOC_SET_MIND: 'adf:doc:set-mind',
  DOC_GET_AGENT_CONFIG: 'adf:doc:get-agent-config',
  DOC_SET_AGENT_CONFIG: 'adf:doc:set-agent-config',
  DOC_GET_CHAT: 'adf:doc:get-chat',
  DOC_SET_CHAT: 'adf:doc:set-chat',
  DOC_CLEAR_CHAT: 'adf:doc:clear-chat',
  DOC_GET_INBOX: 'adf:doc:get-inbox',
  DOC_CLEAR_INBOX: 'adf:doc:clear-inbox',
  DOC_GET_OUTBOX: 'adf:doc:get-outbox',
  DOC_GET_BATCH: 'adf:doc:get-batch',

  // Agent runtime
  AGENT_START: 'adf:agent:start',
  AGENT_STOP: 'adf:agent:stop',
  AGENT_STATUS: 'adf:agent:status',
  AGENT_INVOKE: 'adf:agent:invoke',

  // Agent events (main -> renderer)
  AGENT_EVENT: 'adf:agent:event',

  // Agent tool approval (renderer -> main)
  AGENT_TOOL_APPROVAL_RESPOND: 'adf:agent:tool-approval-respond',

  // Agent ask tool (renderer -> main)
  AGENT_ASK_RESPOND: 'adf:agent:ask-respond',

  // Agent suspend (renderer -> main)
  AGENT_SUSPEND_RESPOND: 'adf:agent:suspend-respond',

  // Models
  MODELS_LIST: 'adf:models:list',

  // Settings
  SETTINGS_GET: 'adf:settings:get',
  SETTINGS_SET: 'adf:settings:set',

  // Tracked directories
  TRACKED_DIRS_GET: 'adf:tracked-dirs:get',
  TRACKED_DIRS_ADD: 'adf:tracked-dirs:add',
  TRACKED_DIRS_REMOVE: 'adf:tracked-dirs:remove',
  TRACKED_DIRS_SCAN: 'adf:tracked-dirs:scan',
  TRACKED_DIRS_CHANGED: 'adf:tracked-dirs:changed',

  // Mesh (inter-agent messaging)
  MESH_ENABLE: 'adf:mesh:enable',
  MESH_DISABLE: 'adf:mesh:disable',
  MESH_STATUS: 'adf:mesh:status',
  MESH_EVENT: 'adf:mesh:event',
  MESH_DEBUG: 'adf:mesh:debug',
  MESH_GET_RECENT_TOOLS: 'adf:mesh:get-recent-tools',

  // Background agents
  BACKGROUND_AGENT_START: 'adf:background-agent:start',
  BACKGROUND_AGENT_EVENT: 'adf:background-agent:event',
  BACKGROUND_AGENT_STATUS: 'adf:background-agent:status',
  BACKGROUND_AGENT_STOP: 'adf:background-agent:stop',
  BACKGROUND_AGENT_ASK_RESPOND: 'adf:background-agent:ask-respond',
  BACKGROUND_AGENT_TOOL_APPROVAL_RESPOND: 'adf:background-agent:tool-approval-respond',

  // Directory bulk operations
  DIRECTORY_START_ALL: 'adf:directory:start-all',
  DIRECTORY_STOP_ALL: 'adf:directory:stop-all',

  // Tools
  TOOLS_DESCRIPTIONS: 'adf:tools:descriptions',

  // Token usage tracking
  TOKEN_USAGE_GET: 'adf:token-usage:get',
  TOKEN_USAGE_CLEAR: 'adf:token-usage:clear',
  TOKEN_COUNT: 'adf:token:count',
  TOKEN_COUNT_BATCH: 'adf:token:count-batch',

  // Timers (renderer -> main)
  DOC_GET_TIMERS: 'adf:doc:get-timers',
  DOC_ADD_TIMER: 'adf:doc:add-timer',
  DOC_UPDATE_TIMER: 'adf:doc:update-timer',
  DOC_DELETE_TIMER: 'adf:doc:delete-timer',

  // Internal files (renderer -> main)
  DOC_GET_FILES: 'adf:doc:get-files',
  DOC_UPLOAD_FILE: 'adf:doc:upload-file',
  DOC_IMPORT_PATHS: 'adf:doc:import-paths',
  DOC_PICK_AND_IMPORT: 'adf:doc:pick-and-import',
  DOC_DELETE_INTERNAL_FILE: 'adf:doc:delete-internal-file',
  DOC_RENAME_INTERNAL_FILE: 'adf:doc:rename-internal-file',
  DOC_RENAME_FOLDER: 'adf:doc:rename-folder',
  DOC_SET_FILE_PROTECTION: 'adf:doc:set-file-protection',
  DOC_SET_FILE_AUTHORIZED: 'adf:doc:set-file-authorized',
  DOC_READ_INTERNAL_FILE: 'adf:doc:read-internal-file',
  DOC_WRITE_INTERNAL_FILE: 'adf:doc:write-internal-file',
  DOC_DOWNLOAD_INTERNAL_FILE: 'adf:doc:download-internal-file',

  // Meta (renderer -> main)
  DOC_GET_ALL_META: 'adf:doc:get-all-meta',
  DOC_SET_META: 'adf:doc:set-meta',
  DOC_DELETE_META: 'adf:doc:delete-meta',
  DOC_SET_META_PROTECTION: 'adf:doc:set-meta-protection',

  // Logs (renderer -> main)
  DOC_GET_LOGS: 'adf:doc:get-logs',
  DOC_GET_LOGS_AFTER: 'adf:doc:get-logs-after',
  DOC_CLEAR_LOGS: 'adf:doc:clear-logs',

  // Tasks (renderer -> main)
  DOC_GET_TASKS: 'adf:doc:get-tasks',

  // Local tables (renderer -> main)
  DOC_LIST_LOCAL_TABLES: 'adf:doc:list-local-tables',
  DOC_QUERY_LOCAL_TABLE: 'adf:doc:query-local-table',
  DOC_DROP_LOCAL_TABLE: 'adf:doc:drop-local-table',

  // Inbox push (main -> renderer)
  INBOX_UPDATED: 'adf:inbox:updated',

  // MCP
  MCP_PROBE_SERVER: 'adf:mcp:probe-server',
  MCP_INSTALL_PACKAGE: 'adf:mcp:install-package',
  MCP_UNINSTALL_PACKAGE: 'adf:mcp:uninstall-package',
  MCP_LIST_INSTALLED: 'adf:mcp:list-installed',
  MCP_GET_SERVER_STATUS: 'adf:mcp:get-server-status',
  MCP_RESTART_SERVER: 'adf:mcp:restart-server',
  MCP_GET_SERVER_LOGS: 'adf:mcp:get-server-logs',
  MCP_INSTALL_PROGRESS: 'adf:mcp:install-progress',
  MCP_SERVER_STATUS_CHANGED: 'adf:mcp:server-status-changed',
  MCP_CREDENTIAL_SET: 'adf:mcp:credential-set',
  MCP_CREDENTIAL_GET: 'adf:mcp:credential-get',
  MCP_CREDENTIAL_LIST_FILES: 'adf:mcp:credential-list-files',
  MCP_ATTACH_SERVER: 'adf:mcp:attach-server',
  MCP_DETACH_SERVER: 'adf:mcp:detach-server',
  MCP_PICK_ADF_FILE: 'adf:mcp:pick-adf-file',
  MCP_INSTALL_PYTHON_PACKAGE: 'adf:mcp:install-python-package',
  MCP_UNINSTALL_PYTHON_PACKAGE: 'adf:mcp:uninstall-python-package',
  MCP_ENSURE_PYTHON_RUNTIME: 'adf:mcp:ensure-python-runtime',

  // Compute environment
  COMPUTE_STATUS: 'adf:compute:status',
  COMPUTE_INIT: 'adf:compute:init',
  COMPUTE_STOP: 'adf:compute:stop',
  COMPUTE_DESTROY: 'adf:compute:destroy',
  COMPUTE_LIST_CONTAINERS: 'adf:compute:list-containers',
  COMPUTE_STOP_CONTAINER: 'adf:compute:stop-container',
  COMPUTE_START_CONTAINER: 'adf:compute:start-container',
  COMPUTE_DESTROY_CONTAINER: 'adf:compute:destroy-container',
  COMPUTE_SETUP: 'adf:compute:setup',
  COMPUTE_CONTAINER_DETAIL: 'adf:compute:container-detail',
  COMPUTE_EXEC_LOG: 'adf:compute:exec-log',

  // Sandbox packages
  SANDBOX_CHECK_MISSING: 'adf:sandbox:check-missing',
  SANDBOX_INSTALL_PACKAGES: 'adf:sandbox:install-packages',
  SANDBOX_INSTALL_PROGRESS: 'adf:sandbox:install-progress',
  SANDBOX_LIST_INSTALLED: 'adf:sandbox:list-installed',

  // Identity / Keystore
  IDENTITY_SET: 'adf:identity:set',
  IDENTITY_GET: 'adf:identity:get',
  IDENTITY_DELETE: 'adf:identity:delete',
  IDENTITY_DELETE_PREFIX: 'adf:identity:delete-prefix',
  IDENTITY_LIST: 'adf:identity:list',

  // Identity password & encryption
  IDENTITY_PASSWORD_CHECK: 'adf:identity:password-check',
  IDENTITY_PASSWORD_UNLOCK: 'adf:identity:password-unlock',
  IDENTITY_PASSWORD_SET: 'adf:identity:password-set',
  IDENTITY_PASSWORD_REMOVE: 'adf:identity:password-remove',
  IDENTITY_PASSWORD_CHANGE: 'adf:identity:password-change',
  IDENTITY_LIST_ENTRIES: 'adf:identity:list-entries',
  IDENTITY_REVEAL: 'adf:identity:reveal',
  IDENTITY_WIPE_ALL: 'adf:identity:wipe-all',
  IDENTITY_GET_DID: 'adf:identity:get-did',
  IDENTITY_GENERATE_KEYS: 'adf:identity:generate-keys',
  IDENTITY_CLAIM: 'adf:identity:claim',
  IDENTITY_SET_CODE_ACCESS: 'adf:identity:set-code-access',

  // Channel Adapters
  ADAPTER_INSTALL_PACKAGE: 'adf:adapter:install-package',
  ADAPTER_UNINSTALL_PACKAGE: 'adf:adapter:uninstall-package',
  ADAPTER_LIST_INSTALLED: 'adf:adapter:list-installed',
  ADAPTER_GET_STATUS: 'adf:adapter:get-status',
  ADAPTER_RESTART: 'adf:adapter:restart',
  ADAPTER_GET_LOGS: 'adf:adapter:get-logs',
  ADAPTER_INSTALL_PROGRESS: 'adf:adapter:install-progress',
  ADAPTER_STATUS_CHANGED: 'adf:adapter:status-changed',
  ADAPTER_CREDENTIAL_SET: 'adf:adapter:credential-set',
  ADAPTER_CREDENTIAL_GET: 'adf:adapter:credential-get',
  ADAPTER_CREDENTIAL_LIST_FILES: 'adf:adapter:credential-list-files',
  ADAPTER_ATTACH: 'adf:adapter:attach',
  ADAPTER_DETACH: 'adf:adapter:detach',

  // Provider credentials (per-ADF)
  PROVIDER_CREDENTIAL_SET: 'adf:provider:credential-set',
  PROVIDER_CREDENTIAL_GET: 'adf:provider:credential-get',
  PROVIDER_CREDENTIAL_LIST_FILES: 'adf:provider:credential-list-files',
  PROVIDER_ATTACH: 'adf:provider:attach',
  PROVIDER_DETACH: 'adf:provider:detach',

  // ChatGPT Subscription Auth
  CHATGPT_AUTH_START: 'adf:chatgpt-auth:start',
  CHATGPT_AUTH_STATUS: 'adf:chatgpt-auth:status',
  CHATGPT_AUTH_LOGOUT: 'adf:chatgpt-auth:logout',

  // Mesh HTTP server
  MESH_SERVER_STATUS: 'adf:mesh-server:status',
  MESH_SERVER_RESTART: 'adf:mesh-server:restart',
  MESH_SERVER_START: 'adf:mesh-server:start',
  MESH_SERVER_STOP: 'adf:mesh-server:stop',
  MESH_SERVER_LAN_IPS: 'adf:mesh-server:lan-ips',

  // mDNS LAN discovery
  MESH_DISCOVERED_RUNTIMES: 'adf:mesh:discovered-runtimes',

  // Agent review (file open flow)
  FILE_CHECK_REVIEW: 'adf:file:check-review',
  FILE_REVIEW_ACCEPT: 'adf:file:review-accept',

  // Open file request (main -> renderer)
  OPEN_FILE_REQUEST: 'adf:open-file-request',

  // App lifecycle (main -> renderer)
  APP_SHUTTING_DOWN: 'adf:app:shutting-down',

  // Emergency stop
  EMERGENCY_STOP: 'adf:emergency-stop'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
