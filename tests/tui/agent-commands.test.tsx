import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/main/tui/app/App'
import { createTheme, ThemeContext } from '../../src/main/tui/app/theme'
import { slashEnterAction } from '../../src/main/tui/app/Prompt'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { transcriptKey, type ContextItem } from '../../src/main/tui/state/types'
import { historyToItems, mergeHistory, prependHistory } from '../../src/main/tui/state/transcript'
import { clientFrameEffects } from '../../src/main/tui/state/client-stream'
import { collectCommands, completeSlash, createScope, runSlash } from '../../src/main/tui/commands/registry'
import { withAgentCommands, validAgentCommands, isAuthorizedCommandInput } from '../../src/main/tui/commands/agent-commands'
import { BUILTIN_COMMANDS } from '../../src/main/tui/commands/builtin/index'
import { VIEWS } from '../../src/main/tui/views/registry'
import { buildEntries } from '../../src/main/tui/app/palette/entries'
import { TranscriptItemView } from '../../src/main/tui/views/chat/Transcript'
import { itemHeight } from '../../src/main/tui/views/chat/model'
import { formatOwnerCommandRow, type OwnerCommandHeader } from '../../src/shared/utils/owner-command-row'
import type { OwnerCommandBody, OwnerCommandResult } from '../../src/shared/types/owner-command.types'
import type { ClientFrame } from '../../src/main/tui/api/types'
import type { AgentCommand } from '../../src/shared/types/adf-v02.types'
import { AGENT_1_ID as A, AGENT_2_ID as B, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'
import { renderTui, type RenderedTui } from './fixtures/render'

const declarations: AgentCommand[] = [
  { name: 'weather', description: 'Forecast by city', usage: '<city>,<days>', lambda: 'lib/commands.ts:weather', locked: true },
  { name: 'status', description: 'Agent status lambda', lambda: 'lib/commands.ts:status' },
  { name: 'cfg', description: 'Update config', lambda: 'lib/commands.ts:cfg' },
]
const base = collectCommands(VIEWS, [BUILTIN_COMMANDS])
let mock: MockDaemon | undefined
let other: MockDaemon | undefined
let store: TuiStore | undefined
let ui: RenderedTui | undefined

afterEach(async () => {
  ui?.unmount(); ui = undefined
  await store?.stop(); store = undefined
  await mock?.close(); mock = undefined
  await other?.close(); other = undefined
})

async function setup(options: { live?: boolean; delay?: Promise<void>; deferred?: boolean } = {}) {
  mock = await startMockDaemon({ stepMs: 5 })
  const daemon = mock
  const commands: Record<string, AgentCommand[]> = { [A]: declarations, [B]: [{ name: 'second', description: 'Other agent', lambda: 'second.ts:run' }] }
  const calls: Array<{ agentId: string; name: string; body: OwnerCommandBody }> = []
  const records: Array<{ header: OwnerCommandHeader; body: string; loop: string; agentId: string }> = []
  const persist = (record: typeof records[number]) => {
    const rows = daemon.agents.get(record.agentId)!.history[record.loop] ??= []
    const seq = (rows.at(-1)?.seq ?? 0) + 1
    rows.push({ seq, role: 'user', content_json: [{ type: 'text', text: formatOwnerCommandRow(record.header, record.body) }], created_at: Date.now() })
    daemon.emit({ event_type: 'context.injected', agent_id: record.agentId, loop: record.loop, payload: { category: 'owner_command' } })
    return seq
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const route = url.pathname.match(/^\/agents\/([^/]+)\/commands\/([^/]+)\/run$/)
    if (route) {
      const agentId = route[1], name = decodeURIComponent(route[2])
      const body = JSON.parse(String(init?.body)) as OwnerCommandBody
      calls.push({ agentId, name, body })
      await options.delay
      if (daemon.agents.get(agentId)?.state === 'stopped') return Response.json({ code: 'agent_not_running', error: 'Agent is off. Start it first.' }, { status: 409 })
      const command = commands[agentId]?.find(c => c.name === name)
      if (!command) return Response.json({ code: 'command_not_found', error: `No command /${name}` }, { status: 404 })
      const status = name === 'cfg' && !body.authorize ? 'denied' : 'ok'
      const record = { agentId, loop: body.loop ?? 'main', header: { v: 1 as const, id: body.requestId!, command: `/${name}${body.args ? ` ${body.args}` : ''}`, lambda: command.lambda, authorized: body.authorize, status, duration_ms: 5 } as OwnerCommandHeader, body: status === 'denied' ? 'Restricted call refused' : `result: ${body.args}` }
      records.push(record)
      const seq = options.deferred ? undefined : persist(record)
      return Response.json({ id: body.requestId, name, loop: record.loop, authorized: body.authorize, status, result: record.body, durationMs: 5, deferred: !!options.deferred, seq } satisfies OwnerCommandResult)
    }
    const result = await fetch(input, init)
    const config = url.pathname.match(/^\/agents\/([^/]+)\/config$/)
    if (config && (!init?.method || init.method === 'GET') && result.ok) {
      const data = await result.json()
      return Response.json({ ...data, config: { ...data.config, commands: commands[config[1]] } })
    }
    return result
  }
  store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: fetcher }), live: options.live ?? false, initialView: 'chat' })
  await store.start()
  store.actions.selectAgent(A)
  store.actions.selectLoop(A, 'researcher')
  await store.actions.ensureTranscript(A, 'researcher')
  const registry = () => withAgentCommands(base, store!.getState().agents[store!.getState().selectedAgentId!]?.config?.commands)
  const items = (id = A, loop = 'researcher') => store!.getState().transcripts[transcriptKey(id, loop)]?.items.filter((item): item is ContextItem => item.kind === 'context' && !!item.ownerCommand) ?? []
  return { commands, calls, records, persist, registry, items, store }
}

