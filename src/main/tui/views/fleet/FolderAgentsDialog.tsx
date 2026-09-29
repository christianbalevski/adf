// A tracked folder's agents and where each stands: loaded, needs review, not
// autostart, not loaded (with the daemon's error), password-protected or
// unreadable. Shown right after tracking a folder and on Enter in Runtime ›
// Folders. Enter does the next step for the selected agent: open its chat,
// review it (summary, then accept + load), or load it. Rendered by the Track
// dialog overlay (props `folder`, optional `result`).

import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { Modal } from '../../ui/Modal'
import { truncate } from '../../ui/text'
import type { FolderAgent, ReviewInfo } from '../../api/types'
import type { OverlayProps } from '../types'
import { folderAgentLabel, folderAgentNextStep, folderAgentsSummary, loadFolderAgent, type FolderOverlayProps } from './folders'
import { openChat } from './ops'

type Mode =
  | { kind: 'list' }
  | { kind: 'review'; agent: FolderAgent; info: ReviewInfo | null; error?: string }

function glyphOf(theme: Theme, agent: FolderAgent): { glyph: string; color: string | undefined } {
  if (agent.error || agent.status === 'unreadable') return { glyph: theme.glyph.cross, color: theme.color.error }
  switch (agent.status) {
    case 'loaded': return { glyph: theme.glyph.dot, color: theme.color.live }
    case 'needs_review': return { glyph: theme.glyph.warn, color: theme.color.warn }
    default: return { glyph: theme.glyph.ring, color: theme.color.muted }
  }
}

/** The review summary as short lines: what the agent can do on this machine. */
export function reviewLines(info: ReviewInfo): string[] {
  const s = info.summary
  const lines: string[] = []
  lines.push(s.description ? `${s.name}: ${s.description}` : s.name)
  const owner = s.identity?.scenario === 'mine' || s.identity?.scenario === 'recognized'
    ? 'yours'
    : s.identity?.scenario === 'foreign' ? 'someone else’s' : 'no owner (unclaimed)'
  lines.push(`Owner: ${owner}${s.identity?.needsClaim ? '; accepting claims it for you' : ''}`)
  lines.push(`Autostart: ${s.autostart ? 'yes, loads at every daemon start' : 'no'}`)
  lines.push(`Compute: ${s.computeTier === 'host' ? 'host access (runs commands on this machine)' : s.computeTier === 'isolated' ? 'isolated container' : 'shared sandbox'}`)
  const notable = s.tools.filter(t => t.enabled && t.notable).map(t => t.name)
  if (notable.length) lines.push(`Powerful tools on: ${notable.join(', ')}`)
  if (s.codeExecution) lines.push('Runs code (sys_code / lambdas)')
  if (s.mcpServers.length) lines.push(`MCP servers: ${s.mcpServers.map(m => m.npmPackage || m.pypiPackage || m.name).join(', ')}`)
  if (s.network.adapters.length) lines.push(`Channels: ${s.network.adapters.join(', ')}`)
  if (s.network.serving) lines.push(`Serves ${s.network.serving.routeCount} API route${s.network.serving.routeCount === 1 ? '' : 's'}`)
  if (s.network.wsConnections.length) lines.push(`WebSocket connections: ${s.network.wsConnections.map(w => w.url).join(', ')}`)
  const triggers = s.triggers.filter(t => t.enabled).map(t => t.type)
  if (triggers.length) lines.push(`Triggers: ${triggers.join(', ')}`)
  return lines
}

