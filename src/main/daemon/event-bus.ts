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
  /** Circular buffer: once full, `head` is the oldest slot and the next to be overwritten. */
  private readonly buffer: DaemonEventEnvelope[] = []
  private head = 0
  private readonly listeners = new Set<DaemonEventListener>()

  constructor(private readonly capacity = 1000) {}

  publish(event: UmbilicalEvent): DaemonEventEnvelope {
    const envelope: DaemonEventEnvelope = {
      cursor: this.nextCursor++,
      event,
    }

    if (this.capacity > 0) {
      if (this.buffer.length < this.capacity) {
        this.buffer.push(envelope)
      } else {
        this.buffer[this.head] = envelope
        this.head = (this.head + 1) % this.capacity
      }
    }

    for (const listener of this.listeners) {
      try {
        listener(envelope)
      } catch {
        // A bad subscriber should not break daemon event publication.
      }
    }

    return envelope
  }

  /** Replay buffered envelopes with a cursor strictly greater than `cursor`, oldest first. */
  getSince(cursor: number, agentId?: string): DaemonEventEnvelope[] {
    const size = this.buffer.length
    const out: DaemonEventEnvelope[] = []
    for (let i = 0; i < size; i++) {
      const envelope = this.buffer[(this.head + i) % size]
      if (envelope.cursor > cursor && (!agentId || envelope.event.agent_id === agentId)) {
        out.push(envelope)
      }
    }
    return out
  }

  subscribe(listener: DaemonEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
