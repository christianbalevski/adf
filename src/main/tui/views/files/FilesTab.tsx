// Tree of the agent's files (document + mind pinned on top) and the viewer.
// Edits go through $EDITOR (editor.ts), or the OS default app for anything
// (external.ts); every write, rename, delete and protection change is
// confirmed or reported with a toast.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { useTheme } from '../../app/theme'
import { useActions, useClient, useTuiSelector } from '../../state/store'
import { List } from '../../ui/List'
import { displayWidth, formatAgo, truncate } from '../../ui/text'
import type { FileListEntry } from '../../api/types'
import type { UmbilicalEvent } from '../../api/types'
import { editTarget } from './editor'
import { externalChanged, externalCopy, openExternal, saveBackExternal, type ExternalDeps } from './external'
import { listFiles, loadTarget, type LoadedContent } from './io'
import {
  buildRows, formatBytes, nextProtection, parentDir, protectionMark, targetFromKey, targetKey, targetLabel,
  DOCUMENT_KEY, MIND_KEY, type FileTarget, type TreeRow,
} from './model'
import { askText, type AgentFilesState, type FilesPane, type FilesRequest } from './state'
import { Viewer } from './Viewer'
import { recordRecentFile } from '../../app/palette/entries'

export interface FilesTabProps {
  width: number
  height: number
  focused: boolean
  agentId: string
  agentLabel: string
  pane: FilesPane
  setPane: (pane: FilesPane) => void
  agentState: AgentFilesState
  setAgentState: (patch: Partial<AgentFilesState>) => void
  request?: FilesRequest
  clearRequest: () => void
}

interface RecentWrite { at: number; loop?: string; deleted: boolean }
const recentWrites = new Map<string, Map<string, RecentWrite>>()
const RECENT_MS = 10 * 60_000

/** Agent-side paths that alias the pinned targets. */
function pinnedKeyForPath(path: string): string | null {
  if (path === 'mind.md') return MIND_KEY
  if (path === 'README.md' || path === 'document.md') return DOCUMENT_KEY
  return null
}

function isOpenable(row: TreeRow | undefined): boolean {
  return !!row && row.kind !== 'dir'
}

function rowTarget(row: TreeRow): FileTarget | null {
  if (row.kind === 'document') return { kind: 'document' }
  if (row.kind === 'mind') return { kind: 'mind' }
  if (row.kind === 'file') return { kind: 'file', path: row.path }
  return null
}

function parentsOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_p, i) => parts.slice(0, i + 1).join('/'))
}

