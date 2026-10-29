import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHeadlessAgent, openHeadlessAgent, type HeadlessAgent } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { deriveLoopConfig } from '../../../src/main/adf/derive-loop-config'
import { LoopConfigSchema } from '../../../src/main/adf/adf-schema'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

const root = resolve(import.meta.dirname, '../../../skills/persistent-investigations')
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
const journalPath = 'investigations/control/state.json'
const activation = readFileSync(join(root, 'assets/resume-instructions.txt'), 'utf8').replaceAll('JOURNAL_PATH', journalPath)
const compactionPrompt = 'Summarize this transcript for the resumption test.'
const misleadingSummary = 'Assigned work complete. All reports delivered. Nothing else to do.'
const firstState = { status: 'active', goal: 'Explain the anomaly', questions: [{ id: 'q1', status: 'open', question: 'Does delay explain the anomaly?' }], experiments: [{ id: 'e1', status: 'completed', result: 'Delay did not remove the anomaly.' }] }

class Recorder implements LLMProvider {
  readonly name = 'resumption-test'
  readonly modelId = 'resumption-test-model'
  readonly calls: CreateMessageOptions[] = []
  compactions = 0
  async validateConfig() { return { valid: true } }
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const compacting = options.system === compactionPrompt
    if (compacting) this.compactions++
    else this.calls.push(options)
    return {
      id: 'response', stop_reason: 'end_turn',
      content: [{ type: 'text', text: compacting ? misleadingSummary : 'Scripted response; no behavioral claim.' }],
      usage: { input_tokens: !compacting && this.calls.length === 1 ? 38_000 : 100, output_tokens: 20 },
    }
  }
}

const agents = new Set<HeadlessAgent>()
const dirs: string[] = []
beforeEach(() => clearAllUmbilicalBuses())
afterEach(async () => {
  for (const agent of agents) await agent.disposeAsync()
  agents.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(bare = false) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-resumption-'))
  dirs.push(dir)
  const filePath = join(dir, 'agent.adf')
  const provider = new Recorder()
  const options = { filePath, provider, profile: 'benchmark' as const, basePrompt: 'Existing base prompt.', toolPrompts: {}, compactionPrompt }
  const agent = createHeadlessAgent({
    ...options,
    createOptions: {
      instructions: `Existing principal scope: explain the anomaly within the agreed budget.\n\n${activation}`,
      bare_prompt: bare,
      context: { compact_threshold: 50_000 },
      tools: [{ name: 'fs_read', enabled: true, visible: true }],
    },
  })
  agents.add(agent)
  agent.workspace.writeFile('skills/persistent-investigations/SKILL.md', skill)
  agent.workspace.writeFile(journalPath, JSON.stringify(firstState))
  return { agent, provider, options }
}

function chat(text: string) {
  return createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }), { scope: 'agent' })
}

describe('investigation activation through existing instruction file interpolation', () => {
  it.each([false, true])('loads the full skill and fresh journal after automatic compaction (bare=%s)', async bare => {
    const { agent, provider } = fixture(bare)
    await agent.executor.executeTurn(chat('Continue the investigation'))
    expect(provider.calls[0].system).toContain(skill)
    expect(provider.calls[0].system).toContain(firstState.questions[0].question)

    const updated = { ...firstState, questions: [{ id: 'q2', status: 'open', question: 'Does input order explain the anomaly?' }] }
    agent.workspace.writeFile(journalPath, JSON.stringify(updated))
    await agent.executor.executeTurn(chat('New trial detail. '.repeat(12_000)))
    expect(provider.compactions).toBe(1)
    expect(provider.calls).toHaveLength(2)
    const next = provider.calls[1]
    expect(JSON.stringify(next.messages)).toContain(misleadingSummary)
    expect(next.system).toContain(skill)
    expect(next.system).toContain(JSON.stringify(updated))
    expect(next.system).not.toContain(firstState.questions[0].question)
    expect(next.system).toContain('Existing principal scope')
    const promptAudit = agent.workspace.getLoop().flatMap(row => row.content_json.filter(block => block.type === 'text').map(block => block.text))
    expect(promptAudit).toContain(`[Context: system_prompt] ${next.system}`)
  })

  it('refreshes paused state after explicit compaction rather than preserving the old active snapshot', async () => {
    const { agent, provider } = fixture()
    await agent.executor.executeTurn(chat('Start'))
    const paused = { ...firstState, status: 'paused', pause_reason: 'Principal paused further trials' }
    agent.workspace.writeFile(journalPath, JSON.stringify(paused))
    expect(await agent.executor.compactNow('test boundary')).toEqual({ success: true })
    await agent.executor.executeTurn(chat('Report the current state'))
    expect(provider.calls[1].system).toContain(JSON.stringify(paused))
    expect(provider.calls[1].system).toContain('without a current instruction')
  })

  it('loads the binding and current state again after an actual close and reopen', async () => {
    const { agent, provider, options } = fixture(true)
    await agent.executor.executeTurn(chat('Start'))
    const updated = { ...firstState, next_experiment: 'Replicate using reversed input order' }
    agent.workspace.writeFile(journalPath, JSON.stringify(updated))
    await agent.disposeAsync()
    agents.delete(agent)
    const reopened = openHeadlessAgent(options)
    agents.add(reopened)
    await reopened.executor.executeTurn(chat('Resume the assigned investigation'))
    expect(provider.calls[1].system).toContain(skill)
    expect(provider.calls[1].system).toContain(JSON.stringify(updated))
  })

  it('surfaces a missing journal instead of dropping the activation instructions', async () => {
    const { agent, provider } = fixture()
    agent.workspace.deleteFile(journalPath)
    await agent.executor.executeTurn(chat('Resume'))
    expect(provider.calls[0].system).toContain(`<injected_file path="${journalPath}" missing="true"/>`)
    expect(provider.calls[0].system).toContain('Missing or malformed journal data means recovery')
    expect(provider.calls[0].system).toContain(skill)
  })

  it('binds a worker through its own goal and reloads its journal after compaction', async () => {
    const { agent, options } = fixture(true)
    const provider = new Recorder()
    const loop = LoopConfigSchema.parse({ name: 'research', enabled: true, autostart: false, goal: `Explain the control failure.\n${activation}`, tools: ['fs_read'] })
    const config = deriveLoopConfig({ ...agent.workspace.getAgentConfig(), instructions: 'Main has unrelated coordination instructions.' }, loop)
    const worker = await new AgentRuntimeBuilder({ basePrompt: '', toolPrompts: {}, compactionPrompt }).build({
      workspace: agent.workspace.forLoop('research'), filePath: options.filePath,
      config, provider,
    })
    try {
      await worker.executor.executeTurn(chat('Continue'))
      expect(provider.calls[0].system).toContain(skill)
      expect(provider.calls[0].system).not.toContain('Main has unrelated coordination instructions')
      const updated = { ...firstState, next_experiment: 'Worker experiment: reverse input order' }
      agent.workspace.writeFile(journalPath, JSON.stringify(updated))
      expect(await worker.executor.compactNow('worker checkpoint')).toEqual({ success: true })
      await worker.executor.executeTurn(chat('Continue within the charter'))
      expect(JSON.stringify(provider.calls[1].messages)).toContain(misleadingSummary)
      expect(provider.calls[1].system).toContain(JSON.stringify(updated))
      expect(provider.calls[1].system).toContain(skill)
    } finally {
      await worker.disposeAsync()
    }
  })
})
