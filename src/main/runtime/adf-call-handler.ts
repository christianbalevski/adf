import { nanoid } from 'nanoid'
import type { ToolRegistry } from '../tools/tool-registry'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig, CodeExecutionConfig, MetaProtectionLevel, FileProtectionLevel } from '../../shared/types/adf-v02.types'
import { CODE_EXECUTION_DEFAULTS, META_PROTECTION_LEVELS, FILE_PROTECTION_LEVELS } from '../../shared/types/adf-v02.types'
import type { LLMProvider } from '../providers/provider.interface'
import type { LLMMessage, ContentBlock } from '../../shared/types/provider.types'
import { getTokenUsageService } from '../services/token-usage.service'
import type { AdfCallResult } from './code-sandbox'
import type { LlmCallEventData } from '../../shared/types/adf-event.types'
import { callLlmWithMetadata, getAttachedLlmCallMetadata, toLlmCallEventData } from './llm-call-metadata'
import { emitUmbilicalEvent } from './emit-umbilical'
import { withAuthorization, currentAuthorization } from './authorization-context'

/** Raw message from sandbox input — supports system role unlike LLMMessage. */
interface ModelInvokeMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ModelInvokeContentBlock[]
}

interface ModelInvokeContentBlock {
  type: 'text' | 'image_url' | 'input_audio' | 'video_url'
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
  video_url?: { url: string }
}

interface ModelInvokeInput {
  messages: ModelInvokeMessage[]
  model?: string
  temperature?: number
  max_tokens?: number
  top_p?: number
  provider_params?: Record<string, unknown>
}

export interface AdfCallHandlerOptions {
  toolRegistry: ToolRegistry
  workspace: AdfWorkspace
  config: AgentConfig
  provider: LLMProvider
  /** Factory to create a provider for a different model ID (used by model_invoke's `model` param). */
  createProviderForModel?: (modelId: string) => LLMProvider
  /** Resolve an identity value from adf_identity (respects code_access flag). Never falls back to app-level settings. */
  resolveIdentity?: (purpose: string) => string | null
}

/** Tools that cannot be called from code */
const EXCLUDED_TOOLS = new Set(['say', 'ask'])

/** Code-execution-only methods (not regular tools — gated by code_execution config). */
const CODE_EXECUTION_METHODS = new Set<keyof CodeExecutionConfig>([
  'model_invoke', 'sys_lambda', 'task_resolve', 'loop_inject', 'get_identity', 'set_identity', 'emit_event'
])

/**
 * Routes `adf_call` requests from sandbox code to the appropriate handler:
 * tool execution, model_invoke, sys_lambda, task_resolve, or loop_inject.
 */
export class AdfCallHandler {
  private toolRegistry: ToolRegistry
  private workspace: AdfWorkspace
  private config: AgentConfig
  private provider: LLMProvider
  private createProviderForModel?: (modelId: string) => LLMProvider
  private resolveIdentity?: (purpose: string) => string | null

  /**
   * Fallback authorization flag for callers that haven't migrated to
   * withAuthorization() yet. Per-call ALS context (currentAuthorization())
   * takes precedence — see `effectiveAuthorization()`.
   */
  private isAuthorized = false

  private effectiveAuthorization(): boolean {
    const fromContext = currentAuthorization()
    return fromContext !== undefined ? fromContext : this.isAuthorized
  }

  /** Call stack for circular sys_lambda detection */
  private callStack: string[] = []

  /** Task lifecycle callback (set by IPC layer) */
  onTaskCompleted?: (taskId: string, tool: string, status: string, result?: string, error?: string, sideEffects?: { endTurn?: boolean }) => void

  /**
   * Fires when a synchronous lambda tool call returns endTurn (e.g. sys_set_state).
   * Sync calls don't go through the task lifecycle, so this is the only signal the
   * executor gets to apply state transitions like 'off'.
   */
  onLambdaToolEndTurn?: (tool: string, resultContent: string) => void

  /** HIL task approval callback — signals executor to proceed with tool execution */
  onHilApproved?: (taskId: string, approved: boolean, modifiedArgs?: Record<string, unknown>) => void

  /** Event callback for UI updates (set by IPC layer) */
  onEvent?: (event: { type: string; payload: unknown; timestamp: number }) => void
  onLlmCall?: (data: LlmCallEventData) => void

  constructor(options: AdfCallHandlerOptions) {
    this.toolRegistry = options.toolRegistry
    this.workspace = options.workspace
    this.config = options.config
    this.provider = options.provider
    this.createProviderForModel = options.createProviderForModel
    this.resolveIdentity = options.resolveIdentity
  }

  updateConfig(config: AgentConfig): void {
    this.config = config
  }

  /** Best-effort log to adf_logs — never throws. */
  private logCall(level: string, event: string, target: string | null, message: string): void {
    try { this.workspace.insertLog(level, 'adf_call', event, target, message) } catch { /* non-fatal */ }
  }

  /** Get the tool registry (used by SystemScopeHandler for shell command triggers) */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  /** Set the authorization context for the current execution. Called before each sandbox execution. */
  setAuthorizationContext(authorized: boolean): void {
    this.isAuthorized = authorized
  }

  /**
   * Get the current authorization context. Prefers the per-call ALS value
   * established by withAuthorization(); falls back to the legacy field for
   * any caller that hasn't migrated yet.
   */
  getAuthorizationContext(): boolean {
    return this.effectiveAuthorization()
  }

