import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectLoopSlice, type AgentLogEntry } from '../../../src/renderer/stores/agent.store'
import { parseAuthorizeToken, RESERVED_COMMAND_NAMES } from '../../../src/shared/utils/agent-commands'
import { BUILTIN_COMMANDS } from '../../../src/renderer/utils/slash-commands'

const row = (id: string, seq?: number): AgentLogEntry => ({ id: Math.random().toString(), type: 'context', content: '', timestamp: 1,
  metadata: { category: 'owner_command', ownerCommand: { id, command: '/weather', status: 'running' }, ...(seq === undefined ? {} : { seq }) } })

describe('owner command pending entries', () => {
  beforeEach(() => useAgentStore.getState().clearLog())
  it('settles only a matching pending entry and preserves durable entries', () => {
    const store = useAgentStore.getState()
    const durable = row('one', 5)
    const unrelated = row('two')
    store.addLogEntry(row('one'))
    store.addLogEntry(durable)
    store.addLogEntry(unrelated)
    const result = row('one', 7)
    store.settleOwnerCommand(result)
    expect(useAgentStore.getState().log).toEqual([durable, unrelated, result])
  })
  it('removes refused pending entries only from the addressed loop', () => {
    const store = useAgentStore.getState()
    store.addLogEntry(row('one'))
    store.addLogEntry(row('one'), 'work')
    store.removePendingOwnerCommand('one', 'work')
    expect(selectLoopSlice(useAgentStore.getState(), 'work').log).toEqual([])
    expect(useAgentStore.getState().log).toHaveLength(1)
  })
})

describe('composer authorization input', () => {
  it.each(['!authorize Berlin', 'Berlin !authorize', 'Berlin !authorize now !authorize'])('strips standalone tokens: %s', (args) => {
    const parsed = parseAuthorizeToken(args)
    expect(parsed.authorize).toBe(true)
    expect(parsed.args).not.toContain('!authorize')
  })
  it('keeps escaped and partial tokens literal', () => {
    expect(parseAuthorizeToken('\\!authorize !authorized x!authorize')).toEqual({ args: '!authorize !authorized x!authorize', authorize: false })
  })
  it('pins built-ins to the shared reserved names', () => {
    for (const command of BUILTIN_COMMANDS) expect(RESERVED_COMMAND_NAMES).toContain(command.key)
  })
})

import { vi } from 'vitest'
import { submitOwnerCommand } from '../../../src/renderer/utils/owner-command-submit'

describe('composer owner command submission', () => {
  beforeEach(() => useAgentStore.getState().clearLog())
  it('sends the cleaned arguments, owner grant, captured path and selected loop', async () => {
    const run = vi.fn(async (request) => {
      expect(useAgentStore.getState().log[0]?.metadata?.ownerCommand).toMatchObject({ status: 'running', authorized: true })
      return { success: true as const, id: request.requestId, name: request.name, loop: request.loop, status: 'ok' as const, authorized: true, result: 'done', durationMs: 1, deferred: true }
    })
    await submitOwnerCommand({ filePath: '/agents/a.adf', loop: 'main', name: 'cmd', args: 'Berlin !authorize', run, say: vi.fn() })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/agents/a.adf', loop: 'main', name: 'cmd', args: 'Berlin', authorize: true, requestId: expect.any(String) }))
    expect(useAgentStore.getState().log[0]).toMatchObject({ content: 'done', metadata: { deferred: true, ownerCommand: { status: 'ok' } } })
  })
  it('removes a refused pending card and says the runtime error', async () => {
    const say = vi.fn()
    await submitOwnerCommand({ loop: 'main', name: 'cmd', args: '', run: vi.fn(async () => ({ success: false as const, error: 'Agent is off.' })), say })
    expect(useAgentStore.getState().log).toEqual([])
    expect(say).toHaveBeenCalledWith('/cmd — Agent is off.')
  })
  it('preserves a durable event that arrives before the response', async () => {
    const run = vi.fn(async (request) => {
      useAgentStore.getState().settleOwnerCommand(row(request.requestId!, 8))
      return { success: true as const, id: request.requestId!, name: 'cmd', loop: 'main', status: 'denied' as const, authorized: false, result: 'denied', durationMs: 1, deferred: true }
    })
    await submitOwnerCommand({ loop: 'main', name: 'cmd', args: '', run, say: vi.fn() })
    expect(useAgentStore.getState().log).toHaveLength(1)
    expect(useAgentStore.getState().log[0].metadata?.seq).toBe(8)
    expect(useAgentStore.getState().log[0].metadata?.deferred).toBeUndefined()
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OwnerCommandRow } from '../../../src/renderer/components/agent/OwnerCommandRow'

it('renders the owner result card and a UI-only permission hint', () => {
  const entry = row('one', 8)
  entry.content = 'Restricted tool refused'
  entry.metadata!.ownerCommand = { v: 1, id: 'one', command: '/cmd Berlin', lambda: 'lib/a.ts:run', authorized: true, status: 'denied', duration_ms: 1 }
  const html = renderToStaticMarkup(createElement(OwnerCommandRow, { entry }))
  expect(html).toContain('You ran /cmd Berlin')
  expect(html).toContain('permission denied')
  expect(html).toContain('authorized')
  expect(html).toContain('Run again with !authorize')
  expect(html).toContain('Restricted tool refused')
  expect(entry.content).not.toContain('Run again')
})

import { useDocumentStore } from '../../../src/renderer/stores/document.store'

it('does not publish a late refusal into another document after navigation', async () => {
  useAgentStore.getState().clearLog()
  const say = vi.fn()
  const run = vi.fn(async () => {
    useDocumentStore.getState().setFilePath('/agents/other.adf')
    useAgentStore.getState().clearLog()
    return { success: false as const, error: 'Old agent is off.' }
  })
  await submitOwnerCommand({ loop: 'main', name: 'cmd', args: '', run, say })
  expect(say).not.toHaveBeenCalled()
  expect(useAgentStore.getState().log).toEqual([])
})

it('settles the local outcome when teardown prevents recording', async () => {
  useAgentStore.getState().clearLog()
  const run = vi.fn(async () => ({ success: true as const, id: 'one', name: 'cmd', loop: 'main', status: 'ok' as const, authorized: false, result: 'finished', durationMs: 1, deferred: false }))
  await submitOwnerCommand({ loop: 'main', name: 'cmd', args: '', run, say: vi.fn() })
  const entry = useAgentStore.getState().log[0]
  expect(entry).toMatchObject({ content: 'finished', metadata: { unrecorded: true, deferred: false, ownerCommand: { status: 'ok' } } })
  expect(renderToStaticMarkup(createElement(OwnerCommandRow, { entry }))).toContain('Agent stopped before this result could be recorded.')
})
