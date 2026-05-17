import { z } from 'zod'
import { AGENT_STATES, MESSAGING_MODES, START_IN_STATES } from '../../shared/types/adf-v02.types'

/**
 * Tool-name renames applied transparently on config load.
 * Any entry in `config.tools` with a legacy name is rewritten in memory; the rename
 * persists on the next sys_update_config save. No explicit migration step required.
 */
const TOOL_NAME_RENAMES: Record<string, string> = {
  msg_list_agents: 'agent_discover'
}

export const ToolDeclarationSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  visible: z.boolean(),
  restricted: z.boolean().optional(),
  mcp_tool_hash: z.string().optional(),
  mcp_tool_status: z.enum(['new', 'changed', 'removed']).optional()
}).transform((decl) => {
  const renamed = TOOL_NAME_RENAMES[decl.name]
  return renamed ? { ...decl, name: renamed } : decl
})

const TriggerFilterSchema = z.object({
  source: z.union([z.string(), z.array(z.string())]).optional(),
  sender: z.string().optional(),
  to: z.string().optional(),
  watch: z.string().optional(),
  tools: z.array(z.string()).optional(),
  status: z.string().optional(),
  level: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
  origin: z.array(z.string()).optional(),
  event: z.array(z.string()).optional(),
  provider: z.array(z.string()).optional()
}).strict().optional()

const TriggerTargetSchema = z.object({
  scope: z.enum(['system', 'agent']),
  lambda: z.string().optional(),
  command: z.string().optional(),
  warm: z.boolean().optional(),
  filter: TriggerFilterSchema,
  debounce_ms: z.number().int().positive().optional(),
  interval_ms: z.number().int().positive().optional(),
  batch_ms: z.number().int().positive().optional(),
  batch_count: z.number().int().positive().optional()
}).refine(
  (t) => [t.debounce_ms, t.interval_ms, t.batch_ms].filter(v => v !== undefined).length <= 1,
  { message: 'Only one timing modifier allowed per target' }
).refine(
  (t) => t.batch_count === undefined || t.batch_ms !== undefined,
  { message: 'batch_count requires batch_ms' }
).refine(
  (t) => t.scope === 'system' || (!t.lambda && !t.command && t.warm === undefined),
  { message: 'lambda, command, and warm only allowed on system scope targets' }
).refine(
  (t) => !t.lambda || !t.command,
  { message: 'lambda and command are mutually exclusive' }
)

const TriggerConfigSchema = z.object({
  enabled: z.boolean(),
  targets: z.array(TriggerTargetSchema).default([])
})

export const TriggersConfigV3Schema = z.object({
  on_startup: TriggerConfigSchema.optional(),
  on_inbox: TriggerConfigSchema.optional(),
  on_outbox: TriggerConfigSchema.optional(),
  on_file_change: TriggerConfigSchema.optional(),
  on_chat: TriggerConfigSchema.optional(),
  on_timer: TriggerConfigSchema.optional(),
  on_tool_call: TriggerConfigSchema.optional(),
  on_task_create: TriggerConfigSchema.optional(),
  on_task_complete: TriggerConfigSchema.optional(),
  on_logs: TriggerConfigSchema.optional(),
  on_llm_call: TriggerConfigSchema.optional()
})

const LoggingRuleSchema = z.object({
  origin: z.string().min(1),
  min_level: z.enum(['debug', 'info', 'warn', 'error'])
})

const LoggingConfigSchema = z.object({
  default_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  rules: z.array(LoggingRuleSchema).optional(),
  max_rows: z.number().int().positive().nullable().optional()
})

const MiddlewareRefSchema = z.object({
  lambda: z.string().min(1)
})

export const ServingApiRouteSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS']),
  path: z.string().min(1),
  lambda: z.string().optional(),
  warm: z.boolean().optional(),
  cache_ttl_ms: z.number().int().positive().optional(),
  middleware: z.array(MiddlewareRefSchema).optional(),
  high_water_mark_bytes: z.number().int().positive().optional()
}).superRefine((route, ctx) => {
  if (route.method === 'WS' && !route.lambda) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'WS routes require a lambda handler', path: ['lambda'] })
  }
  if (route.method !== 'WS' && !route.lambda) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'HTTP routes require a lambda handler', path: ['lambda'] })
  }
})

