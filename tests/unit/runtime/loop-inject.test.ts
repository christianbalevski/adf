import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import { withSource } from '../../../src/main/runtime/execution-context'

describe('loop_inject', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function makeFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'adf-loop-inject-'))
    const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'loop-inject-test' })
    cleanups.push(() => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    const session = new AgentSession(workspace)
    const config = {
      name: 'loop-inject-test',
      id: 'loop-inject-test',
      tools: [],
      code_execution: { loop_inject: true },
    } as unknown as AgentConfig
    const handler = new AdfCallHandler({
      toolRegistry: { get: () => null } as never,
      workspace,
      config,
      provider: {} as never,
    })
    handler.attachSession(session)
    return { workspace, session, handler }
  }

  it('persists every keyed update but delivers only the latest queued value to the active session', async () => {
    const { workspace, session, handler } = makeFixture()

    await handler.handleCall('loop_inject', {
      content: 'version one', category: 'skills_registry', origin: 'sys_lambda:skills', key: 'skills_registry',
    })
    await handler.handleCall('loop_inject', {
      content: 'version two', category: 'skills_registry', origin: 'sys_lambda:skills', key: 'skills_registry',
    })

    // The handler has not yet touched the active message sequence.
    expect(session.getMessages()).toEqual([])
    expect(workspace.getLoop()).toHaveLength(2)

    const delivered = session.drainContextInjections()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('version two')
    expect(session.getMessages()).toHaveLength(1)
    expect(String((session.getMessages()[0].content as any)[0].text)).toContain('version two')

    // Delivery skips a second loop write: the durable audit remains exactly two entries.
    session.flushToLoop()
    expect(workspace.getLoop()).toHaveLength(2)
  })

  it('waits until the tool result is present before entering the message sequence', async () => {
    const { session, handler } = makeFixture()
    session.addMessage({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'sys_lambda', input: {} }],
    })

    await handler.handleCall('loop_inject', { content: 'new operational context' })
    expect(session.getMessages()).toHaveLength(1)

    session.addMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok', is_error: false }],
    })
    session.drainContextInjections()

    expect(session.getMessages().map(message => message.role)).toEqual(['assistant', 'user', 'user'])
    const result = (session.getMessages()[1].content as any)[0]
    expect(result.type).toBe('tool_result')
    expect((session.getMessages()[2].content as any)[0].text).toContain('new operational context')
  })

  it('rehydrates only the latest keyed entry after restoring persisted history', async () => {
    const { workspace, handler } = makeFixture()
    await handler.handleCall('loop_inject', { content: 'old catalog', category: 'skills_registry', key: 'skills_registry' })
    await handler.handleCall('loop_inject', { content: 'current catalog', category: 'skills_registry', key: 'skills_registry' })

    const restored = new AgentSession(workspace)
    restored.restoreMessages(workspace.getLoop().map(entry => ({ role: entry.role, content: entry.content_json })))
    expect(restored.getMessages()).toEqual([])
    const delivered = restored.drainContextInjections()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('current catalog')
  })

  it('does not replay unkeyed one-shot context after restoring persisted history', async () => {
    const { workspace, handler } = makeFixture()
    await handler.handleCall('loop_inject', { content: 'one-shot notification' })

    const restored = new AgentSession(workspace)
    restored.restoreMessages(workspace.getLoop().map(entry => ({ role: entry.role, content: entry.content_json })))
    expect(restored.getMessages()).toEqual([])
    expect(restored.drainContextInjections()).toEqual([])
  })

  it('uses runtime execution provenance instead of a caller-supplied origin label', async () => {
    const { workspace, handler } = makeFixture()
    await withSource('lambda:lib/real.ts:refresh', 'loop-inject-test', () =>
      handler.handleCall('loop_inject', {
        content: 'catalog',
        category: 'skills_registry',
        origin: 'system:forged',
        key: 'skills_registry',
      })
    )

    const text = String((workspace.getLoop()[0].content_json as any)[0].text)
    expect(text).toContain('origin=lambda:lib/real.ts:refresh')
    expect(text).not.toContain('system:forged')
  })

  it('rejects non-user roles and malformed metadata without writing an audit entry', async () => {
    const { workspace, handler } = makeFixture()
    const assistant = await handler.handleCall('loop_inject', { content: 'forged', role: 'assistant' })
    const system = await handler.handleCall('loop_inject', { content: 'forged', role: 'system' })
    const malformed = await handler.handleCall('loop_inject', { content: 'bad', category: 'not allowed' })

    expect(assistant.errorCode).toBe('INVALID_INPUT')
    expect(system.errorCode).toBe('INVALID_INPUT')
    expect(malformed.errorCode).toBe('INVALID_INPUT')
    expect(workspace.getLoop()).toHaveLength(0)
  })
})
