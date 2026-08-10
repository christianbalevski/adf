import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { SecurityConfig } from '../../../shared/types/adf-v02.types'
import type { CodeSandboxService } from '../../runtime/code-sandbox'
import type { AdfCallHandler } from '../../runtime/adf-call-handler'
import { executeMiddlewareChain } from '../../services/middleware-executor'

const MAX_BODY_BYTES = 25 * 1024 * 1024 // 25 MB response body limit
const MAX_REDIRECTS = 5

// =============================================================================
// SSRF guard
//
// sys_fetch is reachable from the LLM loop, so a prompt-injected agent could
// otherwise drive the unauthenticated local daemon (127.0.0.1:7385), the mesh
// server, cloud metadata (169.254.169.254) or anything else on the LAN.
// Default-deny every non-routable destination; `security.allow_local_fetch:
// true` is the explicit, config-level escape hatch for agents that legitimately
// call their own served endpoints.
// =============================================================================

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Parse the loose inet_aton forms a resolver accepts but `net.isIP` rejects
 * ("127.1", "0x7f000001", "2130706433", "0177.0.0.1") into dotted-quad form.
 * Returns null when the host is not a numeric IPv4 spelling at all.
 */
export function parseLooseIPv4(host: string): string | null {
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (part === '') return null
    let n: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part.slice(2), 16)
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8)
    else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10)
    else return null
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  // In inet_aton the final part absorbs all remaining octets.
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null
  const last = nums[nums.length - 1]
  if (last >= Math.pow(256, 4 - nums.length + 1)) return null
  let value = last
  for (let i = 0; i < nums.length - 1; i++) value += nums[i] * Math.pow(256, 3 - i)
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/** Loopback, RFC1918, CGNAT, link-local, multicast/reserved. */
function isBlockedIPv4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = o
  if (a === 0) return true                            // 0.0.0.0/8 "this host"
  if (a === 10) return true                           // RFC1918
  if (a === 127) return true                          // loopback
  if (a === 100 && b >= 64 && b <= 127) return true   // RFC6598 CGNAT
  if (a === 169 && b === 254) return true             // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true    // RFC1918
  if (a === 192 && b === 0 && c === 0) return true    // IETF protocol assignments
  if (a === 192 && b === 168) return true             // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true                           // multicast, reserved, broadcast
  return false
}

/** ::, ::1, fe80::/10, fc00::/7, ff00::/8 and IPv4-mapped forms of the above. */
function isBlockedIPv6(raw: string): boolean {
  const addr = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (addr === '::' || addr === '::1') return true
  if (/^(0:){7}[01]$/.test(addr)) return true
  const mapped = addr.match(/^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/)
  if (mapped) return isBlockedIPv4(mapped[1])
  const head = addr.split(':')[0]
  if (!head) return false
  const h = parseInt(head, 16)
  if (Number.isNaN(h)) return false
  if ((h & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((h & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** True when a literal IP address is loopback / link-local / private. */
export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip.replace(/^\[|\]$/g, ''))
  if (version === 4) return isBlockedIPv4(ip)
  if (version === 6) return isBlockedIPv6(ip)
  return false
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')
}

function blockedMessage(target: string): string {
  return (
    `Blocked by the sys_fetch SSRF guard: "${target}" is a loopback, link-local, or private-network address. ` +
    'Set security.allow_local_fetch: true in your config to permit local/private fetches.'
  )
}

/**
 * Returns a rejection reason when `rawUrl` must not be fetched, else null.
 * Hostnames are resolved and every returned address is checked, so a
 * DNS-rebinding record pointing at 127.0.0.1 is rejected too.
 */
export async function checkFetchTarget(rawUrl: string): Promise<string | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return `Invalid URL: ${rawUrl}`
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return `Blocked by the sys_fetch guard: only http and https URLs may be fetched (got "${url.protocol}").`
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) return `Invalid URL: ${rawUrl}`
  if (isLoopbackHostname(host)) return blockedMessage(url.hostname)

  if (isIP(host)) {
    return isBlockedIpAddress(host) ? blockedMessage(host) : null
  }

  const loose = parseLooseIPv4(host)
  if (loose) {
    return isBlockedIPv4(loose) ? blockedMessage(`${host} → ${loose}`) : null
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    // Resolution failed — let fetch surface the real network error instead of
    // masking it as a security denial.
    return null
  }
  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) return blockedMessage(`${host} → ${entry.address}`)
  }
  return null
}

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
    'Only http/https URLs are allowed, and loopback/link-local/private-network destinations (localhost, 127.0.0.0/8, ::1, 169.254.0.0/16, 10/8, 172.16/12, 192.168/16, 100.64/10) are blocked — including after DNS resolution and across redirects. ' +
    'Set security.allow_local_fetch: true to permit local/private fetches.'
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

    // SSRF guard — runs on the post-middleware URL so a middleware rewrite is
    // checked too. `security.allow_local_fetch` is the explicit opt-out.
    const allowLocal =
      (this.getSecurityConfig?.() as unknown as { allow_local_fetch?: boolean } | undefined)
        ?.allow_local_fetch === true
    if (!allowLocal) {
      const blocked = await checkFetchTarget(params.url)
      if (blocked) {
        try { _workspace.insertLog('warn', 'sys_fetch', 'blocked', params.url, blocked.slice(0, 200)) } catch { /* non-fatal */ }
        return { content: JSON.stringify({ error: blocked }), isError: true }
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), params.timeout_ms)

    try {
      // Redirects are followed manually when the guard is active so every hop
      // is re-checked — a public URL that 302s to 127.0.0.1 is stopped here.
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
          redirect: allowLocal ? 'follow' : 'manual'
        })
        if (allowLocal) break
        if (response.status < 300 || response.status > 399) break
        const location = response.headers.get('location')
        if (!location) break
        if (++hops > MAX_REDIRECTS) {
          return { content: JSON.stringify({ error: `Too many redirects (>${MAX_REDIRECTS})` }), isError: true }
        }
        const next = new URL(location, currentUrl).toString()
        const blockedHop = await checkFetchTarget(next)
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
