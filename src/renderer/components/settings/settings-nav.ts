/**
 * The Settings sidebar (docs/design/settings-scopes.md §4): two groups.
 * **Studio** is this app on this computer (client keys,
 * client-settings-keys.ts); the second group is the runtime this window uses
 * (backend keys). It is headed **Runtime · <name>** only once a runtime on
 * another computer is saved; until then it has no heading, so Settings reads
 * as plain ADF Studio. Labels are plain nouns; each page has at most one
 * short sentence under its title.
 */
import type { SettingsSection } from '../../stores/app.store'
import { DOCS } from '../../../shared/constants/docs-links'

/** The pages (settings-scopes.md §4); `general` and `backend` are older ids that still open their new page. */
export type SettingsTab = Exclude<SettingsSection, 'general' | 'backend'>

export type SettingsNavItem = {
  id: SettingsTab
  label: string
  description: string
  keywords: string
  /** Guide for this tab — rendered as a "Docs" link beside the page title. */
  docs: string
}

export type SettingsNavGroup = {
  /** `studio`: this app on this computer; `runtime`: the runtime this window uses. */
  scope: 'studio' | 'runtime'
  label: string
  items: SettingsNavItem[]
}

/** Studio: the app on this computer. Client keys only (client-settings-keys.ts). */
export const STUDIO_NAV_ITEMS: SettingsNavItem[] = [
  { id: 'appearance', label: 'Appearance', description: 'Theme, avatars, chat width, font and scale.', keywords: 'theme dark light font scale avatars chat width', docs: DOCS.settingsGeneral },
  { id: 'notifications', label: 'Notifications', description: 'System notifications and the menu bar icon.', keywords: 'notifications menu bar badge', docs: DOCS.settingsGeneral },
  { id: 'updates', label: 'Updates', description: 'Version and update checks.', keywords: 'update version release check', docs: DOCS.settingsGeneral },
  { id: 'privacy', label: 'Privacy', description: 'Studio sends no telemetry.', keywords: 'privacy telemetry network spell check dictionaries', docs: DOCS.settingsGeneral },
  { id: 'about', label: 'About', description: 'Concepts and links.', keywords: 'help docs github format', docs: DOCS.index },
  { id: 'connection', label: 'Connections', description: 'Runtimes on other computers.', keywords: 'backend daemon embedded local remote server url token pair add connection connections this computer runtime', docs: DOCS.backendConnection },
]

/** Runtime: the connected daemon's settings (backend keys). */
export const RUNTIME_NAV_ITEMS: SettingsNavItem[] = [
  { id: 'agents', label: 'Prompts', description: 'Agents read these when they start.', keywords: 'prompts instructions system prompt tool prompts compaction defaults', docs: DOCS.settingsSystemPrompt },
  { id: 'template', label: 'Agent templates', description: 'What new agents start from.', keywords: 'defaults template templates model tools limits new agent files readme mind sandboxed full access', docs: DOCS.agentTemplates },
  { id: 'providers', label: 'Providers', description: 'Models, keys, and subscriptions', keywords: 'anthropic claude claude code openai chatgpt grok xai openrouter gemini groq ollama lm studio local models api keys provider checks', docs: DOCS.settingsProviders },
  { id: 'packages', label: 'Packages', description: 'Shared JavaScript packages', keywords: 'npm sandbox dependencies', docs: DOCS.settingsPackages },
  { id: 'mcps', label: 'MCP servers', description: 'External tools and services', keywords: 'model context protocol integrations tools live catalogs registry', docs: DOCS.settingsMcp },
  { id: 'skills', label: 'Skills', description: 'Catalogs the skill browser reads', keywords: 'catalog registry sources install browse', docs: DOCS.settingsSkills },
  { id: 'channels', label: 'Channels', description: 'Telegram, Discord, Slack, email, WhatsApp', keywords: 'adapters messages integrations bot token', docs: DOCS.settingsChannels },
  { id: 'files', label: 'Files', description: 'Where agents you claim are saved.', keywords: 'agents folder directory files', docs: DOCS.settingsGeneral },
  { id: 'identity', label: 'Identity', description: 'Owner and runtime identity', keywords: 'did mnemonic alias delegation seed phrase owner', docs: DOCS.settingsIdentity },
  { id: 'networking', label: 'Networking', description: 'Mesh and remote access', keywords: 'lan tailscale mdns peers server remote access devices pair add device allowed networks', docs: DOCS.settingsNetworking },
  { id: 'compute', label: 'Compute', description: 'Containers and host access', keywords: 'podman machine resources isolation', docs: DOCS.settingsCompute },
  { id: 'usage', label: 'Usage', description: 'Token totals by day, provider and model.', keywords: 'tokens usage cost burn', docs: DOCS.settingsUsage },
]

/**
 * The sidebar: Studio, then the runtime's pages (settings-scopes.md §4),
 * unheaded. With more than one runtime the Runtime picker heads them
 * (multi-runtime.md §6.3).
 */
export function settingsNavGroups(): SettingsNavGroup[] {
  return [
    { scope: 'studio', label: 'Studio', items: STUDIO_NAV_ITEMS },
    { scope: 'runtime', label: '', items: RUNTIME_NAV_ITEMS },
  ]
}

/** An older id, and the Usage anchor of General, opens its new page. */
export function settingsTabFor(section: SettingsSection, anchor?: string | null): SettingsTab {
  if (section === 'backend') return 'connection'
  if (section === 'general') return anchor === 'usage' ? 'usage' : 'appearance'
  return section
}
