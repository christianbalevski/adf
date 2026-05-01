/**
 * Umbilical burst benchmark.
 *
 * Dispatches 500 events within 100ms to 3 taps. Measures:
 *   - catch-up latency (time from last emit to last tap decision)
 *   - drop count (rate-limit-adjusted)
 *
 * Models the realistic worst case: agent startup when many warm handlers hit
 * their first invocations and the bus sees a burst of events at once.
 */

import { UmbilicalBus } from '../../src/main/runtime/umbilical-bus'

const BURST_SIZE = 500
const BURST_WINDOW_MS = 100

interface Tap {
  name: string
  tokens: number
  lastRefillAt: number
  maxRate: number
  lastDeliveryAt: number
  deliveries: number
  drops: number
}

async function main(): Promise<void> {
  const bus = new UmbilicalBus('bench-agent')

  // Default rate limit from spec: 100/sec. Bursty workloads will drop.
  const taps: Tap[] = [
    { name: 'tap-a', tokens: 100, lastRefillAt: Date.now(), maxRate: 100, lastDeliveryAt: 0, deliveries: 0, drops: 0 },
    { name: 'tap-b', tokens: 100, lastRefillAt: Date.now(), maxRate: 100, lastDeliveryAt: 0, deliveries: 0, drops: 0 },
    { name: 'tap-c', tokens: 100, lastRefillAt: Date.now(), maxRate: 100, lastDeliveryAt: 0, deliveries: 0, drops: 0 },
  ]

  for (const tap of taps) {
    bus.subscribe((event) => {
      const now = Date.now()
      const elapsedSec = (now - tap.lastRefillAt) / 1000
      tap.tokens = Math.min(tap.maxRate, tap.tokens + elapsedSec * tap.maxRate)
      tap.lastRefillAt = now
      if (tap.tokens < 1) {
        tap.drops += 1
        return
      }
      tap.tokens -= 1
      tap.deliveries += 1
      tap.lastDeliveryAt = now
      void event
    })
  }

  const startWall = Date.now()
  const interval = BURST_WINDOW_MS / BURST_SIZE  // ~0.2ms between emits

  for (let i = 0; i < BURST_SIZE; i++) {
    bus.publish({
      event_type: 'tool.completed',
      timestamp: Date.now(),
      source: 'agent:bench',
      payload: { name: 'burst', index: i }
    })
    // Tight spin-wait to hit the target burst window
    const target = startWall + (i + 1) * interval
    while (Date.now() < target) { /* spin */ }
  }

  const endEmit = Date.now()
  // Catch-up window: wait for any queued work to settle
  await new Promise(r => setTimeout(r, 10))
  const settleEnd = Date.now()

  const maxLastDelivery = Math.max(...taps.map(t => t.lastDeliveryAt))
  const catchUpMs = maxLastDelivery - endEmit

  console.log('=== Umbilical burst benchmark ===')
  console.log(`Burst size:            ${BURST_SIZE} events`)
  console.log(`Emit window:           ${endEmit - startWall}ms (target ${BURST_WINDOW_MS}ms)`)
  console.log(`Catch-up latency:      ${catchUpMs}ms (last emit -> last delivery)`)
  console.log(`Settle window:         ${settleEnd - endEmit}ms`)
  for (const tap of taps) {
    console.log(`Tap ${tap.name}: ${tap.deliveries} deliveries, ${tap.drops} drops (rate limit ${tap.maxRate}/sec)`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
