// Command palette (Ctrl+K, `:`): fuzzy search over views, agents, every loop
// of every agent, all slash commands and palette actions, and recent files.
// Enter runs; commands that need arguments prefill the prompt instead.

import { useEffect, useMemo, useRef, useState } from 'react'
import { isTrackedKey } from '../state/tracked'
import { Box, Text, type DOMElement } from 'ink'
import { useTheme } from './theme'
import { useShell } from './shell-context'
import { useKeys, useWheel, keyLabel } from './keys'
import { useStore, useTuiSelector } from '../state/store'
import { Modal } from '../ui/Modal'
import { displayWidth, truncate } from '../ui/text'
import type { FileListEntry } from '../api/types'
import type { OverlayProps } from '../views/types'
import { buildEntries, rankEntries, rememberRun, type PaletteEntry } from './palette/entries'

export { fuzzyScore, scoreEntry } from './palette/fuzzy'
export { buildEntries, rankEntries, recordRecentFile, needsArgs, type PaletteEntry } from './palette/entries'
export { HelpOverlay, helpLines, LOOPS_EXPLAINER } from './palette/help'

/** Palette props: `agents` narrows it to the agent / loop picker (the header's agent label). */
export interface PaletteProps { mode?: 'agents' }

const inSwitcher = (e: PaletteEntry) => e.id.startsWith('agent:') || e.id.startsWith('loop:')

export function Palette({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { views, registry, exit } = useShell()
  const switcher = (overlay.props as PaletteProps | undefined)?.mode === 'agents'
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [files, setFiles] = useState<FileListEntry[] | undefined>(undefined)
  const agentId = useTuiSelector(s => s.selectedAgentId)
  // Rebuild when agents/loops change while the palette is open.
  const agents = useTuiSelector(s => s.agents)

  useEffect(() => {
    if (!agentId || isTrackedKey(agentId)) return
    let cancelled = false
    store.client.files(agentId).then(
      result => { if (!cancelled) setFiles([...result.files].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))) },
      () => { /* recent files are optional; the palette works without them */ },
    )
    return () => { cancelled = true }
  }, [store, agentId])

  const entries = useMemo(() => {
    const all = buildEntries({ store, views, registry, exit, loopGlyph: theme.glyph.loop, files })
    return switcher ? all.filter(inSwitcher) : all
  }, [store, views, registry, exit, theme.glyph.loop, files, agents, switcher])
  const filtered = useMemo(() => rankEntries(entries, query), [entries, query])

  const selected = Math.min(index, Math.max(0, filtered.length - 1))
  const rows = Math.max(3, Math.min(filtered.length || 1, height - 9))
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), filtered.length - rows))

  const choose = () => {
    const entry = filtered[selected]
    if (!entry) return
    rememberRun(entry.id)
    close()
    void Promise.resolve()
      .then(() => entry.run())
      .catch(err => store.actions.toast(`${entry.title}: ${err instanceof Error ? err.message : String(err)}`, 'error'))
  }

  const listRef = useRef<DOMElement>(null)
  useWheel(listRef, delta => setIndex(Math.max(0, Math.min(filtered.length - 1, selected + delta))), { layer: 'overlay' })

  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { close(); return true }
    if (key.return) { choose(); return true }
    if (key.upArrow || (key.ctrl && input === 'p')) { setIndex(Math.max(0, selected - 1)); return true }
    if (key.downArrow || (key.ctrl && input === 'n')) { setIndex(Math.min(filtered.length - 1, selected + 1)); return true }
    if (key.pageUp) { setIndex(Math.max(0, selected - rows)); return true }
    if (key.pageDown) { setIndex(Math.min(filtered.length - 1, selected + rows)); return true }
    if (key.ctrl && input === 'u') { setQuery(''); setIndex(0); return true }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setIndex(0); return true }
    if (key.ctrl && input === 'k') { close(); return true }
    if (input && !key.ctrl && !key.meta && !key.tab && !/[\r\n]/.test(input)) { setQuery(q => q + input); setIndex(0); return true }
    return true
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(30, Math.min(width - 4, 88))
  const inner = dialogWidth - 4
  let lastGroup = ''
  return (
    <Modal title={switcher ? 'Switch agent' : 'Command palette'} width={dialogWidth} hints={[{ keys: 'enter', label: 'run' }, { keys: 'up down', label: 'move' }, { keys: 'ctrl+u', label: 'clear' }, { keys: 'esc', label: 'close' }]}>
      <Text wrap="truncate-end">
        <Text color={theme.color.accent}>{theme.glyph.pointer} </Text>
        <Text color={theme.color.text}>{query}</Text>
        <Text inverse> </Text>
        {query ? null : <Text color={theme.color.dim}>{switcher ? ' agents and loops' : ' agents, loops, /commands, views, files'}</Text>}
        <Text color={theme.color.dim}>  {filtered.length} of {entries.length}</Text>
      </Text>
      <Box ref={listRef} flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? <Text color={theme.color.muted}>No match. Esc closes; /help lists everything.</Text> : null}
        {filtered.slice(start, start + rows).map((entry, i) => {
          const isSelected = start + i === selected
          const showGroup = !query && entry.group !== lastGroup
          lastGroup = entry.group
          return <PaletteRow key={`${entry.group}:${entry.id}`} entry={entry} selected={isSelected} width={inner} group={showGroup || !!query ? entry.group : ''} />
        })}
      </Box>
    </Modal>
  )
}

function PaletteRow({ entry, selected, width, group }: { entry: PaletteEntry; selected: boolean; width: number; group: string }) {
  const theme = useTheme()
  const shortcut = entry.shortcut ? entry.shortcut.split(' ').map(keyLabel).join('/') : ''
  const groupCol = 9
  const shortcutCol = shortcut ? displayWidth(shortcut) + 2 : 0
  const room = Math.max(8, width - groupCol - shortcutCol - 2)
  const title = truncate(entry.title, Math.max(6, Math.min(room, Math.floor(room * (entry.hint ? 0.55 : 1)))))
  const hintRoom = Math.max(0, room - displayWidth(title) - 2)
  const hint = entry.hint && hintRoom > 4 ? truncate(entry.hint, hintRoom) : ''
  const fg = selected ? theme.color.selectionFg : undefined
  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate-end" backgroundColor={selected ? theme.color.selectionBg : undefined} inverse={theme.mono && selected} bold={selected}>
        <Text color={fg ?? theme.color.accent}>{selected ? theme.glyph.pointer : ' '} </Text>
        <Text color={fg ?? theme.color.text}>{title}</Text>
        {hint ? <Text color={fg ?? theme.color.muted}>  {hint}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        {shortcut ? <Text color={theme.color.accent} bold>{shortcut}  </Text> : null}
        <Text color={theme.color.dim}>{truncate(group, groupCol).padStart(groupCol)}</Text>
      </Text>
    </Box>
  )
}

/** Push the palette overlay (no-op when it is already on top). */
export function openPalette(store: ReturnType<typeof useStore>): void {
  const top = store.getState().overlays.at(-1)
  if (top?.kind === 'palette') return
  store.actions.pushOverlay({ id: 'palette', kind: 'palette' })
}

/** The palette as an agent / loop picker (the header's agent label: click, or Enter on the tab bar). */
export function openAgentSwitcher(store: ReturnType<typeof useStore>): void {
  const top = store.getState().overlays.at(-1)
  if (top?.kind === 'palette') return
  store.actions.pushOverlay({ id: 'palette', kind: 'palette', props: { mode: 'agents' } satisfies PaletteProps })
}
