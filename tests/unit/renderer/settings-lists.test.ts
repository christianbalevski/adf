/**
 * Settings lists written whole from more than one window (agent windows,
 * docs/design/agent-windows.md): providers, MCP servers and channel
 * adapters. A save applies this window's edit onto the lists stored when it
 * starts, so a change another window made is never undone.
 */
import { describe, expect, it } from 'vitest'
import { listsToWrite, rebaseSettingsLists, type SettingsLists } from '../../../src/renderer/utils/settings-lists'
import { rebaseProviderList } from '../../../src/renderer/components/providers/provider-save'
import type { ProviderConfig, McpServerRegistration } from '../../../src/shared/types/ipc.types'
import type { AdapterRegistration } from '../../../src/shared/types/channel-adapter.types'

const provider = (id: string, name = id): ProviderConfig => ({ id, type: 'openai-compatible', name, baseUrl: 'https://llm.example.com/v1', apiKey: '' }) as ProviderConfig
const server = (id: string): McpServerRegistration => ({ id, name: id }) as McpServerRegistration
const adapter = (id: string): AdapterRegistration => ({ id, type: id }) as AdapterRegistration
const lists = (over: Partial<SettingsLists> = {}): SettingsLists => ({ providers: [provider('p1')], defaultProviderId: 'p1', mcpServers: [server('m1')], adapters: [adapter('a1')], ...over })

describe('Settings open in the main window while an agent window changes the lists', () => {
  it('closing Settings with no edit keeps a provider, server and adapter the agent window added', async () => {
    const opened = lists()
    const stored = lists({ providers: [provider('p1'), provider('q')], mcpServers: [server('m1'), server('m2')], adapters: [adapter('a1'), adapter('a2')] })
    const written = await listsToWrite(opened, opened, async () => ({ ...stored }))
    expect(written).toEqual(stored)
  })

  it('does not bring back one the agent window removed', async () => {
    const opened = lists({ providers: [provider('p1'), provider('r')], mcpServers: [server('m1'), server('m9')] })
    const stored = lists()
    expect(await listsToWrite(opened, opened, async () => ({ ...stored }))).toEqual(stored)
  })

  it('applies this window\'s own add, change and removal on top', async () => {
    const opened = lists({ providers: [provider('p1'), provider('p2')] })
    const shown = lists({ providers: [provider('p1', 'renamed'), provider('n')], mcpServers: [] })
    const stored = lists({ providers: [provider('p1'), provider('p2'), provider('q')] })
    expect(await listsToWrite(opened, shown, async () => ({ ...stored }))).toEqual(
      lists({ providers: [provider('p1', 'renamed'), provider('q'), provider('n')], mcpServers: [] }))
  })

  it('a provider just added through the picker (written at once) survives the page\'s debounced save', () => {
    // The picker wrote [p1, q (the agent window's), n]; the page still had [p1] as its last save.
    const stored = lists({ providers: [provider('p1'), provider('q'), provider('n')] })
    const shown = lists({ providers: [provider('p1'), provider('n')] })
    expect(rebaseSettingsLists(lists(), shown, stored).providers.map((p) => p.id)).toEqual(['p1', 'q', 'n'])
  })

  it('a failed read writes this window\'s lists as they are', async () => {
    const shown = lists({ providers: [provider('p1'), provider('n')] })
    expect(await listsToWrite(lists(), shown, async () => { throw new Error('daemon away') })).toEqual(shown)
  })
})

describe('the providers shown after a save', () => {
  it('are what was written, with an edit made while the save was in flight on top', () => {
    const attempted = { providers: [provider('p1')], defaultProviderId: 'p1' }
    // The agent window's q came with the write; the owner added n meanwhile.
    const written = { providers: [provider('p1'), provider('q')], defaultProviderId: 'p1' }
    const shownNow = { providers: [provider('p1'), provider('n')], defaultProviderId: 'p1' }
    expect(rebaseProviderList(attempted, shownNow, written).providers.map((p) => p.id)).toEqual(['p1', 'q', 'n'])
    // The next save, from the written list, keeps q and adds n.
    const next = rebaseProviderList(written, rebaseProviderList(attempted, shownNow, written), written)
    expect(next.providers.map((p) => p.id)).toEqual(['p1', 'q', 'n'])
  })
})
