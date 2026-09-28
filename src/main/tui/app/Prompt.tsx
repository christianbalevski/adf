import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from './theme'
import { useTerminalCaps } from './terminal'
import { useShell } from './shell-context'
import { PROMPT_PREFILL_KEY, useStore, useTuiSelector } from '../state/store'
import { useActiveView, useSelectedAgent, useSelectedLoop, useViewState } from '../state/hooks'
import { completeSlash, createScope, runSlash } from '../commands/registry'
import { TextInput } from '../ui/TextInput'
import { truncate } from '../ui/text'
import { MAIN_LOOP } from '../api/types'
import type { PromptCompletion } from '../views/types'

const HISTORY_LIMIT = 200
const MENU_ROWS = 6
export const PROMPT_HISTORY_KEY = 'shell.prompt.history'
export const PROMPT_DRAFTS_KEY = 'shell.prompt.drafts'
const EMPTY_HISTORY: string[] = []

// Whether the prompt's completion menu is showing: Esc closes it before any
// view's Esc binding (chat's interrupt) sees the key.
let menuShowing = false
export function isPromptMenuOpen(): boolean {
  return menuShowing
}

// Whether the prompt holds no text: chat scrolls its transcript with ↑/↓ then.
let promptEmpty = true
export function isPromptEmpty(): boolean {
  return promptEmpty
}

interface MenuItem {
  key: string
  label: string
  description: string
  accept: () => { value: string; cursor?: number }
}

/**
 * The shell's prompt line. Slash input runs through the command registry;
 * other text goes to the active view's `prompt.onSubmit`, else is sent as
 * chat to the selected agent + loop. Views may scope history and drafts
 * (chat: per agent + loop) and add completions (chat: `@path`).
 */
