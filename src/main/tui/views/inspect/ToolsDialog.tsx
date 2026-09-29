// /tools (Inspect › Settings › Tools): the agent's tools grouped like Studio's
// Tools section, plus one group per MCP server. Space enables, v shows / hides
// it in the LLM's tool list, r requires approval, l locks it for the agent; on
// a group header the same keys act on the whole group (locked tools skipped).
// / filters. Each keypress is one re-read + PUT (settings-ops.ts).

import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { List } from '../../ui/List'
import { Modal } from '../../ui/Modal'
import { truncate } from '../../ui/text'
import type { AgentMcpDiagnostics, AgentToolEntry } from '../../api/types'
import type { OverlayProps } from '../types'
import {
  buildToolRows, filterToolRows, toggleGroup, toggleToolEnabled, toggleToolLock, toggleToolRestricted, toggleToolVisible,
  toolSummary, type ToolListRow, type ToolRow,
} from './settings-model'
import { applyChange } from './settings-ops'

function stateWords(row: ToolRow): string {
  const parts = [row.enabled ? 'enabled' : 'disabled']
  if (row.enabled) parts.push(row.visible ? 'in the agent’s tool list' : 'hidden from the tool list (still callable from code)')
  if (row.restricted) parts.push(row.enabled ? 'every LLM call waits for your approval' : 'needs approval when enabled')
  if (row.locked) parts.push('locked: the agent cannot change it')
  if (row.status) parts.push(`MCP: ${row.status}${row.status === 'changed' ? ' (schema changed, review before enabling)' : ''}`)
  return parts.join(' · ')
}

