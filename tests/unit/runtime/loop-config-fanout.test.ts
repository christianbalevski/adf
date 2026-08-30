/**
 * The config-change choke point (review C2).
 *
 * Every path that changes an agent's config — sys_update_config, Studio's save,
 * the runtime service, the loop pool's own writes — must go through
 * `AssembledAgent.applyConfigChange`. Hand-rolling the fan-out
 * (`executor.updateConfig` + `triggerEvaluator.updateConfig` + …) looks
 * equivalent and silently drops four things:
 *
 *   1. `loopPool.reconcile` — side loops keep running under grants the owner
 *      just revoked, until something else happens to re-assemble them.
 *   2. the pool's raw-config snapshot — the next `loop_manage` write is built on
 *      a stale base and reverts the whole save.
 *   3. main's synthetic loop_send/loop_list declarations — main silently loses
 *      the tools it needs to talk to its own loops.
 *   4. `stripLoopNameMarker` — an imported .adf can bind MAIN's executor to a
 *      side loop's guards.
 *
 * These tests are about those four, not about the fan-out's happy path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { MockLLMProvider } from '../../../src/main/runtime/headless'
import { assembleAgent, type AssembledAgent } from '../../../src/main/runtime/assemble-agent'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

let dir: string
let workspace: AdfWorkspace
let agent: AssembledAgent<'headlessLive'>

/** What Studio's save does: persist, then fan out. */
function studioSave(mutate: (config: AgentConfig) => void): AgentConfig {
  const config = workspace.getAgentConfig()
  mutate(config)
  workspace.setAgentConfig(config)
  agent.applyConfigChange(config, { notifyHost: false })
  return config
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adf-loop-fanout-'))
  workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'fanout', start_in_state: 'idle' })

  const initial = workspace.getAgentConfig()
  const fsRead = initial.tools.find(t => t.name === 'fs_read')
  if (fsRead) fsRead.enabled = true
  workspace.setAgentConfig(initial)

  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  agent = assembleAgent({
    profile: 'headlessLive',
    workspace,
    config: workspace.getAgentConfig(),
    provider: new MockLLMProvider(),
    registry,
  })
})

afterEach(() => {
  try { agent.dispose() } catch { /* already disposed */ }
  clearAllUmbilicalBuses()
  rmSync(dir, { recursive: true, force: true })
})

