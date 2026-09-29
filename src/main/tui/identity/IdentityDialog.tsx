// The owner identity dialog: status + create / restore / unlock, one overlay
// with a small step machine.
//
// Secrets: the 12 words, the typed phrase and passphrases live in this
// component's state only — never in overlay props (those are store state),
// toasts, transcripts, logs or the clipboard. Closing drops them with the
// component and repaints the screen (clearing scrollback), so a closed
// dialog leaves no words behind.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Text, useApp, useStdout } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore } from '../state/store'
import { useConnection, useIdentity } from '../state/hooks'
import { Modal } from '../ui/Modal'
import { TextInput } from '../ui/TextInput'
import { Spinner } from '../ui/Spinner'
import type { KeyHintSpec } from '../ui/KeyHint'
import type { IdentityStatus } from '../api/types'
import type { OverlayProps } from '../views/types'
import {
  IDENTITY_EXPLAINER,
  LOOPBACK_ONLY_TEXT,
  NEW_AGENT_OVERLAY,
  PHRASE_WORDS,
  SAVED_WORD,
  identityErrorText,
  isLoopbackUrl,
  normalizePhrase,
  onboardingChoices,
  passphraseProblem,
  phraseWords,
  shortDid,
  type IdentityMode,
  type IdentityOverlayProps,
} from './model'

/** Clear screen + scrollback, cursor home. Ink replays the current frame after it. */
const WIPE_SCREEN = '\u001b[2J\u001b[3J\u001b[H'

type Purpose = 'create' | 'restore' | 'unlock'

type Step =
  | { kind: 'status' }
  | { kind: 'phrase' }
  | { kind: 'passphrase'; purpose: Purpose; isNew: boolean; confirming: boolean }
  | { kind: 'busy'; label: string }
  | { kind: 'words' }
  | { kind: 'remote' }

