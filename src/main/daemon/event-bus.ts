import type { UmbilicalEvent } from '../runtime/umbilical-bus'

/**
 * Daemon-side wrapper around the canonical umbilical envelope.
 *
 * `cursor` is a transport-level resume token only — a monotonic counter owned
 * by this process' ring buffer. It carries no agent-level meaning; the
 * per-agent sequence number lives on `event.seq`.
 */
export interface DaemonEventEnvelope {
  cursor: number
  event: UmbilicalEvent
}

export type DaemonEventListener = (envelope: DaemonEventEnvelope) => void

export class DaemonEventBus {
  private nextCursor = 1
  private readonly buffer: DaemonEventEnvelope[] = []
  private readonly listeners = new Set<DaemonEventListener>()

  constructor(private readonly capacity = 1000) {}

  publish(event: UmbilicalEvent): DaemonEventEnvelope {
    const envelope: DaemonEventEnvelope = {
      cursor: this.nextCursor++,
      event,
    }

    this.buffer.push(envelope)
    while (this.buffer.length > this.capacity) this.buffer.shift()

    for (const listener of this.listeners) {
      try {
        listener(envelope)
      } catch {
        // A bad subscriber should not break daemon event publication.
      }
    }

    return envelope
  }

  /** Replay buffered envelopes with a cursor strictly greater than `cursor`. */
  getSince(cursor: number, agentId?: string): DaemonEventEnvelope[] {
    return this.buffer.filter(envelope =>
      envelope.cursor > cursor && (!agentId || envelope.event.agent_id === agentId)
    )
  }

  subscribe(listener: DaemonEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