  /**
   * Handle an adf_call from sandbox code.
   * Routes to model_invoke, sys_lambda, or tool execution.
   */
  async handleCall(method: string, args: unknown): Promise<AdfCallResult> {
    const authorized = this.effectiveAuthorization()
    try {
      // Restricted code execution methods — check before CE dispatch
      const restrictedMethods = new Set(this.config.code_execution?.restricted_methods ?? [])
      if (restrictedMethods.has(method) && !authorized) {
        this.logCall('warn', 'call_rejected', method, `"${method}" requires authorized code`)
        return {
          error: `"${method}" can only be called from authorized code. Ask the owner to authorize the source file.`,
          errorCode: 'REQUIRES_AUTHORIZED_CODE'
        }
      }

      // authorize_file — only callable from authorized code
      if (method === 'authorize_file') {
        return this.handleAuthorizeFile(args)
      }

      // Authorized-code-only: bypass meta/file protection (same privilege as UI)
      if (authorized) {
        switch (method) {
          case 'sys_set_meta': return this.handleAuthorizedSetMeta(args)
          case 'sys_delete_meta': return this.handleAuthorizedDeleteMeta(args)
          case 'set_meta_protection': return this.handleSetMetaProtection(args)
          case 'set_file_protection': return this.handleSetFileProtection(args)
        }
      }

      // Code-execution-only methods — gated by code_execution config
      if (CODE_EXECUTION_METHODS.has(method as keyof CodeExecutionConfig)) {
        const ce = { ...CODE_EXECUTION_DEFAULTS, ...this.config.code_execution }
        if (!ce[method as keyof CodeExecutionConfig]) {
          this.logCall('warn', 'call_rejected', method, `Code execution method "${method}" is disabled`)
          return {
            error: `"${method}" is disabled in code_execution config`,
            errorCode: 'DISABLED'
          }
        }
        switch (method) {
          case 'model_invoke': return await this.handleModelInvoke(args)
          case 'sys_lambda': return await this.handleSysLambda(args)
          case 'task_resolve': return await this.handleTaskResolve(args)
          case 'loop_inject': return this.handleLoopInject(args)
          case 'get_identity': return this.handleGetIdentity(args)
          case 'set_identity': return this.handleSetIdentity(args)
          case 'emit_event': return this.handleEmitEvent(args)
        }
      }

      // Excluded tools (say, ask) — cannot be called from code
      if (EXCLUDED_TOOLS.has(method)) {
        this.logCall('warn', 'call_rejected', method, `Excluded tool "${method}" called from code`)
        return {
          error: `Tool "${method}" cannot be called from code`,
          errorCode: 'EXCLUDED_TOOL'
        }
      }

      // Check tool existence and configuration
      const toolDecl = this.config.tools.find(t => t.name === method)

      if (!toolDecl) {
        // Check if tool exists in registry but isn't declared
        const tool = this.toolRegistry.get(method)
        if (!tool) {
          this.logCall('warn', 'call_rejected', method, `Tool "${method}" not found`)
          return {
            error: `Tool "${method}" not found`,
            errorCode: 'NOT_FOUND'
          }
        }
        this.logCall('warn', 'call_rejected', method, `Tool "${method}" is not declared in agent config`)
        return {
          error: `Tool "${method}" is not declared in agent config`,
          errorCode: 'DISABLED'
        }
      }

      // Restricted tool: only authorized code can call directly
      // Authorized code bypasses disabled and HIL checks
      const authorizedBypass = !!toolDecl.restricted && authorized

      if (toolDecl.restricted && !authorized) {
        this.logCall('warn', 'call_rejected', method, `Tool "${method}" requires authorized code`)
        return {
          error: `"${method}" can only be called from authorized code. Ask the owner to authorize the source file.`,
          errorCode: 'REQUIRES_AUTHORIZED_CODE'
        }
      }

      if (!toolDecl.enabled && !authorizedBypass) {
        this.logCall('warn', 'call_rejected', method, `Tool "${method}" is disabled`)
        return {
          error: `Tool "${method}" is disabled`,
          errorCode: 'DISABLED'
        }
      }

      // Check tool is actually registered. Mesh tools (msg_send, agent_discover,
      // ws_*) get registered into the per-agent toolRegistry by
      // MeshManager.registerAgent → registerCommunicationTools. If they're
      // missing, the agent was either (a) never registered with the mesh because
      // the mesh was disabled at registration time, or (b) registered but its
      // tool registry was rebuilt afterward without re-registration. The error
      // string distinguishes the two so the user knows where to look.
      if (!this.toolRegistry.get(method)) {
        const meshTools = ['msg_send', 'agent_discover', 'ws_connect', 'ws_disconnect', 'ws_connections', 'ws_send']
        if (meshTools.includes(method)) {
          this.logCall('warn', 'call_rejected', method, `Mesh tool "${method}" missing from registry — agent not registered with the mesh`)
          return {
            error: `Mesh tool "${method}" is not available in this agent's tool registry. The mesh network may be disabled, or this agent was not (re-)registered after enabling the mesh. Check that the mesh is on and restart this agent.`,
            errorCode: 'MESH_TOOL_UNAVAILABLE'
          }
        }
        this.logCall('warn', 'call_rejected', method, `Tool "${method}" not available`)
        return { error: `Tool "${method}" is not available`, errorCode: 'NOT_FOUND' }
      }

      // _async: true — execute tool in background, return task reference
      const argsObj = args as Record<string, unknown> | undefined
      if (argsObj && (argsObj._async === true || argsObj._async === 'true')) {
        const { _async: _, ...cleanArgs } = argsObj
        const taskId = `task_${nanoid(12)}`
        this.workspace.insertTask(taskId, method, JSON.stringify(cleanArgs), 'lambda')
        // Capture authorization at schedule time — subsequent sandbox executions may flip it.
        const capturedAuthorized = authorized
        this.executeAsyncToolFromLambda(taskId, method, cleanArgs, capturedAuthorized).catch(err => {
          console.error(`[AdfCallHandler] Async tool ${method} (task ${taskId}) error:`, err)
        })
        return { result: JSON.stringify({ task_id: taskId, status: 'running', tool: method }) }
      }

      // Auto-convert Buffer/Uint8Array content for fs_write (binary passthrough from lambdas)
      if (method === 'fs_write') {
        const a = args as Record<string, unknown> | undefined
        if (a && (Buffer.isBuffer(a.content) || (a.content instanceof Uint8Array))) {
          a.content = Buffer.from(a.content as Uint8Array).toString('base64')
          if (!a.encoding) a.encoding = 'base64'
          if (!a.mime_type) a.mime_type = 'application/octet-stream'
        }
      }

      // Authorized code carries the same privileges as the UI — inject _authorized so
      // tools (fs_write, fs_delete, db_execute, ...) can bypass protection checks. The agent
      // executor strips this flag from LLM tool calls, so unauthorized code cannot forge it.
      const toolArgs = authorized && args && typeof args === 'object'
        ? { ...(args as Record<string, unknown>), _authorized: true }
        : args

      // Execute the tool
      const result = await this.toolRegistry.executeTool(method, toolArgs, this.workspace)

      if (result.isError) {
        this.logCall('warn', 'call_error', method, result.content.slice(0, 200))
        return {
          error: result.content,
          errorCode: 'TOOL_ERROR'
        }
      }

      // Propagate end-turn side effects for sync lambda calls (e.g. sys_set_state).
      // Sync calls bypass the task lifecycle, so this is the executor's only signal.
      if (result.endTurn) {
        try { this.onLambdaToolEndTurn?.(method, result.content) } catch { /* never break the call */ }
      }

      return { result: result.content }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.logCall('error', 'call_error', method, errorMsg.slice(0, 200))
      return {
        error: errorMsg,
        errorCode: 'INTERNAL_ERROR'
      }
    }
  }

