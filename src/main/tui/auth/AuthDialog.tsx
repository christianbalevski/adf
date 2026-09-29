// Provider sign-in (ChatGPT, Grok): status of each subscription, sign in,
// sign out. Sign-in runs the same flows as `adf auth login` (cli/auth-flow.ts):
// ChatGPT opens the browser (URL shown too), Grok shows a device code.

import { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useStore, useTuiSelector } from '../state/store'
import { Modal } from '../ui/Modal'
import { Spinner } from '../ui/Spinner'
import type { KeyHintSpec } from '../ui/KeyHint'
import type { SubscriptionProvider } from '../api/types'
import type { OverlayProps } from '../views/types'
import { copyToClipboard } from '../views/chat/model'
import { signIn, type AuthOutcome } from './flow'
import { AUTH_EXPLAINER, SUBSCRIPTIONS, SUBSCRIPTION_LABELS, describeStatus, spacedCode, statusOf, type AuthOverlayProps } from './model'

type Flow =
  | { kind: 'list' }
  | { kind: 'signout'; provider: SubscriptionProvider }
  | { kind: 'running'; provider: SubscriptionProvider; url?: string; code?: string; relay?: string }
  | { kind: 'done'; provider: SubscriptionProvider; outcome: AuthOutcome; url?: string }

export function AuthDialog({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const auth = useTuiSelector(s => s.auth)
  const props = (overlay.props ?? {}) as AuthOverlayProps
  const [cursor, setCursor] = useState(Math.max(0, SUBSCRIPTIONS.indexOf(props.login ?? 'chatgpt')))
  const [flow, setFlow] = useState<Flow>({ kind: 'list' })
  const [note, setNote] = useState<string | null>(null)
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
    setFlow({ kind: 'running', provider })
    void signIn(store.client, provider, ctrl.signal, {
      onChatGpt: info => setFlow({ kind: 'running', provider, url: info.authUrl, relay: info.mode === 'relay' ? info.redirectUri : undefined }),
      onGrok: info => setFlow({ kind: 'running', provider, url: info.verificationUri, code: info.userCode }),
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
        if (input === 'c') { copyUrl(flow.url); return true }
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
    const hints: KeyHintSpec[] = running
      ? [...(url ? [{ keys: 'c', label: 'copy URL' }] : []), { keys: 'esc', label: 'cancel' }]
      : flow.outcome.ok ? [{ keys: 'enter', label: 'close' }] : [{ keys: 'r', label: 'try again' }, { keys: 'esc', label: 'back' }]
    return (
      <Modal title={`Sign in to ${label}`} width={dialogWidth} hints={hints}>
        {running && !url ? <Spinner label={`asking the daemon to start ${label} sign-in…`} /> : null}
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
            <Text color={theme.color.muted}>{code ? 'on this page (the browser should open it):' : 'The browser should open. If it does not, open this URL:'}</Text>
            <Text color={theme.color.info} wrap="wrap">{url}</Text>
          </>
        ) : null}
        {running && url ? <Box marginTop={1}><Spinner label={flow.relay ? `waiting for you to finish in the browser… (callback on ${flow.relay})` : 'waiting for you to finish in the browser…'} /></Box> : null}
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
