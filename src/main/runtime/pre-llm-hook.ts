import { randomUUID } from 'crypto'
import type { AgentConfig, PreLlmHookConfig } from '../../shared/types/adf-v02.types'
import type { LLMMessage, ReasoningConfig } from '../../shared/types/provider.types'
import type { ToolProviderFormat } from '../../shared/types/tool.types'
import { ToolRegistry } from '../tools/tool-registry'
import { SysLambdaTool } from '../tools/built-in/sys-lambda.tool'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AdfCallHandler } from './adf-call-handler'
import type { CodeSandboxService } from './code-sandbox'
import { loadLambdaSource } from './ts-transpiler'
import { withAuthorization } from './authorization-context'
import { withSource } from './execution-context'

/**
 * JSON-safe portion of CreateMessageOptions. Runtime-owned callbacks and the
 * abort signal deliberately never cross the hook boundary.
 */
export interface PreLlmHookRequestOptions {
  maxTokens?: number
  temperature?: number
  topP?: number
  thinkingBudget?: number
  reasoning?: ReasoningConfig
  dynamicInstructions?: string
  providerParams?: Record<string, unknown>
}

/** The mutable, request-local portion of a normal conversational LLM call. */
export interface PreLlmHookRequest {
  system: string
  messages: LLMMessage[]
  tools: ToolProviderFormat[]
  options: PreLlmHookRequestOptions
}

/** The sole argument passed to a pre-LLM lambda. The lambda returns `request`. */
export interface PreLlmHookInput {
  request: PreLlmHookRequest
  loop: { name: string }
}

/** Errors here are deliberately structural: a configured hook must fail closed. */
export class PreLlmHookError extends Error {
  constructor(message: string) {
    super(`Pre-LLM hook failed: ${message}`)
    this.name = 'PreLlmHookError'
  }
}

