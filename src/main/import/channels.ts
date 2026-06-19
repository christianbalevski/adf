import type { AdaptersConfig, AdapterPolicy } from '../../shared/types/channel-adapter.types'
import { asString, get, type YamlValue } from './yaml-lite'

/** A channel pulled from a source config, before mapping to an ADF adapter. */
export interface SourceChannel {
  /** Raw source channel/platform name (e.g. "telegram", "imap"). */
  type: string
  /** Sender IDs the source restricted the channel to, if any. */
  allowFrom?: string[]
}

export interface ChannelMapping {
  adapters: AdaptersConfig
  /** Union of every channel's allowlist, for messaging.allow_list. */
  allowList: string[]
  warnings: string[]
}

/** Source channel names → ADF built-in adapter types. */
const KNOWN: Record<string, string> = {
  telegram: 'telegram',
  discord: 'discord',
  email: 'email', imap: 'email', smtp: 'email', mail: 'email',
}

/**
 * Map source channels onto ADF adapter config. Adapters are imported
 * **disabled** so nothing auto-connects before the user re-supplies
 * credentials (bot tokens / passwords never travel in a .adf). Allowlists are
 * preserved as policy; unsupported channels are reported and skipped.
 */
export function buildAdapters(channels: SourceChannel[]): ChannelMapping {
  const adapters: AdaptersConfig = {}
  const allowSet = new Set<string>()
  const warnings: string[] = []
  const unsupported = new Set<string>()

  for (const ch of channels) {
    const mapped = KNOWN[ch.type.toLowerCase()]
    if (!mapped) {
      unsupported.add(ch.type)
      continue
    }
    const policy: AdapterPolicy = {}
    if (ch.allowFrom && ch.allowFrom.length > 0) {
      policy.dm = 'allowlist'
      policy.allow_from = ch.allowFrom
      for (const id of ch.allowFrom) allowSet.add(id)
    }
    // Last write wins if a source lists the same channel twice; fine.
    adapters[mapped] = { enabled: false, ...(policy.allow_from ? { policy } : {}) }
  }

  const types = Object.keys(adapters)
  if (types.length > 0) {
    warnings.push(
      `${types.length} channel adapter(s) imported disabled (${types.join(', ')}); ` +
      `re-add credentials in Studio and enable them — bot tokens/passwords never travel in a .adf.`,
    )
  }
  if (unsupported.size > 0) {
    warnings.push(
      `No built-in ADF adapter for: ${[...unsupported].join(', ')} (built-in: telegram, discord, email); skipped.`,
    )
  }
  return { adapters, allowList: [...allowSet], warnings }
}

/**
 * Normalize a source's channel/platform config — which may be a list of
 * `{ type, … }` objects or a map keyed by channel name — into SourceChannels.
 * Shared by both OpenClaw (`channels`) and Hermes (`platforms`).
 */
export function channelsFromValue(value: YamlValue | undefined): SourceChannel[] {
  const out: SourceChannel[] = []
  if (!value) return out
  if (Array.isArray(value)) {
    for (const v of value) {
      const type = asString(get(v, 'type')) ?? asString(get(v, 'name'))
      if (type) out.push({ type, allowFrom: extractAllowFrom(v) })
    }
  } else if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, YamlValue>)) {
      if (v === false) continue // explicitly disabled platform
      out.push({ type: key, allowFrom: extractAllowFrom(v) })
    }
  }
  return out
}

/** Collect allowlist-style arrays from a channel definition under any common key. */
function extractAllowFrom(def: YamlValue | undefined): string[] | undefined {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return undefined
  const ids: string[] = []
  for (const key of ['allow_from', 'allowlist', 'allow', 'allowed', 'allowed_users', 'users']) {
    const v = get(def, key)
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = asString(item)
        if (s) ids.push(s)
      }
    }
  }
  return ids.length > 0 ? ids : undefined
}
