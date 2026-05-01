/**
 * Umbilical bus — per-agent internal event stream for taps.
 *
 * Events published via emitUmbilicalEvent flow to two places:
 *   1. The daemon DaemonEventBus (external observers on /events SSE).
 *   2. The agent's UmbilicalBus (taps running in the agent's sandbox).
 *
 * Isolation: event buses are stored in a Map<agentId, UmbilicalBus>. No shared
 * instance. A tap in agent A cannot see agent B's events through any
 * in-process mechanism.
 *
 * Lifecycle: bus is created at agent start and destroyed at agent stop.
 *
 * Delivery: best-effort. Events dispatched to a single tap in seq order.
 * Multiple taps run concurrently. Handlers that throw are logged; subsequent
 * events continue.
 */

import { EventEmitter } from 'events'

export interface UmbilicalEvent {
  seq: number
  event_type: string
  timestamp: number
  source: string
  payload: Record<string, unknown>
}

export type UmbilicalListener = (event: UmbilicalEvent) => void | Promise<void>

export interface UmbilicalSequenceStore {
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
}

interface UmbilicalBusOptions {
  initialSeq?: number
  reserveNextSeq?: (nextSeq: number) => void
  reservationSize?: number
}

const UMBILICAL_NEXT_SEQ_META_KEY = 'runtime_umbilical_next_seq'
const DEFAULT_SEQUENCE_RESERVATION_SIZE = 1000

export class UmbilicalBus {
  private emitter = new EventEmitter()
  private nextSeq: number
  private reserveNextSeq: ((nextSeq: number) => void) | null
  private reservationSize: number
  private reservedUntilExclusive = 0
  // `exclude_own_origin` is enforced per-subscription via the tap's lambda
  // identifier; the bus just fan-outs. Rate limiting also lives per-subscription.

  constructor(public readonly agentId: string, options: UmbilicalBusOptions = {}) {
    this.emitter.setMaxListeners(200)
    this.nextSeq = normalizeSeq(options.initialSeq)
    this.reserveNextSeq = options.reserveNextSeq ?? null
    this.reservationSize = Math.max(1, options.reservationSize ?? DEFAULT_SEQUENCE_RESERVATION_SIZE)
    this.reserveSequenceBlock()
  }

  /** Returns the sequence number assigned to this event. */
  publish(partial: Omit<UmbilicalEvent, 'seq'>): UmbilicalEvent {
    this.reserveSequenceBlock()
    const event: UmbilicalEvent = { ...partial, seq: this.nextSeq++ }
    if (process.env.ADF_UMBILICAL_TRACE === '1') {
      console.log(`[Umbilical:bus] agent=${this.agentId} seq=${event.seq} type=${event.event_type} listeners=${this.emitter.listenerCount('event')}`)
    }
    this.emitter.emit('event', event)
    return event
  }

  subscribe(listener: UmbilicalListener): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  teardown(): void {
    this.emitter.removeAllListeners()
  }

  configureSequenceReservation(options: UmbilicalBusOptions): void {
    if (typeof options.initialSeq === 'number') {
      this.nextSeq = Math.max(this.nextSeq, normalizeSeq(options.initialSeq))
    }
    if (options.reserveNextSeq) this.reserveNextSeq = options.reserveNextSeq
    if (typeof options.reservationSize === 'number') {
      this.reservationSize = Math.max(1, options.reservationSize)
    }
    this.reserveSequenceBlock()
  }

  private reserveSequenceBlock(): void {
    if (!this.reserveNextSeq) return
    if (this.nextSeq < this.reservedUntilExclusive) return
    this.reservedUntilExclusive = this.nextSeq + this.reservationSize
    this.reserveNextSeq(this.reservedUntilExclusive)
  }
}

// =============================================================================
// Per-agent registry
// =============================================================================

const registry = new Map<string, UmbilicalBus>()

export function getUmbilicalBus(agentId: string): UmbilicalBus | undefined {
  return registry.get(agentId)
}

export function ensureUmbilicalBus(agentId: string, options?: UmbilicalBusOptions): UmbilicalBus {
  let bus = registry.get(agentId)
  if (!bus) {
    bus = new UmbilicalBus(agentId, options)
    registry.set(agentId, bus)
    if (process.env.ADF_UMBILICAL_TRACE === '1') {
      console.log(`[Umbilical:registry] ENSURE agent=${agentId} (size=${registry.size})`)
      console.trace('[Umbilical:registry] ensure stack')
    }
  } else {
    if (options) bus.configureSequenceReservation(options)
    if (process.env.ADF_UMBILICAL_TRACE === '1') {
      console.log(`[Umbilical:registry] ENSURE (existing) agent=${agentId}`)
    }
  }
  return bus
}

export function ensureWorkspaceUmbilicalBus(agentId: string, store: UmbilicalSequenceStore): UmbilicalBus {
  const raw = store.getMeta(UMBILICAL_NEXT_SEQ_META_KEY)
  const initialSeq = normalizeSeq(raw ? Number(raw) : Date.now() * 1000)
  return ensureUmbilicalBus(agentId, {
    initialSeq,
    reserveNextSeq: (nextSeq) => {
      store.setMeta(UMBILICAL_NEXT_SEQ_META_KEY, String(nextSeq))
    },
  })
}

export function destroyUmbilicalBus(agentId: string): void {
  const bus = registry.get(agentId)
  if (!bus) return
  if (process.env.ADF_UMBILICAL_TRACE === '1') {
    console.log(`[Umbilical:registry] DESTROY agent=${agentId}`)
    console.trace('[Umbilical:registry] destroy stack')
  }
  bus.teardown()
  registry.delete(agentId)
}

/** Test-only helper. */
export function clearAllUmbilicalBuses(): void {
  for (const bus of registry.values()) bus.teardown()
  registry.clear()
}

function normalizeSeq(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 1
}
