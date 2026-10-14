import type { DaemonClient } from '../../../src/shared/daemon-client'
import { createEventsAdapterSession, type ClientSession } from '../../../src/main/backend/daemon-mode/client-stream'

/**
 * DIAGNOSTIC stand-in until W2-C2: the interim GET /events adapter, plus
 * real document holds through a W2-B client session (POST /client/sessions,
 * POST/DELETE …/documents). It lets W3-A's handlers run on open documents
 * now; the event stream is still the adapter's (no deltas, no push topics).
 * Used only by `PARITY_W3A_HOLDS=1` runs of documents/daemon.test.ts.
 */
export function createHoldingAdapterSession(client: DaemonClient): ClientSession {
  const base = createEventsAdapterSession(client)
  let sessionId: Promise<string> | null = null
  const sid = () => (sessionId ??= client.createClientSession({ client: 'parity-w3a', version: '0' }).then((r) => r.sessionId))
  return {
    kind: base.kind,
    limitations: base.limitations,
    start: (listener) => base.start(listener),
    setFocus: async (agentId) => { await client.setClientSessionFocus(await sid(), agentId) },
    holdDocument: async (filePath) => ({ agentId: (await client.holdClientSessionDocument(await sid(), { filePath })).agentId }),
    releaseDocument: async (agentId) => { await client.releaseClientSessionDocument(await sid(), agentId) },
    reconnect: () => base.reconnect(),
    end: async () => {
      await base.end()
      if (sessionId) await client.endClientSession(await sessionId).catch(() => {})
    },
  }
}
