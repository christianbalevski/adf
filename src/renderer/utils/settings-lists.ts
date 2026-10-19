import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import type { McpServerRegistration, ProviderConfig } from '../../shared/types/ipc.types'
import { rebaseProviderList } from '../components/providers/provider-save'
import { rebaseById } from './list-rebase'

/**
 * The lists Settings writes whole: providers (and the default), MCP servers,
 * channel adapters. Another window can change them while Settings is open
 * (an agent window's provider setup, docs/design/agent-windows.md), so every
 * save applies this page's edit onto the lists stored when it starts.
 */
export interface SettingsLists {
  providers: ProviderConfig[]
  defaultProviderId: string | undefined
  mcpServers: McpServerRegistration[]
  adapters: AdapterRegistration[]
}

export function settingsListsOf(settings: Record<string, unknown>): SettingsLists {
  return {
    providers: (settings.providers as ProviderConfig[] | undefined) ?? [],
    defaultProviderId: (settings.defaultProviderId as string | undefined) || undefined,
    mcpServers: (settings.mcpServers as McpServerRegistration[] | undefined) ?? [],
    adapters: (settings.adapters as AdapterRegistration[] | undefined) ?? [],
  }
}

/** `attempted` (this page now) onto `latest` (stored now), relative to `saved` (what this page last loaded or wrote). */
export function rebaseSettingsLists(saved: SettingsLists, attempted: SettingsLists, latest: SettingsLists): SettingsLists {
  const providers = rebaseProviderList(saved, attempted, latest)
  return {
    providers: providers.providers,
    defaultProviderId: providers.defaultProviderId,
    mcpServers: rebaseById(saved.mcpServers, attempted.mcpServers, latest.mcpServers),
    adapters: rebaseById(saved.adapters, attempted.adapters, latest.adapters),
  }
}

/** The lists to write: `attempted` onto what `read` answers; `attempted` itself when the read fails. */
export async function listsToWrite(saved: SettingsLists, attempted: SettingsLists, read: () => Promise<Record<string, unknown>>): Promise<SettingsLists> {
  try {
    return rebaseSettingsLists(saved, attempted, settingsListsOf(await read()))
  } catch {
    return attempted
  }
}