it('uses normal completion and palette entries; TUI names and aliases win', async () => {
  const f = await setup()
  const registry = f.registry()
  expect(registry.find('status')).toBe(base.find('status'))
  expect(withAgentCommands(base, [{ ...declarations[0], name: 'abort' }]).find('abort')).toBe(base.find('abort'))
  expect(completeSlash('/wea', registry, createScope(f.store, () => {}))[0]).toMatchObject({ value: '/weather', command: { args: '<city>,<days>', description: 'Forecast by city [locked]' } })
  expect(buildEntries({ store: f.store, registry, views: VIEWS, exit() {} }).find(e => e.id === 'cmd:weather')?.title).toBe('/weather <city>,<days>')
  expect(validAgentCommands([null, {}, { ...declarations[0], name: 'bad name' }])).toEqual([])
  expect(withAgentCommands(base, [{ ...declarations[0], description: 'Safe\u001b[31m\ntext' }]).find('weather')?.description).not.toContain('\u001b')
  const command = registry.find('weather')!
  expect(slashEnterAction('/weather', command)).toEqual({ insert: '/weather ' })
  expect(slashEnterAction('/weather !authorize', command)).toEqual({ insert: '/weather !authorize ' })
  expect(slashEnterAction('/weather Berlin,3', command)).toEqual({ run: '/weather Berlin,3' })
  expect(isAuthorizedCommandInput('/weather Berlin !authorize', registry)).toBe(true)
  expect(isAuthorizedCommandInput('/command status !authorize', registry)).toBe(true)
  expect(isAuthorizedCommandInput('/status !authorize', registry)).toBe(false)
  expect(isAuthorizedCommandInput('/weather \\!authorize', registry)).toBe(false)
})

