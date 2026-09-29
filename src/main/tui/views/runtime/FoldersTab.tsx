// Runtime › Folders: the daemon's tracked agent folders (settings
// trackedDirectories). Enter lists the selected folder's agents (review, load,
// errors), a track another (the fleet's Track dialog), d stop tracking the
// selected one (asks; files untouched, optional unload), r re-read (the counts
// are a fresh scan: .adf files found / agents loaded from there).

import { useEffect } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore, useTuiSelector } from '../../state/store'
import { useViewState } from '../../state/hooks'
import { Table } from '../../ui/Table'
import { formatClock } from '../../ui/text'
import type { TrackedDirEntry } from '../../api/types'
import { useDaemonData } from '../inspect/hooks'
import { askUntrack, loadFolders, openFolderAgents, readFolders, TRACK_OVERLAY } from '../fleet/folders'

const CURSOR_KEY = 'runtime.folders.cursor'

export function FoldersTab({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const theme = useTheme()
  const store = useStore()
  // Any track / untrack anywhere bumps the revision: re-read then.
  const rev = useTuiSelector(s => readFolders(s).rev)
  const { data, error, loading, loadedAt, reload } = useDaemonData(`folders:${rev}`, () => loadFolders(store))
  const [cursor, setCursor] = useViewState<number>(CURSOR_KEY, 0)
  const rows: TrackedDirEntry[] = data ?? []
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  useEffect(() => { if (at !== cursor) setCursor(at) }, [at, cursor, setCursor])

  useKeys((input, key) => {
    if (key.ctrl || key.meta) return false
    const move = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : 0
    if (move) { setCursor(Math.max(0, Math.min(rows.length - 1, at + move))); return true }
    if (input === 'a' || input === 'n') { store.actions.pushOverlay({ kind: TRACK_OVERLAY }); return true }
    if (input === 'r') { reload(); return true }
    const row = rows[at]
    if ((input === 'd' || key.delete) && row) { askUntrack(store, row.path); return true }
    if (key.return && row) { openFolderAgents(store, row.path); return true }
    return false
  }, { layer: 'main', active: focused })

  const body = error
    ? <Text color={theme.color.error} wrap="wrap">Could not load: {error} (r retries)</Text>
    : (
      <Table
        width={width}
        height={Math.max(2, height - 3)}
        rows={rows}
        getKey={r => r.path}
        selectedIndex={rows.length ? at : undefined}
        emptyText={loading && !data ? 'Asking the daemon…' : 'No tracked folders — a tracks one (or f on the Fleet, /track <dir>)'}
        columns={[
          { key: 'path', title: 'FOLDER', minWidth: 20, value: r => r.path, color: r => (r.exists ? theme.color.text : theme.color.warn) },
          { key: 'exists', title: 'ON DISK', width: 8, value: r => (r.exists ? 'yes' : 'missing'), color: r => (r.exists ? theme.color.muted : theme.color.warn) },
          { key: 'found', title: 'AGENTS', width: 6, align: 'right', value: r => String(r.agentCount), color: () => theme.color.muted },
          { key: 'loaded', title: 'LOADED', width: 6, align: 'right', value: r => String(r.loadedCount), color: r => (r.loadedCount ? theme.color.live : theme.color.dim) },
        ]}
      />
    )

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={theme.color.muted} wrap="truncate-end">Folders the daemon loads agents from at start (reviewed autostart agents). Enter shows a folder’s agents.</Text>
      <Box flexDirection="column" height={Math.max(2, height - 2)}>{body}</Box>
      <Text color={theme.color.dim} wrap="truncate-end">
        enter its agents {theme.glyph.sep} a track folder {theme.glyph.sep} d stop tracking {theme.glyph.sep} r rescan {theme.glyph.sep} {loading ? 'loading…' : loadedAt ? `as of ${formatClock(loadedAt)}` : ''}
      </Text>
    </Box>
  )
}
