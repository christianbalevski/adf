import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { CodeSandboxService } from '../../runtime/code-sandbox'
import type { AdfCallHandler } from '../../runtime/adf-call-handler'
import { transformImports, transformExports } from '../../runtime/code-sandbox'
import { loadLambdaSource } from '../../runtime/ts-transpiler'
import { withSource } from '../../runtime/execution-context'
import { withAuthorization } from '../../runtime/authorization-context'
import { emitUmbilicalEvent } from '../../runtime/emit-umbilical'

const InputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'File path, optionally with :function_name (e.g. "utils/parser.ts:parse"). Calls main() if no function specified.'
    ),
  args: z
    .record(z.unknown())
    .optional()
    .describe('Arguments object passed as the single parameter to the function. Functions must accept one object parameter, e.g. function add({ a, b }) { return a + b; }')
})

/**
 * Tool that calls agent-authored functions stored in adf_files.
 * The function code runs in the same sandbox Worker with a fresh vm.Context,
 * with full access to the `adf` proxy for tool calls and model_invoke.
 */
export class SysLambdaTool implements Tool {
  readonly name = 'sys_lambda'
  readonly description =
    'Call a function from a script file in the workspace. The function receives the provided args as a single object parameter — use destructuring: function add({ a, b }) { return a + b; }. Functions have access to the `adf` object for calling tools and model_invoke. If no function name is specified (e.g. just "utils.js"), calls main(). Use "file.js:functionName" to call a specific function.'
  readonly inputSchema = InputSchema
  readonly category = 'external' as const

  private codeSandboxService: CodeSandboxService
  private adfCallHandler: AdfCallHandler
  private agentId: string
  private maxTimeout: number

  constructor(
    codeSandboxService: CodeSandboxService,
    adfCallHandler: AdfCallHandler,
    agentId: string,
    maxTimeout?: number
  ) {
    this.codeSandboxService = codeSandboxService
    this.adfCallHandler = adfCallHandler
    this.agentId = agentId
    this.maxTimeout = maxTimeout ?? 30_000
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { source, args } = input as z.infer<typeof InputSchema>

    // Parse source: "path/file.ts:functionName" or just "path/file.ts"
    let filePath: string
    let functionName: string

    const colonIdx = source.lastIndexOf(':')
    if (colonIdx > 0 && colonIdx < source.length - 1) {
      const afterColon = source.substring(colonIdx + 1)
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(afterColon)) {
        filePath = source.substring(0, colonIdx)
        functionName = afterColon
      } else {
        filePath = source
        functionName = 'main'
      }
    } else {
      filePath = source
      functionName = 'main'
    }

    // Read the source file (transpile .ts automatically)
    const fileContent = await loadLambdaSource(p => workspace.readFile(p), filePath)
    if (fileContent === null) {
      return {
        content: `File "${filePath}" not found in workspace files`,
        isError: true
      }
    }

    // Transform the code: strip exports, transform imports
    let transformedCode = transformImports(fileContent)
    transformedCode = transformExports(transformedCode)

    // Wrap code to define functions and call the target
    // The function is exposed via __exports, then called with args
    const wrappedCode = `
${transformedCode}

// Expose the target function and call it
if (typeof ${functionName} === 'function') {
  return await ${functionName}(${JSON.stringify(args ?? {})});
} else {
  throw new Error('Function "${functionName}" not found in "${filePath}". Available functions should be declared at the top level.');
}
`

    // Authorization context: based on file authorization status.
    //
    // Code-to-code privilege escalation (unauthorized → authorized) is already
    // blocked by handleSysLambda's guard (REQUIRES_AUTHORIZED_CALLER) before
    // reaching this method, so we don't need to AND with callerAuthorized here.
    // Using fileAuthorized alone lets LLM loop calls correctly run authorized
    // lambdas with their intended privilege level.
    const fileAuthorized = workspace.isFileAuthorized(filePath)
    this.adfCallHandler.setAuthorizationContext(fileAuthorized)

    // Log execution start
    workspace.insertLog('info', 'sys_lambda', 'execute', source, `${functionName}()`, args ? { args } : undefined)

    // Execute via CodeSandboxService with the adf RPC bridge.
    // Bind the file's authorization to every call this lambda makes, so when
    // it returns to its caller the caller's auth context is unchanged.
    const onAdfCall = (method: string, callArgs: unknown) =>
      withAuthorization(fileAuthorized, () => this.adfCallHandler.handleCall(method, callArgs))

    const toolConfig = {
      enabledTools: this.adfCallHandler.getEnabledToolNames(),
      hilTools: this.adfCallHandler.getHilToolNames(),
      isAuthorized: this.adfCallHandler.getAuthorizationContext()
    }

    const t0 = performance.now()
    emitUmbilicalEvent({
      event_type: 'lambda.started',
      agentId: this.agentId,
      source: `lambda:${filePath}:${functionName}`,
      payload: { lambda_path: filePath, function_name: functionName, kind: 'sys_lambda' }
    })
    const result = await withSource(`lambda:${filePath}:${functionName}`, this.agentId, () =>
      this.codeSandboxService.execute(
        `${this.agentId}:fn:${filePath}`,
        wrappedCode,
        this.maxTimeout,
        onAdfCall,
        toolConfig
      )
    )
    const durationMs = +(performance.now() - t0).toFixed(2)
    emitUmbilicalEvent({
      event_type: result.error ? 'lambda.failed' : 'lambda.completed',
      agentId: this.agentId,
      source: `lambda:${filePath}:${functionName}`,
      payload: {
        lambda_path: filePath, function_name: functionName, kind: 'sys_lambda',
        duration_ms: durationMs,
        ...(result.error ? { error: result.error } : {})
      }
    })

    const parts: string[] = []

    if (result.error) {
      parts.push(`Error: ${result.error}`)
    } else if (result.result !== undefined) {
      parts.push(result.result)
    }

    if (result.stdout && result.stdout.length > 0) {
      if (parts.length > 0) parts.push('')
      parts.push('Output:')
      parts.push(result.stdout)
    }

    if (parts.length === 0) {
      parts.push('Function executed successfully (no return value).')
    }

    // Log execution result
    workspace.insertLog(
      result.error ? 'error' : 'info',
      'sys_lambda', 'result', source,
      `${functionName}() → ${result.error ? 'error' : 'ok'} (${durationMs}ms)`,
      result.stdout ? { stdout: result.stdout } : undefined
    )

    return {
      content: parts.join('\n'),
      isError: !!result.error
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