  /**
   * Owner/runtime control-plane helper for resolving tasks outside sandbox code.
   * Runs with authorized privileges so the daemon can approve tasks that require
   * owner authorization without depending on a lambda file context.
   */
  async resolveTask(args: unknown): Promise<AdfCallResult> {
    return await withAuthorization(true, () => this.handleTaskResolve(args))
  }

  /**
   * Handle model_invoke — direct LLM call with messages array, no tools or streaming.
   */
  private async handleModelInvoke(args: unknown): Promise<AdfCallResult> {
    const input = args as ModelInvokeInput

    // Validate messages
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      return {
        error: 'model_invoke requires a non-empty "messages" array',
        errorCode: 'INVALID_INPUT'
      }
    }

    const validRoles = new Set(['system', 'user', 'assistant'])
    for (const msg of input.messages) {
      if (!msg.role || !validRoles.has(msg.role)) {
        return {
          error: `Invalid message role "${msg.role}" — must be "system", "user", or "assistant"`,
          errorCode: 'INVALID_INPUT'
        }
      }
      if (msg.content === undefined || msg.content === null) {
        return {
          error: 'Each message must have a "content" field',
          errorCode: 'INVALID_INPUT'
        }
      }
    }

    // Validate content block types — only text and multimodal types are supported
    const ALLOWED_BLOCK_TYPES = new Set(['text', 'image_url', 'input_audio', 'video_url'])
    for (const msg of input.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const t = (block as { type: string }).type
          if (!ALLOWED_BLOCK_TYPES.has(t)) {
            return {
              error: `Unsupported content block type "${t}" — allowed types: ${[...ALLOWED_BLOCK_TYPES].join(', ')}`,
              errorCode: 'INVALID_INPUT'
            }
          }
        }
      }
    }

    // Extract system messages (must be at the start, before any user/assistant messages)
    let systemText = ''
    let systemDone = false
    const conversationMessages: ModelInvokeMessage[] = []

    for (const msg of input.messages) {
      if (msg.role === 'system') {
        if (systemDone) {
          return {
            error: 'System messages must appear at the start of the messages array, before any user/assistant messages',
            errorCode: 'INVALID_INPUT'
          }
        }
        const text = this.extractTextContent(msg.content)
        if (systemText) systemText += '\n'
        systemText += text
      } else {
        systemDone = true
        conversationMessages.push(msg)
      }
    }

    if (conversationMessages.length === 0) {
      return {
        error: 'messages must contain at least one user or assistant message',
        errorCode: 'INVALID_INPUT'
      }
    }

    // Convert to LLMMessage[] — pass multimodal blocks through as content arrays
    const messages: LLMMessage[] = conversationMessages.map(msg => {
      if (typeof msg.content === 'string') {
        return { role: msg.role as 'user' | 'assistant', content: msg.content }
      }
      const hasMedia = msg.content.some(b => b.type === 'image_url' || b.type === 'input_audio' || b.type === 'video_url')
      if (!hasMedia) {
        return { role: msg.role as 'user' | 'assistant', content: this.extractTextContent(msg.content) }
      }
      // Build content blocks preserving multimodal blocks for the provider
      const blocks: ContentBlock[] = []
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) {
          blocks.push({ type: 'text', text: b.text })
        } else if (b.type === 'image_url' && b.image_url) {
          blocks.push({ type: 'image_url', image_url: b.image_url })
        } else if (b.type === 'input_audio' && b.input_audio) {
          blocks.push({ type: 'input_audio', input_audio: b.input_audio })
        } else if (b.type === 'video_url' && b.video_url) {
          blocks.push({ type: 'video_url', video_url: b.video_url })
        }
      }
      return { role: msg.role as 'user' | 'assistant', content: blocks }
    })

    // Resolve provider — use override model if specified and different from config
    let provider = this.provider
    if (input.model && input.model !== this.config.model.model_id) {
      if (!this.createProviderForModel) {
        return {
          error: 'Model override is not available — createProviderForModel callback not configured',
          errorCode: 'MODEL_ERROR'
        }
      }
      try {
        provider = this.createProviderForModel(input.model)
      } catch (err) {
        return {
          error: `Failed to create provider for model "${input.model}": ${err instanceof Error ? err.message : String(err)}`,
          errorCode: 'MODEL_ERROR'
        }
      }
    }

    // Resolve parameters — input overrides config, with fallback defaults
    const temperature = input.temperature ?? this.config.model.temperature ?? 0.7
    const maxTokens = input.max_tokens ?? this.config.model.max_tokens ?? 4096
    const topP = input.top_p ?? this.config.model.top_p

    try {
      const { response, metadata } = await callLlmWithMetadata(provider, {
        system: systemText,
        messages,
        maxTokens,
        temperature,
        topP,
        providerParams: input.provider_params ?? this.config.model.provider_params
      })
      const eventData = toLlmCallEventData(metadata, 'model_invoke')
      this.onLlmCall?.(eventData)
      this.emitLlmCallEvent(eventData)

      // Extract text from response content blocks
      const textParts: string[] = []
      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        }
      }

      // Record token usage
      getTokenUsageService().recordUsage(
        metadata.provider,
        metadata.model,
        metadata.input_tokens,
        metadata.output_tokens
      )

      if (textParts.length === 0) {
        return {
          error: 'Model returned empty content',
          errorCode: 'MODEL_REFUSED'
        }
      }

      return { result: textParts.join(''), raw: true }
    } catch (err) {
      const metadata = getAttachedLlmCallMetadata(err)
      if (metadata) {
        const eventData = toLlmCallEventData(metadata, 'model_invoke')
        this.onLlmCall?.(eventData)
        this.emitLlmCallEvent(eventData)
      }
      const errorMsg = `model_invoke failed: ${err instanceof Error ? err.message : String(err)}`
      this.logCall('error', 'model_invoke', null, errorMsg.slice(0, 200))
      return {
        error: errorMsg,
        errorCode: 'MODEL_ERROR'
      }
    }
  }

  private emitLlmCallEvent(data: LlmCallEventData): void {
    const { source, ...rest } = data
    emitUmbilicalEvent({
      event_type: data.stop_reason === 'error' ? 'llm.failed' : 'llm.completed',
      agentId: this.config.id,
      payload: { ...rest, call_source: source },
    })
  }

  /** Extract text from string or content block array. */
  private extractTextContent(content: string | ModelInvokeContentBlock[]): string {
    if (typeof content === 'string') return content
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('')
  }

  /**
   * Handle sys_lambda — delegate to the sys_lambda tool.
   * Circular detection is managed via callStack.
   */
  private async handleSysLambda(args: unknown): Promise<AdfCallResult> {
    const input = args as { source?: string; args?: Record<string, unknown> }

    if (!input.source || typeof input.source !== 'string') {
      return {
        error: 'sys_lambda requires a "source" string parameter',
        errorCode: 'INVALID_INPUT'
      }
    }

    // Parse source: "path/file.ts:functionName" or just "path/file.ts"
    const colonIdx = input.source.lastIndexOf(':')
    let filePath: string
    let functionName: string

    // Check if colon separates a function name (not part of the file path)
    if (colonIdx > 0 && !input.source.substring(0, colonIdx).includes('/')) {
      filePath = input.source.substring(0, colonIdx)
      functionName = input.source.substring(colonIdx + 1)
    } else if (colonIdx > 0 && colonIdx < input.source.length - 1) {
      // For paths like "utils/parser.ts:parse"
      const afterColon = input.source.substring(colonIdx + 1)
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(afterColon)) {
        filePath = input.source.substring(0, colonIdx)
        functionName = afterColon
      } else {
        filePath = input.source
        functionName = 'main'
      }
    } else {
      filePath = input.source
      functionName = 'main'
    }

    // Circular call detection
    const callKey = `${filePath}:${functionName}`
    if (this.callStack.includes(callKey)) {
      this.logCall('error', 'call_rejected', callKey, `Circular sys_lambda: ${this.callStack.join(' → ')} → ${callKey}`)
      return {
        error: `Circular sys_lambda detected: ${this.callStack.join(' → ')} → ${callKey}`,
        errorCode: 'CIRCULAR_CALL'
      }
    }

    this.callStack.push(callKey)
    try {
      // Read the source file
      const fileContent = this.workspace.readFile(filePath)
      if (fileContent === null) {
        return {
          error: `File "${filePath}" not found`,
          errorCode: 'NOT_FOUND'
        }
      }

      // Call-chain enforcement: unauthorized code cannot call authorized code
      const targetAuthorized = this.workspace.isFileAuthorized(filePath)
      if (targetAuthorized && !this.effectiveAuthorization()) {
        this.logCall('warn', 'call_rejected', callKey, `Unauthorized code cannot call authorized code`)
        return {
          error: `Cannot call authorized code from unauthorized context`,
          errorCode: 'REQUIRES_AUTHORIZED_CALLER'
        }
      }

      // The sys_lambda tool will handle execution — delegate to it
      const sysLambdaTool = this.toolRegistry.get('sys_lambda')
      if (!sysLambdaTool) {
        return {
          error: 'sys_lambda tool is not registered',
          errorCode: 'NOT_FOUND'
        }
      }

      const result = await sysLambdaTool.execute(
        { source: input.source, args: input.args },
        this.workspace
      )

      if (result.isError) {
        return { error: result.content, errorCode: 'FN_ERROR' }
      }

      return { result: result.content }
    } finally {
      this.callStack.pop()
    }
  }

  /**
   * Handle task_resolve — approve, deny, or modify an intercepted task.
   */
  private async handleTaskResolve(args: unknown): Promise<AdfCallResult> {
    const input = args as {
      task_id?: string
      action?: 'approve' | 'deny' | 'pending_approval'
      reason?: string
      modified_args?: Record<string, unknown>
      requires_authorization?: boolean
    }

    if (!input.task_id || typeof input.task_id !== 'string') {
      return { error: 'task_resolve requires a "task_id" string parameter', errorCode: 'INVALID_INPUT' }
    }
    if (!input.action || !['approve', 'deny', 'pending_approval'].includes(input.action)) {
      return { error: 'task_resolve requires "action" to be "approve", "deny", or "pending_approval"', errorCode: 'INVALID_INPUT' }
    }

    const task = this.workspace.getTask(input.task_id)
    if (!task) {
      return { error: `Task "${input.task_id}" not found`, errorCode: 'NOT_FOUND' }
    }
    if (task.status !== 'pending' && task.status !== 'pending_approval') {
      return { error: `Task "${input.task_id}" is in status "${task.status}" — can only resolve pending or pending_approval tasks`, errorCode: 'INVALID_STATE' }
    }

    // Set requires_authorization on the task (one-way: can only be set to true, never unset)
    if (input.requires_authorization === true && !task.requires_authorization) {
      this.workspace.setTaskRequiresAuthorization(input.task_id, true)
      task.requires_authorization = true
    }

    // Check task-level authorization before allowing approve/deny
    if (task.requires_authorization && !this.effectiveAuthorization()) {
      // Setting to pending_approval is allowed from unauthorized code (it's restrictive, not permissive)
      if (input.action !== 'pending_approval') {
        this.logCall('warn', 'call_rejected', 'task_resolve', `Task "${input.task_id}" requires authorized code to resolve`)
        return {
          error: `Task "${input.task_id}" requires authorized code to resolve. Ask the owner to authorize the source file.`,
          errorCode: 'REQUIRES_AUTHORIZED_CODE'
        }
      }
    }

    switch (input.action) {
      case 'approve': {
        // Executor-managed tasks (HIL): signal the executor to proceed — it executes the tool itself
        if (task.executor_managed) {
          this.workspace.updateTaskStatus(input.task_id, 'running')
          this.onHilApproved?.(input.task_id, true, input.modified_args)
          return { result: JSON.stringify({ task_id: input.task_id, status: 'approved' }) }
        }

        // Deferred tasks (async/on_tool_call): execute the tool here
        this.workspace.updateTaskStatus(input.task_id, 'running')
        const toolArgs = input.modified_args ?? JSON.parse(task.args)
        try {
          const result = await this.toolRegistry.executeTool(task.tool, toolArgs, this.workspace)
          const sideEffects = result.endTurn ? { endTurn: true } : undefined
          if (result.isError) {
            this.workspace.updateTaskStatus(input.task_id, 'failed', undefined, result.content)
            this.onTaskCompleted?.(input.task_id, task.tool, 'failed', undefined, result.content, sideEffects)
            return { result: JSON.stringify({ task_id: input.task_id, status: 'failed', error: result.content }) }
          }
          this.workspace.updateTaskStatus(input.task_id, 'completed', result.content)
          this.onTaskCompleted?.(input.task_id, task.tool, 'completed', result.content, undefined, sideEffects)
          return { result: JSON.stringify({ task_id: input.task_id, status: 'completed', result: result.content }) }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.workspace.updateTaskStatus(input.task_id, 'failed', undefined, errorMsg)
          this.onTaskCompleted?.(input.task_id, task.tool, 'failed', undefined, errorMsg)
          return { result: JSON.stringify({ task_id: input.task_id, status: 'failed', error: errorMsg }) }
        }
      }
      case 'deny': {
        const reason = input.reason ?? 'Denied'
        this.workspace.updateTaskStatus(input.task_id, 'denied', undefined, reason)
        // Executor-managed: signal the executor to reject
        if (task.executor_managed) {
          this.onHilApproved?.(input.task_id, false)
        }
        this.onTaskCompleted?.(input.task_id, task.tool, 'denied', undefined, reason)
        return { result: JSON.stringify({ task_id: input.task_id, status: 'denied', reason }) }
      }
      case 'pending_approval': {
        this.workspace.updateTaskStatus(input.task_id, 'pending_approval')
        return { result: JSON.stringify({ task_id: input.task_id, status: 'pending_approval' }) }
      }
    }
  }

  /**
   * Handle loop_inject — write a [Context: loop_inject] entry to the loop.
   */
  private handleEmitEvent(args: unknown): AdfCallResult {
    const input = args as { event_type?: unknown; payload?: unknown }
    if (typeof input.event_type !== 'string' || input.event_type.length === 0) {
      return { error: 'emit_event requires event_type: string', errorCode: 'INVALID_INPUT' }
    }
    if (!input.event_type.startsWith('custom.')) {
      return {
        error: 'emit_event event_type must start with "custom." — the custom.* namespace is reserved for agent-authored events.',
        errorCode: 'INVALID_EVENT_TYPE'
      }
    }
    const payload = (input.payload && typeof input.payload === 'object') ? input.payload as Record<string, unknown> : {}
    // Lazy import to avoid circular dep (emit-umbilical has no deps on this file but the other way around is noisy).
    const { emitUmbilicalEvent } = require('./emit-umbilical') as typeof import('./emit-umbilical')
    emitUmbilicalEvent({
      event_type: input.event_type,
      payload
    })
    return { result: `Emitted ${input.event_type}.` }
  }

  private handleLoopInject(args: unknown): AdfCallResult {
    const input = args as { content?: string }

    if (!input.content || typeof input.content !== 'string') {
      return {
        error: 'loop_inject requires a "content" string parameter',
        errorCode: 'INVALID_INPUT'
      }
    }

    try {
      const text = `[Context: loop_inject] ${input.content}`
      this.workspace.appendToLoop('user', [{ type: 'text', text }])
      this.onEvent?.({
        type: 'context_injected',
        payload: { category: 'loop_inject', content: text },
        timestamp: Date.now()
      })
      return { result: `Injected context entry (${input.content.length} chars).` }
    } catch (err) {
      const errorMsg = `loop_inject failed: ${err instanceof Error ? err.message : String(err)}`
      this.logCall('error', 'loop_inject', null, errorMsg.slice(0, 200))
      return { error: errorMsg, errorCode: 'INTERNAL_ERROR' }
    }
  }

  /**
   * Handle get_identity — read a value from adf_identity (respects code_access flag).
   * Never falls back to app-level settings — only agent-owned keys are accessible.
   */
  private handleGetIdentity(args: unknown): AdfCallResult {
    const input = args as { purpose?: string }

    // No purpose → list accessible identity key purposes
    if (!input.purpose) {
      try {
        const entries = this.workspace.listIdentityEntries()
        const purposes = entries.map((e) => ({
          purpose: e.purpose,
          encrypted: e.encrypted,
        }))
        this.logCall('info', 'get_identity', '(list)', `Listed ${purposes.length} identity entries`)
        return { result: purposes }
      } catch {
        return { result: [] }
      }
    }

    if (typeof input.purpose !== 'string') {
      return { error: 'get_identity "purpose" must be a string', errorCode: 'INVALID_INPUT' }
    }

    if (!this.resolveIdentity) {
      return { error: 'Identity resolution not available', errorCode: 'NOT_CONFIGURED' }
    }

    const value = this.resolveIdentity(input.purpose)
    if (value === null) {
      return {
        error: `Identity "${input.purpose}" not found or not accessible from code`,
        errorCode: 'NOT_FOUND'
      }
    }

    this.logCall('info', 'get_identity', input.purpose, `Identity accessed from code`)
    return { result: value, raw: true }
  }

  /**
   * Store a value in the agent's identity keystore from code.
   * Used by agents to store MCP server credentials, API keys, etc.
   */
  private handleSetIdentity(args: unknown): AdfCallResult {
    const input = args as { purpose?: string; value?: string }

    if (!input.purpose || typeof input.purpose !== 'string') {
      return { error: 'set_identity requires a "purpose" string parameter', errorCode: 'INVALID_INPUT' }
    }
    if (input.value === undefined || typeof input.value !== 'string') {
      return { error: 'set_identity requires a "value" string parameter', errorCode: 'INVALID_INPUT' }
    }

    try {
      this.workspace.setIdentity(input.purpose, input.value)
      this.logCall('info', 'set_identity', input.purpose, 'Identity stored from code')
      return { result: { success: true, purpose: input.purpose } }
    } catch (err) {
      return { error: `Failed to store identity: ${err instanceof Error ? err.message : String(err)}`, errorCode: 'WRITE_ERROR' }
    }
  }

  /**
   * Handle authorize_file — set the authorized flag on a file.
   * Only callable from authorized code (gateway pattern).
   */
  private handleAuthorizeFile(args: unknown): AdfCallResult {
    if (!this.effectiveAuthorization()) {
      this.logCall('warn', 'call_rejected', 'authorize_file', 'authorize_file requires authorized code')
      return {
        error: '"authorize_file" can only be called from authorized code',
        errorCode: 'REQUIRES_AUTHORIZED_CODE'
      }
    }

    const input = args as { path?: string; authorized?: boolean }
    if (!input.path || typeof input.path !== 'string') {
      return { error: 'authorize_file requires a "path" string parameter', errorCode: 'INVALID_INPUT' }
    }

    const authorized = input.authorized !== false // default true
    try {
      const success = this.workspace.setFileAuthorized(input.path, authorized)
      if (!success) {
        return { error: `File "${input.path}" not found`, errorCode: 'NOT_FOUND' }
      }
      this.logCall('info', 'authorize_file', input.path, `File ${authorized ? 'authorized' : 'deauthorized'} from code`)
      return { result: JSON.stringify({ success: true, path: input.path, authorized }) }
    } catch (err) {
      return { error: `Failed to authorize file: ${err instanceof Error ? err.message : String(err)}`, errorCode: 'WRITE_ERROR' }
    }
  }

  /** Authorized-code bypass: write to any meta key, ignoring protection. */
  private handleAuthorizedSetMeta(args: unknown): AdfCallResult {
    const input = args as { key?: string; value?: string; protection?: string }
    if (!input.key || typeof input.key !== 'string') {
      return { error: 'sys_set_meta requires a "key" string parameter', errorCode: 'INVALID_INPUT' }
    }
    if (input.value === undefined || typeof input.value !== 'string') {
      return { error: 'sys_set_meta requires a "value" string parameter', errorCode: 'INVALID_INPUT' }
    }
    const protection = (input.protection as MetaProtectionLevel) || undefined
    if (protection && !META_PROTECTION_LEVELS.includes(protection)) {
      return { error: `Invalid protection level "${protection}". Valid: ${META_PROTECTION_LEVELS.join(', ')}`, errorCode: 'INVALID_INPUT' }
    }
    try {
      this.workspace.setMeta(input.key, input.value, protection)
      this.logCall('info', 'authorized_set_meta', input.key, `Authorized write to "${input.key}"`)
      return { result: 'OK' }
    } catch (err) {
      return { error: `Failed to set meta: ${err instanceof Error ? err.message : String(err)}`, errorCode: 'WRITE_ERROR' }
    }
  }

  /** Authorized-code bypass: delete any meta key, ignoring protection. */
  private handleAuthorizedDeleteMeta(args: unknown): AdfCallResult {
    const input = args as { key?: string }
    if (!input.key || typeof input.key !== 'string') {
      return { error: 'sys_delete_meta requires a "key" string parameter', errorCode: 'INVALID_INPUT' }
    }
    try {
      const deleted = this.workspace.deleteMeta(input.key)
      this.logCall('info', 'authorized_delete_meta', input.key, `Authorized delete of "${input.key}"`)
      return { result: deleted ? 'OK' : `Key "${input.key}" not found.` }
    } catch (err) {
      return { error: `Failed to delete meta: ${err instanceof Error ? err.message : String(err)}`, errorCode: 'WRITE_ERROR' }
    }
  }

  /** Authorized-code only: change meta key protection level. */
  private handleSetMetaProtection(args: unknown): AdfCallResult {
    const input = args as { key?: string; protection?: string }
    if (!input.key || typeof input.key !== 'string') {
      return { error: 'set_meta_protection requires a "key" string parameter', errorCode: 'INVALID_INPUT' }
    }
    if (!input.protection || !META_PROTECTION_LEVELS.includes(input.protection as MetaProtectionLevel)) {
      return { error: `set_meta_protection requires a "protection" parameter. Valid: ${META_PROTECTION_LEVELS.join(', ')}`, errorCode: 'INVALID_INPUT' }
    }
    try {
      const success = this.workspace.setMetaProtection(input.key, input.protection as MetaProtectionLevel)
      if (!success) {
        return { error: `Key "${input.key}" not found`, errorCode: 'NOT_FOUND' }
      }
      this.logCall('info', 'set_meta_protection', input.key, `Protection set to "${input.protection}"`)
      return { result: 'OK' }
    } catch (err) {
      return { error: `Failed to set meta protection: ${err instanceof Error ? err.message : String(err)}`, errorCode: 'WRITE_ERROR' }
    }
  }

  /** Authorized-code only: change file protection level. */
  private handleSetFileProtection(args: unknown): AdfCallResult {
    const input = args as { path?: string; protection?: string }
    if (!input.path || typeof input.path !== 'string') {
      return { error: 'set_file_protection requires a "path" string parameter', errorCode: 'INVALID_INPUT' }
    }
    if (!input.protection || !FILE_PROTECTION_LEVELS.includes(input.protection as FileProtectionLevel)) {
      return { error: `set_file_protection requires a "protection" parameter. Valid: ${FILE_PROTECTION_LEVELS.join(', ')}`, errorCode: 'INVALID_INPUT' }
    }
    try {
      const success = this.workspace.setFileProtection(input.path, input.protection as FileProtectionLevel)
      if (!success) {
        return { error: `File "${input.path}" not found`, errorCode: 'NOT_FOUND' }
      }
      this.logCall('info', 'set_file_protection', input.path, `Protection set to "${input.protection}"`)
      return { result: 'OK' }
    } catch (err) {
      return { error: `Failed to set file protection: ${err instanceof Error ? err.message : String(err)}`, errorCode: 'WRITE_ERROR' }
    }
  }

  /**
   * Execute a tool asynchronously from a lambda context (fire-and-forget).
   */
  private async executeAsyncToolFromLambda(taskId: string, method: string, args: unknown, authorized: boolean): Promise<void> {
    try {
      this.workspace.updateTaskStatus(taskId, 'running')
      const toolArgs = authorized && args && typeof args === 'object'
        ? { ...(args as Record<string, unknown>), _authorized: true }
        : args
      const result = await this.toolRegistry.executeTool(method, toolArgs, this.workspace)
      const sideEffects = result.endTurn ? { endTurn: true } : undefined
      if (result.isError) {
        this.workspace.updateTaskStatus(taskId, 'failed', undefined, result.content)
        this.onTaskCompleted?.(taskId, method, 'failed', undefined, result.content, sideEffects)
      } else {
        this.workspace.updateTaskStatus(taskId, 'completed', result.content)
        this.onTaskCompleted?.(taskId, method, 'completed', result.content, undefined, sideEffects)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.workspace.updateTaskStatus(taskId, 'failed', undefined, errorMsg)
      this.onTaskCompleted?.(taskId, method, 'failed', undefined, errorMsg)
    }
  }

  /** Get the list of enabled tool names for proxy fast-fail */
  getEnabledToolNames(): string[] {
    const ce = { ...CODE_EXECUTION_DEFAULTS, ...this.config.code_execution }
    const ceMethods = (Object.keys(ce) as (keyof CodeExecutionConfig)[])
      .filter(k => ce[k])
    return this.config.tools
      .filter(t => t.enabled || t.restricted) // include disabled restricted tools (authorized code can call)
      .map(t => t.name)
      .concat(ceMethods)
  }

  /** Get the list of HIL tool names for proxy fast-fail (enabled + restricted = HIL from code) */
  getHilToolNames(): string[] {
    return this.config.tools
      .filter(t => t.enabled && t.restricted)
      .map(t => t.name)
  }

  /**
   * Schemas for code-execution-only methods (model_invoke, sys_lambda, etc.).
   * Used by the UI to show schema modals — kept alongside the implementation
   * so changes stay in sync.
   */
  static getCodeExecutionSchemas(): Record<string, { name: string; description: string; input_schema: Record<string, unknown> }> {
    return {
      model_invoke: {
        name: 'model_invoke',
        description: 'Direct LLM call with a messages array. No tools or streaming. Returns the model\'s text response.',
        input_schema: {
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              description: 'Array of messages. System messages must appear first, before any user/assistant messages.',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { description: 'String or array of content blocks (text, image_url, input_audio, video_url)' }
                },
                required: ['role', 'content']
              }
            },
            model: { type: 'string', description: 'Override model ID (uses agent\'s configured model if omitted)' },
            temperature: { type: 'number', description: 'Sampling temperature (default: config value or 0.7)' },
            max_tokens: { type: 'number', description: 'Max output tokens (default: config value or 4096)' },
            top_p: { type: 'number', description: 'Nucleus sampling top-p' },
            provider_params: { type: 'object', description: 'Provider-specific parameters' }
          },
          required: ['messages']
        }
      },
      sys_lambda: {
        name: 'sys_lambda',
        description: 'Execute a lambda function from a file in the ADF workspace. Supports circular call detection.',
        input_schema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'File path with optional function name: "path/file.ts:functionName" (defaults to "main")' },
            args: { type: 'object', description: 'Arguments passed to the lambda function' }
          },
          required: ['source']
        }
      },
      task_resolve: {
        name: 'task_resolve',
        description: 'Approve, deny, or escalate an intercepted task (pending or pending_approval status).',
        input_schema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'ID of the task to resolve' },
            action: { type: 'string', enum: ['approve', 'deny', 'pending_approval'], description: 'Resolution action' },
            reason: { type: 'string', description: 'Reason for denial (used when action is "deny")' },
            modified_args: { type: 'object', description: 'Override tool arguments when approving (uses original args if omitted)' }
          },
          required: ['task_id', 'action']
        }
      },
      loop_inject: {
        name: 'loop_inject',
        description: 'Inject a [Context: loop_inject] entry into the agent\'s conversation loop.',
        input_schema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Text content to inject into the loop' }
          },
          required: ['content']
        }
      },
      get_identity: {
        name: 'get_identity',
        description: 'Read a value from adf_identity, or list all keys if no purpose given. Call with no args to see available identity entries.',
        input_schema: {
          type: 'object',
          properties: {
            purpose: { type: 'string', description: 'The identity key/purpose to look up. Omit to list all available keys.' }
          }
        }
      },
      set_identity: {
        name: 'set_identity',
        description: 'Store a value in adf_identity. Use for MCP credentials (purpose: "mcp:<serverName>:<key>"), API keys, or other secrets.',
        input_schema: {
          type: 'object',
          properties: {
            purpose: { type: 'string', description: 'The identity key/purpose (e.g. "mcp:garmin:GARMIN_EMAIL")' },
            value: { type: 'string', description: 'The value to store' }
          },
          required: ['purpose', 'value']
        }
      },
      emit_event: {
        name: 'emit_event',
        description: 'Emit a custom umbilical event. event_type must start with "custom." — the custom.* namespace is reserved for agent-authored events. Payload is arbitrary JSON-serializable data.',
        input_schema: {
          type: 'object',
          properties: {
            event_type: { type: 'string', description: 'Event type, must start with "custom." (e.g. "custom.order_placed")' },
            payload: { description: 'Arbitrary JSON-serializable payload to attach to the event' }
          },
          required: ['event_type']
        }
      }
    }
  }
}