export const WsConnectionConfigSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  did: z.string().optional(),
  enabled: z.boolean(),
  lambda: z.string().optional(),
  auth: z.enum(['auto', 'required', 'none']).optional(),
  auto_reconnect: z.boolean().optional(),
  reconnect_delay_ms: z.number().int().positive().optional(),
  keepalive_interval_ms: z.number().int().positive().optional(),
  high_water_mark_bytes: z.number().int().positive().optional()
})

export const UmbilicalFilterSchema = z.object({
  event_types: z.array(z.string()).optional(),
  when: z.string().optional()
})

export const StreamBindEndpointSchema: z.ZodTypeAny = z.union([
  z.object({
    kind: z.literal('ws'),
    connection_id: z.string().min(1)
  }),
  z.object({
    kind: z.literal('process'),
    isolation: z.enum(['host', 'container_shared', 'container_isolated']),
    image: z.string().optional(),
    command: z.array(z.string()).min(1),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional()
  }).superRefine((endpoint, ctx) => {
    if (endpoint.isolation === 'container_isolated' && !endpoint.image) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'container_isolated process bindings require image',
        path: ['image']
      })
    }
  }),
  z.object({
    kind: z.literal('tcp'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535)
  }),
  z.object({
    kind: z.literal('umbilical'),
    filter: UmbilicalFilterSchema.optional()
  })
])

export const BindOptionsSchema = z.object({
  idle_timeout_ms: z.number().int().positive().optional(),
  max_duration_ms: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
  flow_summary_interval_ms: z.number().int().positive().optional(),
  close_a_on_b_close: z.boolean().optional(),
  close_b_on_a_close: z.boolean().optional()
})

export const StreamBindingDeclarationSchema = z.object({
  id: z.string().min(1),
  a: StreamBindEndpointSchema,
  b: StreamBindEndpointSchema,
  bidirectional: z.boolean().optional(),
  reconnect: z.boolean().optional(),
  options: BindOptionsSchema.optional()
}).superRefine((binding, ctx) => {
  if (binding.b.kind === 'umbilical') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'umbilical endpoints are read-only and cannot appear as b',
      path: ['b']
    })
  }
})

export const StreamBindConfigSchema = z.object({
  host_process_bind: z.boolean().optional(),
  container_shared_bind: z.boolean().optional(),
  container_isolated_bind: z.boolean().optional(),
  allow_tcp_bind: z.boolean().optional(),
  tcp_allowlist: z.array(z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    ports: z.array(z.number().int().min(1).max(65535)).optional(),
    min_port: z.number().int().min(1).max(65535).optional(),
    max_port: z.number().int().min(1).max(65535).optional()
  })).optional()
})

export const ServingPublicConfigSchema = z.object({
  enabled: z.boolean(),
  index: z.string().optional()
})

export const ServingSharedConfigSchema = z.object({
  enabled: z.boolean(),
  patterns: z.array(z.string()).optional().refine(
    (arr) => !arr || arr.every(s => !s.startsWith('messages')),
    { message: 'Shared entries must not start with "messages"' }
  )
})

export const ServingConfigSchema = z.object({
  shared: ServingSharedConfigSchema.optional(),
  public: ServingPublicConfigSchema.optional(),
  api: z.array(ServingApiRouteSchema).optional()
})

const ResolutionSchema = z.object({
  method: z.string().min(1),
  endpoint: z.string().optional(),
  network: z.string().optional(),
  contract: z.string().optional(),
  chain_id: z.number().int().optional(),
  domain: z.string().optional(),
  selector: z.string().optional()
})

const CardOverridesSchema = z.object({
  endpoints: z.object({
    inbox: z.string().url().optional(),
    card: z.string().url().optional(),
    health: z.string().url().optional(),
    ws: z.string().optional()
  }).optional(),
  resolution: ResolutionSchema.optional()
})

