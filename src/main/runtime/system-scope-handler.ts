import type { AdfWorkspace } from '../adf/adf-workspace'
import type { CodeSandboxService } from './code-sandbox'
import type { AdfCallHandler } from './adf-call-handler'
import type { AdfBatchDispatch, AdfEventDispatch } from '../../shared/types/adf-event.types'
import { TRIGGER_TO_EVENT_TYPE } from '../../shared/types/adf-event.types'
import { loadLambdaSource } from './ts-transpiler'
import { withSource } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'

/**
 * Handles system scope triggers by loading and executing lambda functions
 * from adf_files. Each trigger target specifies a lambda in the format
 * "path/file.ts:functionName". The function receives a rich event object
 * and has access to adf.* methods via the sandbox RPC bridge.
 *
 * All executions are logged to adf_logs with structured columns:
 *   origin: 'lambda'
 *   event:  trigger type (e.g. 'on_inbox', 'on_timer')
 *   target: lambda path (e.g. 'lib/inbox-logger.ts:onMessage')
 */
export class SystemScopeHandler {
  constructor(
    private workspace: AdfWorkspace,
    private codeSandboxService: CodeSandboxService,
    private adfCallHandler: AdfCallHandler,
    private agentId: string
  ) {}

  /** Best-effort log to adf_logs — never throws. */
  private log(level: string, event: string | null, target: string | null, message: string, data?: unknown): void {
    try {
      this.workspace.insertLog(level, 'lambda', event, target, message, data)
      console.log(`[Lambda] adf_logs: ${level} | ${event} | ${target} | ${message.slice(0, 80)}`)
    } catch (err) {
      console.error(`[Lambda] insertLog failed (level=${level}, event=${event}, target=${target}):`, err)
    }
  }

