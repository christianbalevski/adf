import { afterEach, describe, expect, it, vi } from 'vitest'
import { TapManager } from '../../src/main/runtime/tap-manager'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../src/main/runtime/umbilical-bus'
import type { UmbilicalTapConfig } from '../../src/shared/types/adf-v02.types'

afterEach(() => {
  clearAllUmbilicalBuses()
  vi.restoreAllMocks()
})

function makeTap(overrides: Partial<UmbilicalTapConfig> = {}): UmbilicalTapConfig {
  return {
    name: 'orders',
    lambda: 'lib/tap.ts:onEvent',
    filter: { event_types: ['db.write'], allow_wildcard: false },
    exclude_own_origin: true,
    max_rate_per_sec: 100,
    ...overrides,
  }
}

function makeHarness(source = 'export async function onEvent(event) { return event.seq }') {
  const bus = ensureUmbilicalBus('agent-1')
  const execute = vi.fn(async () => ({ stdout: '' }))
  const insertLog = vi.fn()
  const workspace = {
    readFile: vi.fn((path: string) => path === 'lib/tap.ts' ? source : null),
    insertLog,
    getAgentConfig: vi.fn(() => ({ limits: {} })),
  }
  const adfCallHandler = {
    handleCall: vi.fn(),
    getEnabledToolNames: vi.fn(() => []),
    getHilToolNames: vi.fn(() => []),
    getAuthorizationContext: vi.fn(() => false),
  }
  const manager = new TapManager(
    'agent-1',
    workspace as any,
    bus,
    { execute } as any,
    adfCallHandler as any,
  )
  return { bus, manager, execute, insertLog }
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('TapManager', () => {
  it('dispatches only matching event types and when expressions', async () => {
    const { bus, manager, execute } = makeHarness()
    await manager.register([makeTap({
      filter: {
        event_types: ['db.write'],
        when: "event.payload.sql.includes('local_orders')",
        allow_wildcard: false,
      },
    })])

    bus.publish({ event_type: 'db.write', timestamp: 1, source: 'agent:t', payload: { sql: 'INSERT INTO local_other VALUES (1)' } })
    bus.publish({ event_type: 'db.write', timestamp: 2, source: 'agent:t', payload: { sql: 'INSERT INTO local_orders VALUES (1)' } })
    bus.publish({ event_type: 'tool.completed', timestamp: 3, source: 'agent:t', payload: {} })
    await tick()

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not evaluate when expressions in the main-process global scope', async () => {
    const { bus, manager, execute } = makeHarness()
    await manager.register([makeTap({
      filter: {
        event_types: ['db.write'],
        when: "typeof process !== 'undefined'",
        allow_wildcard: false,
      },
    })])

    bus.publish({ event_type: 'db.write', timestamp: 1, source: 'agent:t', payload: { sql: 'INSERT INTO local_orders VALUES (1)' } })
    await tick()

    expect(execute).not.toHaveBeenCalled()
  })

  it('suppresses events from the tap lambda when exclude_own_origin is enabled', async () => {
    const { bus, manager, execute } = makeHarness()
    await manager.register([makeTap()])

    bus.publish({
      event_type: 'db.write',
      timestamp: 1,
      source: 'lambda:lib/tap.ts:onEvent',
      payload: { sql: 'INSERT INTO local_orders VALUES (1)' },
    })
    await tick()

    expect(execute).not.toHaveBeenCalled()
  })

  it('rate limits matching events', async () => {
    const { bus, manager, execute, insertLog } = makeHarness()
    await manager.register([makeTap({ max_rate_per_sec: 1 })])

    bus.publish({ event_type: 'db.write', timestamp: 1, source: 'agent:t', payload: { sql: 'INSERT INTO local_orders VALUES (1)' } })
    bus.publish({ event_type: 'db.write', timestamp: 2, source: 'agent:t', payload: { sql: 'INSERT INTO local_orders VALUES (2)' } })
    await tick()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(insertLog).toHaveBeenCalledWith('warn', 'umbilical_tap', 'rate_limited', 'orders', expect.stringContaining('events/sec exceeded'))
  })

  it('emits tap lambda lifecycle events and logs sandbox errors', async () => {
    const { bus, manager, execute, insertLog } = makeHarness()
    execute.mockResolvedValueOnce({ stdout: '', error: 'boom' })
    const lifecycle: string[] = []
    bus.subscribe(event => {
      if (event.event_type.startsWith('lambda.')) lifecycle.push(`${event.event_type}:${event.payload.kind}`)
    })
    await manager.register([makeTap()])

    bus.publish({ event_type: 'db.write', timestamp: 1, source: 'agent:t', payload: { sql: 'INSERT INTO local_orders VALUES (1)' } })
    await tick()

    expect(lifecycle).toEqual(['lambda.started:tap', 'lambda.failed:tap'])
    expect(insertLog).toHaveBeenCalledWith('warn', 'umbilical_tap', 'dispatch_error', 'orders', expect.stringContaining('boom'))
  })
})