export function ToolsOverlay({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { actions } = store
  const agentId = String(overlay.props?.agentId ?? '')
  const agent = useAgent(agentId)
  const config = agent?.config
  const [catalog, setCatalog] = useState<AgentToolEntry[] | null>(null)
  const [live, setLive] = useState<AgentMcpDiagnostics | null>(null)
  const [query, setQuery] = useState(typeof overlay.props?.query === 'string' ? overlay.props.query : '')
  const [typing, setTyping] = useState(false)
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(0)

  useEffect(() => {
    if (!config) void actions.loadConfig(agentId)
    // Descriptions + tools the registry holds but the config does not declare
    // yet; an older daemon without the route just shows the config's tools.
    store.client.agentTools(agentId).then(r => setCatalog(r.tools), () => setCatalog(null))
    store.client.agentMcp(agentId).then(setLive, () => setLive(null))
  }, [agentId])

  const rows = useMemo(() => (config ? filterToolRows(buildToolRows(config, catalog), query) : []), [config, catalog, query])
  const at = Math.min(index, Math.max(0, rows.length - 1))
  const row = rows[at] as ToolListRow | undefined

  const act = (field: 'enabled' | 'visible' | 'restricted' | 'locked') => {
    if (!row) return
    setBusy(n => n + 1)
    const done = () => setBusy(n => n - 1)
    if (row.kind === 'group') {
      if (field === 'locked') { actions.toast('Lock tools one at a time, or lock the whole Tools section from Settings (l)', 'info', 3000); done(); return }
      const names = row.tools
      void applyChange(actions, agentId, cfg => toggleGroup(cfg, row.id, field, names), 'Tools').finally(done)
      return
    }
    const fn = field === 'enabled' ? toggleToolEnabled : field === 'visible' ? toggleToolVisible : field === 'restricted' ? toggleToolRestricted : toggleToolLock
    void applyChange(actions, agentId, cfg => fn(cfg, row.name), 'Tools').finally(done)
  }

  // Sees keys before the List (registered after it): filter typing, the toggles, Esc.
  useKeys((input, key) => {
    if (typing) {
      if (key.escape) { setTyping(false); setQuery(''); setIndex(0); return true }
      if (key.return) { setTyping(false); return true }
      if (key.downArrow || key.upArrow) { setTyping(false); return false }
      if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setIndex(0); return true }
      // eslint-disable-next-line no-control-regex
      if (input && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(input)) { setQuery(q => q + input); setIndex(0); return true }
      return true
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      if (query && !(key.ctrl && input === 'c')) { setQuery(''); setIndex(0); return true }
      close()
      return true
    }
    if (key.ctrl || key.meta) return false
    if (input === '/') { setTyping(true); return true }
    if (input === ' ' || key.return) { act('enabled'); return true }
    if (input === 'v') { act('visible'); return true }
    if (input === 'r') { act('restricted'); return true }
    if (input === 'l') { act('locked'); return true }
    return false
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(40, Math.min(width - 4, 104))
  const inner = dialogWidth - 4
  const listHeight = Math.max(3, Math.min(rows.length || 1, height - 13))
  const colList = 7
  const colAppr = 9
  const colLock = 7
  const nameWidth = Math.max(10, inner - 6 - colList - colAppr - colLock)
  const who = agent?.summary.handle || agent?.summary.name || agentId
  const liveState = (server?: string) => {
    if (!server || !live) return ''
    const s = (live.states as Array<{ name: string; status?: string; toolCount?: number }> | undefined)?.find(x => x.name === server)
    return s ? ` · ${s.status ?? '?'}${typeof s.toolCount === 'number' ? `, ${s.toolCount} live` : ''}` : ' · not running'
  }

  return (
    <Modal
      title={`Tools ${theme.glyph.sep} ${who}${busy > 0 ? ` ${theme.glyph.sep} saving…` : ''}`}
      width={dialogWidth}
      hints={[{ keys: 'space', label: 'enable' }, { keys: 'v', label: 'show/hide' }, { keys: 'r', label: 'approval' }, { keys: 'l', label: 'lock' }, { keys: '/', label: 'filter' }, { keys: 'esc', label: 'close' }]}
    >
      <Text wrap="truncate-end" color={theme.color.muted}>{config ? toolSummary(config) : 'loading config…'}</Text>
      <Text wrap="truncate-end">
        <Text color={theme.color.accent}>/</Text>
        <Text color={theme.color.text}>{query}</Text>
        {typing ? <Text inverse> </Text> : null}
        <Text color={theme.color.dim}>{query || typing ? `  ${rows.filter(r => r.kind === 'tool').length} match` : '  filter'}</Text>
      </Text>
      <Text color={theme.color.dim} wrap="truncate-end">{'      '}{'tool'.padEnd(nameWidth)}{'list'.padEnd(colList)}{'approval'.padEnd(colAppr)}{'lock'}</Text>
      <List
        items={rows}
        getKey={r => (r.kind === 'group' ? `g:${r.id}` : `t:${r.name}`)}
        height={listHeight}
        width={inner}
        keyLayer="overlay"
        selectedIndex={at}
        onSelectedIndexChange={setIndex}
        emptyText={query ? `No tool matches "${query}".` : 'No tools declared.'}
        renderItem={(r, { selected }) => {
          const pointer = <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
          if (r.kind === 'group') {
            const tri = (s: 'all' | 'none' | 'mixed') => (s === 'all' ? '[x]' : s === 'mixed' ? '[-]' : '[ ]')
            return (
              <Text wrap="truncate-end" inverse={theme.mono && selected}>
                {pointer}
                <Text color={r.blocked ? theme.color.dim : theme.color.text}>{tri(r.blocked ? 'none' : r.enabled)} </Text>
                <Text bold color={theme.color.accent}>{r.label}</Text>
                <Text color={theme.color.muted}> {r.count.enabled}/{r.count.total}{liveState(r.mcpServer && r.mcpServer !== '?' ? r.mcpServer : undefined)}</Text>
                {r.blocked ? <Text color={theme.color.warn}> ({r.blocked})</Text> : r.note ? <Text color={theme.color.dim}> ({r.note})</Text> : null}
              </Text>
            )
          }
          const dim = !r.enabled
          return (
            <Text wrap="truncate-end" inverse={theme.mono && selected}>
              {pointer}
              <Text color={r.blocked ? theme.color.dim : r.enabled ? theme.color.success : theme.color.muted}>{r.enabled ? '[x]' : '[ ]'} </Text>
              <Text bold={selected} color={dim ? theme.color.muted : theme.color.text}>{truncate(`${r.mcpServer ? '  ' : ''}${r.label}`, nameWidth - 1).padEnd(nameWidth)}</Text>
              <Text color={r.enabled && r.visible ? theme.color.text : theme.color.dim}>{(r.enabled ? (r.visible ? 'shown' : 'hidden') : '-').padEnd(colList)}</Text>
              <Text color={r.restricted ? theme.color.warn : theme.color.dim}>{(r.canRestrict ? (r.restricted ? 'required' : '-') : 'n/a').padEnd(colAppr)}</Text>
              <Text color={r.locked ? theme.color.warn : theme.color.dim}>{r.locked ? 'locked' : r.mcpServer ? '' : '-'}</Text>
              {r.status ? <Text color={theme.color.warn}> {r.status}</Text> : null}
            </Text>
          )
        }}
      />
      <Box flexDirection="column" marginTop={1} height={2}>
        {row?.kind === 'tool' ? (
          <>
            <Text wrap="truncate-end" color={theme.color.text}>{row.name}: <Text color={theme.color.muted}>{stateWords(row)}</Text></Text>
            <Text wrap="truncate-end" color={theme.color.dim}>{(row.blocked ? `Blocked: ${row.blocked}. ` : '') + (row.description ?? 'No description.').replace(/\s+/g, ' ')}</Text>
          </>
        ) : row?.kind === 'group' ? (
          <>
            <Text wrap="truncate-end" color={theme.color.text}>{row.label}: <Text color={theme.color.muted}>Space / v / r act on all {row.tools.length} tools (locked ones are skipped)</Text></Text>
            <Text wrap="truncate-end" color={theme.color.dim}>{row.blocked ? `Blocked: ${row.blocked}` : 'Approval = restricted: authorized code may call it; an LLM call waits for you.'}</Text>
          </>
        ) : null}
      </Box>
    </Modal>
  )
}
