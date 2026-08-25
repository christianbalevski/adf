import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { SecurityConfig } from '../../../shared/types/adf-v02.types'
import type { CodeSandboxService } from '../../runtime/code-sandbox'
import type { AdfCallHandler } from '../../runtime/adf-call-handler'
import { executeMiddlewareChain } from '../../services/middleware-executor'
import { checkFetchTarget, type FetchGuardOptions } from '../../utils/ssrf-guard'

const MAX_BODY_BYTES = 25 * 1024 * 1024 // 25 MB response body limit
const MAX_REDIRECTS = 5

// The SSRF/egress guard now lives in ../../utils/ssrf-guard. Re-export the pure
// helpers so existing importers (and the ssrf test) keep resolving from here.
export {
  parseLooseIPv4,
  isBlockedIpAddress,
  checkFetchTarget
} from '../../utils/ssrf-guard'

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
    'Make an HTTP request to a URL. Returns the response status, headers, and body. Useful for calling APIs, webhooks, or fetching web content. ' +
    'Only http/https URLs are allowed. Loopback (localhost, 127.0.0.0/8, ::1) is reachable by default, but link-local (169.254.0.0/16) and private-network destinations (10/8, 172.16/12, 192.168/16, 100.64/10) are blocked — including after DNS resolution and across redirects. ' +
    'Set security.allow_local_fetch: true to permit private/LAN fetches (an agent-initiated write raises an owner approval).'
  readonly inputSchema = InputSchema
  readonly category = 'external' as const

  private codeSandboxService?: CodeSandboxService
  private adfCallHandler?: AdfCallHandler
  private agentId?: string
  private getSecurityConfig?: () => SecurityConfig
  private getFetchGuardContext?: () => { daemonPort?: number; ownOrigin?: { port: number; pathPrefix: string } }

  setMiddlewareDeps(opts: {
    codeSandboxService: CodeSandboxService
    adfCallHandler: AdfCallHandler
    agentId: string
    getSecurityConfig: () => SecurityConfig
    getFetchGuardContext?: () => { daemonPort?: number; ownOrigin?: { port: number; pathPrefix: string } }
  }): void {
    this.codeSandboxService = opts.codeSandboxService
    this.adfCallHandler = opts.adfCallHandler
    this.agentId = opts.agentId
    this.getSecurityConfig = opts.getSecurityConfig
    this.getFetchGuardContext = opts.getFetchGuardContext
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

    // SSRF guard — runs on the post-middleware URL so a middleware rewrite is
    // checked too. `security.allow_local_fetch` is the explicit opt-out, but the
    // guard runs UNCONDITIONALLY: its always-block tiers (daemon control API,
    // link-local/cloud-metadata) fire even when allowLocal is set. daemonPort
    // must ALWAYS be present — loopback is default-open, so a caller that
    // forgot to wire getFetchGuardContext would otherwise expose the daemon.
    const allowLocal =
      (this.getSecurityConfig?.() as unknown as { allow_local_fetch?: boolean } | undefined)
        ?.allow_local_fetch === true
    const guardOpts: FetchGuardOptions = {
      allowLocal,
      daemonPort: Number(process.env.ADF_DAEMON_PORT) || 7385,
      ...(this.getFetchGuardContext?.() ?? {})
    }
    {
      const blocked = await checkFetchTarget(params.url, guardOpts)
      if (blocked) {
        try { _workspace.insertLog('warn', 'sys_fetch', 'blocked', params.url, blocked.slice(0, 200)) } catch { /* non-fatal */ }
        return { content: JSON.stringify({ error: blocked }), isError: true }
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), params.timeout_ms)

    try {
      // Redirects are ALWAYS followed manually so every hop is re-checked — a
      // public URL that 302s to 127.0.0.1:daemonPort (or cloud metadata) is
      // stopped here even under allow_local_fetch.
      let currentUrl = params.url
      let reqMethod: z.infer<typeof InputSchema>['method'] = params.method
      let reqHeaders = params.headers
      let reqBody = params.body
      let hops = 0
      let response: Response

      for (;;) {
        response = await fetch(currentUrl, {
          method: reqMethod,
          headers: reqHeaders,
          body: reqBody,
          signal: controller.signal,
          redirect: 'manual'
        })
        if (response.status < 300 || response.status > 399) break
        const location = response.headers.get('location')
        if (!location) break
        if (++hops > MAX_REDIRECTS) {
          return { content: JSON.stringify({ error: `Too many redirects (>${MAX_REDIRECTS})` }), isError: true }
        }
        const next = new URL(location, currentUrl).toString()
        const blockedHop = await checkFetchTarget(next, guardOpts)
        if (blockedHop) {
          try { _workspace.insertLog('warn', 'sys_fetch', 'blocked', next, blockedHop.slice(0, 200)) } catch { /* non-fatal */ }
          return { content: JSON.stringify({ error: `Redirect blocked. ${blockedHop}` }), isError: true }
        }
        try { await response.body?.cancel() } catch { /* non-fatal */ }
        // Per fetch semantics, 301/302/303 downgrade a non-HEAD request to GET
        // and drop the body; 307/308 replay the request verbatim.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && reqMethod !== 'HEAD')) {
          reqMethod = 'GET'
          reqBody = undefined
          if (reqHeaders) {
            reqHeaders = Object.fromEntries(
              Object.entries(reqHeaders).filter(([k]) => !/^content-(type|length)$/i.test(k))
            )
          }
        }
        currentUrl = next
      }

      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      const contentType = response.headers.get('content-type') || ''
      let body: string
      let bodyEncoding: string | undefined

      if (reqMethod === 'HEAD') {
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
