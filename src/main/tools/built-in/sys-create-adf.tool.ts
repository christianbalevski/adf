import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { dirname, join, resolve, isAbsolute } from 'path'
import type { Tool } from '../tool.interface'
import { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { CreateAgentOptions } from '../../../shared/types/adf-v02.types'
import { readTemplate, mergeTemplateWithOverrides } from '../../adf/adf-template'

// ---------------------------------------------------------------------------
// Reusable sub-schemas
// ---------------------------------------------------------------------------

const MiddlewareRefSchema = z.object({
  lambda: z.string()
})

const ToolTriggerTargetSchema = z.object({
  scope: z.enum(['system', 'agent']),
  lambda: z.string().optional(),
  command: z.string().optional(),
  warm: z.boolean().optional(),
  filter: z.object({
    source: z.string().optional(),
    sender: z.string().optional(),
    to: z.string().optional(),
    watch: z.string().optional(),
    tools: z.array(z.string()).optional(),
    status: z.string().optional(),
    level: z.array(z.string()).optional(),
    origin: z.array(z.string()).optional(),
    event: z.array(z.string()).optional()
  }).strict().optional(),
  debounce_ms: z.number().optional(),
  interval_ms: z.number().optional(),
  batch_ms: z.number().optional(),
  batch_count: z.number().optional(),
  locked: z.boolean().optional()
}).strict()

const ToolTriggerConfigSchema = z.object({
  enabled: z.boolean(),
  targets: z.array(ToolTriggerTargetSchema).default([]),
  locked: z.boolean().optional()
})

const AuditSchema = z.object({
  loop: z.boolean(),
  inbox: z.boolean(),
  outbox: z.boolean(),
  files: z.boolean()
})

// ---------------------------------------------------------------------------
// Main input schema — full parity with AgentConfig / CreateAgentOptions
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  name: z.string().min(1).describe('Name for the new agent.'),
  location: z
    .string()
    .optional()
    .describe(
      'Directory path where to create the .adf file. If omitted, creates in same directory as this agent.'
    ),
  description: z.string().optional().describe('Description of what the new agent does.'),
  instructions: z.string().optional().describe('System prompt for the new agent.'),
  icon: z.string().optional().describe('Single emoji or character for UI display.'),
  handle: z.string().optional().describe('URL-safe identity label for the agent.'),
  autonomous: z.boolean().optional().describe('Whether the agent runs autonomously without human approval for each turn.'),
  start_in_state: z.enum(['active', 'idle', 'hibernate']).optional().describe('Initial state for the agent. Defaults to active.'),
  autostart: z.boolean().optional().describe('Auto-start on runtime boot. Also triggers immediate background start on creation.'),

  model: z.object({
    provider: z.string().optional(),
    model_id: z.string().optional(),
    temperature: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    thinking_budget: z.number().nullable().optional(),
    vision: z.boolean().optional(),
    multimodal: z.object({
      image: z.boolean().optional(),
      audio: z.boolean().optional(),
      video: z.boolean().optional()
    }).optional(),
    params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    provider_params: z.record(z.unknown()).optional()
  }).optional().describe('Model configuration overrides.'),

  context: z.object({
    compact_threshold: z.number().nullable().optional(),
    max_loop_messages: z.number().nullable().optional(),
    audit: AuditSchema.optional(),
    dynamic_instructions: z.object({
      inbox_hints: z.boolean().optional(),
      context_warning: z.boolean().optional(),
      idle_reminder: z.boolean().optional(),
      mesh_updates: z.boolean().optional()
    }).optional()
  }).optional().describe('Context configuration overrides.'),

  tools: z.array(z.object({
    name: z.string(),
    enabled: z.boolean(),
    restricted: z.boolean().optional(),
    locked: z.boolean().optional()
  })).optional().describe('Tool enablement overrides. Merged with defaults by tool name.'),

  triggers: z.object({
    on_startup: ToolTriggerConfigSchema.optional(),
    on_inbox: ToolTriggerConfigSchema.optional(),
    on_outbox: ToolTriggerConfigSchema.optional(),
    on_file_change: ToolTriggerConfigSchema.optional(),
    on_chat: ToolTriggerConfigSchema.optional(),
    on_timer: ToolTriggerConfigSchema.optional(),
    on_tool_call: ToolTriggerConfigSchema.optional(),
    on_task_create: ToolTriggerConfigSchema.optional(),
    on_task_complete: ToolTriggerConfigSchema.optional(),
    on_logs: ToolTriggerConfigSchema.optional()
  }).optional().describe('Trigger configuration overrides per trigger type.'),

  security: z.object({
    allow_unsigned: z.boolean().optional(),
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    require_signature: z.boolean().optional(),
    require_payload_signature: z.boolean().optional(),
    middleware: z.object({
      inbox: z.array(MiddlewareRefSchema).optional(),
      outbox: z.array(MiddlewareRefSchema).optional()
    }).optional(),
    fetch_middleware: z.array(MiddlewareRefSchema).optional(),
    require_middleware_authorization: z.boolean().optional(),
    table_protections: z.record(z.enum(['none', 'append_only', 'authorized'])).optional()
  }).optional().describe('Security configuration overrides.'),

  limits: z.object({
    execution_timeout_ms: z.number().optional(),
    max_loop_rows: z.number().optional(),
    max_daily_budget_usd: z.number().nullable().optional(),
    max_file_read_tokens: z.number().optional(),
    max_file_write_bytes: z.number().optional(),
    max_tool_result_tokens: z.number().optional(),
    max_tool_result_preview_chars: z.number().optional(),
    max_active_turns: z.number().nullable().optional(),
    max_image_size_bytes: z.number().optional(),
    max_audio_size_bytes: z.number().optional(),
    max_video_size_bytes: z.number().optional(),
    suspend_timeout_ms: z.number().optional(),
    hibernate_nudge: z.object({
      enabled: z.boolean(),
      interval_ms: z.number()
    }).optional()
  }).optional().describe('Resource limit overrides.'),

  messaging: z.object({
    receive: z.boolean().optional(),
    mode: z.enum(['proactive', 'respond_only', 'listen_only']).optional(),
    inbox_mode: z.boolean().optional(),
    allow_list: z.array(z.string()).optional(),
    block_list: z.array(z.string()).optional(),
    network: z.string().optional()
  }).optional().describe('Messaging configuration overrides.'),

  audit: AuditSchema.optional().describe('Audit configuration. Controls whether cleared data is saved to the audit log.'),

  code_execution: z.object({
    model_invoke: z.boolean().optional(),
    sys_lambda: z.boolean().optional(),
    task_resolve: z.boolean().optional(),
    loop_inject: z.boolean().optional(),
    get_identity: z.boolean().optional(),
    set_identity: z.boolean().optional(),
    network: z.boolean().optional(),
    packages: z.array(z.object({ name: z.string(), version: z.string() })).optional(),
    restricted_methods: z.array(z.string()).optional()
  }).optional().describe('Code execution method toggles.'),

  logging: z.object({
    default_level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    rules: z.array(z.object({
      origin: z.string(),
      min_level: z.enum(['debug', 'info', 'warn', 'error'])
    })).optional(),
    max_rows: z.number().int().positive().nullable().optional()
  }).optional().describe('Log filtering. default_level sets the global minimum; rules override per-origin; max_rows caps the ring buffer (null = unlimited, default 10000).'),

  mcp: z.object({
    servers: z.array(z.object({
      name: z.string(),
      transport: z.enum(['stdio', 'http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string()).optional(),
      header_env: z.array(z.object({
        header: z.string(),
        env: z.string(),
        required: z.boolean().optional(),
        credential_ref: z.string().optional()
      })).optional(),
      bearer_token_env_var: z.string().optional(),
      env: z.record(z.string()).optional(),
      env_keys: z.array(z.string()).optional(),
      env_schema: z.array(z.object({
        key: z.string(),
        scope: z.enum(['agent', 'app']),
        required: z.boolean().optional(),
        description: z.string().optional(),
        credential_ref: z.string().optional()
      })).optional(),
      npm_package: z.string().optional(),
      pypi_package: z.string().optional(),
      available_tools: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.record(z.unknown())
      })).optional(),
      source: z.string().optional(),
      tool_call_timeout_ms: z.number().optional(),
      restricted: z.boolean().optional(),
      run_location: z.enum(['host', 'shared']).optional()
    }))
  }).optional().describe('MCP server configuration.'),

  adapters: z.record(z.object({
    enabled: z.boolean(),
    credential_key: z.string().optional(),
    config: z.record(z.unknown()).optional(),
    policy: z.object({
      dm: z.enum(['all', 'allowlist', 'none']).optional(),
      groups: z.enum(['all', 'mention', 'none']).optional(),
      allow_from: z.array(z.string()).optional()
    }).optional(),
    limits: z.object({
      max_attachment_size: z.number().optional()
    }).optional()
  })).optional().describe('Channel adapter configuration. Keyed by adapter type.'),

  serving: z.object({
    shared: z.object({
      enabled: z.boolean(),
      patterns: z.array(z.string()).optional()
    }).optional(),
    public: z.object({
      enabled: z.boolean(),
      index: z.string().optional()
    }).optional(),
    api: z.array(z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS']),
      path: z.string(),
      lambda: z.string(),
      warm: z.boolean().optional(),
      cache_ttl_ms: z.number().optional(),
      middleware: z.array(MiddlewareRefSchema).optional(),
      locked: z.boolean().optional()
    })).optional()
  }).optional().describe('HTTP serving configuration: shared files, public site, and API routes.'),

  providers: z.array(z.object({
    id: z.string(),
    type: z.enum(['anthropic', 'openai', 'openai-compatible']),
    name: z.string(),
    baseUrl: z.string(),
    defaultModel: z.string().optional(),
    params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    requestDelayMs: z.number().optional()
  })).optional().describe('Custom LLM provider definitions.'),

  ws_connections: z.array(z.object({
    id: z.string(),
    url: z.string(),
    did: z.string().optional(),
    enabled: z.boolean(),
    lambda: z.string().optional(),
    auth: z.enum(['auto', 'required', 'none']).optional(),
    auto_reconnect: z.boolean().optional(),
    reconnect_delay_ms: z.number().optional(),
    keepalive_interval_ms: z.number().optional()
  })).optional().describe('WebSocket connection definitions.'),

  locked_fields: z.array(z.string()).optional().describe('Config field paths that the agent cannot modify.'),

  card: z.object({
    endpoints: z.object({
      inbox: z.string().optional(),
      card: z.string().optional(),
      health: z.string().optional(),
      ws: z.string().optional()
    }).optional(),
    resolution: z.object({
      method: z.string(),
      endpoint: z.string().optional(),
      network: z.string().optional(),
      contract: z.string().optional(),
      chain_id: z.number().optional(),
      domain: z.string().optional(),
      selector: z.string().optional()
    }).optional()
  }).optional().describe('Agent card endpoint and resolution overrides.'),

  template: z.string().optional().describe(
    'Path to a .adf template file in this agent\'s file store. ' +
    'The template\'s config and files become the starting point; explicit params override on top. ' +
    'Template locked_fields and locked items are enforced. The child gets fresh identity keys.'
  ),

  files: z.array(z.object({
    parent_path: z.string().describe('Path to the file in this (parent) agent\'s file store.'),
    child_path: z.string().describe('Path where the file should be placed in the new agent\'s file store.')
  })).optional().describe(
    'Files to copy from this agent\'s file store into the new agent. ' +
    'Overwrites existing files unless they have read_only protection.'
  ),

  metadata: z.object({
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional()
  }).optional().describe('Metadata overrides. created_at and updated_at are always auto-set.')
})

