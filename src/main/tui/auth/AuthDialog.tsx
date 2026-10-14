// Provider sign-in (ChatGPT, Grok, Claude): status of each subscription, sign
// in, sign out. Sign-in runs the same flows as `adf auth login` (cli/auth-flow.ts):
// ChatGPT opens the browser (URL shown too), Grok shows a device code, Claude
// runs Claude Code on the daemon host (URL shown as the fallback, and a box to
// paste the code Claude's page may show).

import { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import { TextInput } from '../ui/TextInput'
import type { KeyHintSpec } from '../ui/KeyHint'
import type { SubscriptionProvider } from '../api/types'
import type { OverlayProps } from '../views/types'
import { copyToClipboard } from '../views/chat/model'
import { signIn, type AuthOutcome } from './flow'
import { AUTH_EXPLAINER, CLAUDE_EXPLAINER, SUBSCRIPTIONS, SUBSCRIPTION_LABELS, describeStatus, spacedCode, statusOf, type AuthOverlayProps } from './model'

type Flow =
  | { kind: 'list' }
  | { kind: 'signout'; provider: SubscriptionProvider }
  | { kind: 'running'; provider: SubscriptionProvider; url?: string; code?: string; relay?: string; started?: boolean }
  | { kind: 'done'; provider: SubscriptionProvider; outcome: AuthOutcome; url?: string }

export function AuthDialog({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const auth = useTuiSelector(s => s.auth)
  const props = (overlay.props ?? {}) as AuthOverlayProps
  const [cursor, setCursor] = useState(Math.max(0, SUBSCRIPTIONS.indexOf(props.login ?? 'chatgpt')))
  const [flow, setFlow] = useState<Flow>({ kind: 'list' })
  const [note, setNote] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const abort = useRef<AbortController | null>(null)
  const dialogWidth = Math.max(50, Math.min(width - 4, 84))

  useEffect(() => {
    void store.actions.refreshAuth()
    if (props.login) start(props.login)
    return () => abort.current?.abort()
  }, [])

  const start = (provider: SubscriptionProvider) => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setNote(null)
    setPasted('')
    setFlow({ kind: 'running', provider })
    void signIn(store.client, provider, ctrl.signal, {
      onChatGpt: info => setFlow({ kind: 'running', provider, url: info.authUrl, relay: info.mode === 'relay' ? info.redirectUri : undefined }),
      onGrok: info => setFlow({ kind: 'running', provider, url: info.verificationUri, code: info.userCode }),
      onClaude: info => setFlow({ kind: 'running', provider, url: info.url || undefined, started: true }),
    }).then(outcome => {
      if (ctrl.signal.aborted && !outcome.ok) return
      abort.current = null
      void store.actions.refreshAuth()
      const label = SUBSCRIPTION_LABELS[provider]
      if (outcome.ok) store.actions.toast(`Signed in to ${label}${outcome.email ? ` as ${outcome.email}` : ''}`, 'success')
      setFlow(prev => ({ kind: 'done', provider, outcome, url: prev.kind === 'running' ? prev.url : undefined }))
    })
  }

  const cancel = () => {
    if (flow.kind !== 'running') return
    abort.current?.abort()
    abort.current = null
    setNote(`${SUBSCRIPTION_LABELS[flow.provider]} sign-in cancelled.`)
    setFlow({ kind: 'list' })
  }

  const sendCode = (value: string) => {
    const code = value.trim()
    if (!code) return false
    setPasted('')
    setNote('Sending the code to Claude Code…')
    store.client.submitClaudeCode(code).then(
      () => setNote('Code sent. Waiting for Claude Code to finish…'),
      (err: unknown) => setNote(`Could not send the code: ${err instanceof Error ? err.message : String(err)}`),
    )
    return true
  }

  const copyUrl = (url: string | undefined) => {
    if (!url) return
    void copyToClipboard(url).then(ok => setNote(ok ? 'URL copied to the clipboard.' : 'Could not copy; select the URL with the mouse instead.'))
  }

  useKeys((input, key) => {
    if (key.ctrl && input === 'c') { if (flow.kind === 'running') cancel(); else close(); return true }
    switch (flow.kind) {
      case 'list': {
        if (key.escape) { close(); return true }
        if (key.upArrow || input === 'k') { setCursor(c => Math.max(0, c - 1)); return true }
        if (key.downArrow || input === 'j') { setCursor(c => Math.min(SUBSCRIPTIONS.length - 1, c + 1)); return true }
        const provider = SUBSCRIPTIONS[cursor]
        if (key.return || input === 'l') { start(provider); return true }
        if (input === 'o' && statusOf(auth, provider)?.authenticated) { setFlow({ kind: 'signout', provider }); return true }
        if (input === 'r') { void store.actions.refreshAuth(); return true }
        return true
      }
      case 'signout':
        if (input === 'y' || key.return) {
          const provider = flow.provider
          setFlow({ kind: 'list' })
          void store.actions.logoutSubscription(provider)
        } else if (input === 'n' || key.escape) setFlow({ kind: 'list' })
        return true
      case 'running':
        if (key.escape) { cancel(); return true }
        // Claude: printable keys go to the code box (registered later, so it sees them first).
        if (input === 'c' && flow.provider !== 'claude') { copyUrl(flow.url); return true }
        return true
      case 'done':
        if (key.escape || key.return) { if (flow.outcome.ok) close(); else setFlow({ kind: 'list' }); return true }
        if (input === 'r' && !flow.outcome.ok) { start(flow.provider); return true }
        if (input === 'c') { copyUrl(flow.url); return true }
        return true
    }
  }, { layer: 'overlay' })

  const noteLine = note ? <Text color={theme.color.muted} wrap="wrap">{note}</Text> : null

  if (flow.kind === 'running' || flow.kind === 'done') {
    const label = SUBSCRIPTION_LABELS[flow.provider]
    const running = flow.kind === 'running'
    const code = running ? flow.code : undefined
    const url = flow.url
    const claude = flow.provider === 'claude'
    const claudeWaiting = running && claude && !!flow.started
    const hints: KeyHintSpec[] = running
      ? claude
        ? [...(claudeWaiting ? [{ keys: 'enter', label: 'send code' }] : []), { keys: 'esc', label: 'cancel' }]
        : [...(url ? [{ keys: 'c', label: 'copy URL' }] : []), { keys: 'esc', label: 'cancel' }]
      : flow.outcome.ok ? [{ keys: 'enter', label: 'close' }] : [{ keys: 'r', label: 'try again' }, { keys: 'esc', label: 'back' }]
    return (
      <Modal title={`Sign in to ${label}`} width={dialogWidth} hints={hints}>
        {running && !url && !(running && flow.started) ? <Spinner label={`asking the daemon to start ${label} sign-in…`} /> : null}
        {claude ? <Text color={theme.color.muted} wrap="wrap">{CLAUDE_EXPLAINER}</Text> : null}
        {code ? (
          <Box flexDirection="column" alignItems="center" marginBottom={1}>
            <Text color={theme.color.muted}>Enter this code in the browser:</Text>
            <Box borderStyle={theme.ascii ? 'classic' : 'double'} borderColor={theme.color.accent} paddingX={3}>
              <Text bold color={theme.color.accent}>{spacedCode(code)}</Text>
            </Box>
          </Box>
        ) : null}
        {url ? (
          <>
            <Text color={theme.color.muted}>{code ? 'on this page (the browser should open it):' : claude ? 'Claude Code is opening the sign-in page in the browser on the daemon host. If it does not open there, open this URL:' : 'The browser should open. If it does not, open this URL:'}</Text>
            <Text color={theme.color.info} wrap="wrap">{url}</Text>
          </>
        ) : null}
        {claudeWaiting ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.color.text}>If the page shows a code, paste it here (or wait):</Text>
            <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={theme.color.borderFocus} paddingX={1}>
              <TextInput value={pasted} onChange={setPasted} onSubmit={sendCode} focused keyLayer="overlay" maxRows={2} placeholder="code from the Claude sign-in page" />
            </Box>
          </Box>
        ) : null}
        {running && (url || claudeWaiting) ? <Box marginTop={1}><Spinner label={flow.relay ? `waiting for you to finish in the browser… (callback on ${flow.relay})` : 'waiting for you to finish in the browser…'} /></Box> : null}
        {!running ? (
          flow.outcome.ok
            ? <Box marginTop={1}><Text bold color={theme.color.success}>{theme.glyph.check} Signed in to {label}{flow.outcome.email ? ` as ${flow.outcome.email}` : ''}.</Text></Box>
            : <Box marginTop={1}><Text bold color={theme.color.error} wrap="wrap">{theme.glyph.cross} Sign-in failed: {flow.outcome.error}</Text></Box>
        ) : null}
        {noteLine}
      </Modal>
    )
  }

  const hints: KeyHintSpec[] = [{ keys: 'up down', label: 'provider' }, { keys: 'enter', label: 'sign in' }]
  if (statusOf(auth, SUBSCRIPTIONS[cursor])?.authenticated) hints.push({ keys: 'o', label: 'sign out' })
  hints.push({ keys: 'r', label: 'refresh' }, { keys: 'esc', label: 'close' })
  return (
    <Modal title="Provider sign-in" width={dialogWidth} hints={flow.kind === 'signout' ? [] : hints}>
      <Text wrap="wrap" color={theme.color.muted}>{AUTH_EXPLAINER}</Text>
      <Box flexDirection="column" marginTop={1}>
        {SUBSCRIPTIONS.map((provider, i) => {
          const selected = i === cursor
          const status = describeStatus(statusOf(auth, provider))
          return (
            <Text key={provider} wrap="truncate-end" inverse={theme.mono && selected}>
              <Text color={theme.color.accent}>{selected ? `${theme.glyph.pointer} ` : '  '}</Text>
              <Text bold={selected} color={theme.color.text}>{SUBSCRIPTION_LABELS[provider].padEnd(9)}</Text>
              <Text color={status.ok ? theme.color.success : theme.color.warn}>{status.ok ? theme.glyph.check : theme.glyph.dot} </Text>
              <Text color={status.ok ? theme.color.text : theme.color.muted}>{auth ? status.text : 'reading…'}</Text>
            </Text>
          )
        })}
      </Box>
      {flow.kind === 'signout' ? (
        <Text bold color={theme.color.warn} wrap="wrap">{theme.glyph.warn} Sign the daemon out of {SUBSCRIPTION_LABELS[flow.provider]}? Agents using it stop working until you sign in again. y sign out {theme.glyph.sep} n keep</Text>
      ) : null}
      {noteLine}
    </Modal>
  )
}