const MAX_HOOK_TIMEOUT_MS = 300_000
const MAX_HOOK_LOOPS = 64
const MIN_HOOK_TIMEOUT_MS = 1_000
const OPTION_KEYS = new Set<keyof PreLlmHookRequestOptions>([
  'maxTokens', 'temperature', 'topP', 'thinkingBudget',
  'reasoning', 'dynamicInstructions', 'providerParams',
])
const LOOP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isJsonValue(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return false
    seen.add(value)
    const valid = value.every(item => isJsonValue(item, seen))
    seen.delete(value)
    return valid
  }
  if (!isPlainObject(value) || seen.has(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(item => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

/** JSON clone before code execution makes request transformation non-persistent. */
export function clonePreLlmHookJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (error) {
    throw new PreLlmHookError(`could not serialize request as JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

function validateHookConfig(hook: PreLlmHookConfig): Required<Pick<PreLlmHookConfig, 'source' | 'scope'>> & PreLlmHookConfig {
  if (typeof hook.source !== 'string' || hook.source.trim().length === 0) {
    throw new PreLlmHookError('config source must be a non-empty string')
  }
  const scope = hook.scope ?? 'all'
  if (scope !== 'all' && scope !== 'main' && scope !== 'loops') {
    throw new PreLlmHookError('config scope must be "all", "main", or "loops"')
  }

  const loops = hook.loops
  if (hook.include_main !== undefined && typeof hook.include_main !== 'boolean') {
    throw new PreLlmHookError('config include_main must be a boolean')
  }
  if (scope !== 'loops' && hook.include_main !== undefined) {
    throw new PreLlmHookError('config include_main is only allowed with scope "loops"')
  }
  if (scope === 'loops') {
    if (!Array.isArray(loops) || loops.length === 0) {
      throw new PreLlmHookError('config scope "loops" requires a non-empty loops array')
    }
    if (loops.length > MAX_HOOK_LOOPS) {
      throw new PreLlmHookError(`config loops must contain no more than ${MAX_HOOK_LOOPS} entries`)
    }
    const seen = new Set<string>()
    for (const loop of loops) {
      if (typeof loop !== 'string' || !LOOP_NAME_PATTERN.test(loop) || loop === 'main') {
        throw new PreLlmHookError('config loops entries must be named inner-loop identifiers, not "main"')
      }
      if (seen.has(loop)) throw new PreLlmHookError(`config loops contains duplicate "${loop}"`)
      seen.add(loop)
    }
  } else if (loops !== undefined) {
    throw new PreLlmHookError('config loops is only allowed with scope "loops"')
  }

  if (hook.timeout_ms !== undefined && (
    typeof hook.timeout_ms !== 'number' ||
    !Number.isFinite(hook.timeout_ms) ||
    !Number.isInteger(hook.timeout_ms) ||
    hook.timeout_ms < MIN_HOOK_TIMEOUT_MS ||
    hook.timeout_ms > MAX_HOOK_TIMEOUT_MS
  )) {
    throw new PreLlmHookError(`config timeout_ms must be an integer from ${MIN_HOOK_TIMEOUT_MS} to ${MAX_HOOK_TIMEOUT_MS}`)
  }

  return { ...hook, source: hook.source.trim(), scope }
}

/**
 * True when this executor's stream is selected. Validates the complete config
 * even when it does not select this stream: malformed hook configuration must
 * never quietly become an unhooked provider call.
 */
export function preLlmHookApplies(config: AgentConfig, loopName: string): boolean {
  const configured = config.pre_llm_hook
  if (!configured) return false
  const hook = validateHookConfig(configured)
  if (hook.scope === 'all') return true
  if (hook.scope === 'main') return loopName === 'main'
  return loopName === 'main' ? hook.include_main === true : hook.loops!.includes(loopName)
}

function parseLambdaSource(source: string): { filePath: string; functionName: string } {
  const colonIdx = source.lastIndexOf(':')
  if (colonIdx > 0 && colonIdx < source.length - 1) {
    const candidate = source.slice(colonIdx + 1)
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(candidate)) {
      return { filePath: source.slice(0, colonIdx), functionName: candidate }
    }
  }
  return { filePath: source, functionName: 'main' }
}

function validateContentBlock(block: unknown, messageIndex: number, blockIndex: number, role: string): void {
  const path = `returned request.messages[${messageIndex}].content[${blockIndex}]`
  if (!isPlainObject(block) || typeof block.type !== 'string') {
    throw new PreLlmHookError(`${path} must be a content-block object`)
  }
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') throw new PreLlmHookError(`${path}.text must be a string`)
      break
    case 'thinking':
      if (role !== 'assistant' || typeof block.thinking !== 'string') {
        throw new PreLlmHookError(`${path} must be an assistant thinking block with a string thinking value`)
      }
      break
    case 'tool_use':
      if (role !== 'assistant' || typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name ||
          (block.input !== undefined && !isJsonValue(block.input))) {
        throw new PreLlmHookError(`${path} must be an assistant tool_use with id, name, and JSON-safe input`)
      }
      break
    case 'tool_result':
      if (role !== 'user' || typeof block.tool_use_id !== 'string' || !block.tool_use_id || typeof block.content !== 'string' ||
          (block.is_error !== undefined && typeof block.is_error !== 'boolean')) {
        throw new PreLlmHookError(`${path} must be a user tool_result with tool_use_id and string content`)
      }
      break
    case 'image_url':
      if (role !== 'user' || !isPlainObject(block.image_url) || typeof block.image_url.url !== 'string') {
        throw new PreLlmHookError(`${path} must be a user image_url block with image_url.url`)
      }
      break
    case 'input_audio':
      if (role !== 'user' || !isPlainObject(block.input_audio) || typeof block.input_audio.data !== 'string' || typeof block.input_audio.format !== 'string') {
        throw new PreLlmHookError(`${path} must be a user input_audio block with data and format`)
      }
      break
    case 'video_url':
      if (role !== 'user' || !isPlainObject(block.video_url) || typeof block.video_url.url !== 'string') {
        throw new PreLlmHookError(`${path} must be a user video_url block with video_url.url`)
      }
      break
    default:
      throw new PreLlmHookError(`${path}.type "${block.type}" is not supported by the provider request contract`)
  }
  if (!isJsonValue(block)) throw new PreLlmHookError(`${path} must be JSON-safe`)
}

function validateMessage(message: unknown, index: number): asserts message is LLMMessage {
  if (!isPlainObject(message)) throw new PreLlmHookError(`returned request.messages[${index}] must be an object`)
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new PreLlmHookError(`returned request.messages[${index}].role must be "user" or "assistant"`)
  }
  if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
    throw new PreLlmHookError(`returned request.messages[${index}].content must be a string or content-block array`)
  }
  if (Array.isArray(message.content)) message.content.forEach((block, blockIndex) => validateContentBlock(block, index, blockIndex, message.role))
  if (!isJsonValue(message)) {
    throw new PreLlmHookError(`returned request.messages[${index}] must be JSON-safe`)
  }
}

/** Provider rejects orphan tool blocks; preserve that invariant after rewrite. */
function validateToolPairing(messages: LLMMessage[]): void {
  const outstanding = new Set<string>()
  const completed = new Set<string>()
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const content = messages[messageIndex].content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') {
        if (outstanding.has(block.id!) || completed.has(block.id!)) {
          throw new PreLlmHookError(`returned request contains duplicate tool_use id "${block.id}"`)
        }
        outstanding.add(block.id!)
      } else if (block.type === 'tool_result') {
        const id = block.tool_use_id!
        if (!outstanding.has(id)) {
          throw new PreLlmHookError(`returned request has tool_result "${id}" without an earlier unmatched tool_use`)
        }
        outstanding.delete(id)
        completed.add(id)
      }
    }
  }
  if (outstanding.size > 0) {
    throw new PreLlmHookError(`returned request has tool_use without tool_result (${Array.from(outstanding).join(', ')})`)
  }
}

function validateTool(tool: unknown, index: number): asserts tool is ToolProviderFormat {
  if (!isPlainObject(tool)) throw new PreLlmHookError(`returned request.tools[${index}] must be an object`)
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new PreLlmHookError(`returned request.tools[${index}].name must be a non-empty string`)
  }
  if (typeof tool.description !== 'string') {
    throw new PreLlmHookError(`returned request.tools[${index}].description must be a string`)
  }
  if (!isPlainObject(tool.input_schema) || !isJsonValue(tool.input_schema)) {
    throw new PreLlmHookError(`returned request.tools[${index}].input_schema must be a JSON object`)
  }
}

function validateOptions(options: unknown): asserts options is PreLlmHookRequestOptions {
  if (!isPlainObject(options)) throw new PreLlmHookError('returned request.options must be an object')
  for (const [key, value] of Object.entries(options)) {
    if (!OPTION_KEYS.has(key as keyof PreLlmHookRequestOptions)) {
      throw new PreLlmHookError(`returned request.options contains unsupported key "${key}"`)
    }
    if (key === 'maxTokens' || key === 'thinkingBudget') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new PreLlmHookError(`returned request.options.${key} must be a positive integer`)
      }
    } else if (key === 'temperature') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
        throw new PreLlmHookError('returned request.options.temperature must be a finite number from 0 to 2')
      }
    } else if (key === 'topP') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new PreLlmHookError('returned request.options.topP must be a finite number from 0 to 1')
      }
    } else if (key === 'dynamicInstructions') {
      if (typeof value !== 'string') throw new PreLlmHookError('returned request.options.dynamicInstructions must be a string')
    } else if ((key === 'reasoning' || key === 'providerParams') && (!isPlainObject(value) || !isJsonValue(value))) {
      throw new PreLlmHookError(`returned request.options.${key} must be a JSON object`)
    }
  }
}

/** Validate and type the lambda's JSON return. It must be request only. */
export function validatePreLlmHookRequest(value: unknown): PreLlmHookRequest {
  if (!isPlainObject(value)) throw new PreLlmHookError('lambda must return a JSON request object')
  const allowed = new Set(['system', 'messages', 'tools', 'options'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PreLlmHookError(`returned request contains unsupported key "${key}"`)
  }
  if (typeof value.system !== 'string') throw new PreLlmHookError('returned request.system must be a string')
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new PreLlmHookError('returned request.messages must be a non-empty array')
  }
  value.messages.forEach(validateMessage)
  validateToolPairing(value.messages as LLMMessage[])
  if (!Array.isArray(value.tools)) throw new PreLlmHookError('returned request.tools must be an array')
  const toolNames = new Set<string>()
  value.tools.forEach((tool, index) => {
    validateTool(tool, index)
    if (toolNames.has(tool.name)) throw new PreLlmHookError(`returned request.tools contains duplicate name "${tool.name}"`)
    toolNames.add(tool.name)
  })
  validateOptions(value.options)
  if (!isJsonValue(value)) throw new PreLlmHookError('lambda result must be JSON-safe')
  return value as unknown as PreLlmHookRequest
}

function effectiveTimeout(config: AgentConfig, hook: PreLlmHookConfig): number {
  const limit = config.limits?.execution_timeout_ms
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new PreLlmHookError('limits.execution_timeout_ms must be a positive integer')
  }
  // validateHookConfig verifies the configured value. The agent-level execution
  // limit remains the authority; a hook can only shorten it.
  return Math.min(hook.timeout_ms ?? limit, limit, MAX_HOOK_TIMEOUT_MS)
}

/**
 * Executes the configured pre-LLM lambda through the existing sandbox/RPC
 * bridge. It is intentionally separate from SysLambdaTool: a pre-LLM hook is
 * an explicit runtime entry point, not a tool grant to the conversational LLM.
 */
export class PreLlmHookRunner {
  constructor(
    private readonly workspace: AdfWorkspace,
    private readonly codeSandboxService: CodeSandboxService,
    private readonly adfCallHandler: AdfCallHandler,
    private readonly agentId: string,
  ) {}

  async transform(config: AgentConfig, request: PreLlmHookRequest, signal?: AbortSignal): Promise<PreLlmHookRequest> {
    const configured = config.pre_llm_hook
    if (!configured) return request
    const hook = validateHookConfig(configured)
    if (signal?.aborted) throw new PreLlmHookError('turn was cancelled before hook execution')

    const { filePath, functionName } = parseLambdaSource(hook.source)
    let source: string | null
    try {
      source = await loadLambdaSource(path => this.workspace.readFile(path), filePath)
    } catch (error) {
      throw new PreLlmHookError(`could not load "${filePath}" (${error instanceof Error ? error.message : String(error)})`)
    }
    if (source === null) throw new PreLlmHookError(`source file "${filePath}" was not found`)

    // Exactly the authorization semantics of SysLambdaTool: source-file status
    // is bound through ALS to every nested adf.* call. The hook gets a private
    // registry containing the live runtime tools plus a private sys_lambda
    // backend; the shared registry remains declaration-dependent, so merely
    // having sys_code (or adding a hook live) cannot expose sys_lambda to the
    // normal LLM/code path.
    let fileAuthorized: boolean
    let hookHandler: AdfCallHandler
    let toolConfig: { enabledTools: string[]; hilTools: string[]; isAuthorized: boolean }
    try {
      fileAuthorized = this.workspace.isFileAuthorized(filePath)
      const hookRegistry = new ToolRegistry()
      for (const tool of this.adfCallHandler.getToolRegistry().getAll()) hookRegistry.register(tool)
      hookHandler = this.adfCallHandler.forLoop(this.workspace, config, hookRegistry)
      const session = this.adfCallHandler.getAttachedSession()
      if (session) hookHandler.attachSession(session)
      hookHandler.onEvent = this.adfCallHandler.onEvent
      hookHandler.onTaskCompleted = this.adfCallHandler.onTaskCompleted
      hookHandler.onLambdaToolEndTurn = this.adfCallHandler.onLambdaToolEndTurn
      hookHandler.onHilApproved = this.adfCallHandler.onHilApproved
      hookHandler.requestProtectionApproval = this.adfCallHandler.requestProtectionApproval
      hookHandler.onLlmCall = this.adfCallHandler.onLlmCall
      hookRegistry.register(new SysLambdaTool(
        this.codeSandboxService,
        hookHandler,
        this.agentId,
        config.limits?.execution_timeout_ms,
      ))
      hookHandler.setAuthorizationContext(fileAuthorized)
      toolConfig = {
        enabledTools: hookHandler.getEnabledToolNames(),
        hilTools: hookHandler.getHilToolNames(),
        isAuthorized: fileAuthorized,
      }
    } catch (error) {
      throw new PreLlmHookError(`could not establish code-execution authority (${error instanceof Error ? error.message : String(error)})`)
    }
    const onAdfCall = (method: string, args: unknown) =>
      withAuthorization(fileAuthorized, () => hookHandler.handleCall(method, args))
    let input: PreLlmHookInput
    try {
      input = clonePreLlmHookJson({
        request,
        loop: { name: this.workspace.getLoopName() },
      })
    } catch (error) {
      if (error instanceof PreLlmHookError) throw error
      throw new PreLlmHookError(`could not assemble hook input (${error instanceof Error ? error.message : String(error)})`)
    }
    const code = `
${source}

if (typeof ${functionName} === 'function') {
  return await ${functionName}(${JSON.stringify(input)});
}
throw new Error('Function "${functionName}" not found in "${filePath}".');
`

    const timeout = effectiveTimeout(config, hook)
    const started = performance.now()
    try {
      this.workspace.insertLog('info', 'pre_llm_hook', 'execute', hook.source, `${functionName}()`, {
        loop: input.loop.name,
        timeout_ms: timeout,
      })
    } catch { /* observability must not weaken the hook boundary */ }

    // Each request gets a fresh worker. This prevents hook module/global state
    // from leaking across tool rounds and isolates abort collateral from all
    // ordinary sandbox callers.
    const sandboxId = `${this.agentId}:pre_llm_hook:${randomUUID()}`
    const result = await (async () => {
      try {
        return await withSource(`lambda:${filePath}:${functionName}`, this.agentId, () =>
          this.codeSandboxService.execute(
            sandboxId,
            code,
            timeout,
            onAdfCall,
            toolConfig,
            { handlerAuthorized: fileAuthorized, agent: this.agentId, signal, ephemeral: true, terminateOnAbort: true },
          )
        )
      } catch (error) {
        if (error instanceof PreLlmHookError) throw error
        throw new PreLlmHookError(`execution could not start (${error instanceof Error ? error.message : String(error)})`)
      } finally {
        // Hook workers are cold and request-scoped. Reap on both success and
        // failure; abort already terminates immediately, while this handles
        // ordinary completion before the cold-worker TTL can accumulate.
        this.codeSandboxService.destroy(sandboxId)
      }
    })()
    const durationMs = +(performance.now() - started).toFixed(2)
    if (result.error) {
      try { this.workspace.insertLog('error', 'pre_llm_hook', 'failed', hook.source, result.error.slice(0, 500), { duration_ms: durationMs }) } catch { /* no-op */ }
      throw new PreLlmHookError(result.error)
    }
    if (signal?.aborted) {
      throw new PreLlmHookError('turn was cancelled during hook execution')
    }
    if (typeof result.result !== 'string') {
      throw new PreLlmHookError('lambda returned no JSON request')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(result.result)
    } catch (error) {
      throw new PreLlmHookError(`lambda returned invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    const transformed = validatePreLlmHookRequest(parsed)
    try {
      this.workspace.insertLog('info', 'pre_llm_hook', 'result', hook.source, `${functionName}() → ok (${durationMs}ms)`, { duration_ms: durationMs })
    } catch { /* no-op */ }
    // One more clone protects callers from any reference held by validation.
    return clonePreLlmHookJson(transformed)
  }
}
