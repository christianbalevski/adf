/**
 * REPRODUCTION HARNESS for the live protection-enforcement bug: drives the
 * REAL assembled runtime (assembleAgent → AgentExecutor → registry →
 * ShellTool → protection-gated registry → real fs tools → real SQLite DB)
 * with a scripted LLM provider, exactly the way the app assembles an agent.
 *
 * Invariant under test: a protected file cannot be deleted/overwritten from
 * an interactive shell command without a REAL human approval. The HIL request
 * must surface as a `tool_approval_request` executor event; denial must leave
 * the file intact; nothing may auto-approve.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nanoid } from 'nanoid'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import { registerBuiltInTools } from '../../../src/main/tools/built-in/register-built-in-tools'
import { assembleAgent, type AssembledAgent } from '../../../src/main/runtime/assemble-agent'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { LLMProvider, CreateMessageOptions } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

/** Provider that plays a fixed script of responses, then end_turns forever. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly modelId = 'scripted-v1'
  private script: LLMResponse[]
  constructor(script: LLMResponse[]) { this.script = [...script] }
  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    const next = this.script.shift()
    if (next) return next
    return {
      id: `scripted-${nanoid(6)}`,
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

function shellCall(command: string): LLMResponse {
  return {
    id: `scripted-${nanoid(6)}`,
    content: [{ type: 'tool_use', id: `tu-${nanoid(6)}`, name: 'adf_shell', input: { command } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function chatDispatch(message: string) {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test:protection',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text' as const, text: message }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

const tempDirs: string[] = []
const agents: Array<AssembledAgent<'headlessLive'>> = []

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.disposeAsync({ mode: 'immediate' }) } catch { /* already down */ }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  agent: AssembledAgent<'headlessLive'>
  workspace: AdfWorkspace
  approvals: Array<{ taskId: string; name: string; input: unknown }>
  events: AgentExecutionEvent[]
}

/**
 * Assemble a real agent the way the app does. `decision` controls what the
 * "human" does when a tool_approval_request surfaces: deny, approve, or
 * ignore (never resolves — protection must then hold the operation).
 */
function makeAgent(script: LLMResponse[], decision: 'deny' | 'approve' | 'none'): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'adf-shell-prot-'))
  tempDirs.push(dir)
  const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), {
    name: 'protection-repro',
    autonomous: false,
    start_in_state: 'active',
    tools: [
      { name: 'adf_shell', enabled: true, visible: true, restricted: false },
      { name: 'fs_delete', enabled: true, visible: true, restricted: false },
      { name: 'fs_write', enabled: true, visible: true, restricted: false },
      { name: 'fs_read', enabled: true, visible: true, restricted: false },
      { name: 'fs_list', enabled: true, visible: true, restricted: false },
    ],
  })
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  const agent = assembleAgent({
    profile: 'headlessLive',
    workspace,
    config: workspace.getAgentConfig(),
    provider: new ScriptedProvider(script),
    registry,
  })
  agents.push(agent)

  const approvals: Array<{ taskId: string; name: string; input: unknown }> = []
  const events: AgentExecutionEvent[] = []
  agent.executor.on('event', (event: AgentExecutionEvent) => {
    events.push(event)
    if (event.type === 'tool_approval_request') {
      const payload = event.payload as { taskId: string; name: string; input: unknown }
      approvals.push(payload)
      if (decision === 'deny') {
        setImmediate(() => agent.executor.resolveHilTask(payload.taskId, false, undefined, 'denied by test human'))
      } else if (decision === 'approve') {
        setImmediate(() => agent.executor.resolveHilTask(payload.taskId, true))
      }
    }
  })
  return { agent, workspace, approvals, events }
}

function lastShellResult(events: AgentExecutionEvent[]): { exit_code: number; stdout: string; stderr: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'tool_call_result') {
      const payload = e.payload as { name: string; result?: { content?: string } }
      if (payload.name === 'adf_shell' && payload.result?.content) {
        try { return JSON.parse(payload.result.content) } catch { return null }
      }
    }
  }
  return null
}

