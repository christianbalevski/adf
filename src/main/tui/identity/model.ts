// Owner identity: pure helpers shared by the onboarding panel, the header
// indicator, the identity dialog and the new-agent wizard. No secrets are
// stored here; phrase helpers only transform what the dialog holds.

import type { IdentityStatus } from '../api/types'

/** Overlay kinds (registered by the shell's overlay host). */
export const IDENTITY_OVERLAY = 'identity'
export const NEW_AGENT_OVERLAY = 'new-agent'
/** viewState slot: the fleet banner was dismissed for this identity status. */
export const IDENTITY_BANNER_KEY = 'shell.identity.banner'

export const PHRASE_WORDS = 12
export const MIN_PASSPHRASE = 8
/** What the user types to confirm the words are written down. */
export const SAVED_WORD = 'saved'

export type IdentityMode = 'status' | 'create' | 'restore' | 'unlock'

/** Props of the identity overlay. Never words or passphrases: overlay props live in the store. */
export interface IdentityOverlayProps {
  mode?: IdentityMode
  /**
   * Overlay kind to open once the identity is ready: the new-agent wizard
   * (from /new or `n`), /connect, /provider add.
   */
  then?: string
  /** Props for that overlay (never secrets). The new-agent wizard takes `name` instead. */
  thenProps?: Record<string, unknown>
  /** Agent name to carry into that wizard. */
  name?: string
  /** One line saying why the dialog opened (e.g. "Set up your owner identity first"). */
  reason?: string
}

/** `did:key:z6MkhaXg…3xQp`: enough to recognise, short enough for a header. */
export function shortDid(did: string | null | undefined, keep = 6): string {
  if (!did) return ''
  const m = did.match(/^(did:[a-z0-9]+:)(.*)$/i)
  if (!m) return did.length > 16 ? `${did.slice(0, 10)}…${did.slice(-4)}` : did
  const id = m[2]
  return id.length > keep + 5 ? `${m[1]}${id.slice(0, keep)}…${id.slice(-4)}` : did
}

/**
 * A pasted or typed phrase → 12 lowercase words. Numbering from a written or
 * copied grid ("1. word", "1) word", "1 word") and punctuation are dropped.
 */
export function normalizePhrase(text: string): string {
  return phraseWords(text).join(' ')
}

export function phraseWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;]+/)
    .map(w => w.replace(/^\d+[.):-]?$/, '').replace(/^\d+[.):-]/, '').replace(/[^a-z]/g, ''))
    .filter(Boolean)
}

/** create / restore / unlock go to loopback daemons only (the daemon enforces it too). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || /^127\./.test(host) || host.startsWith('::ffff:127.')
  } catch {
    return false
  }
}

export const LOOPBACK_ONLY_TEXT = 'The seed phrase and passphrase never travel over the network: create, restore and unlock only work from the daemon’s own machine. Run the terminal app (`adf`) or `adf identity` there.'

/** One or two sentences: what the owner identity is. */
export const IDENTITY_EXPLAINER = 'Your owner identity proves these agents are yours. It is 12 words: the same words restore it anywhere, in the terminal or in ADF Studio.'

/** The daemon's error code → what to tell the user (inline in the dialog). */
export function identityErrorText(code: string | undefined, fallback: string, identity?: IdentityStatus | null): string {
  switch (code) {
    case 'invalid_mnemonic':
      return 'Those are not 12 valid seed words. Check each word and the order.'
    case 'owner_mismatch':
      return identity?.ownerDid
        ? `That phrase belongs to a different owner. This machine’s owner is ${shortDid(identity.ownerDid)}: enter its phrase. (To switch owners, import the new phrase in ADF Studio.)`
        : 'That phrase belongs to a different owner than this machine’s.'
    case 'wrong_passphrase':
      return 'Wrong passphrase.'
    case 'weak_passphrase':
      return `Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`
    case 'passphrase_required':
      return 'This machine keeps the identity in a passphrase-protected file: enter the passphrase.'
    case 'loopback_only':
      return LOOPBACK_ONLY_TEXT
    case 'identity_exists':
      return 'An owner identity already exists here; nothing was created.'
    case 'nothing_to_unlock':
      return 'There is nothing to unlock yet: create or restore an identity.'
    default:
      return fallback
  }
}

export interface IdentityBadge {
  text: string
  tone: 'ok' | 'warn' | 'muted'
}

/** Header indicator. null = the daemon has no identity routes: show nothing. */
export function identityBadge(identity: IdentityStatus | null): IdentityBadge | null {
  if (!identity) return null
  switch (identity.status) {
    case 'ready':
      return identity.backupConfirmed
        ? { text: `owner ${shortDid(identity.ownerDid, 4).replace(/^did:key:/, "")}`, tone: 'muted' }
        : { text: `owner ${shortDid(identity.ownerDid, 4).replace(/^did:key:/, "")} not backed up`, tone: 'warn' }
    case 'locked':
      return { text: 'owner locked', tone: 'warn' }
    case 'restore-needed':
      return { text: 'owner: restore', tone: 'warn' }
    default:
      return { text: 'no owner', tone: 'warn' }
  }
}

/** Onboarding copy per status: the headline and the next step. */
export function onboardingLines(identity: IdentityStatus): { title: string; next: string } {
  switch (identity.status) {
    case 'locked':
      return { title: 'Your owner identity is locked', next: 'Unlock it with its passphrase to create and seal agents.' }
    case 'restore-needed':
      return {
        title: 'Restore your owner identity',
        next: `This machine already belongs to ${shortDid(identity.ownerDid)}: enter the 12-word phrase for this owner.`,
      }
    case 'ready':
      return { title: 'Owner identity ready', next: '' }
    default:
      return { title: 'Set up your owner identity', next: 'Create a new one, or restore yours from its 12-word seed phrase.' }
  }
}

/** The actions each status offers: [key, label, mode]. */
export function onboardingChoices(identity: IdentityStatus): Array<{ key: string; label: string; mode: IdentityMode }> {
  switch (identity.status) {
    case 'none':
      return [
        { key: 'c', label: 'Create new', mode: 'create' },
        { key: 'r', label: 'Restore from seed phrase', mode: 'restore' },
      ]
    case 'restore-needed':
      return [{ key: 'r', label: 'Restore from seed phrase', mode: 'restore' }]
    case 'locked':
      return identity.storage === 'file' && identity.passphraseRequired
        ? [{ key: 'u', label: 'Unlock with passphrase', mode: 'unlock' }]
        : []
    default:
      return []
  }
}

/** Passphrase rule for the passphrase-file store: a new file needs 8+ chars, typed twice. */
export function passphraseProblem(first: string, second: string | null, isNew: boolean): string | null {
  if (!first) return 'Enter the passphrase.'
  if (!isNew) return null
  if (first.length < MIN_PASSPHRASE) return `At least ${MIN_PASSPHRASE} characters.`
  if (second !== null && first !== second) return 'The two passphrases differ. Type them again.'
  return null
}