/**
 * Create a new ADF file.
 * This tool should require approval since it creates files on disk.
 */
export class CreateAdfTool implements Tool {
  readonly name = 'sys_create_adf'
  readonly description =
    'Create a new agent (.adf file) with full configuration. Required: name. ' +
    'Optionally use template (path to a .adf in this agent\'s file store) as a base config, ' +
    'and files (array of {parent_path, child_path}) to inject files. ' +
    'All other AgentConfig fields are optional overrides.'
  readonly inputSchema = InputSchema
  readonly category = 'external' as const

  /** Injected by runtime — starts a child agent as a background agent. */
  onAutostartChild?: (filePath: string) => Promise<boolean>
  /** Injected by runtime — registers a child agent as reviewed (parent creation = implicit review). */
  onChildCreated?: (filePath: string, config: import('../../../shared/types/adf-v02.types').AgentConfig) => void
  readonly requireApproval = true

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const { name, location, template, files, ...configOverrides } = parsed

    try {
      // Determine output path — resolve relative to the parent agent's directory
      const currentPath = workspace.getFilePath()
      const currentDir = dirname(currentPath)
      const targetDir = location
        ? (isAbsolute(location) ? location : resolve(currentDir, location))
        : currentDir

      // Sanitize filename
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_')
      const newPath = join(targetDir, `${safeName}.adf`)

      let options: CreateAgentOptions
      let templateData: ReturnType<typeof readTemplate> | null = null

      if (template) {
        // Template-based creation
        templateData = readTemplate(workspace, template)

        // Unified validate + merge — checks locks at every merge point
        const mergeResult = mergeTemplateWithOverrides(
          templateData.config,
          { name, ...configOverrides }
        )
        if (!mergeResult.ok) {
          return { content: mergeResult.error, isError: true }
        }
        options = mergeResult.options
      } else {
        options = { name, ...configOverrides }
      }

      // Create the new ADF
      const newWorkspace = AdfWorkspace.create(newPath, options)

      try {
        // Set parent lineage — use DID if available, fall back to config ID
        const parentDid = workspace.getDid()
        const parentId = parentDid || workspace.getAgentConfig().id
        newWorkspace.getDatabase().setMeta('adf_parent_did', parentId)

        // Inject template files (after creation so they overwrite defaults)
        if (templateData) {
          const db = newWorkspace.getDatabase()

          for (const file of templateData.files) {
            const existingProtection = newWorkspace.getFileProtection(file.path)
            if (existingProtection === 'read_only') continue
            const protection = existingProtection ?? file.protection
            db.writeFile(file.path, file.content, file.mime_type ?? undefined, protection)
          }

          // Copy non-signing identity rows
          for (const row of templateData.identityRows) {
            db.setIdentityRaw(
              row.purpose,
              row.value,
              row.encryption_algo,
              row.salt,
              row.kdf_params
            )
            if (row.code_access) {
              db.setIdentityCodeAccess(row.purpose, true)
            }
          }

          // Replay custom tables (local_* etc.) from template
          for (const table of templateData.customTables) {
            db.executeSQL(table.ddl)
            if (table.rows.length > 0) {
              const cols = Object.keys(table.rows[0])
              const placeholders = cols.map(() => '?').join(', ')
              const insertSql = `INSERT INTO "${table.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`
              for (const row of table.rows) {
                db.executeSQL(insertSql, cols.map((c) => row[c]))
              }
            }
          }
          // Replay indexes for custom tables
          for (const indexSql of templateData.customIndexes) {
            db.executeSQL(indexSql)
          }

          // Generate fresh identity keys (new DID, public/private keypair)
          newWorkspace.generateIdentityKeys(null)
        }

        // Inject parent files
        if (files) {
          const db = newWorkspace.getDatabase()

          for (const { parent_path, child_path } of files) {
            const entry = workspace.getDatabase().readFile(parent_path)
            if (!entry) {
              newWorkspace.close()
              return {
                content: `File not found in parent: ${parent_path}`,
                isError: true
              }
            }

            const existingProtection = newWorkspace.getFileProtection(child_path)
            if (existingProtection === 'read_only') {
              newWorkspace.close()
              return {
                content: `Cannot overwrite read-only file in child: ${child_path}`,
                isError: true
              }
            }

            const protection = existingProtection ?? 'none'
            db.writeFile(child_path, entry.content, entry.mime_type ?? undefined, protection)
          }
        }

        const newConfig = newWorkspace.getAgentConfig()
        const did = newWorkspace.getDid()
        newWorkspace.close()

        // Auto-register child as reviewed (parent creation = implicit review)
        if (this.onChildCreated) {
          try {
            this.onChildCreated(newPath, newConfig)
          } catch (err) {
            console.warn(`[sys_create_adf] Failed to register child review for ${newPath}:`, err)
          }
        }

        let autostarted = false
        if (parsed.autostart && this.onAutostartChild) {
          try {
            autostarted = await this.onAutostartChild(newPath)
          } catch (err) {
            console.warn(`[sys_create_adf] Autostart failed for ${newPath}:`, err)
          }
        }

        let result = `Agent created successfully.\nName: ${name}\nID: ${newConfig.id}\nPath: ${newPath}`
        if (did) result += `\nDID: ${did}`
        if (template) result += `\nTemplate: ${template}`
        if (files?.length) result += `\nFiles injected: ${files.length}`
        result += `\nAutostarted: ${autostarted}`

        return { content: result, isError: false }
      } catch (innerError) {
        try { newWorkspace.close() } catch { /* ignore */ }
        throw innerError
      }
    } catch (error) {
      return {
        content: `Failed to create agent: ${String(error)}`,
        isError: true
      }
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