describe('Studio save → loop fan-out', () => {
  beforeEach(async () => {
    await agent.loopPool.createLoop({
      name: 'reflector', goal: 'Notice what main missed.', enabled: true, tools: ['fs_read'],
    })
  })

  it('revokes a tool from the side loop\'s DERIVED config on save', async () => {
    const runtime = agent.loopPool.getRuntime('reflector')!
    expect(runtime.derived.tools.find(t => t.name === 'fs_read')?.enabled).toBe(true)
    expect(runtime.executor.getConfig().tools.find(t => t.name === 'fs_read')?.enabled).toBe(true)

    // The owner takes fs_read away from the agent in Studio.
    studioSave(config => {
      const fsRead = config.tools.find(t => t.name === 'fs_read')
      if (fsRead) fsRead.enabled = false
    })

    // The loop must lose it too, and lose it NOW — a save that only reached
    // main's executor left the loop holding a revoked grant.
    const after = agent.loopPool.getRuntime('reflector')!
    expect(after.derived.tools.find(t => t.name === 'fs_read')?.enabled).toBe(false)
    expect(after.executor.getConfig().tools.find(t => t.name === 'fs_read')?.enabled).toBe(false)
    // ...and nothing leaked the RAW host config into the loop.
    expect(after.executor.getConfig().metadata?.loop_name).toBe('reflector')
    expect(after.executor.getConfig().loops).toEqual([])
  })

  it('does not let the next loop_manage write revert the save', async () => {
    studioSave(config => { config.instructions = 'a charter the owner just wrote' })

    // A loop_manage create builds on the pool's view of the host config. If the
    // save never refreshed it, this write puts the pre-save config back.
    await agent.loopPool.createLoop({
      name: 'critic', goal: 'Disagree usefully.', enabled: true, tools: [],
    })

    const stored = workspace.getAgentConfig()
    expect(stored.instructions).toBe('a charter the owner just wrote')
    expect(stored.loops?.map(l => l.name)).toEqual(['reflector', 'critic'])
  })

  it('keeps main\'s synthetic loop_send/loop_list declarations across a save', () => {
    // Main's tool exposure is declaration-driven end to end, and these
    // declarations are injected in memory and never written to the .adf — so a
    // fan-out that hands the executor the raw stored config strips them.
    studioSave(config => { config.description = 'edited' })

    const mainTools = agent.executor.getConfig().tools
    expect(mainTools.some(t => t.name === 'loop_send' && t.enabled)).toBe(true)
    expect(mainTools.some(t => t.name === 'loop_list' && t.enabled)).toBe(true)
    // Still absent from the file — injected, not persisted.
    expect(workspace.getAgentConfig().tools.some(t => t.name === 'loop_send')).toBe(false)
  })

  it('strips a hand-edited metadata.loop_name rather than binding main to a side stream', async () => {
    // The marker is derived-config-only: on MAIN's executor it turns on the
    // side-loop guards and points the call handler at a stream main does not
    // own. An imported or hand-edited .adf can carry one.
    studioSave(config => {
      config.metadata = { ...config.metadata, loop_name: 'reflector' }
    })

    expect(agent.executor.getConfig().metadata?.loop_name).toBeUndefined()
    // And it does not survive into the file either: the strip is in-place, so
    // the next config write the runtime makes persists the cleaned object.
    await agent.loopPool.createLoop({
      name: 'archivist', goal: 'Keep the record.', enabled: true, tools: [],
    })
    expect(workspace.getAgentConfig().metadata?.loop_name).toBeUndefined()
  })

  it('spins up a loop declared by a config edit, and drops one removed by it', () => {
    studioSave(config => {
      config.loops = [
        ...(config.loops ?? []),
        { name: 'archivist', goal: 'Keep the record.', enabled: true, tools: [] },
      ]
    })
    expect(agent.loopPool.getRuntime('archivist')).toBeDefined()

    studioSave(config => {
      config.loops = (config.loops ?? []).filter(l => l.name !== 'archivist')
    })
    expect(agent.loopPool.getRuntime('archivist')).toBeUndefined()
    expect(agent.loopPool.hasLoop('archivist')).toBe(false)
  })
})

/**
 * The host fan-out is what reaches Studio: main's IPC layer turns
 * `onConfigChanged` into the DOC_AGENT_CONFIG_CHANGED push that refreshes the
 * renderer's agent store (loop tab strip, config panel's Loops section).
 *
 * A loop the AGENT creates must fire it. Before this, only sys_update_config
 * refreshed the UI — and only because the renderer watched for that one tool
 * NAME in the tool_result stream — so a loop_manage create/update/delete was
 * invisible until the user switched agents and back.
 */
describe('host notification on loop_manage-driven writes', () => {
  let seen: AgentConfig[]
  let attachment: { detach(): void }

  beforeEach(() => {
    seen = []
    attachment = agent.attachHost({
      onConfigChanged: (config) => { seen.push(structuredClone(config)) },
    })
  })

  afterEach(() => {
    attachment.detach()
  })

  it('notifies the host when the pool creates a loop', async () => {
    await agent.loopPool.createLoop({
      name: 'reflector', goal: 'Notice what main missed.', enabled: true, tools: [],
    })

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)!.loops?.map(l => l.name)).toContain('reflector')
  })

  it('notifies the host when the pool updates or deletes a loop', async () => {
    await agent.loopPool.createLoop({
      name: 'reflector', goal: 'Notice what main missed.', enabled: true, tools: [],
    })

    await agent.loopPool.updateLoop('reflector', { goal: 'A sharper charter.' })
    expect(seen.at(-1)!.loops?.find(l => l.name === 'reflector')?.goal).toBe('A sharper charter.')

    await agent.loopPool.deleteLoop('reflector')
    expect(seen.at(-1)!.loops?.map(l => l.name)).not.toContain('reflector')
  })

  it('does not echo a Studio-originated save back at the window that made it', () => {
    // Origin dedup: DOC_SET_AGENT_CONFIG passes `notifyHost: false` because the
    // renderer already holds what it just saved. An echo could land on top of
    // an edit still in flight.
    studioSave(config => { config.description = 'edited in Studio' })

    expect(seen).toEqual([])
  })
})
