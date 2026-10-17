import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline, Readable, Transform } from 'node:stream'
import type { DaemonClient } from '../../../../shared/daemon-client'
import type { OAuthCallbackRelay } from './oauth-relay'
import type { RemotePicker } from './picker'

/**
 * What remote mode adds to the daemon-mode context (tracker W4-B): the
 * daemon-side picker, the OAuth callback relay and the upload of a file of
 * this computer. Null in local mode, where the daemon shares this
 * computer's files, browser and loopback.
 */
export interface RemoteServices {
  picker: RemotePicker
  oauth: OAuthCallbackRelay
  /** The daemon's host (`host:port`), as dialogs name it. */
  host(): string
  /**
   * Stream a file of this computer to `path` on the daemon (octet-stream,
   * never read into memory). The token goes to the daemon's origin only.
   */
  upload(client: DaemonClient, path: string, query: Record<string, string>, file: string, onProgress?: (sent: number, total: number) => void): Promise<Response>
}

/** Uploads may take long on a slow link; the daemon's own body limit ends a runaway one. */
export const UPLOAD_TIMEOUT_MS = 30 * 60_000

export function uploadFile(fetchImpl: typeof fetch) {
  return async (client: DaemonClient, path: string, query: Record<string, string>, file: string, onProgress?: (sent: number, total: number) => void): Promise<Response> => {
    const size = (await stat(file)).size
    const url = client.url(path, query)
    let sent = 0
    let lastReport = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        sent += chunk.length
        // At most every 1 %: the task-bar progress, not a call per 64 KiB chunk.
        if (onProgress && (sent - lastReport >= size / 100 || sent === size)) { lastReport = sent; onProgress(sent, size) }
        done(null, chunk)
      },
    })
    // pipeline: a read error ends the upload instead of leaving it waiting.
    const body = Readable.toWeb(pipeline(createReadStream(file), counter, () => {})) as unknown as ReadableStream<Uint8Array>
    return fetchImpl(url, {
      method: 'POST',
      headers: client.headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }),
      body,
      // Node's fetch streams a ReadableStream body only half-duplex.
      duplex: 'half',
      redirect: 'manual',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    } as RequestInit & { duplex: 'half' })
  }
}
