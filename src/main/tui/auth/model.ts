// Subscription provider sign-in (ChatGPT, Grok): pure helpers for the /auth
// dialog and the "not signed in" hints in Fleet and Chat.

import type { AuthDiagnostics, SubscriptionAuthStatus, SubscriptionProvider } from '../api/types'
import type { TuiState } from '../state/types'

export const AUTH_OVERLAY = 'auth'

export const SUBSCRIPTIONS: SubscriptionProvider[] = ['chatgpt', 'grok']

export const SUBSCRIPTION_LABELS: Record<SubscriptionProvider, string> = { chatgpt: 'ChatGPT', grok: 'Grok' }

/** Said once in the dialog. */
export const AUTH_EXPLAINER = 'The daemon keeps its own sign-in, separate from ADF Studio’s. Agents that use these providers need no changes.'

export interface AuthOverlayProps {
  /** Start signing in to this provider right away. */
  login?: SubscriptionProvider
}

/** Provider registration type → the subscription it needs, if any. */
export function subscriptionOfType(type: string | undefined, id?: string): SubscriptionProvider | null {
  const t = `${type ?? ''} ${id ?? ''}`.toLowerCase()
  if (t.includes('chatgpt-subscription') || (!type && /chatgpt/.test(t))) return 'chatgpt'
  if (t.includes('grok-subscription') || (!type && /grok/.test(t))) return 'grok'
  return null
}

export function statusOf(auth: AuthDiagnostics | null | undefined, provider: SubscriptionProvider): SubscriptionAuthStatus | null {
  const value = auth?.[provider] as SubscriptionAuthStatus | undefined
  return value && typeof value === 'object' ? value : null
}

/**
 * The subscription an agent's model needs and the daemon is not signed in to,
 * or null (signed in, an API-key provider, or not known yet).
 */
export function authNeedOf(state: Pick<TuiState, 'auth' | 'agents'>, agentId: string | null | undefined): SubscriptionProvider | null {
  if (!agentId || !state.auth) return null
  const config = state.agents[agentId]?.config
  const providerId = config?.model?.provider
  if (!providerId) return null
  const own = (config?.providers as Array<{ id?: string; type?: string }> | undefined)?.find(p => p.id === providerId)
  const app = state.auth.providers.find(p => p.id === providerId)
  const need = subscriptionOfType(own?.type ?? app?.type, providerId)
  if (!need) return null
  return statusOf(state.auth, need)?.authenticated ? null : need
}

/** "ChatGPT not signed in — /login chatgpt" */
export function authNeedText(provider: SubscriptionProvider): string {
  return `${SUBSCRIPTION_LABELS[provider]} not signed in — /login ${provider}`
}

/** Remaining time as `3d` / `5h` / `12m`, or `expired`. */
export function formatExpiry(expiresAt: number | undefined, now = Date.now()): string {
  if (!expiresAt) return ''
  const ms = expiresAt - now
  if (ms <= 0) return 'expired (renews on next use)'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** One status line per provider. */
export function describeStatus(status: SubscriptionAuthStatus | null): { text: string; ok: boolean } {
  if (!status) return { text: 'unknown', ok: false }
  if (status.authenticated) {
    const expiry = formatExpiry(status.expiresAt)
    return { text: `signed in${status.email ? ` as ${status.email}` : ''}${expiry ? ` · token ${expiry.startsWith('expired') ? expiry : `renews in ${expiry}`}` : ''}`, ok: true }
  }
  if (status.flowPending) return { text: 'sign-in in progress', ok: false }
  if (status.flowError) return { text: `not signed in (last attempt: ${status.flowError})`, ok: false }
  return { text: 'not signed in', ok: false }
}

/** Spaced out for a big, readable device code: `ABCD-EFGH` → `A B C D - E F G H`. */
export function spacedCode(code: string): string {
  return code.split('').join(' ')
}
