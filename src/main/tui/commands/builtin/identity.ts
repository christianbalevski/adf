// /identity and /new: the owner identity dialog and the new-agent wizard
// (dialogs in src/main/tui/identity, registered by the shell's overlay host).

import type { CommandScope, PaletteAction, SlashCommand } from '../types'
import { openIdentity, openNewAgent } from '../../identity/Onboarding'
import { onboardingChoices, type IdentityMode } from '../../identity/model'

const MODES: Record<string, IdentityMode> = { create: 'create', new: 'create', restore: 'restore', import: 'restore', unlock: 'unlock', status: 'status' }

const hasIdentity = (scope: CommandScope) => scope.state().identity !== null
const offers = (scope: CommandScope, mode: IdentityMode) => {
  const identity = scope.state().identity
  return !!identity && onboardingChoices(identity).some(c => c.mode === mode)
}

export const identityCommand: SlashCommand = {
  name: 'identity',
  args: '[create|restore|unlock|lock]',
  description: 'Owner identity: status, create, restore from the 12 words, unlock, lock',
  complete: partial => ['create', 'restore', 'unlock', 'lock'].filter(v => v.startsWith(partial.trim())),
  run: async ctx => {
    const identity = ctx.state().identity ?? await ctx.actions.refreshIdentity()
    if (!identity) { ctx.print('This daemon does not report an owner identity (update the daemon)', 'warn'); return }
    const arg = ctx.args[0]?.toLowerCase()
    if (arg === 'lock') {
      if (identity.storage !== 'file') { ctx.print('The identity is in the OS keychain; there is nothing to lock', 'info'); return }
      await ctx.actions.lockIdentity()
      return
    }
    const mode = arg ? MODES[arg] : 'status'
    if (!mode) { ctx.print('Usage: /identity [create|restore|unlock|lock]', 'warn'); return }
    openIdentity(ctx.store, { mode })
  },
}

export const newAgentCommand: SlashCommand = {
  name: 'new',
  args: '[name]',
  description: 'Create a new agent from a template (sealed under your owner identity)',
  run: ctx => openNewAgent(ctx.store, ctx.rest.trim() || undefined),
}

export const identityActions: PaletteAction[] = [
  { id: 'shell.identity', title: 'Owner identity', hint: 'status and actions', group: 'Actions', keywords: ['owner', 'did', 'seed', 'phrase', 'mnemonic'], available: hasIdentity, run: ctx => openIdentity(ctx.store) },
  { id: 'shell.identity.create', title: 'Create owner identity', group: 'Actions', keywords: ['owner', 'seed', 'new identity'], available: s => offers(s, 'create'), run: ctx => openIdentity(ctx.store, { mode: 'create' }) },
  { id: 'shell.identity.restore', title: 'Restore owner identity from seed phrase', group: 'Actions', keywords: ['owner', 'seed', 'mnemonic', 'import', '12 words'], available: s => offers(s, 'restore'), run: ctx => openIdentity(ctx.store, { mode: 'restore' }) },
  { id: 'shell.identity.unlock', title: 'Unlock owner identity', group: 'Actions', keywords: ['owner', 'passphrase'], available: s => offers(s, 'unlock'), run: ctx => openIdentity(ctx.store, { mode: 'unlock' }) },
  { id: 'shell.agent.new', title: 'New agent', hint: 'from a template', group: 'Actions', shortcut: 'n', keywords: ['create', 'agent', 'template', 'adf'], run: ctx => openNewAgent(ctx.store) },
]