export function IdentityDialog({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const identity = useIdentity()
  const { url } = useConnection()
  const { write } = useStdout()
  const { waitUntilRenderFlush } = useApp()
  const props = (overlay.props ?? {}) as IdentityOverlayProps
  const loopback = isLoopbackUrl(url)
  const dialogWidth = Math.max(44, Math.min(width - 4, 76))

  const [step, setStep] = useState<Step>({ kind: 'status' })
  const [error, setError] = useState<string | null>(null)
  // Secrets: component state only.
  const [phrase, setPhrase] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [words, setWords] = useState<string[] | null>(null)
  const [saved, setSaved] = useState('')
  const [leaving, setLeaving] = useState(false)
  const started = useRef(false)

  // Scrub on unmount whatever path closed us (Esc, Ctrl+C, a newer overlay).
  const hadWords = useRef(false)
  useEffect(() => () => {
    if (!hadWords.current) return
    void waitUntilRenderFlush().then(() => write(WIPE_SCREEN)).catch(() => {})
  }, [])

  const finish = (ready?: IdentityStatus) => {
    setWords(null); setPhrase(''); setPass(''); setPass2(''); setSaved('')
    close()
    if (ready?.status === 'ready' && props.then === NEW_AGENT_OVERLAY) {
      store.actions.pushOverlay({ kind: NEW_AGENT_OVERLAY, props: props.name ? { name: props.name } : {} })
    } else if (ready?.status === 'ready' && props.then) {
      store.actions.pushOverlay({ kind: props.then, props: { ...(props.thenProps ?? {}) } })
    }
  }

  const needsPassphrase = (purpose: Purpose) => purpose === 'unlock' || !!identity?.passphraseRequired
  const passIsNew = (purpose: Purpose) => purpose !== 'unlock' && identity?.status !== 'locked'

  const begin = (mode: IdentityMode) => {
    setError(null)
    if (mode === 'status') { setStep({ kind: 'status' }); return }
    if (!loopback) { setStep({ kind: 'remote' }); return }
    if (mode === 'restore') { setStep({ kind: 'phrase' }); return }
    if (needsPassphrase(mode)) { setStep({ kind: 'passphrase', purpose: mode, isNew: passIsNew(mode), confirming: false }); return }
    if (mode === 'create') void create('')
  }

  useEffect(() => {
    if (started.current || !identity) return
    started.current = true
    const mode = props.mode ?? 'status'
    const allowed = mode === 'status' || onboardingChoices(identity).some(c => c.mode === mode)
    if (allowed) begin(mode)
    else setError(identity.status === 'ready' ? 'The owner identity is already set up.' : identity.message)
  }, [identity])

  const create = async (passphrase: string) => {
    setStep({ kind: 'busy', label: 'Creating your owner identity…' })
    const result = await store.actions.createIdentity(passphrase || undefined)
    setPass(''); setPass2('')
    if (!result.ok) {
      setError(identityErrorText(result.code, result.error, store.getState().identity))
      setStep(result.code === 'weak_passphrase' || result.code === 'passphrase_required' || result.code === 'wrong_passphrase'
        ? { kind: 'passphrase', purpose: 'create', isNew: true, confirming: false }
        : { kind: 'status' })
      return
    }
    hadWords.current = true
    setWords(result.value.words.length === PHRASE_WORDS ? result.value.words : result.value.mnemonic.split(' '))
    setError(null)
    setStep({ kind: 'words' })
  }

  const restore = async (passphrase: string) => {
    setStep({ kind: 'busy', label: 'Restoring your owner identity…' })
    const result = await store.actions.restoreIdentity(normalizePhrase(phrase), passphrase || undefined)
    setPass(''); setPass2('')
    if (!result.ok) {
      const text = identityErrorText(result.code, result.error, store.getState().identity)
      setError(text)
      if (result.code === 'wrong_passphrase' || result.code === 'weak_passphrase' || result.code === 'passphrase_required') {
        setStep({ kind: 'passphrase', purpose: 'restore', isNew: passIsNew('restore'), confirming: false })
      } else {
        setStep({ kind: 'phrase' })
      }
      return
    }
    finish(result.value)
  }

  const unlock = async (passphrase: string) => {
    setStep({ kind: 'busy', label: 'Unlocking…' })
    const result = await store.actions.unlockIdentity(passphrase)
    setPass('')
    if (!result.ok) {
      setError(identityErrorText(result.code, result.error, store.getState().identity))
      setStep({ kind: 'passphrase', purpose: 'unlock', isNew: false, confirming: false })
      return
    }
    finish(result.value)
  }

  const submitPhrase = (text: string) => {
    const count = phraseWords(text).length
    if (count !== PHRASE_WORDS) { setError(`That is ${count} word${count === 1 ? '' : 's'}; the phrase has ${PHRASE_WORDS}.`); return false }
    setError(null)
    if (needsPassphrase('restore')) { setStep({ kind: 'passphrase', purpose: 'restore', isNew: passIsNew('restore'), confirming: false }); return false }
    void restore('')
    return false
  }

  const submitPassphrase = (value: string) => {
    if (step.kind !== 'passphrase') return false
    if (step.isNew && !step.confirming) {
      const problem = passphraseProblem(value, null, true)
      if (problem) { setError(problem); return false }
      setError(null)
      setStep({ ...step, confirming: true })
      return false
    }
    const problem = passphraseProblem(pass, step.isNew ? value : null, step.isNew)
    if (problem) {
      setError(problem)
      if (step.isNew) { setPass(''); setPass2(''); setStep({ ...step, confirming: false }) }
      return false
    }
    setError(null)
    const secret = pass
    if (step.purpose === 'create') void create(secret)
    else if (step.purpose === 'restore') void restore(secret)
    else void unlock(secret)
    return false
  }

  const submitSaved = async (value: string) => {
    if (value.trim().toLowerCase() !== SAVED_WORD) { setError(`Type ${SAVED_WORD} once all ${PHRASE_WORDS} words are written down.`); return false }
    setStep({ kind: 'busy', label: 'Confirming…' })
    const result = await store.actions.confirmIdentityBackup()
    finish(result.ok ? result.value : store.getState().identity ?? undefined)
    return true
  }

  // Status-step actions and the "leave without confirming" question.
  useKeys((input, key) => {
    if (step.kind === 'words' && leaving) {
      if (input === 'y' || input === 'Y') { finish(store.getState().identity ?? undefined); return true }
      if (input === 'n' || input === 'N' || key.escape || key.return) { setLeaving(false); return true }
      return true
    }
    if (step.kind === 'words' && (key.escape || (key.ctrl && input === 'c'))) { setLeaving(true); return true }
    if (step.kind === 'busy') return true
    if (step.kind !== 'status' || !identity || key.ctrl || key.meta) return false
    const choice = onboardingChoices(identity).find(c => c.key === input)
    if (choice) { begin(choice.mode); return true }
    if (identity.status === 'ready' && input === 'b' && !identity.backupConfirmed) {
      void store.actions.confirmIdentityBackup()
      return true
    }
    if (identity.status === 'ready' && input === 'l' && identity.storage === 'file') {
      void store.actions.lockIdentity()
      return true
    }
    return false
  }, { layer: 'overlay' })

  const onClose = step.kind === 'words' || step.kind === 'busy' ? undefined : () => finish()

  if (!identity) {
    return (
      <Modal title="Owner identity" width={dialogWidth} onClose={close} hints={[{ keys: 'esc', label: 'close' }]}>
        <Text wrap="wrap" color={theme.color.muted}>This daemon does not report an owner identity (it predates headless identities). Update the daemon, or use `adf identity` against a current one.</Text>
      </Modal>
    )
  }

  const errorLine = error ? <Text color={theme.color.error} wrap="wrap">{theme.glyph.cross} {error}</Text> : null

  switch (step.kind) {
    case 'remote':
      return (
        <Modal title="Owner identity" width={dialogWidth} onClose={onClose} hints={[{ keys: 'esc', label: 'close' }]}>
          <Text wrap="wrap" color={theme.color.warn}>{theme.glyph.warn} This TUI talks to {url}, which is not this machine.</Text>
          <Text> </Text>
          <Text wrap="wrap" color={theme.color.text}>{LOOPBACK_ONLY_TEXT}</Text>
        </Modal>
      )

    case 'busy':
      return (
        <Modal title="Owner identity" width={dialogWidth}>
          <Spinner label={step.label} />
        </Modal>
      )

    case 'phrase': {
      const count = phraseWords(phrase).length
      return (
        <Modal title="Restore owner identity" width={dialogWidth} onClose={onClose} hints={[{ keys: 'enter', label: 'restore' }, { keys: 'esc', label: 'cancel' }]}>
          {identity.ownerDid ? <Text wrap="wrap" color={theme.color.text}>Enter the phrase for this owner: <Text bold>{shortDid(identity.ownerDid)}</Text></Text> : <Text wrap="wrap" color={theme.color.text}>Enter your 12-word seed phrase (from ADF Studio or `adf identity new`).</Text>}
          <Text color={theme.color.dim} wrap="wrap">Typing is hidden. Paste works; numbering and line breaks are ignored.</Text>
          <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={theme.color.borderFocus} paddingX={1}>
            <TextInput value={phrase} onChange={v => { setPhrase(v); setError(null) }} onSubmit={submitPhrase} focused keyLayer="overlay" maxRows={3} mask={theme.ascii ? '*' : '•'} maskKeepSpaces placeholder="word1 word2 … word12" />
          </Box>
          <Text color={count === PHRASE_WORDS ? theme.color.success : theme.color.muted}>{count}/{PHRASE_WORDS} words</Text>
          {errorLine}
        </Modal>
      )
    }

    case 'passphrase': {
      const title = step.purpose === 'unlock' ? 'Unlock owner identity' : step.purpose === 'create' ? 'Protect your owner identity' : 'Restore owner identity'
      const lead = step.purpose === 'unlock'
        ? 'Enter the passphrase that protects the owner identity on this machine.'
        : step.isNew
          ? 'This machine has no usable OS keychain, so the identity is kept in a file protected by a passphrase. Choose one (8+ characters); the daemon asks for it after each restart.'
          : 'Enter the passphrase of the identity file on this machine.'
      return (
        <Modal title={title} width={dialogWidth} onClose={onClose} hints={[{ keys: 'enter', label: step.isNew && !step.confirming ? 'next' : 'ok' }, { keys: 'esc', label: 'cancel' }]}>
          <Text wrap="wrap" color={theme.color.text}>{lead}</Text>
          <Text> </Text>
          <Text color={theme.color.muted}>{step.confirming ? 'Type it again' : 'Passphrase'}</Text>
          <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={theme.color.borderFocus} paddingX={1}>
            {step.confirming
              ? <TextInput key="again" value={pass2} onChange={v => { setPass2(v); setError(null) }} onSubmit={submitPassphrase} focused keyLayer="overlay" maxRows={1} mask={theme.ascii ? '*' : '•'} />
              : <TextInput key="first" value={pass} onChange={v => { setPass(v); setError(null) }} onSubmit={submitPassphrase} focused keyLayer="overlay" maxRows={1} mask={theme.ascii ? '*' : '•'} />}
          </Box>
          {errorLine}
        </Modal>
      )
    }

    case 'words': {
      const list = words ?? []
      const colWidth = Math.max(14, Math.floor((dialogWidth - 4) / 3))
      const rows = Math.ceil(list.length / 3)
      return (
        <Modal title="Your seed phrase" width={dialogWidth} hints={leaving ? [] : [{ keys: 'enter', label: `after typing ${SAVED_WORD}` }, { keys: 'esc', label: 'close without confirming' }]}>
          <Text wrap="wrap" color={theme.color.warn} bold>{theme.glyph.warn} Write these 12 words down, in order, and keep them offline. They are shown once.</Text>
          <Text wrap="wrap" color={theme.color.muted}>Anyone with them can act as you. Without them this identity cannot be recovered if this machine is lost.</Text>
          <Box flexDirection="column" marginY={1}>
            {Array.from({ length: rows }, (_, r) => (
              <Text key={r}>
                {[0, 1, 2].map(c => {
                  const i = r + c * rows
                  const word = list[i]
                  if (!word) return null
                  return (
                    <Text key={c}>
                      <Text color={theme.color.dim}>{String(i + 1).padStart(2)} </Text>
                      <Text bold color={theme.color.text}>{word.padEnd(colWidth - 3)}</Text>
                    </Text>
                  )
                })}
              </Text>
            ))}
          </Box>
          <Text wrap="wrap" color={theme.color.muted}>Same words in ADF Studio (Settings → Import identity) or `adf identity restore` make you the same owner there.</Text>
          {leaving ? (
            <Text bold color={theme.color.warn} wrap="wrap">{theme.glyph.warn} Close without confirming? The words will not be shown again. y close {theme.glyph.sep} n keep them on screen</Text>
          ) : (
            <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={theme.color.borderFocus} paddingX={1}>
              <TextInput value={saved} onChange={v => { setSaved(v); setError(null) }} onSubmit={v => { void submitSaved(v); return false }} focused={!leaving} keyLayer="overlay" maxRows={1} placeholder={`type ${SAVED_WORD} when they are written down`} />
            </Box>
          )}
          {errorLine}
        </Modal>
      )
    }

    default:
      return <StatusBody identity={identity} width={dialogWidth} reason={props.reason} errorLine={errorLine} onClose={onClose} loopback={loopback} />
  }
}

function StatusBody({ identity, width, reason, errorLine, onClose, loopback }: { identity: IdentityStatus; width: number; reason?: string; errorLine: ReactNode; onClose?: () => void; loopback: boolean }) {
  const theme = useTheme()
  const choices = onboardingChoices(identity)
  const hints: KeyHintSpec[] = choices.map(c => ({ keys: c.key, label: c.label.toLowerCase() }))
  if (identity.status === 'ready' && !identity.backupConfirmed) hints.push({ keys: 'b', label: 'I have written the words down' })
  if (identity.status === 'ready' && identity.storage === 'file') hints.push({ keys: 'l', label: 'lock' })
  hints.push({ keys: 'esc', label: 'close' })
  const state = identity.status === 'ready' ? 'ready' : identity.status === 'restore-needed' ? 'restore needed' : identity.status === 'locked' ? 'locked' : 'not set up'
  const tone = identity.status === 'ready' ? theme.color.success : theme.color.warn
  return (
    <Modal title="Owner identity" width={width} onClose={onClose} hints={hints}>
      {reason ? <Text wrap="wrap" color={theme.color.warn}>{reason}</Text> : null}
      <Text wrap="wrap" color={theme.color.muted}>{IDENTITY_EXPLAINER}</Text>
      <Text> </Text>
      <Text><Text color={theme.color.muted}>{'status   '}</Text><Text bold color={tone}>{state}</Text></Text>
      {identity.ownerDid ? <Text wrap="wrap"><Text color={theme.color.muted}>{'owner    '}</Text><Text color={theme.color.text}>{identity.ownerDid}</Text></Text> : null}
      <Text><Text color={theme.color.muted}>{'stored   '}</Text><Text color={theme.color.text}>{identity.storage === 'keychain' ? 'OS keychain (shared with ADF Studio)' : 'passphrase-protected file'}</Text></Text>
      {identity.status === 'ready' ? (
        <Text><Text color={theme.color.muted}>{'backup   '}</Text><Text color={identity.backupConfirmed ? theme.color.success : theme.color.warn}>{identity.backupConfirmed ? 'written down' : 'not confirmed: make sure the 12 words are written down'}</Text></Text>
      ) : null}
      {identity.status !== 'ready' ? <><Text> </Text><Text wrap="wrap" color={theme.color.text}>{identity.message}</Text></> : null}
      {!loopback && choices.length > 0 ? <Text wrap="wrap" color={theme.color.dim}>{LOOPBACK_ONLY_TEXT}</Text> : null}
      {errorLine}
    </Modal>
  )
}
