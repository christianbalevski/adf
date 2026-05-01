/**
 * Custom Middleware Executor
 *
 * Runs user-defined middleware lambdas through the CodeSandboxService.
 * Used by routes, inbox, outbox, and fetch pipelines.
 */

import type { MiddlewareRef } from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { CodeSandboxService } from '../runtime/code-sandbox'
import type { AdfCallHandler } from '../runtime/adf-call-handler'
import { loadLambdaSource } from '../runtime/ts-transpiler'
import { withSource } from '../runtime/execution-context'
import { emitUmbilicalEvent } from '../runtime/emit-umbilical'

export interface MiddlewareInput {
  point: 'route' | 'inbox' | 'outbox' | 'fetch'
  data: unknown
  meta: Record<string, unknown>
}

export interface MiddlewareOutput {
  data?: unknown
  meta?: Record<string, unknown>
  reject?: { code: number; reason: string }
}

export interface MiddlewareChainResult {
  data: unknown
  meta: Record<string, unknown>
  rejected?: { code: number; reason: string }
}

/**
 * Execute a chain of middleware lambdas in order.
 * Each middleware receives the current data + accumulated meta.
 * If any middleware returns `reject`, the chain short-circuits.
 */
export async function executeMiddlewareChain(
  refs: MiddlewareRef[],
  input: MiddlewareInput,
  workspace: AdfWorkspace,
  codeSandboxService: CodeSandboxService,
  adfCallHandler: AdfCallHandler,
  agentId: string
): Promise<MiddlewareChainResult> {
  let currentData = input.data
  let currentMeta = { ...input.meta }

  const sandboxId = `${agentId}:mw:${input.point}`
  const onAdfCall = (method: string, args: unknown) =>
    adfCallHandler.handleCall(method, args)
  const toolConfig = {
    enabledTools: adfCallHandler.getEnabledToolNames(),
    hilTools: adfCallHandler.getHilToolNames(),
    isAuthorized: adfCallHandler.getAuthorizationContext()
  }

  for (const ref of refs) {
    const lastColon = ref.lambda.lastIndexOf(':')
    if (lastColon <= 0) {
      workspace.insertLog('warn', 'middleware', 'execute', ref.lambda, `Invalid lambda format: ${ref.lambda}`)
      continue
    }
    const filePath = ref.lambda.slice(0, lastColon)
    const fnName = ref.lambda.slice(lastColon + 1)

    let fileContent: string | null
    try {
      fileContent = await loadLambdaSource(p => workspace.readFile(p), filePath)
    } catch (err) {
      workspace.insertLog('error', 'middleware', 'execute', ref.lambda, `${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (fileContent === null) {
      workspace.insertLog('warn', 'middleware', 'execute', ref.lambda, `File not found: ${filePath}`)
      continue
    }

    // Middleware authorization check
    const config = workspace.getAgentConfig()
    const requireAuth = config.security?.require_middleware_authorization ?? true
    const fileAuthorized = workspace.isFileAuthorized(filePath)

    if (requireAuth && !fileAuthorized) {
      workspace.insertLog('warn', 'middleware', 'skipped', ref.lambda,
        `Middleware ${filePath} skipped — not authorized`)
      continue
    }

    // Set authorization context for any adf.* calls within this middleware
    adfCallHandler.setAuthorizationContext(fileAuthorized)

    const middlewareInput: MiddlewareInput = {
      point: input.point,
      data: currentData,
      meta: currentMeta
    }

    const wrappedCode = `
${fileContent}

if (typeof ${fnName} === 'function') {
  return await ${fnName}(${JSON.stringify(middlewareInput)});
} else {
  throw new Error('Middleware function "${fnName}" not found in "${filePath}"');
}
`

    try {
      const config = workspace.getAgentConfig()
      const timeout = config.limits?.execution_timeout_ms

      const t0 = performance.now()
      emitUmbilicalEvent({
        event_type: 'lambda.started',
        agentId: config.id,
        source: `lambda:${filePath}:${fnName}`,
        payload: { lambda_path: filePath, function_name: fnName, kind: 'middleware' }
      })
      const result = await withSource(`lambda:${filePath}:${fnName}`, config.id, () =>
        codeSandboxService.execute(
          sandboxId,
          wrappedCode,
          timeout,
          onAdfCall,
          toolConfig
        )
      )
      emitUmbilicalEvent({
        event_type: result.error ? 'lambda.failed' : 'lambda.completed',
        agentId: config.id,
        source: `lambda:${filePath}:${fnName}`,
        payload: {
          lambda_path: filePath, function_name: fnName, kind: 'middleware',
          duration_ms: +(performance.now() - t0).toFixed(2),
          ...(result.error ? { error: result.error } : {})
        }
      })

      if (result.error) {
        workspace.insertLog('error', 'middleware', 'execute', ref.lambda,
          `Error in ${ref.lambda}`, { error: result.error, stdout: result.stdout || undefined })
        continue
      }

      let output: MiddlewareOutput = {}
      try {
        output = typeof result.result === 'string'
          ? JSON.parse(result.result)
          : (result.result ?? {})
      } catch {
        // Non-JSON result — treat as pass-through
      }

      if (output.reject) {
        workspace.insertLog('warn', 'middleware', 'reject', ref.lambda,
          `Rejected: ${output.reject.code} ${output.reject.reason}`, { stdout: result.stdout || undefined })
        return {
          data: currentData,
          meta: currentMeta,
          rejected: output.reject
        }
      }

      // Log successful execution (include stdout if any)
      workspace.insertLog('info', 'middleware', 'execute', ref.lambda,
        `${input.point} middleware OK${output.data !== undefined ? ' (transformed)' : ''}`,
        result.stdout ? { stdout: result.stdout } : undefined)

      if (output.data !== undefined) {
        currentData = output.data
      }

      if (output.meta) {
        currentMeta = { ...currentMeta, ...output.meta }
      }
    } catch (err) {
      workspace.insertLog('error', 'middleware', 'execute', ref.lambda,
        `Exception in ${ref.lambda}: ${err}`)
    }
  }

  return { data: currentData, meta: currentMeta }
}
