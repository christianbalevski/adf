export interface DaemonEventEnvelope {
  seq: number
  type: string
  agentId?: string | null
  timestamp: number
  payload: unknown
}

export interface PublishDaemonEvent {
  type: string
  agentId?: string | null
  timestamp?: number
  payload?: unknown
}

export type DaemonEventListener = (event: DaemonEventEnvelope) => void

export class DaemonEventBus {
  private nextSeq = 1
  private readonly buffer: DaemonEventEnvelope[] = []
  private readonly listeners = new Set<DaemonEventListener>()

  constructor(private readonly capacity = 1000) {}

  publish(input: PublishDaemonEvent): DaemonEventEnvelope {
    const event: DaemonEventEnvelope = {
      seq: this.nextSeq++,
      type: input.type,
      agentId: input.agentId,
      timestamp: input.timestamp ?? Date.now(),
      payload: input.payload ?? null,
    }

    this.buffer.push(event)
    while (this.buffer.length > this.capacity) this.buffer.shift()

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A bad subscriber should not break daemon event publication.
      }
    }

    return event
  }

  getSince(seq: number, agentId?: string): DaemonEventEnvelope[] {
    return this.buffer.filter(event =>
      event.seq > seq && (!agentId || event.agentId === agentId)
    )
  }

  subscribe(listener: DaemonEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
