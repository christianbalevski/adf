/**
 * Join two WebSockets: the Computer tab's desktop stream, relayed by the
 * daemon (compute-desktop-routes.ts) and by Studio (desktop-relay.ts).
 */

import WebSocket from 'ws'

/** Relay frames both ways; either side closing closes the other. Frames sent before upstream opens wait for it. */
export function pipeWebSockets(client: WebSocket, upstream: WebSocket): void {
  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
    else pending.push({ data, binary })
  })
  upstream.on('open', () => {
    for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary })
  })
  upstream.on('message', (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
  })
  const closeBoth = () => {
    for (const ws of [client, upstream]) {
      if (ws.readyState === WebSocket.OPEN) ws.close()
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
    }
  }
  client.on('close', closeBoth)
  upstream.on('close', closeBoth)
  client.on('error', closeBoth)
  upstream.on('error', closeBoth)
}
