import http from 'http'
import { URL } from 'url'

interface CallbackResult {
  code: string
  state: string
}

interface CallbackServer {
  port: number
  waitForCallback: () => Promise<CallbackResult>
  close: () => void
}

const PREFERRED_PORT = 1455
const TIMEOUT_MS = 120_000

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authentication Complete</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5">
<div style="text-align:center"><h2>Authentication complete.</h2><p>You can close this tab.</p></div>
</body></html>`

export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let callbackResolve: ((result: CallbackResult) => void) | null = null
    let callbackReject: ((err: Error) => void) | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(404)
        res.end()
        return
      }

      const parsed = new URL(req.url, `http://127.0.0.1`)
      if (parsed.pathname !== '/auth/callback') {
        res.writeHead(404)
        res.end()
        return
      }

      const code = parsed.searchParams.get('code')
      const state = parsed.searchParams.get('state')

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(SUCCESS_HTML)

      if (code && state && callbackResolve) {
        callbackResolve({ code, state })
        callbackResolve = null
        callbackReject = null
      }
    })

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      try {
        server.close()
      } catch {
        // Ignore
      }
    }

    const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
      callbackResolve = resolve
      callbackReject = reject
    })

    // Try preferred port first, fall back to ephemeral
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port occupied — try ephemeral
        server.listen(0, '127.0.0.1')
      } else {
        rejectServer(err)
      }
    })

    server.on('listening', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        cleanup()
        rejectServer(new Error('Failed to get server address'))
        return
      }

      timeout = setTimeout(() => {
        if (callbackReject) {
          callbackReject(new Error('OAuth callback timed out after 120s'))
          callbackResolve = null
          callbackReject = null
        }
        cleanup()
      }, TIMEOUT_MS)

      resolveServer({
        port: addr.port,
        waitForCallback: () => callbackPromise,
        close: cleanup
      })
    })

    server.listen(PREFERRED_PORT, '127.0.0.1')
  })
}