  /**
   * Execute the lambda or shell command specified by the dispatch routing.
   * Lambda receives the AdfEvent directly — no transformation needed.
   */
  async execute(dispatch: AdfEventDispatch): Promise<string | undefined> {
    const { event, lambda, command, warm: warmFlag } = dispatch
    const triggerName = `on_${event.type}` in TRIGGER_TO_EVENT_TYPE
      ? `on_${event.type}`
      : Object.entries(TRIGGER_TO_EVENT_TYPE).find(([, v]) => v === event.type)?.[0] ?? event.type

    console.log(`[Lambda] execute() called: type=${event.type}, scope=${dispatch.scope}, lambda=${lambda ?? 'undefined'}, command=${command ?? 'undefined'}`)

    // Shell command trigger: execute via shell tool if available
    if (command && !lambda) {
      return this.executeShellCommand(command, dispatch)
    }

    if (!lambda) {
      console.warn(`[Lambda] System scope trigger fired without lambda or command — skipping (type: ${event.type})`)
      this.log('warn', triggerName, null, `System scope trigger fired without lambda or command — no execution`)
      return
    }

    // Parse "path/file.ts:functionName" — split on last ':'
    // If no function specified, default to main() (matches sys_lambda behavior)
    const lastColon = lambda.lastIndexOf(':')
    let filePath: string
    let fnName: string
    if (lastColon <= 0) {
      filePath = lambda
      fnName = 'main'
    } else {
      filePath = lambda.slice(0, lastColon)
      fnName = lambda.slice(lastColon + 1)
    }

    console.log(`[Lambda] Firing ${lambda} (trigger: ${event.type}, scope: ${dispatch.scope})`)

    // Load file from workspace (transpile .ts automatically)
    let fileContent: string | null
    try {
      fileContent = await loadLambdaSource(p => this.workspace.readFile(p), filePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[Lambda] ${msg}`)
      this.log('error', triggerName, lambda, msg)
      return
    }
    if (fileContent === null) {
      const msg = `Lambda file not found: "${filePath}"`
      console.error(`[Lambda] ${msg}`)
      this.log('error', triggerName, lambda, msg)
      return
    }

    // Set authorization context based on the source file
    const isAuthorized = this.workspace.isFileAuthorized(filePath)
    this.adfCallHandler.setAuthorizationContext(isAuthorized)

    // Pass the AdfEvent directly to the lambda — no transformation needed.
    // The event has typed data accessible via event.data.*
    const wrappedCode = `
${fileContent}

if (typeof ${fnName} === 'function') {
  return await ${fnName}(${JSON.stringify(event)});
} else {
  throw new Error('Lambda function "${fnName}" not found in "${filePath}"');
}
`

    const onAdfCall = (method: string, args: unknown) =>
      this.adfCallHandler.handleCall(method, args)

    const toolConfig = {
      enabledTools: this.adfCallHandler.getEnabledToolNames(),
      hilTools: this.adfCallHandler.getHilToolNames(),
      isAuthorized: this.adfCallHandler.getAuthorizationContext()
    }

    const warm = warmFlag ?? false
    const sandboxId = `${this.agentId}:lambda`
    const startTime = performance.now()

    try {
      const config = this.workspace.getAgentConfig()
      const timeout = config.limits?.execution_timeout_ms

      emitUmbilicalEvent({
        event_type: 'lambda.started',
        agentId: this.agentId,
        source: `lambda:${filePath}:${fnName}`,
        payload: { lambda_path: filePath, function_name: fnName, kind: 'system_scope', trigger: triggerName }
      })
      const result = await withSource(`lambda:${filePath}:${fnName}`, this.agentId, () =>
        this.codeSandboxService.execute(
          sandboxId,
          wrappedCode,
          timeout,
          onAdfCall,
          toolConfig
        )
      )

      const durationMs = +(performance.now() - startTime).toFixed(2)
      emitUmbilicalEvent({
        event_type: result.error ? 'lambda.failed' : 'lambda.completed',
        agentId: this.agentId,
        source: `lambda:${filePath}:${fnName}`,
        payload: {
          lambda_path: filePath, function_name: fnName, kind: 'system_scope', trigger: triggerName,
          duration_ms: durationMs,
          ...(result.error ? { error: result.error } : {})
        }
      })

      if (result.error) {
        console.error(`[Lambda] Error executing ${lambda} (${durationMs}ms): ${result.error}`)
        this.log('error', triggerName, lambda, `Lambda failed: ${result.error}`, {
          duration_ms: durationMs,
          detail: result.error
        })
      } else {
        console.log(`[Lambda] Completed ${lambda} in ${durationMs}ms${result.stdout ? ` | stdout: ${result.stdout}` : ''}`)
        this.log('info', triggerName, lambda, `Lambda completed in ${durationMs}ms`, {
          duration_ms: durationMs,
          ...(result.stdout ? { stdout: result.stdout } : {})
        })
        return result.result ?? undefined
      }
    } catch (err) {
      const durationMs = +(performance.now() - startTime).toFixed(2)
      const errorMsg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      console.error(`[Lambda] Failed to execute ${lambda} (${durationMs}ms):`, err)
      this.log('error', triggerName, lambda, `Lambda execution failed: ${errorMsg}`, {
        duration_ms: durationMs,
        detail: stack ?? errorMsg
      })
    } finally {
      if (!warm) {
        this.codeSandboxService.destroy(sandboxId)
      }
    }
  }

  async executeBatch(dispatch: AdfBatchDispatch): Promise<string | undefined> {
    const first = dispatch.events[0]
    if (!first) return undefined

    return this.execute({
      event: {
        ...first,
        id: `${first.id}:batch`,
        time: new Date().toISOString(),
        data: dispatch.events.map(e => e.data) as never,
      },
      scope: dispatch.scope,
      lambda: dispatch.lambda,
      command: dispatch.command,
      warm: dispatch.warm,
    })
  }

  /**
   * Execute a shell command string as a system-scope trigger action.
   * The shell tool must be registered in the tool registry.
   */
  private async executeShellCommand(command: string, dispatch: AdfEventDispatch): Promise<void> {
    const { event } = dispatch
    const triggerName = Object.entries(TRIGGER_TO_EVENT_TYPE).find(([, v]) => v === event.type)?.[0] ?? event.type
    console.log(`[Shell] Executing trigger command: "${command}" (trigger: ${event.type})`)

    try {
      const { parse } = await import('../tools/shell/parser/parser')
      const { executeNode } = await import('../tools/shell/executor/pipeline-executor')
      const { EnvironmentResolver } = await import('../tools/shell/executor/environment')

      // Get config from workspace
      const config = this.workspace.getAgentConfig()
      const env = new EnvironmentResolver(config, this.workspace)

      // Inject trigger context as environment variables from event data
      env.setTriggerContext(dispatch)

      // We need the tool registry — get it from the adfCallHandler
      const toolRegistry = this.adfCallHandler.getToolRegistry()

      const ast = parse(command)
      const startTime = performance.now()
      const result = await executeNode(ast, '', {
        workspace: this.workspace,
        toolRegistry,
        config,
        env,
      })
      const durationMs = +(performance.now() - startTime).toFixed(2)

      if (result.exit_code !== 0) {
        console.error(`[Shell] Command failed (exit ${result.exit_code}): ${result.stderr}`)
        this.log('error', triggerName, command, `Shell command failed (exit ${result.exit_code}): ${result.stderr}`, { duration_ms: durationMs })
      } else {
        console.log(`[Shell] Command completed in ${durationMs}ms`)
        this.log('info', triggerName, command, `Shell command completed in ${durationMs}ms`, { duration_ms: durationMs })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Shell] Command execution failed:`, err)
      this.log('error', triggerName, command, `Shell command failed: ${errorMsg}`)
    }
  }
}
