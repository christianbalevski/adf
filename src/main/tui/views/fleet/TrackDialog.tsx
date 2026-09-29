// "Track a folder" dialog: a path input with Tab completion over directories
// (the load dialog's completer, folders only). Enter asks the daemon to track
// it: the folder's reviewed autostart agents load right away, then the
// folder's agents are listed (FolderAgentsDialog: what loaded, what needs
// review, errors). Path problems (not absolute, missing, already tracked /
// covered by a tracked parent) stay in the dialog so they can be fixed.

import { useState } from 'react'
import { sep } from 'node:path'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useStore } from '../../state/store'
import { useViewState } from '../../state/hooks'
import { Modal } from '../../ui/Modal'
import { TextInput } from '../../ui/TextInput'
import { truncate } from '../../ui/text'
import type { OverlayProps } from '../types'
import { expandPath } from './model'
import { completeFolder, trackFolder } from './folders'
import { FolderAgentsDialog } from './FolderAgentsDialog'

const LAST_DIR_KEY = 'fleet.track.lastDir'
const MAX_CANDIDATES = 8

/** The Track overlay: the path input, or (props `folder`) that folder's agents. */
export function TrackDialog(props: OverlayProps) {
  return props.overlay.props?.folder ? <FolderAgentsDialog {...props} /> : <TrackFolderInput {...props} />
}

function TrackFolderInput({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const props = (overlay.props ?? {}) as { path?: string }
  const [lastDir, setLastDir] = useViewState<string>(LAST_DIR_KEY, '')
  const [value, setValue] = useState(props.path ?? (lastDir || `${process.cwd()}${sep}`))
  const [candidates, setCandidates] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogWidth = Math.max(40, Math.min(width - 4, 90))

  const submit = (text: string) => {
    if (busy) return false
    const raw = text.trim()
    if (!raw) { setProblem('Type a folder path'); return false }
    const abs = expandPath(raw)
    setBusy(true)
    setProblem(null)
    void trackFolder(store, abs).then(outcome => {
      setBusy(false)
      if (outcome.ok) {
        const parent = abs.replace(/[\\/]+$/, '')
        const cut = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'))
        if (cut > 0) setLastDir(parent.slice(0, cut + 1))
        close()
        return
      }
      if (outcome.inline) setProblem(outcome.error)
      else close()
    })
    return false // keep the text: a path problem is fixed in place
  }

  return (
    <Modal
      title="Track a folder"
      width={dialogWidth}
      onClose={close}
      hints={[
        { keys: 'tab', label: 'complete' },
        { keys: 'enter', label: 'track' },
        { keys: 'esc', label: 'cancel' },
      ]}
    >
      <Text color={theme.color.muted} wrap="wrap">A folder of agents on the daemon’s machine (~ and relative paths resolve here). Its reviewed autostart agents load now and at every daemon start; the rest are listed next, to review or load.</Text>
      <Box borderStyle={theme.ascii ? 'classic' : 'round'} borderColor={theme.color.borderFocus} paddingX={1}>
        <TextInput
          value={value}
          onChange={next => { setValue(next); setProblem(null); setCandidates([]) }}
          onSubmit={submit}
          focused
          keyLayer="overlay"
          maxRows={2}
          onKey={(_input, key, api) => {
            // A completed Windows folder ends in "\", which TextInput reads as a
            // line continuation: submit here so Enter always tracks.
            if (key.return && !key.shift && !key.meta) { submit(api.value); return true }
            if (key.tab) {
              const result = completeFolder(api.value)
              if (result.value !== api.value) api.setValue(result.value)
              setCandidates(result.candidates.length > 1 ? result.candidates : [])
              if (result.candidates.length === 0) setProblem('No folder matches')
              return true
            }
            return false
          }}
        />
      </Box>
      {candidates.length > 0 ? (
        <Box flexDirection="column">
          {candidates.slice(0, MAX_CANDIDATES).map(c => (
            <Text key={c} color={theme.color.info}>  {truncate(c, dialogWidth - 6)}</Text>
          ))}
          {candidates.length > MAX_CANDIDATES ? <Text color={theme.color.dim}>  +{candidates.length - MAX_CANDIDATES} more</Text> : null}
        </Box>
      ) : null}
      {busy ? <Text color={theme.color.muted}>Tracking and loading its agents…</Text> : null}
      {problem ? <Text color={theme.color.warn} wrap="wrap">{problem}</Text> : null}
    </Modal>
  )
}
