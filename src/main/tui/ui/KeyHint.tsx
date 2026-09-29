import { Fragment } from 'react'
import { Text } from 'ink'
import { useTheme } from '../app/theme'
import { keyLabel } from '../app/keys'

export interface KeyHintSpec {
  /** Key spec as understood by `matchKey`/`keyLabel`, e.g. `ctrl+k`, `enter`, `?`. */
  keys: string
  label: string
}

/** One `key label` pair. */
export function KeyHint({ keys, label }: KeyHintSpec) {
  const theme = useTheme()
  return (
    <Text>
      <Text bold color={theme.color.accent}>{keys.split(' ').map(keyLabel).join('/')}</Text>
      <Text color={theme.color.muted}> {label}</Text>
    </Text>
  )
}

/** A row of hints separated by the theme separator. */
export function KeyHints({ hints }: { hints: KeyHintSpec[] }) {
  const theme = useTheme()
  return (
    <Text wrap="truncate-end">
      {hints.map((hint, index) => (
        <Fragment key={`${hint.keys}:${hint.label}`}>
          {index > 0 ? <Text color={theme.color.dim}> {theme.glyph.sep} </Text> : null}
          <KeyHint {...hint} />
        </Fragment>
      ))}
    </Text>
  )
}
