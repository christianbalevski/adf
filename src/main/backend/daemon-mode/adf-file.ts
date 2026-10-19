import type { DaemonModeSession } from './session'
import type { DaemonConnection } from './connection'

/**
 * `adf-file://<path>` in daemon mode (design D1, §9.3): the open agent's
 * internal file, streamed from the daemon's `GET /agents/:id/files/raw`
 * (W1-E) through Studio main. The token stays in main; the renderer only
 * ever sees the scheme.
 *
 * Same URL rules and response headers as the embedded handler
 * (main/index.ts): the path is the URL after the scheme, `..` and absolute
 * paths are refused, and a MIME type outside the safe prefixes is served as
 * application/octet-stream with `nosniff`.
 */

const SAFE_MIME_PREFIXES = ['image/', 'text/', 'audio/', 'video/', 'application/pdf', 'application/json', 'application/octet-stream', 'font/']

type Log = Pick<Console, 'warn'>

/** adf-file://img1.png → img1.png, adf-file://files/chart.png → files/chart.png (as embedded). */
export function adfFilePathFromUrl(url: string): string {
  return decodeURIComponent(url.replace('adf-file://', '').split('?')[0].split('#')[0].replace(/\/+$/, ''))
}

export function createAdfFileHandler(deps: {
  session: DaemonModeSession
  /** The session of the window that asked (agent windows, agent-windows.md); default `session`. */
  sessionFor?: (request: Request) => DaemonModeSession
  connection: DaemonConnection
  fetch?: typeof fetch
  log?: Log
}): (request: Request) => Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch

  return async (request) => {
    const agentId = (deps.sessionFor?.(request) ?? deps.session).agentId
    const client = deps.connection.current
    if (!agentId || !client) return new Response('No workspace open', { status: 404 })

    const filePath = adfFilePathFromUrl(request.url)
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return new Response('Invalid path', { status: 400 })
    }

    const url = client.url(`/agents/${encodeURIComponent(agentId)}/files/raw`, { path: filePath })
    let upstream: Response
    try {
      upstream = await fetchImpl(url, { headers: client.headers({ Accept: '*/*' }), redirect: 'manual' })
    } catch (err) {
      return new Response(`ADF daemon not reachable: ${err instanceof Error ? err.message : String(err)}`, { status: 502 })
    }
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {})
      return new Response(upstream.status === 404 ? 'File not found' : `ADF daemon answered ${upstream.status}`, { status: upstream.status === 404 ? 404 : 502 })
    }
    const rawType = (upstream.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim()
    const contentType = SAFE_MIME_PREFIXES.some((p) => rawType.startsWith(p)) ? rawType : 'application/octet-stream'
    return new Response(upstream.body, {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
}
