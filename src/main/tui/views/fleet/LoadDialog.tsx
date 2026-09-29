// "Load agent file" dialog: a path input with shell-style Tab completion over
// directories and .adf files, plus the require-review and start-after-load
// options. Paths are resolved on this machine and sent absolute.

import { useState } from 'react'
import { existsSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useStore } from '../../state/store'
import { useViewState } from '../../state/hooks'
import { Modal } from '../../ui/Modal'
import { TextInput } from '../../ui/TextInput'
import { truncate } from '../../ui/text'
import type { OverlayProps } from '../types'
import { completePath, expandPath } from './model'
import { loadAgent } from './ops'

const LAST_DIR_KEY = 'fleet.load.lastDir'
const MAX_CANDIDATES = 8

export function LoadDialog({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const props = (overlay.props ?? {}) as { path?: string; requireReview?: boolean; start?: boolean }
  const [lastDir, setLastDir] = useViewState<string>(LAST_DIR_KEY, '')
  const [value, setValue] = useState(props.path ?? (lastDir || `${process.cwd()}${sep}`))
  const [candidates, setCandidates] = useState<string[]>([])
  const [requireReview, setRequireReview] = useState(!!props.requireReview)
  const [start, setStart] = useState(!!props.start)
  const [problem, setProblem] = useState<string | null>(null)
  const [warned, setWarned] = useState<string | null>(null)
  const dialogWidth = Math.max(40, Math.min(width - 4, 90))

  const submit = (text: string) => {
    const raw = text.trim()
    if (!raw) { setProblem('Type a path to an .adf file'); return false }
    const abs = expandPath(raw)
    let isFile = false
    try { isFile = existsSync(abs) && statSync(abs).isFile() } catch { isFile = false }
    if (!isFile && warned !== abs) {
      setProblem(`${abs} is not a file on this machine. Enter again to send it to the daemon anyway.`)
      setWarned(abs)
      return false
    }
    if (isFile && !/\.adf$/i.test(abs) && warned !== abs) {
      setProblem('That is not an .adf file. Enter again to load it anyway.')
      setWarned(abs)
      return false
    }
    const cut = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
    if (cut > 0) setLastDir(abs.slice(0, cut + 1))
    close()
    void loadAgent(store, abs, { requireReview, start })
    return true
  }

  return (
    <Modal
      title="Load agent file"
      width={dialogWidth}
      onClose={close}
      hints={[
        { keys: 'tab', label: 'complete' },
        { keys: 'enter', label: 'load' },
        { keys: 'ctrl+r', label: `review ${requireReview ? 'on' : 'off'}` },
        { keys: 'ctrl+s', label: `start ${start ? 'on' : 'off'}` },
        { keys: 'esc', label: 'cancel' },
      ]}
    >
      <Text color={theme.color.muted} wrap="wrap">Path to an .adf on this machine (~ and relative paths resolve here).</Text>
      <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={theme.color.borderFocus} paddingX={1}>
        <TextInput
          value={value}
          onChange={next => { setValue(next); setProblem(null); setCandidates([]) }}
          onSubmit={submit}
          focused
          keyLayer="overlay"
          maxRows={2}
          onKey={(input, key, api) => {
            if (key.tab) {
              const result = completePath(api.value)
              if (result.value !== api.value) api.setValue(result.value)
              setCandidates(result.candidates.length > 1 || result.candidates.length === 0 ? result.candidates : [])
              if (result.candidates.length === 0) setProblem('No directory or .adf file matches')
              return true
            }
            if (key.ctrl && input === 'r') { setRequireReview(v => !v); return true }
            if (key.ctrl && input === 's') { setStart(v => !v); return true }
            return false
          }}
        />
      </Box>
      {candidates.length > 0 ? (
        <Box flexDirection="column">
          {candidates.slice(0, MAX_CANDIDATES).map(c => (
            <Text key={c} color={/[\\/]$/.test(c) ? theme.color.info : theme.color.text}>  {truncate(c, dialogWidth - 6)}</Text>
          ))}
          {candidates.length > MAX_CANDIDATES ? <Text color={theme.color.dim}>  +{candidates.length - MAX_CANDIDATES} more</Text> : null}
        </Box>
      ) : null}
      <Text>
        <Text color={requireReview ? theme.color.warn : theme.color.muted}>[{requireReview ? theme.glyph.check : ' '}] require review</Text>
        <Text color={theme.color.dim}>  </Text>
        <Text color={start ? theme.color.success : theme.color.muted}>[{start ? theme.glyph.check : ' '}] start after load</Text>
      </Text>
      {problem ? <Text color={theme.color.warn} wrap="wrap">{problem}</Text> : null}
    </Modal>
  )
}
