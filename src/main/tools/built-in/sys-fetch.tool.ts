import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { SecurityConfig } from '../../../shared/types/adf-v02.types'
import type { CodeSandboxService } from '../../runtime/code-sandbox'
import type { AdfCallHandler } from '../../runtime/adf-call-handler'
import { executeMiddlewareChain } from '../../services/middleware-executor'

const MAX_BODY_BYTES = 25 * 1024 * 1024 // 25 MB response body limit

/** Content types that should be decoded as UTF-8 text; everything else is treated as binary. */
function isTextContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(';')[0].trim()
  if (!ct) return true // No content-type header → assume text for backwards compat
  if (ct.startsWith('text/')) return true
  if (ct === 'application/json' || ct === 'application/xml') return true
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true
  return false
}

const InputSchema = z.object({
  url: z.string().url().describe('The URL to fetch'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .optional()
    .default('GET')
    .describe('HTTP method'),
  headers: z
    .record(z.string())
    .optional()
    .describe('Request headers as key-value pairs'),
  body: z.union([z.string(), z.custom<Buffer>((val) => Buffer.isBuffer(val) || val instanceof Uint8Array)]).optional().describe('Request body (for POST/PUT/PATCH). Accepts string or Buffer.'),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(60000)
    .optional()
    .default(30000)
    .describe('Request timeout in milliseconds (max 60000)')
})

export class SysFetchTool implements Tool {
  readonly name = 'sys_fetch'
  readonly description =
    'Make an HTTP request to a URL. Returns the response status, headers, and body. Useful for calling APIs, webhooks, or fetching web content.'
  readonly inputSchema = InputSchema
  readonly category = 'external' as const

  private codeSandboxService?: CodeSandboxService
  private adfCallHandler?: AdfCallHandler
  private agentId?: string
  private getSecurityConfig?: () => SecurityConfig

  setMiddlewareDeps(opts: {
    codeSandboxService: CodeSandboxService
    adfCallHandler: AdfCallHandler
    agentId: string
    getSecurityConfig: () => SecurityConfig
  }): void {
    this.codeSandboxService = opts.codeSandboxService
    this.adfCallHandler = opts.adfCallHandler
    this.agentId = opts.agentId
    this.getSecurityConfig = opts.getSecurityConfig
  }

  async execute(input: unknown, _workspace: AdfWorkspace): Promise<ToolResult> {
    const params = input as z.infer<typeof InputSchema>

    // Run fetch middleware if configured
    const fetchMw = this.getSecurityConfig?.().fetch_middleware
    if (fetchMw?.length && this.codeSandboxService && this.adfCallHandler && this.agentId) {
      const mwResult = await executeMiddlewareChain(
        fetchMw,
        {
          point: 'fetch',
          data: {
            url: params.url,
            method: params.method,
            headers: params.headers,
            body: params.body,
            timeout_ms: params.timeout_ms
          },
          meta: {}
        },
        _workspace,
        this.codeSandboxService,
        this.adfCallHandler,
        this.agentId
      )
      if (mwResult.rejected) {
        try { _workspace.insertLog('warn', 'sys_fetch', 'rejected', params.url, `Fetch middleware rejected: ${mwResult.rejected.reason}`) } catch { /* non-fatal */ }
        return {
          content: JSON.stringify({ error: mwResult.rejected.reason }),
          isError: true
        }
      }
      if (mwResult.data) {
        const d = mwResult.data as Record<string, unknown>
        if (typeof d.url === 'string') params.url = d.url
        if (typeof d.method === 'string') params.method = d.method as typeof params.method
        if (d.headers) params.headers = d.headers as Record<string, string>
        if (typeof d.body === 'string') params.body = d.body
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), params.timeout_ms)

    try {
      const response = await fetch(params.url, {
        method: params.method,
        headers: params.headers,
        body: params.body,
        signal: controller.signal
      })

      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      const contentType = response.headers.get('content-type') || ''
      let body: string
      let bodyEncoding: string | undefined

      if (params.method === 'HEAD') {
        body = ''
      } else {
        const buffer = await response.arrayBuffer()
        const bytes = new Uint8Array(buffer)

        if (isTextContentType(contentType)) {
          // Text response — decode as UTF-8
          if (bytes.length > MAX_BODY_BYTES) {
            const decoder = new TextDecoder('utf-8', { fatal: false })
            body =
              decoder.decode(bytes.slice(0, MAX_BODY_BYTES)) +
              `\n\n[truncated: response was ${bytes.length} bytes, showing first ${MAX_BODY_BYTES}]`
          } else {
            const decoder = new TextDecoder('utf-8', { fatal: false })
            body = decoder.decode(bytes)
          }
        } else {
          // Binary response — base64-encode for safe transport through JSON boundary
          const toEncode = bytes.length > MAX_BODY_BYTES ? bytes.slice(0, MAX_BODY_BYTES) : bytes
          body = Buffer.from(toEncode).toString('base64')
          bodyEncoding = 'base64'
        }
      }

      const responsePayload: Record<string, unknown> = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body
      }
      if (bodyEncoding) {
        responsePayload._body_encoding = bodyEncoding
      }

      return {
        content: JSON.stringify(responsePayload),
        isError: false
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err)
      const isTimeout =
        err instanceof DOMException && err.name === 'AbortError'
      const errorMsg = isTimeout ? `Request timed out after ${params.timeout_ms}ms` : message
      try { _workspace.insertLog('error', 'sys_fetch', 'error', params.url, errorMsg.slice(0, 200)) } catch { /* non-fatal */ }

      return {
        content: JSON.stringify({ error: errorMsg }),
        isError: true
      }
    } finally {
      clearTimeout(timer)
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
