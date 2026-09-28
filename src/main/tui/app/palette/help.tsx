// Full keys + commands reference, grouped by view. Built from the registry,
// so every view's commands and palette actions show up without edits here.

import { Box, Text } from 'ink'
import { useTheme } from '../theme'
import { useShell } from '../shell-context'
import { useKeys, keyLabel } from '../keys'
import { CONFIRM_KEYS, GLYPHS, SHELL_KEYS, SIDEBAR_KEYS } from '../shell-keys'
import { useStore, type TuiStore } from '../../state/store'
import { createScope, type CommandRegistry } from '../../commands/registry'
import type { SlashCommand } from '../../commands/types'
import { Modal } from '../../ui/Modal'
import type { OverlayProps, ViewDefinition } from '../../views/types'
import { LinesView } from '../../views/inspect/LinesView'
import { blank, heading, plain, type Line } from '../../views/inspect/format'

const KEY_COL = 18

// Paragraphs; the help view word-wraps them to its width.
export const LOOPS_EXPLAINER = [
  'Loops are an agent’s parallel chat sessions (threads), each with its own history.',
  'main is the agent itself and talks to you. Inner loops (also called side loops) are extra threads with their own goal: a consolidator that tidies memory on a recurring timer, a researcher you hand questions to, a critic. They run on demand, when main hands work over, or on a schedule.',
  'Pick a loop in the sidebar or with Shift+←/→ to chat with it and see its transcript; create, edit, enable, disable, delete and schedule inner loops in the Loops view (4).',
]

/**
 * Word-wrap lines to `width`. Continuations hang under the last segment
 * (a key's description stays under the description column); a prefix wider
 * than half the width hangs by 4 instead.
 */
export function wrapLines(lines: Line[], width: number): Line[] {
  const out: Line[] = []
  for (const line of lines) {
    const total = line.reduce((n, s) => n + s.text.length, 0)
    if (total <= width || line.length === 0) { out.push(line); continue }
    const last = line[line.length - 1]
    let prefix = line.slice(0, -1)
    let body = last.text
    if (prefix.length === 0) {
      const lead = body.match(/^\s*/)?.[0] ?? ''
      prefix = lead ? [{ text: lead }] : []
      body = body.slice(lead.length)
    }
    const prefixWidth = prefix.reduce((n, s) => n + s.text.length, 0)
    const hang = prefixWidth <= width / 2 ? prefixWidth : 4
    const first = Math.max(8, width - prefixWidth)
    const rest = Math.max(8, width - hang)
    const chunks = wrapWords(body, first, rest)
    out.push([...prefix, { ...last, text: chunks[0] ?? '' }])
    for (const chunk of chunks.slice(1)) out.push([{ text: ' '.repeat(hang) }, { ...last, text: chunk }])
  }
  return out
}

function wrapWords(text: string, first: number, rest: number): string[] {
  const out: string[] = []
  let current = ''
  let room = first
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word
    while (w.length > room && current === '') {
      out.push(w.slice(0, room))
      w = w.slice(room)
      room = rest
    }
    if (!current) { current = w; continue }
    if (current.length + 1 + w.length <= room) { current += ` ${w}`; continue }
    out.push(current)
    current = w
    room = rest
  }
  if (current || out.length === 0) out.push(current)
  return out
}

function keyLine(keys: string, label: string): Line {
  const text = keys.split(' ').map(keyLabel).join(' ')
  return [{ text: '  ' }, { text: text.padEnd(KEY_COL), tone: 'accent' }, { text: label }]
}

function commandLine(command: SlashCommand): Line {
  const name = `/${command.name}${command.args ? ` ${command.args}` : ''}`
  const aliases = command.aliases?.length ? ` (${command.aliases.map(a => `/${a}`).join(' ')})` : ''
  return [{ text: '  ' }, { text: name, tone: 'accent' }, { text: `${aliases}  `, tone: 'muted' }, { text: command.description }]
}

