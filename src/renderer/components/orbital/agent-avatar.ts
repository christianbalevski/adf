/**
 * Which avatar a small agent surface draws: the orbital (default) or the
 * agent's emoji, per the `agentAvatars` setting. Pure, so it is unit-tested;
 * the components read the mode from the app store.
 */

import { pickAgentIcon } from '../../../shared/constants/agent-icons'

export type AgentAvatarMode = 'orbital' | 'emoji'

export const AGENT_AVATAR_MODE_DEFAULT: AgentAvatarMode = 'orbital'

export function isAgentAvatarMode(v: unknown): v is AgentAvatarMode {
  return v === 'orbital' || v === 'emoji'
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

function firstGrapheme(value: string): string {
  if (!segmenter) return value
  return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? value
}

/**
 * The agent's configured emoji (first grapheme), else a stable pick from the
 * curated pool seeded by `fallbackSeed`. Null when there is neither.
 */
export function agentAvatarEmoji(icon: string | null | undefined, fallbackSeed: string | null | undefined): string | null {
  const own = icon?.trim()
  if (own) return firstGrapheme(own)
  return fallbackSeed ? pickAgentIcon(fallbackSeed) : null
}

export type AgentAvatarChoice =
  | { kind: 'orbital'; seed: string | null }
  | { kind: 'emoji'; emoji: string | null }

/**
 * Orbital mode draws the orbital from `seed`. Emoji mode draws `icon`, else
 * pickAgentIcon(`iconSeed`, falling back to `seed`).
 */
export function selectAgentAvatar(
  mode: AgentAvatarMode,
  src: { seed?: string | null; icon?: string | null; iconSeed?: string | null }
): AgentAvatarChoice {
  if (mode === 'emoji') return { kind: 'emoji', emoji: agentAvatarEmoji(src.icon, src.iconSeed || src.seed) }
  return { kind: 'orbital', seed: src.seed ?? null }
}
