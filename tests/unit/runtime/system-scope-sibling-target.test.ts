/**
 * Agent wake lost behind a same-tick system-scope sibling (aom 2026-09-04).
 *
 * aom's on_inbox lists a system-scope lambda target BEFORE the agent-scope
 * target. The evaluator emits one dispatch per target in config order, in one
 * tick. The concurrent-turn guard (0953ee3) read activeTurnCount, which the
 * system-scope dispatch had already claimed while its lambda ran, so the
 * agent's own wake was queued as "another turn active" — and the system-scope
 * path returns before the finally-block drain, so nothing ever ran it. The
 * message sat unread until an unrelated agent turn drained the queue. Same
 * mechanism swallowed the default startup turn behind the on_startup lambda.
 *
 * Agents whose agent target comes first (mik, coo2) never hit it: order is the
 * whole bug.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import type { SystemScopeHandler } from '../../../src/main/runtime/system-scope-handler'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out')
    await sleep(10)
  }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-sysscope-sibling-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

/** A lambda handler that is still running when the sibling dispatch arrives. */
function slowHandler(delayMs: number) {
  const calls = { execute: 0 }
  const handler = {
    execute: async () => { calls.execute++; await sleep(delayMs); return undefined },
    executeBatch: async () => undefined,
  } as unknown as SystemScopeHandler
  return { handler, calls }
}

function inboxEvent(id: string) {
  return createEvent({
    type: 'inbox',
    source: 'adapter:telegram',
    data: {
      message: {
        id, from: 'telegram:1', content: `msg ${id}`, source: 'telegram',
        received_at: Date.now(), status: 'unread' as const,
      },
    },
  })
}

function loopTexts(workspace: AdfWorkspace): string[] {
  return workspace.getLoop().map(e => JSON.stringify(e.content_json))
}

async function buildAgent(name: string) {
  const { filePath, workspace } = makeWorkspace(name)
  const agent = await new AgentRuntimeBuilder().build({
    workspace,
    filePath,
    config: workspace.getAgentConfig(),
    provider: new MockLLMProvider(),
  })
  return { agent, workspace }
}

describe('AgentExecutor — system-scope sibling target before the agent target', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('on_inbox: agent wake runs even though the lambda target dispatched first', async () => {
    const { agent, workspace } = await buildAgent('inbox')
    const { handler, calls } = slowHandler(80)
    agent.executor.setSystemScopeHandler(handler)
    try {
      workspace.addToInbox({ from: 'telegram:1', content: 'hello', source: 'telegram', received_at: Date.now(), status: 'unread' })

      // Exactly what TriggerEvaluator.evaluateTargets emits for aom's config:
      // targets[0] = system lambda, targets[1] = agent, same event, same tick.
      const event = inboxEvent('a')
      await Promise.all([
        agent.executor.executeTurn(createDispatch(event, { scope: 'system', lambda: 'lib/command-handler.js:onInbox' })),
        agent.executor.executeTurn(createDispatch(event, { scope: 'agent' })),
      ])
      await waitFor(() => !agent.executor.isTurnActive())

      expect(calls.execute).toBe(1)
      // The agent turn ran: its trigger row is on the loop, not stuck in
      // pendingTriggers waiting for some unrelated turn.
      expect(loopTexts(workspace).some(t => t.includes('[Inbox notification]'))).toBe(true)
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('on_startup: the default startup turn runs behind an on_startup lambda', async () => {
    const { agent, workspace } = await buildAgent('startup')
    const { handler, calls } = slowHandler(80)
    agent.executor.setSystemScopeHandler(handler)
    try {
      const startup = () => createEvent({ type: 'startup', source: 'system', data: undefined })
      await Promise.all([
        agent.executor.executeTurn(createDispatch(startup(), { scope: 'system', lambda: 'lib/skill-indexer.ts:refresh' })),
        agent.executor.executeTurn(createDispatch(startup(), { scope: 'agent' })),
      ])
      await waitFor(() => !agent.executor.isTurnActive())

      expect(calls.execute).toBe(1)
      expect(loopTexts(workspace).some(t => t.includes('Agent started.'))).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('two agent-scope dispatches in one tick still serialize (0953ee3 guard intact)', async () => {
    const { filePath, workspace } = makeWorkspace('serialize')
    const agent = await new AgentRuntimeBuilder().build({
      workspace,
      filePath,
      config: workspace.getAgentConfig(),
      provider: new MockLLMProvider({ latencyMs: 100 }),
    })
    try {
      // The mock never reads the message, so the queued sibling is not
      // dropped as stale when it drains.
      workspace.addToInbox({ from: 'telegram:1', content: 'hello', source: 'telegram', received_at: Date.now(), status: 'unread' })
      await Promise.all([
        agent.executor.executeTurn(createDispatch(inboxEvent('a'), { scope: 'agent' })),
        agent.executor.executeTurn(createDispatch(inboxEvent('b'), { scope: 'agent' })),
      ])
      // Both promises settled: the first ran, the second was queued (its
      // promise resolves on enqueue) and has just claimed its re-entrant slot.
      const notifications = () => loopTexts(workspace).filter(t => t.includes('[Inbox notification]')).length
      expect(notifications()).toBe(1)
      expect(agent.executor.isTurnActive()).toBe(true)
      await waitFor(() => !agent.executor.isTurnActive())
      expect(notifications()).toBe(2)
    } finally {
      await agent.disposeAsync()
    }
  })
})