export function helpLines(views: ViewDefinition[], registry: CommandRegistry, store: TuiStore, exit: () => void, activeView?: string): Line[] {
  const scope = createScope(store, exit)
  const lines: Line[] = [heading('Loops'), ...LOOPS_EXPLAINER.map(t => plain(`  ${t}`, 'muted')), blank()]
  lines.push(heading('Shell keys'))
  for (const k of SHELL_KEYS) lines.push(keyLine(k.keys, k.label))
  lines.push(blank(), heading('Sidebar: the fleet tree (Tab to focus)'))
  for (const k of SIDEBAR_KEYS) lines.push(keyLine(k.keys, k.label))
  lines.push(blank(), heading('Dialogs'))
  for (const k of CONFIRM_KEYS) lines.push(keyLine(k.keys, k.label))
  lines.push(blank(), heading('Legend: sidebar, tabs and header'))
  for (const g of GLYPHS) lines.push([{ text: '  ' }, { text: g.glyph.padEnd(KEY_COL), tone: 'accent' }, { text: g.label }])

  const byView = new Map<string, SlashCommand[]>()
  const seen = new Set<SlashCommand>()
  for (const command of registry.commands) {
    if (seen.has(command)) continue
    seen.add(command)
    const owner = command.view ?? 'builtin'
    byView.set(owner, [...(byView.get(owner) ?? []), command])
  }

  lines.push(blank(), heading('Shell commands'))
  for (const command of byView.get('builtin') ?? []) lines.push(commandLine(command))

  const ordered = [...views].sort((a, b) => (a.id === activeView ? -1 : b.id === activeView ? 1 : 0))
  for (const view of ordered) {
    const hints = typeof view.keyHints === 'function' ? view.keyHints(scope) : view.keyHints ?? []
    const commands = byView.get(view.id) ?? []
    const actions = registry.actions.filter(a => a.view === view.id)
    lines.push(blank(), [{ text: `${view.key} ${view.title}`, tone: 'heading', bold: true }, { text: view.id === activeView ? '  (current view)' : '', tone: 'muted' }])
    if (view.helpKeys) {
      for (const section of view.helpKeys) {
        if (section.title) lines.push(plain(`  ${section.title}`, 'muted'))
        for (const k of section.keys) lines.push(keyLine(k.keys, k.label))
      }
    } else {
      for (const hint of hints) lines.push(keyLine(hint.keys, hint.label))
    }
    for (const command of commands) lines.push(commandLine(command))
    for (const action of actions) {
      lines.push([{ text: '  ' }, { text: (action.shortcut ? keyLabel(action.shortcut) : 'palette').padEnd(KEY_COL), tone: action.shortcut ? 'accent' : 'dim' }, { text: action.title }])
    }
    if (!view.helpKeys && hints.length === 0 && commands.length === 0 && actions.length === 0) lines.push(plain('  (no keys of its own)', 'dim'))
  }

  const builtinActions = registry.actions.filter(a => !a.view || a.view === 'builtin')
  if (builtinActions.length) {
    lines.push(blank(), heading('Palette actions'))
    for (const action of builtinActions) {
      lines.push([{ text: '  ' }, { text: (action.shortcut ? keyLabel(action.shortcut) : '').padEnd(KEY_COL), tone: 'accent' }, { text: action.title }])
    }
  }
  if (registry.conflicts.length) {
    lines.push(blank(), heading('Command name conflicts'))
    for (const c of registry.conflicts) lines.push(plain(`  ${c}`, 'warn'))
  }
  return lines
}

export function HelpOverlay({ close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { views, registry, exit } = useShell()
  useKeys((input, key) => {
    if (key.escape || input === 'q' || input === '?' || key.return || (key.ctrl && input === 'c')) { close(); return true }
    return false
  }, { layer: 'overlay' })
  const dialogWidth = Math.max(30, Math.min(width - 4, 96))
  const inner = dialogWidth - 4
  const bodyHeight = Math.max(4, height - 7)
  const lines = helpLines(views, registry, store, exit, store.getState().activeView)
  return (
    <Modal title="ADF keys & commands" width={dialogWidth} hints={[{ keys: 'up down', label: 'scroll' }, { keys: 'pgup pgdn', label: 'page' }, { keys: 'esc', label: 'close' }]}>
      <Box flexDirection="column" height={bodyHeight}>
        <LinesView lines={wrapLines(lines, inner)} width={inner} height={bodyHeight} keyLayer="overlay" />
      </Box>
      <Text color={theme.color.dim} wrap="truncate-end">Ctrl+K searches all of this.</Text>
    </Modal>
  )
}