export const AgentConfigSchema = z.object({
  adf_version: z.literal('0.2'),
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
  icon: z.string().optional(),
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(64).optional(),
  reply_to: z.string().optional(),  // deprecated — use card.endpoints.inbox
  card: CardOverridesSchema.optional(),
  state: z.enum(AGENT_STATES).default('active'),
  start_in_state: z.enum(START_IN_STATES).optional(),
  autonomous: z.boolean().default(false),
  autostart: z.boolean().optional(),
  model: z.object({
    provider: z.string().min(1),
    model_id: z.string().default(''),
    temperature: z.number().min(0).max(2).nullable().default(0.7),
    max_tokens: z.number().int().positive().nullable().default(4096),
    top_p: z.number().min(0).max(1).nullable().optional(),
    thinking_budget: z.number().int().positive().nullable().optional(),
    compact_threshold: z.number().int().positive().nullable().optional(),
    max_loop_messages: z.number().int().positive().nullable().optional(),
    vision: z.boolean().default(false),
    params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    provider_params: z.record(z.unknown()).optional()
  }),
  instructions: z.string().min(1),
  include_base_prompt: z.boolean().optional(),
  context: z.object({
    compact_threshold: z.number().int().positive().nullable().optional(),
    max_loop_messages: z.number().int().positive().nullable().optional(),
    audit: z.object({
      loop: z.boolean().default(false),
      inbox: z.boolean().default(false),
      outbox: z.boolean().default(false),
      files: z.boolean().default(false)
    }).optional(),
    dynamic_instructions: z.object({
      inbox_hints: z.boolean().optional(),
      context_warning: z.boolean().optional(),
      mesh_updates: z.boolean().optional()
    }).optional()
  }),
  tools: z.array(ToolDeclarationSchema).default([]),
  triggers: TriggersConfigV3Schema,
  security: z.object({
    allow_unsigned: z.boolean().default(true),
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    require_signature: z.boolean().optional(),
    require_payload_signature: z.boolean().optional(),
    middleware: z.object({
      inbox: z.array(MiddlewareRefSchema).optional(),
      outbox: z.array(MiddlewareRefSchema).optional()
    }).optional(),
    fetch_middleware: z.array(MiddlewareRefSchema).optional(),
    require_middleware_authorization: z.boolean().default(true),
    table_protections: z.record(z.enum(['none', 'append_only', 'authorized'])).optional()
  }),
  limits: z.object({
    execution_timeout_ms: z.number().int().positive().default(5000),
    max_loop_rows: z.number().int().positive().default(500),
    max_daily_budget_usd: z.number().positive().nullable().default(null),
    max_file_read_tokens: z.number().int().positive().default(30000),
    max_file_write_bytes: z.number().int().positive().default(5000000),
    max_tool_result_tokens: z.number().int().positive().default(16000),
    max_tool_result_preview_chars: z.number().int().positive().default(5000),
    max_active_turns: z.number().int().positive().nullable().default(null),
    max_image_size_bytes: z.number().int().positive().optional(),
    suspend_timeout_ms: z.number().int().positive().optional(),
    hibernate_nudge: z.object({
      enabled: z.boolean(),
      interval_ms: z.number().int().positive()
    }).optional()
  }),
  messaging: z.object({
    mode: z.enum(MESSAGING_MODES).default('respond_only'),
    visibility: z.enum(['directory', 'localhost', 'lan', 'public', 'off']).default('localhost'),
    inbox_mode: z.boolean().optional(),
    allow_list: z.array(z.string()).optional(),
    block_list: z.array(z.string()).optional()
  }),
  audit: z.object({
    loop: z.boolean().default(false),
    inbox: z.boolean().default(false),
    outbox: z.boolean().default(false),
    files: z.boolean().default(false)
  }).optional(),
  code_execution: z.object({
    model_invoke: z.boolean().default(true),
    sys_lambda: z.boolean().default(true),
    task_resolve: z.boolean().default(true),
    loop_inject: z.boolean().default(true),
    get_identity: z.boolean().default(true),
    set_identity: z.boolean().default(true),
    network: z.boolean().optional(),
    packages: z.array(z.object({
      name: z.string().min(1),
      version: z.string().min(1)
    })).max(50).optional(),
    restricted_methods: z.array(z.string()).optional()
  }).optional(),
  /** @deprecated Packages moved to code_execution.packages. */
  sandbox: z.object({
    packages: z.array(z.object({
      name: z.string().min(1),
      version: z.string().optional(),
      enabled: z.boolean()
    })).optional()
  }).optional(),
  compute: z.object({
    enabled: z.boolean().default(false),
    packages: z.object({
      npm: z.array(z.string()).max(100).optional(),
      pip: z.array(z.string()).max(100).optional(),
    }).optional(),
    host_access: z.boolean().optional(),
  }).optional(),
  logging: LoggingConfigSchema.optional(),
  adapters: z.record(z.object({
    enabled: z.boolean(),
    credential_key: z.string().optional(),
    policy: z.object({
      dm: z.enum(['all', 'allowlist', 'none']).optional(),
      groups: z.enum(['all', 'mention', 'none']).optional(),
      allow_from: z.array(z.string()).optional()
    }).optional(),
    limits: z.object({
      max_attachment_size: z.number().int().positive().optional()
    }).optional()
  })).optional(),
  serving: ServingConfigSchema.optional(),
  ws_connections: z.array(WsConnectionConfigSchema).optional(),
  stream_bind: StreamBindConfigSchema.optional(),
  stream_bindings: z.array(StreamBindingDeclarationSchema).optional(),
  umbilical_taps: z.array(z.object({
    name: z.string().min(1),
    lambda: z.string().min(1),
    filter: z.object({
      event_types: z.array(z.string()).default(['*']),
      when: z.string().optional(),
      allow_wildcard: z.boolean().default(false)
    }).default({ event_types: ['*'], allow_wildcard: false }),
    exclude_own_origin: z.boolean().default(true),
    max_rate_per_sec: z.number().int().positive().default(100)
  }).superRefine((tap, ctx) => {
    // Wildcard gate: "*" or bare-prefix filters require allow_wildcard: true.
    const hasWildcard = tap.filter.event_types.some(t => t === '*' || t.endsWith('.*'))
    const isBarePrefix = tap.filter.event_types.some(t => t.endsWith('.*'))
    const isStar = tap.filter.event_types.includes('*')
    if ((isStar || isBarePrefix) && !tap.filter.allow_wildcard) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `umbilical_tap "${tap.name}" uses wildcard event_types (${tap.filter.event_types.join(', ')}) but allow_wildcard is not true.`,
        path: ['filter', 'allow_wildcard']
      })
    }
    void hasWildcard
  })).default([]),
  providers: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['anthropic', 'openai', 'openai-compatible']),
    name: z.string(),
    baseUrl: z.string(),
    defaultModel: z.string().optional(),
    params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    requestDelayMs: z.number().optional()
  })).optional(),
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
      source: z.string().optional(),
      tool_call_timeout_ms: z.number().positive().optional(),
      available_tools: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.record(z.unknown())
      })).optional(),
      restricted: z.boolean().optional(),
      host_requested: z.boolean().optional(),
      run_location: z.enum(['host', 'shared']).optional()
    }))
  }).optional(),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional()
  })
})

export type ValidatedAgentConfig = z.infer<typeof AgentConfigSchema>

// =============================================================================
// Timer Schedule Validation (used by sys-set-timer tool)
// =============================================================================

const TimerOnceSchema = z.object({
  mode: z.literal('once'),
  at: z.number().int().positive()
})

const TimerIntervalSchema = z.object({
  mode: z.literal('interval'),
  every_ms: z.number().int().positive(),
  start_at: z.number().int().positive().optional(),
  end_at: z.number().int().positive().optional(),
  max_runs: z.number().int().positive().optional()
})

const TimerCronSchema = z.object({
  mode: z.literal('cron'),
  cron: z.string(),
  end_at: z.number().int().positive().optional(),
  max_runs: z.number().int().positive().optional()
})

export const TimerScheduleSchema = z.discriminatedUnion('mode', [
  TimerOnceSchema, TimerIntervalSchema, TimerCronSchema
])
