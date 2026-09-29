// Openers for the setup dialogs. Secrets need the owner identity first:
// channel credentials are sealed under it, and on machines without an OS
// keychain the daemon's secret store (provider keys) is its passphrase file.
// When it is not ready the identity dialog opens, then the dialog follows.

import type { TuiStore } from '../state/store'
import { openIdentity } from '../identity/Onboarding'
import { CHANNELS_OVERLAY, type ChannelsOverlayProps } from './channels'
import { PROVIDER_OVERLAY } from './provider'
import { WELCOME_OVERLAY } from './welcome'
import { MCP_OVERLAY, type McpOverlayProps } from './mcp'

type Store = Pick<TuiStore, 'actions' | 'getState'>

/** Whether channel credentials can be sealed now (identity ready, or a daemon without identity routes). */
export function channelsIdentityReady(store: Store): boolean {
  const identity = store.getState().identity
  return !identity || identity.status === 'ready'
}

/** The daemon secret store is usable: the OS keychain, or an unlocked passphrase file. */
export function secretStoreReady(store: Store): boolean {
  const identity = store.getState().identity
  if (!identity) return true
  return identity.storage === 'keychain' ? identity.status !== 'locked' : identity.status === 'ready'
}

export function openChannels(store: Store, props: ChannelsOverlayProps = {}): void {
  const state = store.getState()
  const agentId = props.agentId ?? state.selectedAgentId
  if (!agentId || !state.agents[agentId]) {
    store.actions.toast('Select an agent first (sidebar or /agent), or create one with /new', 'warn')
    return
  }
  const next: ChannelsOverlayProps = { agentId, ...(props.channel ? { channel: props.channel } : {}) }
  if (props.channel && !channelsIdentityReady(store)) {
    identityFirst(store, CHANNELS_OVERLAY, next as Record<string, unknown>, 'Channel credentials are sealed under your owner identity: set it up first, then the channel setup follows.')
    return
  }
  store.actions.pushOverlay({ kind: CHANNELS_OVERLAY, props: { ...next } })
}

export function openProviderAdd(store: Store, props: { preset?: string } = {}): void {
  if (!secretStoreReady(store)) {
    identityFirst(store, PROVIDER_OVERLAY, { ...props }, 'API keys go into the daemon’s secret store, which is protected by your owner identity here: set it up or unlock it first.')
    return
  }
  store.actions.pushOverlay({ kind: PROVIDER_OVERLAY, props: { ...props } })
}

export function openMcp(store: Store, props: McpOverlayProps = {}): void {
  const state = store.getState()
  const agentId = props.agentId ?? state.selectedAgentId
  if (!agentId || !state.agents[agentId]) {
    store.actions.toast('Select an agent first (sidebar or /agent), or create one with /new', 'warn')
    return
  }
  store.actions.pushOverlay({ kind: MCP_OVERLAY, props: { ...props, agentId } })
}

export function openWelcome(store: Pick<TuiStore, 'actions'>): void {
  store.actions.pushOverlay({ id: WELCOME_OVERLAY, kind: WELCOME_OVERLAY })
}

export function identityFirst(store: Store, then: string, thenProps: Record<string, unknown>, reason: string): void {
  openIdentity(store, { mode: 'status', then, thenProps, reason })
}
