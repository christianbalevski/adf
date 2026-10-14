import type { DaemonClient } from '../../../../shared/daemon-client'
import type { DaemonModeContext } from '../context'

/**
 * Coalescing for the reads the renderer polls (the fleet map's 5 s
 * MESH_MAP_POLL, fleet status, token burn, mesh status, recent tools, the
 * dashboard's container tile): a call while the same read is in flight
 * shares it, and a call within FRESH_MS of its answer gets that answer. So
 * several windows, panels or overlapping polls cost the daemon one request
 * per read and second at most. Studio's own writes (MESH_SET_AGENT_STATE,
 * EMERGENCY_STOP, …) drop the cache, so the next poll after them is fresh.
 */

/** How long an answer serves later identical polls. Well below every renderer poll interval (5 s). */
export const FRESH_MS = 1_000

interface Entry {
  promise: Promise<unknown>
  /** When the answer arrived; null while in flight. */
  settledAt: number | null
}

export class PollCoalescer {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly freshMs = FRESH_MS, private readonly now: () => number = Date.now) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && (hit.settledAt === null || this.now() - hit.settledAt < this.freshMs)) return hit.promise as Promise<T>
    const entry: Entry = { promise: Promise.resolve(), settledAt: null }
    entry.promise = load().then(
      (value) => { entry.settledAt = this.now(); return value },
      (err) => {
        // A failed read is never served again.
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw err
      },
    )
    this.entries.set(key, entry)
    return entry.promise as Promise<T>
  }

  invalidate(): void {
    this.entries.clear()
  }
}

/** The W3-D handlers' per-registration state: the coalescer and the burn-totals hand-over. */
interface FleetClientState {
  polls: PollCoalescer
  /** The client the burn totals were handed to; a reconnect (a restarted daemon) hands them over again. */
  hydrated: DaemonClient | null
  hydrating: Promise<void> | null
}

const STATES = new WeakMap<DaemonModeContext, FleetClientState>()

export function fleetState(ctx: DaemonModeContext): FleetClientState {
  let state = STATES.get(ctx)
  if (!state) {
    const created: FleetClientState = { polls: new PollCoalescer(), hydrated: null, hydrating: null }
    // A lost connection may come back to a restarted daemon: its burn
    // totals are gone and every cached answer is stale.
    ctx.connection.onState((s) => {
      if (s.state === 'disconnected') {
        created.hydrated = null
        created.polls.invalidate()
      }
    })
    STATES.set(ctx, created)
    state = created
  }
  return state
}

/**
 * Lifetime burn totals are the client key fleetMapState.burnTotals (§4.1):
 * the renderer saves them, the daemon's rolling counters start empty. Handed
 * over once per daemon connection, before the first burn read (route notes
 * from W1-D). The daemon keeps the larger of each pair, so a second hand-over
 * changes nothing.
 */
export async function hydrateBurn(ctx: DaemonModeContext, client: DaemonClient): Promise<void> {
  const state = fleetState(ctx)
  if (state.hydrated === client) return
  state.hydrating ??= (async () => {
    const saved = ctx.clientSettings.get('fleetMapState') as { burnTotals?: Record<string, number> } | undefined
    const burnTotals = saved?.burnTotals
    if (burnTotals && typeof burnTotals === 'object' && Object.keys(burnTotals).length > 0) {
      try {
        await client.request('POST', '/fleet/burn/hydrate', { body: { burnTotals } })
        ctx.log.log(`[Backend] Handed the fleet map's saved token totals (${Object.keys(burnTotals).length} agents) to the daemon`)
      } catch (err) {
        // Not fatal: the map shows totals from this daemon run only. Retried on the next read.
        ctx.log.warn(`[Backend] Could not hand the fleet map's saved token totals to the daemon: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    state.hydrated = client
  })().finally(() => { state.hydrating = null })
  await state.hydrating
}
