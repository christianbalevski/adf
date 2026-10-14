// The daemon's mesh registrations follow RuntimeService: register on load,
// unregister before the stop's teardown (Studio's handleAgentOff order) and
// move with rekeyAgentPath.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { wireRuntimeToMesh } from '../src/main/daemon/runtime-mesh-wiring'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})

function setup() {
  const dir = realpathSync.native(mkdtempSync(join(process.env.ADF_USER_DATA_DIR!, 'mesh-wiring-')))
  const filePath = join(dir, 'agent-1.adf')
  createHeadlessAgent({ filePath, name: 'agent-1', provider: new MockLLMProvider() }).dispose()
  const runtime = new RuntimeService({ enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }) })
  const calls: string[] = []
  const registered = new Set<string>()
  const wiring = wireRuntimeToMesh(runtime, {
    register: (event) => { calls.push(`register ${event.filePath} as ${event.ref.config.name}`); registered.add(event.filePath!) },
    unregister: (fp) => { calls.push(`unregister ${fp}`); registered.delete(fp) },
  })
  // Lifecycle events interleaved with the mesh calls show the order.
  runtime.on('agent-lifecycle', (e) => calls.push(e.type))
  return { dir, filePath, runtime, calls, registered, wiring }
}

describe('wireRuntimeToMesh', () => {
  it('registers on load and unregisters at agent_stopping, before the teardown', async () => {
    const { filePath, runtime, calls, registered, wiring } = setup()
    const ref = await runtime.loadAgent(filePath)
    expect([...registered]).toEqual([filePath])
    expect(wiring.loaded().map((e) => e.agentId)).toEqual([ref.id])

    await runtime.unloadAgent(ref.id)
    const stopping = calls.indexOf('agent_stopping')
    expect(calls[stopping + 1]).toBe(`unregister ${filePath}`)
    expect(calls.indexOf('agent_stopped')).toBeGreaterThan(stopping + 1)
    expect(registered.size).toBe(0)
    expect(wiring.loaded()).toEqual([])
  })

  it('moves the registration when the agent file moves (rekeyAgentPath)', async () => {
    const { dir, filePath, runtime, calls, registered, wiring } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ref = await runtime.loadAgent(filePath)
    const newPath = join(dir, 'agent-1-moved.adf')
    writeFileSync(newPath, '')

    await runtime.rekeyAgentPath(filePath, newPath)

    const canonicalNew = realpathSync.native(newPath)
    expect([...registered]).toEqual([canonicalNew])
    expect(calls.slice(-2)).toEqual([`unregister ${filePath}`, `register ${canonicalNew} as agent-1`])
    expect(wiring.loaded()).toMatchObject([{ agentId: ref.id, filePath: canonicalNew, ref: { filePath: canonicalNew } }])
  })
})
