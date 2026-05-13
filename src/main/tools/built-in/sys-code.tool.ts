import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { CodeSandboxService } from '../../runtime/code-sandbox'
import type { AdfCallHandler } from '../../runtime/adf-call-handler'
import { withAuthorization } from '../../runtime/authorization-context'

function buildInputSchema(maxTimeout: number) {
  return z.object({
    code: z
      .string()
      .min(1)
      .describe(
        'JavaScript code to execute. Supports async/await. Use the `adf` object to call tools (e.g. `await adf.fs_read({ path: "file.md" })`), invoke the LLM (`await adf.model_invoke({ prompt: "..." })`), or call functions (`await adf.sys_lambda({ source: "utils.js", args: { x: 1 } })`). Import statements for allowed Node.js modules (crypto, buffer, url, path, util, etc.) and standard library packages (xlsx, pdf-lib, cheerio, yaml, date-fns, jimp, docx, jszip, sql.js, mupdf) are supported. Additional packages can be installed via npm_install.'
      ),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(maxTimeout)
      .optional()
      .describe(`Execution timeout in milliseconds. Default: 10000, max: ${maxTimeout}.`),
    clear_state: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Whether to clear the sandbox state before executing. Defaults to true (fresh environment each call). Set to false to preserve variables and functions from previous calls.'
      )
  })
}

/**
 * Tool that executes JavaScript code in a sandboxed vm.Context.
 * Each agent gets its own persistent sandbox — variables defined in one call
 * carry over to the next. Code has access to the `adf` proxy object for calling
 * tools, model_invoke, and sys_lambda. Allowed Node.js modules can be imported.
 */
export class SysCodeTool implements Tool {
  readonly name = 'sys_code'
  readonly description =
    'Execute JavaScript code in a sandboxed environment with access to agent tools via the `adf` object. ' +
    'Supports async/await. Call any enabled tool: `await adf.fs_read({ path: "file.md" })`. ' +
    'Invoke the LLM: `await adf.model_invoke({ prompt: "..." })`. ' +
    'Call workspace functions: `await adf.sys_lambda({ source: "utils.js:parse", args: {...} })`. ' +
    'Import allowed Node.js modules: `import { randomUUID } from "crypto"`. ' +
    'Allowed modules: crypto, buffer, url, querystring, path, util, string_decoder, punycode, assert, events, stream, zlib. ' +
    'Standard library packages (always available): xlsx, pdf-lib, mupdf, docx, jszip, sql.js, cheerio, yaml, date-fns, jimp. ' +
    'Additional packages can be installed via npm_install (pure JS only, no native addons). ' +
    'Set clear_state to false to preserve variables between calls.'
  readonly inputSchema: ReturnType<typeof buildInputSchema>
  readonly category = 'external' as const

  private service: CodeSandboxService
  private agentId: string
  private adfCallHandler: AdfCallHandler | null
  private maxTimeout: number

  constructor(service: CodeSandboxService, agentId: string, adfCallHandler?: AdfCallHandler, maxTimeout?: number) {
    this.service = service
    this.agentId = agentId
    this.adfCallHandler = adfCallHandler ?? null
    this.maxTimeout = maxTimeout ?? 30_000
    this.inputSchema = buildInputSchema(this.maxTimeout)
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { code, timeout, clear_state } = input as z.infer<ReturnType<typeof buildInputSchema>>

    if (clear_state) {
      this.service.destroy(this.agentId)
    }

    // Inline code is never authorized. setAuthorizationContext keeps the
    // legacy field in sync for any caller still reading it; withAuthorization
    // around handleCall is what actually scopes the per-call check.
    this.adfCallHandler?.setAuthorizationContext(false)

    const onAdfCall = this.adfCallHandler
      ? (method: string, args: unknown) =>
          withAuthorization(false, () => this.adfCallHandler!.handleCall(method, args))
      : undefined

    const toolConfig = this.adfCallHandler
      ? {
          enabledTools: this.adfCallHandler.getEnabledToolNames(),
          hilTools: this.adfCallHandler.getHilToolNames(),
          isAuthorized: this.adfCallHandler.getAuthorizationContext()
        }
      : undefined

    const t0 = performance.now()
    const result = await this.service.execute(this.agentId, code, timeout ?? this.maxTimeout, onAdfCall, toolConfig)
    const durationMs = +(performance.now() - t0).toFixed(2)

    const parts: string[] = []

    if (result.error) {
      parts.push(`Error: ${result.error}`)
      try { workspace.insertLog('error', 'sys_code', 'result', null, `Error (${durationMs}ms): ${result.error.slice(0, 200)}`) } catch { /* non-fatal */ }
    } else if (result.result !== undefined) {
      parts.push(`Result: ${result.result}`)
    }

    if (result.stdout && result.stdout.length > 0) {
      if (parts.length > 0) parts.push('')
      parts.push('Output:')
      parts.push(result.stdout)
    }

    // If nothing at all — no result, no error, no stdout
    if (parts.length === 0) {
      parts.push('Code executed successfully (no output).')
    }

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
