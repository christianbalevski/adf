// First-run owner identity: a calm panel in place of the empty fleet, and a
// one-line banner above a non-empty one. Keys are handled by the fleet view
// (`identityKey`), so the panel works wherever the fleet has focus.

import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { KeyHints } from '../ui/KeyHint'
import type { TuiStore } from '../state/store'
import type { IdentityStatus } from '../api/types'
import {
  IDENTITY_BANNER_KEY,
  IDENTITY_EXPLAINER,
  IDENTITY_OVERLAY,
  NEW_AGENT_OVERLAY,
  onboardingChoices,
  onboardingLines,
  shortDid,
  type IdentityMode,
  type IdentityOverlayProps,
} from './model'

export function openIdentity(store: Pick<TuiStore, 'actions'>, props: IdentityOverlayProps = {}): void {
  store.actions.pushOverlay({ kind: IDENTITY_OVERLAY, props: { ...props } })
}

/**
 * The new-agent wizard, or (identity not ready) the identity dialog first,
 * which opens the wizard once the identity is ready.
 */
export function openNewAgent(store: Pick<TuiStore, 'actions' | 'getState'>, name?: string): void {
  const identity = store.getState().identity
  if (identity && identity.status !== 'ready') {
    openIdentity(store, { mode: 'status', then: NEW_AGENT_OVERLAY, name, reason: 'Agents are sealed under your owner identity: set it up first, then the new agent follows.' })
    return
  }
  store.actions.pushOverlay({ kind: NEW_AGENT_OVERLAY, props: name ? { name } : {} })
}

/** The banner shows until dismissed for this status (it comes back when the status changes). */
export function bannerKeyOf(identity: IdentityStatus): string {
  return `${identity.status}:${identity.backupConfirmed ? 1 : 0}`
}

/** Whether identity needs attention: not ready, or ready with an unconfirmed backup. */
export function needsAttention(identity: IdentityStatus | null): identity is IdentityStatus {
  return !!identity && (identity.status !== 'ready' || !identity.backupConfirmed)
}

/**
 * Fleet keys for the identity: the onboarding choices (c / r / u) while it is
 * not ready, `i` for the dialog, `I` hides the banner. Returns true when consumed.
 */
export function identityKey(store: TuiStore, identity: IdentityStatus | null, input: string, panel: boolean): boolean {
  if (!identity) return false
  if (input === 'i') { openIdentity(store); return true }
  if (input === 'I' && !panel && needsAttention(identity)) { store.actions.setViewState(IDENTITY_BANNER_KEY, bannerKeyOf(identity)); return true }
  if (!panel) return false
  const choice = onboardingChoices(identity).find(c => c.key === input)
  if (!choice) return false
  openIdentity(store, { mode: choice.mode as IdentityMode })
  return true
}

/** Empty fleet + identity not ready: what it is, and the one or two next steps. */
export function IdentityOnboarding({ identity, width, focused }: { identity: IdentityStatus; width: number; focused: boolean }) {
  const theme = useTheme()
  const { title, next } = onboardingLines(identity)
  const choices = onboardingChoices(identity)
  const inner = Math.max(30, Math.min(width - 2, 72))
  return (
    <Box flexDirection="column" width={inner} marginTop={1}>
      <Text bold color={theme.color.accent}>{theme.glyph.wordmark} {title}</Text>
      <Text> </Text>
      <Text wrap="wrap" color={theme.color.text}>{IDENTITY_EXPLAINER}</Text>
      {next ? <Text wrap="wrap" color={theme.color.muted}>{next}</Text> : null}
      {identity.status === 'locked' && choices.length === 0 ? <Text wrap="wrap" color={theme.color.warn}>{identity.message}</Text> : null}
      <Text> </Text>
      {choices.map(c => (
        <Text key={c.key}>
          <Text bold color={theme.color.accent}>  [{c.key}]</Text>
          <Text color={theme.color.text}> {c.label}</Text>
        </Text>
      ))}
      <Text> </Text>
      <KeyHints hints={focused ? [{ keys: 'i', label: 'details' }, { keys: 'o', label: 'load an existing .adf' }] : [{ keys: 'shift+tab', label: 'focus here to choose' }]} />
    </Box>
  )
}

/** One line above a non-empty fleet. */
export function IdentityBanner({ identity, width }: { identity: IdentityStatus; width: number }) {
  const theme = useTheme()
  const text = identity.status === 'ready'
    ? `Seed phrase backup not confirmed for ${shortDid(identity.ownerDid, 4)}. Make sure the 12 words are written down.`
    : identity.status === 'locked'
      ? 'Owner identity locked: new agents cannot be created until it is unlocked.'
      : identity.status === 'restore-needed'
        ? `Restore owner ${shortDid(identity.ownerDid, 4)} from its 12 words to create agents here.`
        : 'No owner identity yet: set one up to create agents.'
  return (
    <Text wrap="truncate-end">
      <Text color={theme.color.warn}>{theme.glyph.warn} {text.slice(0, Math.max(10, width - 24))}</Text>
      <Text color={theme.color.dim}>  </Text>
      <Text bold color={theme.color.accent}>i</Text><Text color={theme.color.muted}> open</Text>
      <Text color={theme.color.dim}> {theme.glyph.sep} </Text>
      <Text bold color={theme.color.accent}>I</Text><Text color={theme.color.muted}> hide</Text>
    </Text>
  )
}
