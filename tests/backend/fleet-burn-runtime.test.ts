/**
 * The fleet map's saved token totals per runtime (docs/design/multi-runtime.md
 * §7.4): the primary runtime is handed fleetMapState.burnTotals, as before; a
 * runtime other than the primary is handed only its own
 * runtimeFleet[<runtime id>].fleetMapState.burnTotals, never the primary's.
 */
import { describe, expect, it, vi } from 'vitest'
import { hydrateBurn } from '../../src/main/backend/daemon-mode/handlers/poll'
import type { DaemonModeContext } from '../../src/main/backend/daemon-mode/context'
import type { DaemonClient } from '../../src/shared/daemon-client'

const HOST_1 = 'remote:host-1'
const LOCAL_TOTALS = { '/agents/agent-1.adf': 120 }
const HOST_TOTALS = { '/home/u/agents/agent-2.adf': 340 }

function ctxFor(runtime: { id: string; primary: boolean } | undefined, settings: Record<string, unknown>): DaemonModeContext {
  return {
    runtime,
    clientSettings: { get: (key: string) => settings[key] },
    connection: { onState: () => () => {} },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  } as unknown as DaemonModeContext
}

function client() {
  const request = vi.fn(async () => ({}))
  return { request, client: { request } as unknown as DaemonClient }
}

const SETTINGS = {
  fleetMapState: { burnTotals: LOCAL_TOTALS },
  runtimeFleet: { [HOST_1]: { fleetMapState: { burnTotals: HOST_TOTALS } } },
}

describe('fleet burn hand-over per runtime', () => {
  it('the primary runtime is handed fleetMapState.burnTotals', async () => {
    const c = client()
    await hydrateBurn(ctxFor({ id: 'local', primary: true }, SETTINGS), c.client)
    expect(c.request).toHaveBeenCalledWith('POST', '/fleet/burn/hydrate', { body: { burnTotals: LOCAL_TOTALS } })
  })

  it('another runtime is handed its own runtimeFleet totals, not the primary\'s', async () => {
    const c = client()
    await hydrateBurn(ctxFor({ id: HOST_1, primary: false }, SETTINGS), c.client)
    expect(c.request).toHaveBeenCalledTimes(1)
    expect(c.request).toHaveBeenCalledWith('POST', '/fleet/burn/hydrate', { body: { burnTotals: HOST_TOTALS } })
  })

  it('another runtime with nothing saved is handed nothing', async () => {
    const c = client()
    await hydrateBurn(ctxFor({ id: 'remote:host-2', primary: false }, SETTINGS), c.client)
    expect(c.request).not.toHaveBeenCalled()
  })
})
