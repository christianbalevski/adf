// The welcome dialog: what ADF is, then the getting-started checklist.
// Enter runs the selected step's command, ↑/↓ pick, d = don't show again,
// Esc closes. Opens over the normal UI and never blocks it: every key but
// these goes nowhere while it is open, and it is one Esc away.

import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../app/theme'
import { useKeys } from '../app/keys'
import { useShell } from '../app/shell-context'
import { useStore, useTuiSelector } from '../state/store'
import { runSlash } from '../commands/registry'
import { Modal } from '../ui/Modal'
import { truncate, wrapText } from '../ui/text'
import type { OverlayProps } from '../views/types'
import {
  WELCOME_INTRO,
  WELCOME_TITLE,
  dismissWelcome,
  enabledAdapters,
  nextStepIndex,
  welcomeFacts,
  welcomeSteps,
  type WelcomeExtras,
} from './welcome'

const LABEL = 21

export function WelcomeDialog({ close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { registry, exit } = useShell()
  const identity = useTuiSelector(s => s.identity)
  const auth = useTuiSelector(s => s.auth)
  const agents = useTuiSelector(s => s.agents)
  const agentOrder = useTuiSelector(s => s.agentOrder)
  const [extras, setExtras] = useState<WelcomeExtras>({ adapters: {}, timers: {} })

  // Adapters and timers are not in the state: read them once, quietly (a
  // failure only leaves a step unticked).
  useEffect(() => {
    let live = true
    const ids = store.getState().agentOrder
    void Promise.all(ids.map(async id => {
      const entry = store.getState().agents[id]
      const [config, timers] = await Promise.all([
        entry?.config ? Promise.resolve(entry.config) : store.client.config(id).then(r => r.config, () => undefined),
        store.client.timers(id).then(r => r.timers.length, () => 0),
      ])
      return { id, adapters: enabledAdapters(config as never), timers }
    })).then(rows => {
      if (!live) return
      setExtras({
        adapters: Object.fromEntries(rows.map(r => [r.id, r.adapters])),
        timers: Object.fromEntries(rows.map(r => [r.id, r.timers])),
      })
    })
    return () => { live = false }
  }, [store, agentOrder.join('|')])

  const steps = useMemo(
    () => welcomeSteps(welcomeFacts({ identity, auth, agents, agentOrder }, extras)),
    [identity, auth, agents, agentOrder, extras],
  )
  const [index, setIndex] = useState(() => nextStepIndex(steps))
  const selected = Math.min(index, steps.length - 1)

  const start = () => {
    const step = steps[selected]
    close()
    if (step) void runSlash(step.run, registry, store, exit)
  }

  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { close(); return true }
    if (key.return) { start(); return true }
    if (key.upArrow || input === 'k') { setIndex(Math.max(0, selected - 1)); return true }
    if (key.downArrow || input === 'j') { setIndex(Math.min(steps.length - 1, selected + 1)); return true }
    if (input === 'd' || input === 'D') {
      dismissWelcome()
      close()
      store.actions.toast('Welcome hidden for good · /welcome brings it back', 'info')
      return true
    }
    return true
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(40, Math.min(width - 4, 90))
  const inner = dialogWidth - 4
  // Short terminals lose the blank spacer lines first.
  const roomy = height >= 22
  const commandWidth = Math.max(10, inner - LABEL - 4)
  const mark = (done: boolean) => (theme.ascii ? (done ? '[x]' : '[ ]') : done ? theme.glyph.check : theme.glyph.ring)

  return (
    <Modal
      title={WELCOME_TITLE}
      width={dialogWidth}
      hints={[
        { keys: 'enter', label: 'start next step' },
        { keys: 'up down', label: 'pick' },
        { keys: 'd', label: 'don’t show again' },
        { keys: 'esc', label: 'close' },
      ]}
    >
      {WELCOME_INTRO.map((text, i) => (
        <Box key={i} flexDirection="column" marginBottom={roomy && i < WELCOME_INTRO.length - 1 ? 1 : 0}>
          {wrapText(text, inner).map((line, j) => <Text key={j} color={i === 0 ? theme.color.text : theme.color.muted}>{line}</Text>)}
        </Box>
      ))}
      <Box marginTop={1}><Text bold color={theme.color.accent}>Get started</Text></Box>
      {steps.map((step, i) => {
        const current = i === selected
        return (
          <Text key={step.id} wrap="truncate-end" inverse={theme.mono && current}>
            <Text color={current ? theme.color.accent : theme.color.dim}>{current ? theme.glyph.pointer : ' '}</Text>
            <Text color={step.done ? theme.color.success : theme.color.muted}>{` ${mark(step.done)} `}</Text>
            <Text bold={current} color={step.done ? theme.color.muted : current ? theme.color.accent : theme.color.text}>{truncate(step.label, LABEL).padEnd(LABEL)}</Text>
            <Text color={theme.color.dim}>{truncate(step.shown, commandWidth)}</Text>
          </Text>
        )
      })}
    </Modal>
  )
}
