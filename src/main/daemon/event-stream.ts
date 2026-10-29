import type { ServerResponse } from 'node:http'
import type { DaemonEventBus, DaemonEventEnvelope } from './event-bus'
import { safeJsonStringify, sseControl } from './sse-wire'

type EventSink = Pick<ServerResponse, 'write' | 'once' | 'removeListener' | 'destroy' | 'destroyed'>

/**
 * Stream the shared event ring without a per-reader queue. A full socket
 * pauses delivery until drain, then replays the ring. If that ring has
 * evicted unread events, disconnect so the resume handshake reports a gap.
 */
export function streamDaemonEvents(bus: DaemonEventBus, sink: EventSink, options: { since?: number; epoch?: string; agentId?: string }): () => void {
  const { since, agentId } = options
  const epochMismatch = options.epoch !== undefined && options.epoch !== bus.epoch
  const latest = bus.latestCursor
  const oldest = bus.oldestCursor
  const evicted = !epochMismatch && since !== undefined && since < latest && (oldest === null || since < oldest - 1)
  // The live-only sentinel starts at the current cursor, not at MAX_SAFE_INTEGER.
  let cursor = epochMismatch ? 0 : Math.min(since ?? 0, latest)
  let paused = false
  let closed = false

  const write = (chunk: string): boolean => {
    if (closed || sink.destroyed) return false
    if (!sink.write(chunk)) {
      paused = true
      sink.once('drain', drain)
      return false
    }
    return true
  }
  const send = (envelope: DaemonEventEnvelope): boolean => {
    cursor = envelope.cursor
    if (agentId && envelope.event.agent_id !== agentId) return true
    return write(`id: ${envelope.cursor}\nevent: ${envelope.event.event_type}\ndata: ${safeJsonStringify(envelope)}\n\n`)
  }
  const replay = (): void => {
    if (closed || paused || sink.destroyed) return
    const through = bus.latestCursor
    for (const envelope of bus.getSince(cursor, agentId)) {
      if (!send(envelope)) return
    }
    // Account for filtered events too, so they do not cause a false gap.
    cursor = through
  }
  function drain(): void {
    paused = false
    const oldestNow = bus.oldestCursor
    if (cursor < bus.latestCursor && (oldestNow === null || cursor < oldestNow - 1)) {
      cleanup()
      sink.destroy()
      return
    }
    replay()
  }
  const unsubscribe = bus.subscribe((envelope) => {
    if (!closed && !paused && !sink.destroyed) send(envelope)
  })
  const heartbeat = setInterval(() => {
    if (!closed && !paused && !sink.destroyed) write(`: heartbeat ${Date.now()}\n\n`)
  }, 30_000)
  heartbeat.unref?.()
  function cleanup(): void {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    sink.removeListener('drain', drain)
    sink.removeListener('close', cleanup)
  }
  sink.once('close', cleanup)

  let greeting = ': connected\n\n' + sseControl('stream.hello', { epoch: bus.epoch, oldestCursor: oldest, latestCursor: latest })
  if (epochMismatch || evicted) {
    greeting += sseControl('stream.gap', {
      reason: epochMismatch ? 'epoch_changed' : 'evicted',
      epoch: bus.epoch,
      requestedCursor: since ?? null,
      oldestCursor: oldest,
      latestCursor: latest,
    })
  }
  // Initial replay is allowed to begin at the oldest retained frame. Its
  // missing prefix was already reported above (or no cursor was supplied).
  cursor = Math.max(cursor, oldest === null ? latest : oldest - 1)
  if (write(greeting)) replay()
  return cleanup
}
