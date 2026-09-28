import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { List } from '../../ui/List'
import { Modal } from '../../ui/Modal'
import { THEMES, applyTheme, findTheme, nextThemeName, type ThemeChoice } from '../../commands/builtin/themes'
import type { OverlayProps } from '../types'

/** /theme [name|next]: apply directly, or pick from a list with swatches. */
export function ThemeOverlay({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const requested = typeof overlay.props?.name === 'string' ? overlay.props.name : ''
  const currentIndex = Math.max(0, THEMES.findIndex(t => t.name === theme.name))
  const [index, setIndex] = useState(currentIndex)

  const apply = (choice: ThemeChoice) => {
    applyTheme(theme, choice)
    close()
    // The toast re-renders the whole shell with the new palette.
    store.actions.toast(`Theme: ${choice.label}${choice.colors ? '' : ' (no color)'}`, 'success', 2500)
  }

  useEffect(() => {
    if (!requested) return
    const choice = requested === 'next' ? findTheme(nextThemeName(theme.name)) : findTheme(requested)
    if (choice) apply(choice)
    else {
      close()
      store.actions.toast(`No theme "${requested}". Themes: ${THEMES.map(t => t.name).join(', ')}`, 'warn')
    }
  }, [])

  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { close(); return true }
    return false
  }, { layer: 'overlay', active: !requested })

  if (requested) return null
  const dialogWidth = Math.max(30, Math.min(width - 4, 72))
  return (
    <Modal title="Color theme" width={dialogWidth} hints={[{ keys: 'enter', label: 'apply' }, { keys: 'up down', label: 'move' }, { keys: 'esc', label: 'cancel' }]}>
      <List
        items={THEMES}
        getKey={t => t.name}
        height={THEMES.length}
        width={dialogWidth - 4}
        keyLayer="overlay"
        selectedIndex={index}
        onSelectedIndexChange={setIndex}
        onSubmit={apply}
        renderItem={(t, { selected }) => (
          <Text wrap="truncate-end">
            <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
            <Text bold={selected} inverse={theme.mono && selected} color={theme.color.text}>{t.label.padEnd(18)}</Text>
            <Swatch choice={t} show={!theme.mono} block={theme.ascii ? '#' : '█'} />
            <Text color={theme.color.muted}> {t.name === theme.name ? '(current) ' : ''}{t.description}</Text>
          </Text>
        )}
      />
      {theme.mono ? <Text color={theme.color.dim} wrap="wrap">Color is off (NO_COLOR, --mono or the mono theme). Picking a color theme turns it on for this session.</Text> : null}
    </Modal>
  )
}

function Swatch({ choice, show, block }: { choice: ThemeChoice; show: boolean; block: string }) {
  if (!show || !choice.colors) return <Text>{'      '}</Text>
  const c = choice.colors
  return (
    <Text>
      <Text color={c.accent}>{block}</Text>
      <Text color={c.live}>{block}</Text>
      <Text color={c.loop}>{block}</Text>
      <Text color={c.tool}>{block}</Text>
      <Text color={c.success}>{block}</Text>
      <Text color={c.error}>{block}</Text>
    </Text>
  )
}
