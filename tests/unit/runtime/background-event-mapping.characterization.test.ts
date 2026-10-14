/**
 * Characterization of the background event mapping (W1-F, design §3.2 E1).
 *
 * Drives a real BackgroundAgentManager through both of its host-wiring sites —
 * a started agent (`setupAgent`) and an agent adopted from the foreground
 * (`transitionToBackground` → `adoptAssembledAgent`) — with the recorded event
 * sequence, and pins what comes out:
 *   - every `background_agent_event`, in order, with key order and `undefined`
 *     fields preserved, plus the agent's status as a synchronous listener sees
 *     it at emit time;
 *   - the manager's own state after each event;
 *   - what BackgroundEventBatcher sends to the renderer (stripping, state
 *     collapse, IMMEDIATE_TYPES flush points).
 *
 * Written before the extraction and left unchanged by it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-bam-mapping-test-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-bam-mapping-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

// Capture the host bindings each site attaches, so the test calls the site's
// own `onEvent` closure directly (no executor, no assemble-side effects).
const attached: Array<{ onEvent?: (event: unknown) => void }> = []
vi.mock('../../../src/main/runtime/assemble-agent', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/main/runtime/assemble-agent')>()
  return {
    ...mod,
    assembleAgent: (...args: Parameters<typeof mod.assembleAgent>) => {
      const assembled = mod.assembleAgent(...args)
      const attachHost = assembled.attachHost
      assembled.attachHost = (bindings) => {
        attached.push(bindings as { onEvent?: (event: unknown) => void })
        return attachHost(bindings)
      }
      return assembled
    },
  }
})

import { BackgroundAgentManager } from '../../../src/main/runtime/background-agent-manager'
import { BackgroundEventBatcher } from '../../../src/main/ipc/background-event-batch'
import { RuntimeGate } from '../../../src/main/runtime/runtime-gate'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import type { SettingsService } from '../../../src/main/services/settings.service'
import type { BackgroundAgentEvent, RendererBackgroundAgentEvent } from '../../../src/shared/types/ipc.types'
import { CHILD_PATH, RECORDED_EVENTS, type RecordedEvent } from './background-event-mapping.fixture'

const NOW = 1_700_000_000_000

function makeSettings(): SettingsService {
  return {
    get: (_key: string) => undefined,
    getProvider: (id: string) => ({ id: id || 'mock', type: 'anthropic', name: 'mock-provider', apiKey: 'test-key' }),
  } as unknown as SettingsService
}

function createAdfFile(dir: string, name: string): string {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions: { start_in_state: 'hibernate' },
  })
  created.dispose()
  return filePath
}

/** JSON with key order kept and `undefined` made visible. */
export function render(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === undefined ? '<undefined>' : v))
}

interface Managed {
  state: string
  activeLoops: number
  loopStates: Map<string, string>
  accumulatedText: string
}

const managers: BackgroundAgentManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try { await manager.stopAll() } catch { /* best effort */ }
    manager.dispose()
  }
  attached.length = 0
  RuntimeGate._resetForTests()
  vi.restoreAllMocks()
})

type Site = 'started' | 'adopted'

async function bootSite(site: Site): Promise<{
  manager: BackgroundAgentManager
  agentPath: string
  onEvent: (event: unknown) => void
  managed: () => Managed
}> {
  attached.length = 0
  const dir = mkdtempSync(join(tmpdir(), `adf-bam-mapping-${site}-`))
  const filePath = createAdfFile(dir, 'agent-1')
  const manager = new BackgroundAgentManager(makeSettings(), '', {})
  managers.push(manager)
  expect(await manager.startAgent(filePath)).toBe(true)
  if (site === 'adopted') {
    const extracted = manager.extractBackgroundAgent(filePath)
    expect(extracted).not.toBeNull()
    const config = extracted!.workspace.getAgentConfig()
    await manager.transitionToBackground(filePath, config, extracted!.assembledAgent)
  }
  const agents = (manager as unknown as { agents: Map<string, Managed> }).agents
  const [agentPath] = [...agents.keys()]
  const bindings = attached[attached.length - 1]
  expect(attached).toHaveLength(site === 'started' ? 1 : 2)
  return {
    manager,
    agentPath,
    onEvent: bindings.onEvent!,
    managed: () => agents.get(agentPath)!,
  }
}

interface Recording {
  text: string
  emitted: BackgroundAgentEvent[]
  batches: RendererBackgroundAgentEvent[][]
}

async function record(site: Site, events: RecordedEvent[]): Promise<Recording> {
  const { manager, agentPath, onEvent, managed } = await bootSite(site)
  const lines: string[] = []
  const emitted: BackgroundAgentEvent[] = []
  const batches: RendererBackgroundAgentEvent[][] = []
  const batcher = new BackgroundEventBatcher((batch) => batches.push(batch), 60_000)
  const scrub = (s: string): string => s.split(JSON.stringify(agentPath).slice(1, -1)).join('<AGENT>')
  let feeding = false
  manager.on('background_agent_event', (event: BackgroundAgentEvent) => {
    if (!feeding) return
    emitted.push(event)
    const status = manager.getStatuses().find(s => s.filePath === agentPath)
    lines.push(`  emit ${scrub(render(event))} | status ${scrub(render(status))}`)
    batcher.push(event)
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  events.forEach((event, i) => {
    lines.push(`> #${i} ${render(event)}`)
    feeding = true
    try { onEvent(event) } finally { feeding = false }
    const m = managed()
    lines.push(`  state ${m.state} activeLoops ${m.activeLoops} loops ${render([...m.loopStates])} text ${render(m.accumulatedText)}`)
  })
  vi.restoreAllMocks()
  batcher.dispose()
  lines.push('--- renderer batches')
  for (const batch of batches) lines.push(scrub(render(batch)))
  return { text: lines.join('\n') + '\n', emitted, batches }
}

describe('background event mapping: characterization', () => {
  it('started agents (setupAgent) map the recorded sequence as recorded', async () => {
    const { text } = await record('started', RECORDED_EVENTS)
    await expect(text).toMatchFileSnapshot('./__snapshots__/background-event-mapping.started.txt')
  })

  it('adopted agents (transitionToBackground) map the recorded sequence as recorded', async () => {
    const { text } = await record('adopted', RECORDED_EVENTS)
    await expect(text).toMatchFileSnapshot('./__snapshots__/background-event-mapping.adopted.txt')
  })

  it('both sites produce the same output for the same sequence', async () => {
    const started = await record('started', RECORDED_EVENTS)
    const adopted = await record('adopted', RECORDED_EVENTS)
    expect(adopted.text).toBe(started.text)
  })

  it('passes nested payload objects through by reference (shallow spread only)', async () => {
    const result = { content: 'r', isError: false }
    const input = { path: 'a.md' }
    const content = [{ type: 'text', text: 't' }]
    const { emitted } = await record('started', [
      { type: 'tool_call_start', payload: { name: 'fs_read', input, id: 't1' }, timestamp: 1 },
      { type: 'tool_call_result', payload: { name: 'fs_read', id: 't1', result }, timestamp: 2 },
      { type: 'turn_complete', payload: { content }, timestamp: 3 },
    ])
    expect(emitted[0].payload.input).toBe(input)
    expect(emitted[1].payload.result).toBe(result)
    expect(emitted[2].payload.content).toBe(content)
  })

  it('a child created event keys the batcher on the child path', async () => {
    const { batches } = await record('started', [
      { type: 'adf_file_created', payload: { filePath: CHILD_PATH }, timestamp: 1 },
    ])
    expect(batches.flat().map(e => e.payload.filePath)).toEqual([CHILD_PATH])
  })
})