describe('assembled-runtime shell protection enforcement (live-bug reproduction)', () => {
  it('rm on a no_delete file surfaces HIL; denied → file intact', async () => {
    const { agent, workspace, approvals, events } = makeAgent([shellCall('rm tmp/x.txt')], 'deny')
    workspace.writeFile('tmp/x.txt', 'secret')
    workspace.setFileProtection('tmp/x.txt', 'no_delete')

    await agent.start()
    await agent.dispatch(chatDispatch('delete tmp/x.txt'))

    expect(approvals, `events=${events.map(e => e.type).join(',')}`).toHaveLength(1)
    expect(workspace.readFile('tmp/x.txt')).toBe('secret')
    const shell = lastShellResult(events)
    expect(shell?.exit_code).not.toBe(0)
  })

  it('adf fs_delete on a no_delete file surfaces HIL; denied → file intact', async () => {
    const { agent, workspace, approvals, events } = makeAgent(
      [shellCall(`adf fs_delete '{"path":"tmp/x.txt"}'`)], 'deny')
    workspace.writeFile('tmp/x.txt', 'secret')
    workspace.setFileProtection('tmp/x.txt', 'no_delete')

    await agent.start()
    await agent.dispatch(chatDispatch('delete tmp/x.txt'))

    expect(approvals, `events=${events.map(e => e.type).join(',')}`).toHaveLength(1)
    expect(workspace.readFile('tmp/x.txt')).toBe('secret')
  })

  it('echo > read_only file surfaces HIL; denied → content intact', async () => {
    const { agent, workspace, approvals } = makeAgent([shellCall('echo pwned > tmp/r.txt')], 'deny')
    workspace.writeFile('tmp/r.txt', 'original')
    workspace.setFileProtection('tmp/r.txt', 'read_only')

    await agent.start()
    await agent.dispatch(chatDispatch('overwrite tmp/r.txt'))

    expect(approvals).toHaveLength(1)
    expect(workspace.readFile('tmp/r.txt')).toBe('original')
  })

  it('protection set via chmod (the shell path) is enforced for a later rm', async () => {
    const { agent, workspace, approvals } = makeAgent(
      [shellCall('chmod +p=no_delete tmp/x.txt'), shellCall('rm tmp/x.txt')], 'deny')
    workspace.writeFile('tmp/x.txt', 'secret')

    await agent.start()
    await agent.dispatch(chatDispatch('protect then delete'))

    expect(workspace.getFileProtection('tmp/x.txt')).toBe('no_delete')
    expect(approvals).toHaveLength(1)
    expect(workspace.readFile('tmp/x.txt')).toBe('secret')
  })

  it('chmod -p on a protected file surfaces HIL; denied → protection intact', async () => {
    const { agent, workspace, approvals } = makeAgent([shellCall('chmod -p tmp/x.txt')], 'deny')
    workspace.writeFile('tmp/x.txt', 'secret')
    workspace.setFileProtection('tmp/x.txt', 'no_delete')

    await agent.start()
    await agent.dispatch(chatDispatch('unprotect tmp/x.txt'))

    expect(approvals).toHaveLength(1)
    expect(workspace.getFileProtection('tmp/x.txt')).toBe('no_delete')
  })

  it('mv of a no_delete file surfaces HIL; denied → file stays', async () => {
    const { agent, workspace, approvals } = makeAgent([shellCall('mv tmp/x.txt tmp/y.txt')], 'deny')
    workspace.writeFile('tmp/x.txt', 'secret')
    workspace.setFileProtection('tmp/x.txt', 'no_delete')

    await agent.start()
    await agent.dispatch(chatDispatch('rename tmp/x.txt'))

    expect(approvals).toHaveLength(1)
    expect(workspace.readFile('tmp/x.txt')).toBe('secret')
    expect(workspace.readFile('tmp/y.txt')).toBeNull()
  })

  it('rm mind.md (seeded no_delete) surfaces HIL; denied → mind.md intact', async () => {
    const { agent, workspace, approvals, events } = makeAgent([shellCall('rm mind.md')], 'deny')

    await agent.start()
    await agent.dispatch(chatDispatch('delete mind.md'))

    expect(approvals, `events=${events.map(e => e.type).join(',')}`).toHaveLength(1)
    expect(workspace.getFileProtection('mind.md')).toBe('no_delete')
  })

  it('approval path still works: approved rm deletes the protected file', async () => {
    const { agent, workspace, approvals } = makeAgent([shellCall('rm tmp/x.txt')], 'approve')
    workspace.writeFile('tmp/x.txt', 'secret')
    workspace.setFileProtection('tmp/x.txt', 'no_delete')

    await agent.start()
    await agent.dispatch(chatDispatch('delete tmp/x.txt'))

    expect(approvals).toHaveLength(1)
    expect(workspace.readFile('tmp/x.txt')).toBeNull()
  })
})
