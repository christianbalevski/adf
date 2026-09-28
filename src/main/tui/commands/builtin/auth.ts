// /auth, /login, /logout: subscription provider sign-in for the daemon
// (dialog in src/main/tui/auth, registered by the shell's overlay host).

import type { PaletteAction, SlashCommand } from '../types'
import * as authFlowNs from '../../../cli/auth-flow'
import { cjs } from '../../interop'
import { AUTH_OVERLAY, SUBSCRIPTION_LABELS, statusOf, type AuthOverlayProps } from '../../auth/model'
import type { TuiActions } from '../../state/store'

const { normalizeAuthProvider } = cjs(authFlowNs)

export function openAuth(actions: Pick<TuiActions, 'pushOverlay'>, props: AuthOverlayProps = {}): void {
  actions.pushOverlay({ kind: AUTH_OVERLAY, props: { ...props } })
}

const complete = (partial: string) => ['chatgpt', 'grok'].filter(v => v.startsWith(partial.trim().toLowerCase()))

export const authCommand: SlashCommand = {
  name: 'auth',
  description: 'Provider sign-in: ChatGPT and Grok status, sign in, sign out',
  run: ctx => openAuth(ctx.actions),
}

export const loginCommand: SlashCommand = {
  name: 'login',
  args: '[chatgpt|grok]',
  description: 'Sign the daemon in to ChatGPT (browser) or Grok (device code)',
  complete,
  run: ctx => {
    if (!ctx.args[0]) { openAuth(ctx.actions); return }
    const provider = normalizeAuthProvider(ctx.args[0])
    if (!provider) { ctx.print('Usage: /login [chatgpt|grok]', 'warn'); return }
    openAuth(ctx.actions, { login: provider })
  },
}

export const logoutCommand: SlashCommand = {
  name: 'logout',
  args: '<chatgpt|grok>',
  description: 'Sign the daemon out of ChatGPT or Grok (asks)',
  complete,
  run: async ctx => {
    const provider = normalizeAuthProvider(ctx.args[0])
    if (!provider) { ctx.print('Usage: /logout <chatgpt|grok>', 'warn'); return }
    const label = SUBSCRIPTION_LABELS[provider]
    const ok = await ctx.actions.confirm({ title: `Sign out of ${label}`, message: `Sign the daemon out of ${label}? Agents using it stop working until you sign in again.`, confirmLabel: 'Sign out', danger: true })
    if (ok) await ctx.actions.logoutSubscription(provider)
  },
}

export const authActions: PaletteAction[] = [
  { id: 'shell.auth', title: 'Provider sign-in', hint: 'ChatGPT, Grok', group: 'Actions', keywords: ['auth', 'login', 'sign in', 'subscription', 'account'], run: ctx => openAuth(ctx.actions) },
  { id: 'shell.auth.chatgpt', title: 'Sign in to ChatGPT', group: 'Actions', keywords: ['login', 'openai', 'codex', 'auth'], available: s => !statusOf(s.state().auth, 'chatgpt')?.authenticated, run: ctx => openAuth(ctx.actions, { login: 'chatgpt' }) },
  { id: 'shell.auth.grok', title: 'Sign in to Grok', group: 'Actions', keywords: ['login', 'xai', 'auth', 'device code'], available: s => !statusOf(s.state().auth, 'grok')?.authenticated, run: ctx => openAuth(ctx.actions, { login: 'grok' }) },
]