export function FilesTab(props: FilesTabProps) {
  const { width, height, focused, agentId, agentLabel, pane, setPane, agentState, setAgentState, request, clearRequest } = props
  const theme = useTheme()
  const actions = useActions()
  const client = useClient()
  const { suspendTerminal } = useApp()
  const [files, setFiles] = useState<FileListEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [content, setContent] = useState<Record<string, LoadedContent | { error: string }>>({})
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null)
  const [, setTick] = useState(0)
  const busy = useRef(false)

  const collapsed = useMemo(() => new Set(agentState.collapsed ?? []), [agentState.collapsed])
  const rows = useMemo(() => buildRows(files ?? [], collapsed, query), [files, collapsed, query])
  const cursorIndex = Math.max(0, rows.findIndex(r => r.key === agentState.cursor))
  const cursorRow = rows[cursorIndex]
  const viewerKey = isOpenable(cursorRow) ? cursorRow!.key : agentState.open ?? DOCUMENT_KEY
  useEffect(() => {
    if (pane === 'viewer' && viewerKey.startsWith('file:')) recordRecentFile(agentId, viewerKey.slice(5))
  }, [pane, viewerKey, agentId])
  const viewerTarget = targetFromKey(viewerKey)

  const reloadList = useCallback(async () => {
    try {
      const next = await listFiles(client, agentId)
      setFiles(next)
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
      setFiles(prev => prev ?? [])
    }
  }, [client, agentId])

  const loadContent = useCallback(async (key: string) => {
    const target = targetFromKey(key)
    if (!target) return
    try {
      const loaded = await loadTarget(client, agentId, target)
      setContent(prev => ({ ...prev, [key]: loaded }))
    } catch (err) {
      setContent(prev => ({ ...prev, [key]: { error: err instanceof Error ? err.message : String(err) } }))
    }
  }, [client, agentId])

  useEffect(() => {
    setFiles(null)
    setContent({})
    setNotice(null)
    void reloadList()
  }, [agentId])

  // Debounced preview of the highlighted entry.
  useEffect(() => {
    if (!viewerTarget || content[viewerKey]) return
    const timer = setTimeout(() => { void loadContent(viewerKey) }, 90)
    return () => clearTimeout(timer)
  }, [viewerKey, content[viewerKey] === undefined])

  // Live: the agent (any loop) writing or deleting files updates the tree and the open file.
  const lastEvents = useTuiSelector(s => s.lastEvents)
  const seen = useRef<UmbilicalEvent | undefined>(lastEvents[lastEvents.length - 1])
  useEffect(() => {
    const fresh: UmbilicalEvent[] = []
    for (let i = lastEvents.length - 1; i >= 0 && lastEvents[i] !== seen.current; i--) fresh.unshift(lastEvents[i])
    seen.current = lastEvents[lastEvents.length - 1]
    const relevant = fresh.filter(e => e.agent_id === agentId && (e.event_type === 'file.written' || e.event_type === 'file.deleted'))
    if (relevant.length === 0) return
    const perAgent = recentWrites.get(agentId) ?? new Map<string, RecentWrite>()
    recentWrites.set(agentId, perAgent)
    const touched = new Set<string>()
    for (const event of relevant) {
      const path = typeof event.payload?.path === 'string' ? event.payload.path : null
      if (!path) continue
      perAgent.set(path, { at: event.timestamp || Date.now(), loop: event.loop, deleted: event.event_type === 'file.deleted' })
      touched.add(`file:${path}`)
      const pinned = pinnedKeyForPath(path)
      if (pinned) touched.add(pinned)
    }
    void reloadList()
    if (touched.has(viewerKey)) {
      const last = relevant[relevant.length - 1]
      const by = last.loop ? `${theme.glyph.loop} ${last.loop}` : 'main'
      setNotice({ key: viewerKey, text: `${last.event_type === 'file.deleted' ? 'Deleted' : 'Updated'} by ${agentLabel} (${by}) at ${new Date(last.timestamp || Date.now()).toLocaleTimeString()} — reloaded` })
    }
    setContent(prev => {
      const next = { ...prev }
      for (const key of touched) delete next[key]
      return next
    })
  }, [lastEvents])

  // Keep "written 3s ago" badges fresh.
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 15_000)
    return () => clearInterval(timer)
  }, [])

  const selectKey = (key: string) => setAgentState({ cursor: key })
  const reveal = (key: string) => {
    const target = targetFromKey(key)
    const parents = target?.kind === 'file' ? parentsOf(target.path) : []
    setQuery('')
    setFiltering(false)
    setAgentState({
      cursor: key,
      open: key,
      collapsed: (agentState.collapsed ?? []).filter(c => !parents.includes(c)),
    })
  }

  const invalidate = (key: string) => setContent(prev => {
    const next = { ...prev }
    delete next[key]
    return next
  })

  const runEdit = async (target: FileTarget, create = false) => {
    if (busy.current) {
      actions.toast('An edit is already in progress', 'warn')
      return
    }
    busy.current = true
    try {
      const outcome = await editTarget({
        client,
        actions,
        agentId,
        agentLabel,
        suspend: run => suspendTerminal(run),
      }, target, { create })
      if (outcome === 'written') {
        const key = targetKey(target)
        invalidate(key)
        await reloadList()
        reveal(key)
      }
    } catch (err) {
      actions.toast(`Edit failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 12_000)
    } finally {
      busy.current = false
    }
  }

  const externalDeps = (): ExternalDeps => ({ client, actions, agentId, agentLabel })

  const runOpenExternal = async (target: FileTarget) => {
    await openExternal(externalDeps(), target)
    setTick(t => t + 1)
  }

  const runSaveBack = async (target: FileTarget) => {
    if (busy.current) {
      actions.toast('An edit is already in progress', 'warn')
      return
    }
    busy.current = true
    try {
      if (await saveBackExternal(externalDeps(), target) === 'written') {
        invalidate(targetKey(target))
        await reloadList()
      }
    } catch (err) {
      actions.toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 12_000)
    } finally {
      busy.current = false
      setTick(t => t + 1)
    }
  }

  // The viewed file's copy in the default app: re-check its mtime so the
  // "changed — s saves it back" notice appears once the app saves.
  const viewedCopy = viewerTarget ? externalCopy(agentId, viewerTarget) : undefined
  const copyChanged = viewedCopy ? externalChanged(viewedCopy) : false
  useEffect(() => {
    if (!viewedCopy || copyChanged) return
    const timer = setInterval(() => { if (externalChanged(viewedCopy)) setTick(t => t + 1) }, 1500)
    return () => clearInterval(timer)
  }, [viewedCopy, copyChanged])

  const createFile = async (initialPath?: string) => {
    let path = initialPath?.trim()
    if (!path) {
      const base = cursorRow?.kind === 'dir' ? `${cursorRow.path}/` : cursorRow?.kind === 'file' ? (parentDir(cursorRow.path) ? `${parentDir(cursorRow.path)}/` : '') : ''
      const answer = await askText(actions, { title: 'New file', label: `Path in ${agentLabel}`, initial: base, hint: 'Opens $EDITOR; the file is created when you save and confirm.' })
      path = answer?.trim()
    }
    if (!path) return
    path = path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path.endsWith('/')) {
      actions.toast('A file path is required (e.g. notes/idea.md)', 'warn')
      return
    }
    if ((files ?? []).some(f => f.path === path)) {
      actions.toast(`${path} already exists — opening it for editing instead`, 'info')
      await runEdit({ kind: 'file', path })
      return
    }
    await runEdit({ kind: 'file', path }, true)
  }

  const rename = async (row: TreeRow) => {
    if (row.kind !== 'file' && row.kind !== 'dir') {
      actions.toast(`The ${row.name} is fixed; rename a file or folder instead`, 'warn')
      return
    }
    const answer = await askText(actions, { title: row.kind === 'dir' ? 'Move folder' : 'Rename / move file', label: `New path for ${row.path}${row.kind === 'dir' ? '/' : ''}`, initial: row.path })
    const next = answer?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!next || next === row.path) return
    if (row.kind === 'dir') {
      const result = await actions.run('Move folder', c => c.renameFolder(agentId, row.path, next))
      if (result) actions.toast(`Moved ${row.path}/ to ${next}/ (${result.count} files)`, 'success')
    } else {
      const result = await actions.run('Rename', c => c.renameFile(agentId, row.path, next))
      if (result?.success) actions.toast(`Renamed ${row.path} to ${next}`, 'success')
      else if (result) actions.toast(`${row.path} was not renamed (missing, protected, or ${next} exists)`, 'warn')
      if (result?.success) setAgentState({ cursor: `file:${next}`, open: `file:${next}` })
    }
    setContent({})
    await reloadList()
  }

  const remove = async (row: TreeRow) => {
    if (row.kind !== 'file') {
      actions.toast(row.kind === 'dir' ? 'Delete the files inside the folder one by one' : `The ${row.name} cannot be deleted`, 'warn')
      return
    }
    const ok = await actions.confirm({
      title: 'Delete file',
      message: `Delete ${row.path} (${formatBytes(row.size ?? 0)}) from ${agentLabel}? The agent loses it; audit snapshots keep a copy when enabled.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const result = await actions.run('Delete', c => c.deleteFile(agentId, row.path))
    if (result?.success) actions.toast(`Deleted ${row.path}`, 'success')
    else if (result) actions.toast(`${row.path} was not deleted (missing or protected)`, 'warn')
    invalidate(row.key)
    await reloadList()
  }

  const cycleProtection = async (row: TreeRow) => {
    if (row.kind !== 'file' || !row.entry) {
      actions.toast('Protection applies to files', 'warn')
      return
    }
    const next = nextProtection(row.entry.protection)
    const result = await actions.run('Protection', c => c.setFileProtection(agentId, row.path, next))
    if (result?.success) actions.toast(`${row.path}: protection ${row.entry.protection} -> ${next}`, 'success')
    else if (result) actions.toast(`${row.path}: protection unchanged`, 'warn')
    invalidate(row.key)
    await reloadList()
  }

  const toggleAuthorized = async (row: TreeRow) => {
    if (row.kind !== 'file' || !row.entry) {
      actions.toast('Authorization applies to files', 'warn')
      return
    }
    const next = !row.entry.authorized
    const result = await actions.run('Authorize', c => c.setFileAuthorized(agentId, row.path, next))
    if (result?.success) actions.toast(`${row.path}: ${next ? 'authorized for code' : 'no longer authorized'}`, 'success')
    else if (result) actions.toast(`${row.path}: authorization unchanged`, 'warn')
    invalidate(row.key)
    await reloadList()
  }

  const toggleDir = (row: TreeRow, expand?: boolean) => {
    const isCollapsed = collapsed.has(row.path)
    const wantCollapsed = expand === undefined ? !isCollapsed : !expand
    if (wantCollapsed === isCollapsed) return false
    const next = wantCollapsed ? [...collapsed, row.path] : [...collapsed].filter(p => p !== row.path)
    setAgentState({ collapsed: next })
    return true
  }

  // Requests from slash commands (/open, /edit, /doc, /mind, /new-file).
  useEffect(() => {
    if (!request) return
    clearRequest()
    if (request.kind === 'open') {
      reveal(request.key)
      invalidate(request.key)
      setPane('viewer')
    } else if (request.kind === 'edit') {
      const target = targetFromKey(request.key)
      if (target) {
        reveal(request.key)
        void runEdit(target)
      }
    } else if (request.kind === 'new') {
      void createFile(request.path)
    }
  }, [request?.nonce])

  const onKey = (input: string, key: import('../../app/keys').Key, row: TreeRow | undefined): boolean => {
    if (filtering) {
      if (key.escape) { setFiltering(false); setQuery(''); return true }
      if (key.return) { setFiltering(false); return true }
      if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); return true }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) return false
      // ←/→ would switch tabs: not while typing a filter.
      if ((key.leftArrow || key.rightArrow) && !key.ctrl && !key.shift) return true
      if (input && !key.ctrl && !key.meta && !key.tab && !/[\r\n]/.test(input)) { setQuery(q => q + input); return true }
      return false
    }
    if ((key.ctrl || key.shift) && (key.leftArrow || key.rightArrow)) return false
    if (input === '/') { setFiltering(true); return true }
    if (key.escape && query) { setQuery(''); return true }
    if (input === 'r' && !key.ctrl) {
      setContent({})
      void reloadList().then(() => actions.toast(`Reloaded files of ${agentLabel}`, 'info', 1500))
      return true
    }
    if (input === 'n' && !key.ctrl) { void createFile(); return true }
    if (!row) return false
    // Enter opens a file / toggles a folder (List onSubmit); ←/→ are the
    // view's tabs. Backspace is "back": collapse the folder, else go to the
    // parent folder. It never deletes (that is d / Delete).
    if (key.backspace && !key.ctrl && !key.meta) {
      if (row.kind === 'dir' && toggleDir(row, false)) return true
      const parent = row.kind === 'dir' || row.kind === 'file' ? parentDir(row.path) : ''
      if (parent && !query) selectKey(`dir:${parent}`)
      return true
    }
    if (row.kind === 'dir' && input === ' ') { toggleDir(row); return true }
    if (input === 'e' && !key.ctrl) {
      const target = rowTarget(row)
      if (target) void runEdit(target)
      else actions.toast('Pick a file to edit', 'warn')
      return true
    }
    if ((input === 'o' || input === 's') && !key.ctrl) {
      const target = rowTarget(row)
      if (!target) actions.toast('Pick a file', 'warn')
      else if (input === 'o') void runOpenExternal(target)
      else void runSaveBack(target)
      return true
    }
    if (input === 'm' && !key.ctrl) { void rename(row); return true }
    if ((input === 'd' && !key.ctrl) || (key.delete && !key.backspace)) { void remove(row); return true }
    if (input === 'p' && !key.ctrl) { void cycleProtection(row); return true }
    if (input === 'a' && !key.ctrl) { void toggleAuthorized(row); return true }
    return false
  }

  const split = width >= 70
  const listWidth = split ? Math.max(24, Math.min(48, Math.floor(width * 0.38))) : width
  const viewerWidth = split ? width - listWidth - 2 : width
  const showList = split || pane === 'list'
  const showViewer = split || pane === 'viewer'

  const perAgent = recentWrites.get(agentId)
  const renderRow = (row: TreeRow, selected: boolean, w: number) => {
    const indent = '  '.repeat(row.depth)
    let glyph: string
    let color: string | undefined
    let right = ''
    let suffix = ''
    if (row.kind === 'document' || row.kind === 'mind') {
      glyph = theme.glyph.wordmark
      color = row.kind === 'mind' ? theme.color.loop : theme.color.accent
      suffix = row.kind === 'document' ? ' agent document' : ' memory'
    } else if (row.kind === 'dir') {
      glyph = row.expanded ? theme.glyph.expanded : theme.glyph.collapsed
      color = theme.color.info
      right = `${row.fileCount} ${formatBytes(row.size ?? 0)}`
    } else {
      glyph = ' '
      color = theme.color.text
      const marks = [protectionMark(row.entry?.protection), row.entry?.authorized ? 'A' : ''].filter(Boolean).join(' ')
      right = `${marks ? `${marks} ` : ''}${formatBytes(row.size ?? 0)}`
    }
    const recent = row.kind === 'file' ? perAgent?.get(row.path) : undefined
    const badge = recent && !recent.deleted && Date.now() - recent.at < RECENT_MS
      ? ` ${recent.loop ? `${theme.glyph.loop}${recent.loop}` : '*'} ${formatAgo(recent.at)}`
      : ''
    const nameText = `${selected ? theme.glyph.pointer : ' '} ${indent}${glyph} ${row.name}${row.kind === 'dir' ? '/' : ''}`
    const leftWidth = Math.max(4, w - displayWidth(right) - 1)
    const shownName = truncate(nameText, leftWidth)
    let room = leftWidth - displayWidth(shownName)
    const shownSuffix = truncate(suffix, room)
    room -= displayWidth(shownSuffix)
    const shownBadge = truncate(badge, room)
    room -= displayWidth(shownBadge)
    const fg = (c: string | undefined) => (selected ? theme.color.selectionFg : c)
    return (
      <Text
        wrap="truncate-end"
        color={fg(color)}
        backgroundColor={selected ? theme.color.selectionBg : undefined}
        inverse={theme.mono && selected}
        bold={selected || row.kind === 'document' || row.kind === 'mind'}
      >
        {shownName}
        <Text color={fg(theme.color.dim)}>{shownSuffix}</Text>
        <Text color={fg(theme.color.loop)}>{shownBadge}</Text>
        {' '.repeat(Math.max(0, room))}
        <Text color={fg(theme.color.muted)}> {right}</Text>
      </Text>
    )
  }

  const loaded = viewerTarget ? content[viewerKey] : undefined
  const loadedOk = loaded && !('error' in loaded) ? loaded : undefined
  const viewerMeta: string[] = []
  if (loadedOk) {
    viewerMeta.push(formatBytes(loadedOk.size))
    if (loadedOk.protection && loadedOk.protection !== 'none') viewerMeta.push(loadedOk.protection)
    if (loadedOk.authorized) viewerMeta.push('authorized')
    if (loadedOk.target.kind === 'file' && loadedOk.mime) viewerMeta.push(loadedOk.mime)
  }
  const viewerTitle = viewerTarget ? (viewerTarget.kind === 'file' ? viewerTarget.path : `${agentLabel} ${theme.glyph.sep} ${targetLabel(viewerTarget)}`) : ''

  const filterRow = filtering || query
  const listHeight = Math.max(1, height - 1 - (filterRow ? 1 : 0) - (listError ? 1 : 0))
  const fileCount = files?.length ?? 0

  return (
    <Box flexDirection="row" width={width} height={height}>
      {showList ? (
        <Box flexDirection="column" width={listWidth} height={height}>
          <Text wrap="truncate-end">
            <Text bold color={focused && pane === 'list' ? theme.color.accent : theme.color.muted} inverse={theme.mono && focused && pane === 'list'}>{agentLabel}</Text>
            <Text color={theme.color.muted}> {files ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : `loading${theme.glyph.ellipsis}`}</Text>
          </Text>
          {filterRow ? (
            <Text wrap="truncate-end">
              <Text color={theme.color.accent}>/</Text>
              <Text color={theme.color.text}>{query}</Text>
              {filtering ? <Text inverse> </Text> : null}
              <Text color={theme.color.muted}>  {rows.length} match{rows.length === 1 ? '' : 'es'}</Text>
            </Text>
          ) : null}
          {listError ? <Text color={theme.color.error} wrap="truncate-end">{listError}</Text> : null}
          <List
            items={rows}
            getKey={r => r.key}
            height={listHeight}
            width={listWidth}
            active={focused && pane === 'list'}
            selectedIndex={cursorIndex}
            onSelectedIndexChange={(_i, r) => { if (r && r.key !== agentState.cursor) selectKey(r.key) }}
            onSubmit={r => {
              if (r.kind === 'dir') toggleDir(r)
              else { setAgentState({ open: r.key }); setPane('viewer') }
            }}
            onKey={(input, key, r) => onKey(input, key, r)}
            emptyText={files ? 'No files.' : `Loading${theme.glyph.ellipsis}`}
            renderItem={(r, { selected, width: w }) => renderRow(r, selected, w)}
          />
        </Box>
      ) : null}
      {showViewer ? (
        <Box
          flexDirection="column"
          width={split ? viewerWidth + 2 : viewerWidth}
          height={height}
          borderStyle={split ? (theme.ascii ? 'classic' : 'single') : undefined}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={focused && pane === 'viewer' ? theme.color.borderFocus : theme.color.border}
          paddingLeft={split ? 1 : 0}
        >
          {viewerTarget ? (
            <Viewer
              width={viewerWidth}
              height={height}
              active={focused && pane === 'viewer'}
              title={viewerTitle}
              meta={viewerMeta}
              notice={copyChanged
                ? 'Changed in the default app — s saves it back'
                : notice?.key === viewerKey ? notice.text : viewedCopy ? 'Open in the default app (o reopens, s saves it back)' : undefined}
              name={viewerTarget.kind === 'file' ? viewerTarget.path : targetLabel(viewerTarget)}
              text={loadedOk?.text}
              bytes={loadedOk?.binary ? loadedOk.bytes : undefined}
              mime={loadedOk?.mime}
              loading={!loaded}
              error={loaded && 'error' in loaded ? loaded.error : undefined}
              resetKey={viewerKey}
              onBack={() => setPane('list')}
              onEdit={loadedOk?.binary ? undefined : () => { void runEdit(viewerTarget) }}
              onOpenExternal={() => { void runOpenExternal(viewerTarget) }}
              onSaveBack={() => { void runSaveBack(viewerTarget) }}
            />
          ) : (
            <Text color={theme.color.muted}>Pick a file.</Text>
          )}
        </Box>
      ) : null}
    </Box>
  )
}