export function FolderAgentsDialog({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const props = (overlay.props ?? {}) as unknown as FolderOverlayProps
  const folder = props.folder
  const [agents, setAgents] = useState<FolderAgent[] | null>(props.result?.agents ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [rev, setRev] = useState(props.result?.agents ? 0 : 1)
  // Opened for one agent's review (s on a stopped agent): straight into it once listed.
  const [pendingReview, setPendingReview] = useState(props.review ?? null)
  // Load errors seen in this dialog (the track's autostart pass, or a load
  // here): a re-read only knows the file is not loaded, so they are kept.
  const [errors, setErrors] = useState<Record<string, string>>(() =>
    Object.fromEntries((props.result?.agents ?? []).filter(a => a.error && a.status !== 'unreadable').map(a => [a.filePath, a.error as string])))
  const dialogWidth = Math.max(44, Math.min(width - 4, 100))
  const inner = dialogWidth - 4

  // Re-read from the daemon (first open without a track result, and after every action).
  useEffect(() => {
    if (rev === 0) return
    let live = true
    store.client.folderAgents(folder).then(
      list => { if (live) { setAgents(list.agents); setLoadError(null) } },
      err => { if (live) setLoadError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { live = false }
  }, [rev, folder])

  const rows = (agents ?? []).map(a => (a.status !== 'loaded' && !a.error && errors[a.filePath] ? { ...a, error: errors[a.filePath] } : a))
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const selected = rows[at]

  useEffect(() => {
    if (!pendingReview || !agents) return
    const index = rows.findIndex(r => r.filePath === pendingReview)
    setPendingReview(null)
    if (index < 0) return
    setCursor(index)
    if (rows[index].status === 'needs_review') openReview(rows[index])
  }, [agents, pendingReview])

  const act = (agent: FolderAgent, accept: boolean) => {
    setBusy(accept ? `Accepting the review and loading ${agent.name}…` : `Loading ${agent.name}…`)
    setNote(null)
    void loadFolderAgent(store, agent, { accept }).then(outcome => {
      setBusy(null)
      setMode({ kind: 'list' })
      setNote(outcome.ok ? { text: `${agent.name} is loaded.`, error: false } : { text: `${agent.name}: ${outcome.error}`, error: true })
      setErrors(prev => {
        const next = { ...prev }
        if (outcome.ok) delete next[agent.filePath]
        else next[agent.filePath] = outcome.error
        return next
      })
      setRev(r => r + 1)
    })
  }

  const openReview = (agent: FolderAgent) => {
    setMode({ kind: 'review', agent, info: null })
    store.client.review(agent.filePath).then(
      info => setMode(m => (m.kind === 'review' && m.agent.filePath === agent.filePath ? { ...m, info } : m)),
      err => setMode(m => (m.kind === 'review' && m.agent.filePath === agent.filePath ? { ...m, error: err instanceof Error ? err.message : String(err) } : m)),
    )
  }

  useKeys((input, key) => {
    if (busy) return true
    if (mode.kind === 'review') {
      if (key.escape || input === 'n' || input === 'N') { setMode({ kind: 'list' }); return true }
      if ((key.return || input === 'y' || input === 'Y') && !mode.error) { act(mode.agent, true); return true }
      return true
    }
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) { close(); return true }
    if (key.upArrow || input === 'k') { setCursor(Math.max(0, at - 1)); return true }
    if (key.downArrow || input === 'j') { setCursor(Math.min(rows.length - 1, at + 1)); return true }
    if (input === 'r') { setNote(null); setRev(r => r + 1); return true }
    if (key.return && selected) {
      switch (selected.status) {
        case 'loaded':
          if (selected.agentId) { close(); openChat(store, selected.agentId) }
          return true
        case 'needs_review': openReview(selected); return true
        case 'not_autostart':
        case 'stopped': act(selected, false); return true
        default: return true
      }
    }
    return true
  }, { layer: 'overlay' })

  if (mode.kind === 'review') {
    const lines = mode.info ? reviewLines(mode.info) : []
    return (
      <Modal
        title={`Review ${mode.agent.name}`}
        width={dialogWidth}
        hints={mode.error ? [{ keys: 'esc', label: 'back' }] : [{ keys: 'y enter', label: 'accept + load' }, { keys: 'n esc', label: 'back' }]}
      >
        <Text color={theme.color.muted} wrap="truncate-middle">{mode.agent.filePath}</Text>
        <Text color={theme.color.muted} wrap="wrap">Not reviewed on this daemon yet. Check what it can do before it runs here.</Text>
        <Text> </Text>
        {mode.error
          ? <Text color={theme.color.error} wrap="wrap">Could not read it: {mode.error}</Text>
          : mode.info
            ? lines.map((line, i) => <Text key={i} color={i === 0 ? theme.color.text : theme.color.muted} wrap="wrap">{i === 0 ? '' : '  '}{line}</Text>)
            : <Text color={theme.color.muted}>Reading it…</Text>}
        {busy ? <Text color={theme.color.muted}>{busy}</Text> : null}
      </Modal>
    )
  }

  // Rows: 2 per agent at most (a name row, plus its error). Keep the dialog inside the screen.
  const listRows = Math.max(3, height - 16)
  const start = Math.max(0, Math.min(at - Math.floor(listRows / 2), rows.length - listRows))
  const visible = rows.slice(start, start + listRows)
  const nameWidth = Math.max(8, Math.min(28, ...rows.map(r => r.name.length)))
  const result = props.result
  const enterLabel = !selected ? '' : selected.status === 'loaded' ? 'open chat' : selected.status === 'needs_review' ? 'review' : selected.status === 'not_autostart' || selected.status === 'stopped' ? 'load' : ''

  return (
    <Modal
      title={result ? 'Folder tracked' : 'Tracked folder'}
      width={dialogWidth}
      hints={[
        { keys: 'up down', label: 'agent' },
        ...(enterLabel ? [{ keys: 'enter', label: enterLabel }] : []),
        { keys: 'r', label: 'rescan' },
        { keys: 'esc', label: 'close' },
      ]}
    >
      <Text color={theme.color.text} wrap="truncate-middle">{folder}</Text>
      {result ? <Text color={theme.color.muted} wrap="wrap">Tracking now: its reviewed autostart agents load now and at every daemon start.{result.absorbed.length ? ` It covers ${result.absorbed.length} folder${result.absorbed.length === 1 ? '' : 's'} you tracked before.` : ''}</Text> : null}
      {loadError ? <Text color={theme.color.error} wrap="wrap">Could not list its agents: {loadError} (r retries)</Text> : null}
      {agents ? <Text color={theme.color.muted}>{folderAgentsSummary(rows)}</Text> : loadError ? null : <Text color={theme.color.muted}>Reading the folder…</Text>}
      {rows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {start > 0 ? <Text color={theme.color.dim}>  {theme.glyph.ellipsis} {start} more above</Text> : null}
          {visible.map((agent, i) => {
            const isSel = start + i === at
            const g = glyphOf(theme, agent)
            const label = folderAgentLabel(agent)
            return (
              <Box key={agent.filePath} flexDirection="column">
                <Text wrap="truncate-end" backgroundColor={isSel ? theme.color.selectionBg : undefined} inverse={theme.mono && isSel}>
                  <Text color={isSel ? theme.color.selectionFg : theme.color.accent}>{isSel ? `${theme.glyph.pointer} ` : '  '}</Text>
                  <Text color={isSel ? theme.color.selectionFg : g.color}>{g.glyph} </Text>
                  <Text bold={isSel} color={isSel ? theme.color.selectionFg : theme.color.text}>{truncate(agent.name, nameWidth).padEnd(nameWidth)}</Text>
                  <Text color={isSel ? theme.color.selectionFg : g.color}>  {label}</Text>
                </Text>
                {agent.error ? <Text color={theme.color.error} wrap={isSel ? 'wrap' : 'truncate-end'}>{'    '}{agent.error}</Text> : null}
              </Box>
            )
          })}
          {start + listRows < rows.length ? <Text color={theme.color.dim}>  {theme.glyph.ellipsis} {rows.length - start - listRows} more below</Text> : null}
        </Box>
      ) : null}
      {selected ? <Box marginTop={1}><Text color={theme.color.info} wrap="wrap">{truncate(selected.name, inner)}: {folderAgentNextStep(selected)}</Text></Box> : null}
      {busy ? <Text color={theme.color.muted}>{busy}</Text> : null}
      {note ? <Text color={note.error ? theme.color.error : theme.color.success} wrap="wrap">{note.text}</Text> : null}
    </Modal>
  )
}
