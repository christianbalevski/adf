/**
 * Transport Resolve — built-in egress function.
 *
 * Determines the best transport for message delivery.
 * Priority: local → active WS → HTTP.
 * No-op if transport.method was already changed by custom outbox middleware.
 */

import type { EgressContext } from '../../shared/types/adf-v02.types'
import type { WsConnectionManager } from './ws-connection-manager'

export function resolveTransport(
  ctx: EgressContext,
  agentFilePath: string,
  isLocalRecipient: boolean,
  wsManager: WsConnectionManager | null
): void {
  // If custom middleware already set a non-default method, respect it
  if (ctx.transport.method !== 'http') return

  // 1. Local delivery (same runtime)
  if (isLocalRecipient) {
    ctx.transport.method = 'local'
    return
  }

  // 2. Active WebSocket connection to recipient
  if (wsManager) {
    const connId = wsManager.findConnectionByDid(agentFilePath, ctx.message.to)
    if (connId) {
      ctx.transport.method = 'ws'
      ctx.transport.connection_id = connId
      return
    }
  }

  // 3. HTTP (default, already set)
}