it('runs direct and colliding names in the selected loop without chatting or starting an agent', async () => {
  const f = await setup()
  await runSlash('/weather Berlin,3 !authorize', f.registry(), f.store, () => {})
  await runSlash('/command status hello \\!authorize', f.registry(), f.store, () => {})
  expect(f.calls.map(call => [call.name, call.body.args, call.body.authorize, call.body.loop])).toEqual([
    ['weather', 'Berlin,3', true, 'researcher'], ['status', 'hello !authorize', false, 'researcher'],
  ])
  expect(f.calls[0].body.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  expect(mock!.requests.some(r => r.startsWith('POST') && /\/(chat|start)$/.test(r))).toBe(false)
  expect(f.items()).toHaveLength(2)
  await f.store.actions.loadTranscript(A, 'researcher')
  expect(f.items()).toHaveLength(2)
  expect(f.items()[0].ownerCommand).toMatchObject({ command: '/weather Berlin,3', authorized: true, status: 'ok' })
})

it('reports refusal, rejects multiline input, and records denied outcomes', async () => {
  const f = await setup()
  await runSlash('/weather\nBerlin', f.registry(), f.store, () => {})
  expect(f.calls).toHaveLength(0)
  await runSlash('/command nope', f.registry(), f.store, () => {})
  expect(f.items()).toEqual([])
  expect(f.store.getState().toasts.at(-1)?.text).toContain('No command /nope')
  await runSlash('/cfg', f.registry(), f.store, () => {})
  expect(f.items()[0]).toMatchObject({ text: 'Restricted call refused', ownerCommand: { status: 'denied' } })
  mock!.agents.get(A)!.state = 'stopped'
  await runSlash('/weather Berlin', f.registry(), f.store, () => {})
  expect(f.items()).toHaveLength(1)
  expect(f.store.getState().toasts.at(-1)?.text).toContain('Agent is off')
})

it('keeps in-flight outcomes on their original agent and loop, with event-before-response deduplication', async () => {
  let release!: () => void
  const f = await setup({ deferred: true, delay: new Promise<void>(resolve => { release = resolve }) })
  const running = runSlash('/weather Berlin', f.registry(), f.store, () => {})
  expect(f.items()[0].ownerCommand?.status).toBe('running')
  const item = f.items()[0]
  const header = { ...item.ownerCommand!, status: 'ok' as const }
  const effects = clientFrameEffects({ kind: 'executor', cursor: 1, agentId: A, filePath: null, loop: 'researcher', event: { type: 'context_injected', timestamp: 5, payload: { category: 'owner_command', seq: 999, content: formatOwnerCommandRow(header, 'event result') } } } as ClientFrame)
  f.store.dispatch({ type: 'transcript/owner-command', key: transcriptKey(A, 'researcher'), item: effects.ownerCommand!.item })
  f.store.actions.selectAgent(B)
  release(); await running
  expect(f.items()).toHaveLength(1)
  expect(f.items()[0].text).toBe('event result')
  expect(f.items(B, 'main')).toEqual([])
})

it('keeps deferred results through unrelated history refreshes and settles from legacy live provenance', async () => {
  const f = await setup({ live: true, deferred: true })
  await runSlash('/weather Berlin', f.registry(), f.store, () => {})
  await f.store.actions.loadTranscript(A, 'researcher')
  expect(f.items()[0]).toMatchObject({ deferred: true, ownerCommand: { status: 'ok' } })
  f.persist(f.records[0])
  await vi.waitFor(() => expect(f.items()[0].seq).toBeTypeOf('number'))
  expect(f.items()).toHaveLength(1)
  expect(f.items()[0].deferred).toBeUndefined()
})

it('discards late responses after changing daemons', async () => {
  let release!: () => void
  const f = await setup({ delay: new Promise<void>(resolve => { release = resolve }) })
  const running = runSlash('/weather Berlin', f.registry(), f.store, () => {})
  other = await startMockDaemon()
  await f.store.actions.setDaemonUrl(other.url)
  release(); await running
  expect(f.items()).toEqual([])
  expect(f.store.getState().toasts.some(toast => toast.text.includes('/weather'))).toBe(false)
})

it('updates completion when the selected agent or config changes and shows authorization before Enter', async () => {
  const f = await setup()
  ui = renderTui(<App store={f.store} theme={createTheme({ mono: true, ascii: true })} />, { columns: 110, rows: 36 })
  f.store.actions.prefillPrompt('/wea')
  await ui.waitFor('Forecast by city')
  f.commands[A] = [{ ...declarations[0], name: 'forecast', description: 'Updated forecast' }]
  await f.store.actions.loadConfig(A)
  f.store.actions.prefillPrompt('/fore')
  await ui.waitFor('Updated forecast')
  f.store.actions.prefillPrompt('/forecast Berlin,3 !authorize')
  await ui.waitFor('Authorized run')
  await ui.press('\r')
  await ui.waitFor('You ran /forecast Berlin,3')
  expect(f.calls.at(-1)?.body).toMatchObject({ args: 'Berlin,3', authorize: true, loop: 'researcher' })
  f.store.actions.selectAgent(B)
  f.store.actions.prefillPrompt('/sec')
  await ui.waitFor('Other agent')
  expect(f.registry().find('forecast')).toBeUndefined()
})

it.each([false, true])('renders expandable result rows in mono (ASCII %s), with matching measured height', async ascii => {
  const header: OwnerCommandHeader = { v: 1, id: 'cmd_test', command: '/cfg', lambda: 'lib/commands.ts:cfg', authorized: false, status: 'denied', duration_ms: 2 }
  const rows = [{ seq: 1, role: 'user' as const, content_json: [{ type: 'text' as const, text: formatOwnerCommandRow(header, 'Restricted call refused') }], created_at: 1 }]
  const item = historyToItems(rows)[0] as ContextItem
  const pending = { ...item, local: true, seq: undefined, ownerCommand: { ...header, status: 'running' as const } }
  expect(mergeHistory([pending], [item])).toEqual([item])
  expect(prependHistory([pending], [item])).toEqual([item])
  ui = renderTui(<ThemeContext.Provider value={createTheme({ mono: true, ascii })}><TranscriptItemView item={item} width={90} expanded selected={false} showThinking={false} queued={false} /></ThemeContext.Provider>, { columns: 90, rows: 16 })
  const frame = await ui.waitFor('Restricted call refused')
  expect(frame).toContain('You ran /cfg [permission denied]')
  expect(frame).toContain('Add !authorize')
  expect(itemHeight(item, 90, { expanded: true, showThinking: false })).toBeGreaterThan(3)
})