export function Prompt({ width, focused }: { width: number; focused: boolean }) {
  const theme = useTheme()
  const store = useStore()
  const { views, registry, exit } = useShell()
  const activeView = useActiveView()
  const agent = useSelectedAgent()
  const loop = useSelectedLoop()
  const [value, setValue] = useState('')
  promptEmpty = value.length === 0
  // Placeholders name the newline key; re-render when Shift+Enter turns out to work.
  useTerminalCaps()
  const [menuIndex, setMenuIndex] = useState(0)
  const [custom, setCustom] = useState<PromptCompletion[]>([])
  const [dismissed, setDismissed] = useState(false)
  const prefill = useTuiSelector(s => s.viewState[PROMPT_PREFILL_KEY] as { text: string; nonce: string } | undefined)

  const view = views.find(v => v.id === activeView)
  const config = view?.prompt === false ? undefined : view?.prompt
  const scope = createScope(store, exit)
  const historySlot = config?.historyKey ? `${PROMPT_HISTORY_KEY}:${config.historyKey(scope)}` : PROMPT_HISTORY_KEY
  const draftKey = config?.draftKey ? config.draftKey(scope) : 'shell'
  const [history, setHistory] = useViewState<string[]>(historySlot, EMPTY_HISTORY)

  // Drafts: park the unsent text under the old key, restore the new key's.
  const valueRef = useRef(value)
  valueRef.current = value
  const draftRef = useRef(draftKey)
  useEffect(() => {
    const previous = draftRef.current
    if (previous === draftKey) return
    draftRef.current = draftKey
    const drafts = (store.getState().viewState[PROMPT_DRAFTS_KEY] as Record<string, string> | undefined) ?? {}
    store.actions.setViewState(PROMPT_DRAFTS_KEY, { ...drafts, [previous]: valueRef.current })
    setValue(drafts[draftKey] ?? '')
    setMenuIndex(0)
    setDismissed(false)
  }, [draftKey])

  useEffect(() => {
    if (prefill) { setValue(prefill.text); setDismissed(false) }
  }, [prefill?.nonce])

  const target = agent ? `${agent.summary.handle || agent.summary.name} ${theme.glyph.pointer} ${loop}` : null
  const placeholder = typeof config?.placeholder === 'function'
    ? config.placeholder(scope)
    : config?.placeholder ?? (target ? `Message ${target}   / for commands` : 'Select an agent (Tab → sidebar) or type /help')

  const slashing = focused && value.startsWith('/') && !value.includes('\n')
  const slash = useMemo(
    () => (slashing ? completeSlash(value, registry, scope).slice(0, MENU_ROWS) : []),
    [slashing, value, registry, scope.agentId, scope.loop],
  )

  // View completions (may be async); stale answers are dropped.
  const completeRequest = useRef(0)
  useEffect(() => {
    const id = ++completeRequest.current
    if (!focused || slashing || !config?.complete || !value) { setCustom([]); return }
    Promise.resolve(config.complete(value, value.length, scope)).then(
      items => { if (completeRequest.current === id) setCustom(items.slice(0, MENU_ROWS)) },
      () => { if (completeRequest.current === id) setCustom([]) },
    )
  }, [focused, slashing, value, activeView, scope.agentId, scope.loop])

  const menu: MenuItem[] = slashing
    ? slash.map(s => ({
      key: s.value,
      label: `${s.value}${s.command.args ? ` ${s.command.args}` : ''}`,
      description: s.command.description,
      // Completing into a path (`/load C:\agents\`) keeps the caret there.
      accept: () => ({ value: /[\\/]$/.test(s.value) ? s.value : `${s.value} ` }),
    }))
    : custom.map(c => ({ key: `${c.label}:${c.value}`, label: c.label, description: c.description ?? '', accept: () => ({ value: c.value, cursor: c.cursor }) }))
  const menuOpen = !dismissed && menu.length > 0 && !(slashing && slash.length === 1 && slash[0].value === value.trimEnd())
  menuShowing = focused && menuOpen
  useEffect(() => () => { menuShowing = false }, [])
  const highlighted = Math.min(menuIndex, Math.max(0, menu.length - 1))

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return false
    setHistory(prev => [...prev.filter(h => h !== trimmed), trimmed].slice(-HISTORY_LIMIT))
    setMenuIndex(0)
    void (async () => {
      if (await runSlash(trimmed, registry, store, exit)) return
      const ctx = { ...createScope(store, exit), args: [], rest: trimmed }
      if (config?.onSubmit && await config.onSubmit(trimmed, ctx)) return
      if (!ctx.agentId) {
        store.actions.toast('No agent selected — pick one in the sidebar (Tab) or /agent <handle>', 'warn')
        return
      }
      const sent = await store.actions.sendChat(trimmed)
      if (sent && store.getState().activeView !== 'chat') {
        const summary = store.getState().agents[ctx.agentId]?.summary
        store.actions.toast(`Sent to ${summary?.handle || summary?.name || ctx.agentId} ${theme.glyph.pointer} ${ctx.loop ?? MAIN_LOOP}`, 'success', 2500)
      }
    })()
    return true
  }

  return (
    <Box flexDirection="column" width={width}>
      {menuOpen ? (
        <Box flexDirection="column" marginBottom={0}>
          {menu.map((item, i) => (
            <Text key={item.key} wrap="truncate-end">
              <Text color={i === highlighted ? theme.color.selectionFg : theme.color.accent} backgroundColor={i === highlighted ? theme.color.selectionBg : undefined} inverse={theme.mono && i === highlighted}>
                {' '}{item.label}{' '}
              </Text>
              {item.description ? <Text color={theme.color.muted}>  {truncate(item.description, Math.max(10, width - item.label.length - 12))}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={focused ? theme.color.borderFocus : theme.color.border} paddingX={1} width={width} flexDirection="column">
        <TextInput
          value={value}
          onChange={next => { setValue(next); setMenuIndex(0); setDismissed(false) }}
          onSubmit={submit}
          placeholder={placeholder}
          history={history}
          focused={focused}
          onKey={(_input, key, api) => {
            if (!menuOpen) return false
            // Esc closes the menu and keeps the prompt focused (Tab leaves the prompt).
            if (key.escape) { setDismissed(true); return true }
            if (key.upArrow) { setMenuIndex(i => (i - 1 + menu.length) % menu.length); return true }
            if (key.downArrow) { setMenuIndex(i => (i + 1) % menu.length); return true }
            if (key.tab) {
              const next = menu[highlighted].accept()
              api.setValue(next.value, next.cursor)
              return true
            }
            return false
          }}
        />
      </Box>
    </Box>
  )
}
