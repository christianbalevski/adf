// /channels: the selected agent's channels (Telegram, Discord, Slack, email,
// WhatsApp; "channel adapters" in the code and API). Same model as Studio's
// Settings → Channels: the channel types are app-wide (built in), while
// credentials and the switch are per agent. Credentials go to the agent's
// identity keystore (PUT /agents/:id/adapters/credentials, sealed under the
// owner identity), then the config write (POST /agents/:id/adapters) switches
// the channel on, exactly as Studio's ChannelSetupModal does. Channel fields
// and "where to get this" steps come from Studio's registry
// (shared/constants/adapter-registry.ts).

import * as registryNs from '../../../shared/constants/adapter-registry'
import type { AdapterCredentialField, AdapterRegistryEntry } from '../../../shared/constants/adapter-registry'
import type { AdapterInstanceConfig } from '../api/types'
import { cjs } from '../interop'

const { ADAPTER_REGISTRY } = cjs(registryNs)

export const CHANNELS_OVERLAY = 'channels'

/** Built-in channels, in the order the welcome names them. */
export const CHANNEL_ORDER = ['telegram', 'discord', 'slack', 'email', 'whatsapp'] as const

export interface ChannelsOverlayProps {
  agentId?: string
  /** Open this channel's setup form (add) straight away. */
  channel?: string
}

export function channelEntries(): AdapterRegistryEntry[] {
  const byType = new Map(ADAPTER_REGISTRY.map(e => [e.type, e]))
  return CHANNEL_ORDER.map(t => byType.get(t)).filter((e): e is AdapterRegistryEntry => !!e)
}

export function findChannel(type: string | undefined): AdapterRegistryEntry | undefined {
  if (!type) return undefined
  const wanted = type.trim().toLowerCase()
  return channelEntries().find(e => e.type === wanted || e.displayName.toLowerCase() === wanted)
}

/** Credential fields in display order (registry labels + hints; bare keys for unknown ones). */
export function credentialFields(entry: AdapterRegistryEntry): AdapterCredentialField[] {
  return entry.credentials ?? [
    ...entry.requiredEnvKeys.map(key => ({ key, label: key, required: true })),
    ...(entry.optionalEnvKeys ?? []).map(key => ({ key, label: key, required: false })),
  ]
}

/** What Studio writes when a channel is switched on for an agent. */
export const DEFAULT_ADAPTER_CONFIG: AdapterInstanceConfig = { enabled: true, policy: { dm: 'all', groups: 'mention' } }

/** Obvious-mistake checks per credential (the adapter itself is the real test). */
const SHAPES: Record<string, { test: RegExp; message: string }> = {
  TELEGRAM_BOT_TOKEN: { test: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, message: 'A bot token looks like 123456789:AA… (digits, a colon, then 30+ characters).' },
  DISCORD_BOT_TOKEN: { test: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/, message: 'A Discord bot token has three dot-separated parts (Bot page → Reset Token).' },
  DISCORD_APPLICATION_ID: { test: /^\d{15,22}$/, message: 'The application ID is a long number (General Information page).' },
  SLACK_APP_TOKEN: { test: /^xapp-/, message: 'The app-level token starts with xapp- (Socket Mode page).' },
  SLACK_BOT_TOKEN: { test: /^xoxb-/, message: 'The bot token starts with xoxb- (Install App page).' },
  EMAIL_USERNAME: { test: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter the full email address.' },
}

/** field key → problem, for the values the user typed. Empty = fine. */
export function validateCredentials(entry: AdapterRegistryEntry, values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of credentialFields(entry)) {
    const value = (values[field.key] ?? '').trim()
    if (!value) {
      if (field.required) errors[field.key] = `${field.label} is required.`
      continue
    }
    if (/\s/.test(value)) { errors[field.key] = 'No spaces: paste the value exactly.'; continue }
    const shape = SHAPES[field.key]
    if (shape && !shape.test.test(value)) errors[field.key] = shape.message
  }
  return errors
}

/** One line: where to get the first required credential (the registry's first setup step). */
export function whereToGetIt(entry: AdapterRegistryEntry): string {
  const step = entry.setupSteps?.[0]
  if (!step) return entry.description
  return step.url ? `${step.text} (${step.url})` : step.text
}

export interface AdapterLiveState {
  status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'not running' | 'unknown'
  error?: string
}

/** A channel's live state from GET /agents/:id/runtime/adapters. */
export function adapterLiveState(diag: { configured?: Array<{ type: string; enabled?: boolean }>; states?: Array<{ type: string; status: string; error?: string }> } | null | undefined, type: string): AdapterLiveState {
  const state = diag?.states?.find(s => s.type === type)
  if (state) {
    const status = ['connected', 'connecting', 'disconnected', 'error'].includes(state.status) ? state.status as AdapterLiveState['status'] : 'unknown'
    return { status, ...(state.error ? { error: state.error } : {}) }
  }
  return { status: diag?.configured?.some(c => c.type === type) ? 'not running' : 'unknown' }
}

/** Channel types configured on an agent config. */
export function configuredChannels(config: { adapters?: Record<string, unknown> } | undefined): string[] {
  return Object.keys(config?.adapters ?? {})
}
