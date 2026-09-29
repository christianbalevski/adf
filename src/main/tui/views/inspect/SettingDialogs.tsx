// /compaction (Inspect › Settings › Compaction) and the small pickers for
// mesh visibility / send mode.
//
// Compaction: main's threshold is the agent's `context.compact_threshold`
// (PUT /config, re-read first); an inner loop's is its own override (PATCH
// /agents/:id/loops/:name, `null` = inherit main's). Same bounds as Studio and
// the schema: a positive whole number of tokens, empty = default / inherit.

import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useStore } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { List } from '../../ui/List'
import { Modal } from '../../ui/Modal'
import { TextInput } from '../../ui/TextInput'
import { truncate } from '../../ui/text'
import { MAIN_LOOP } from '../../api/types'
import type { AgentConfig } from '../../api/types'
import type { TuiStore } from '../../state/store'
import type { OverlayProps } from '../types'
import {
  formatTokens, isLocked, mainThreshold, parseThreshold, setMainThreshold, setSendMode, setVisibility,
  SEND_MODE_HINTS, SEND_MODES, VISIBILITY_HINTS, VISIBILITY_TIERS, type SendMode, type VisibilityTier,
} from './settings-model'
import { applyChange } from './settings-ops'
import { loadContextUsage } from './SettingsTab'

export interface CompactionRow {
  loop: string
  /** The loop's own value (main: context.compact_threshold), null when unset. */
  own: number | null
  /** What it compacts at now. */
  effective: number
  source: string
}

export function compactionRows(config: AgentConfig): CompactionRow[] {
  const main = mainThreshold(config)
  return [
    { loop: MAIN_LOOP, own: main.source === 'context' ? main.value : null, effective: main.value, source: main.source === 'default' ? 'default' : main.source === 'model' ? 'from the model config' : 'set' },
    ...(config.loops ?? []).map(l => ({
      loop: l.name,
      own: l.compact_threshold ?? null,
      effective: l.compact_threshold ?? main.value,
      source: l.compact_threshold != null ? 'set' : 'inherits main',
    })),
  ]
}

/** Set (or with null clear) the threshold of one loop. Toasts the outcome; true when saved. */
export async function applyThreshold(store: TuiStore, agentId: string, loop: string, value: number | null): Promise<boolean> {
  const { actions } = store
  if (loop === MAIN_LOOP) return applyChange(actions, agentId, cfg => setMainThreshold(cfg, value), 'Compaction')
  const result = await actions.updateLoop(agentId, loop, { compact_threshold: value })
  if (!result) return false
  await actions.loadConfig(agentId)
  actions.toast(value === null ? `${loop} inherits main’s threshold again` : `${loop} compacts at ${formatTokens(value)} tokens`, 'success', 2500)
  return true
}

export function CompactionOverlay({ overlay, close, width, height }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { actions } = store
  const agentId = String(overlay.props?.agentId ?? '')
  const agent = useAgent(agentId)
  const config = agent?.config
  const rows = config ? compactionRows(config) : []
  const initial = Math.max(0, rows.findIndex(r => r.loop === overlay.props?.loop))
  const [index, setIndex] = useState(initial)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<Record<string, number | null>>({})

  useEffect(() => {
    if (!config) void actions.loadConfig(agentId)
    void loadContextUsage(store.client, agentId, [MAIN_LOOP, ...(config?.loops ?? []).map(l => l.name)]).then(setContext)
  }, [agentId])

  const row = rows[Math.min(index, Math.max(0, rows.length - 1))]

  const submit = async (value: string) => {
    if (!editing) return
    // Empty = no change (d resets); type `default` / `inherit` to reset here too.
    if (!value.trim()) { setEditing(null); setError(null); return }
    const parsed = parseThreshold(value)
    if (!parsed.ok) { setError(parsed.error); return }
    const loop = editing
    setEditing(null)
    setError(null)
    await applyThreshold(store, agentId, loop, parsed.value)
  }

  useKeys((input, key) => {
    if (editing) {
      if (key.escape || (key.ctrl && input === 'c')) { setEditing(null); setError(null); return true }
      return false
    }
    if (key.escape || (key.ctrl && input === 'c')) { close(); return true }
    if (key.ctrl || key.meta || !row) return false
    if (key.return || input === 'e') { setEditing(row.loop); setDraft(''); return true }
    if (input === 'd' || key.delete) {
      if (row.own == null) { actions.toast(`${row.loop} already uses ${row.loop === MAIN_LOOP ? 'the default' : 'main’s threshold'}`, 'info', 2000); return true }
      void applyThreshold(store, agentId, row.loop, null)
      return true
    }
    if (input === 'c') {
      void actions.confirm({ title: `Compact ${row.loop} now?`, message: 'Summarizes this loop’s history into a short context now (the full history stays in the audit log when auditing is on).', confirmLabel: 'Compact' })
        .then(ok => { if (ok) void actions.compactLoop(agentId, row.loop).then(() => loadContextUsage(store.client, agentId, [row.loop]).then(c => setContext(prev => ({ ...prev, ...c })))) })
      return true
    }
    return false
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(40, Math.min(width - 4, 90))
  const inner = dialogWidth - 4
  const barWidth = Math.max(6, Math.min(20, inner - 60))
  const who = agent?.summary.handle || agent?.summary.name || agentId
  const locked = config ? isLocked(config, ['context']) : false
  return (
    <Modal
      title={`Compaction ${theme.glyph.sep} ${who}`}
      width={dialogWidth}
      hints={editing
        ? [{ keys: 'enter', label: 'save' }, { keys: 'esc', label: 'cancel' }]
        : [{ keys: 'enter e', label: 'set' }, { keys: 'd', label: 'default/inherit' }, { keys: 'c', label: 'compact now' }, { keys: 'esc', label: 'close' }]}
    >
      <Text color={theme.color.muted} wrap="wrap">When a loop’s context reaches its threshold, its history is summarized. main’s applies to the agent; an inner loop inherits it unless it sets its own. /context shows the breakdown.</Text>
      {locked ? <Text color={theme.color.warn} wrap="truncate-end">The context section is locked for the agent; you can still change it.</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.color.dim} wrap="truncate-end">{'  '}{'loop'.padEnd(16)}{'threshold'.padEnd(22)}{'in use'}</Text>
        <List
          items={rows}
          getKey={r => r.loop}
          height={Math.max(1, Math.min(rows.length, height - 16))}
          width={inner}
          keyLayer="overlay"
          active={!editing}
          selectedIndex={Math.min(index, Math.max(0, rows.length - 1))}
          onSelectedIndexChange={setIndex}
          renderItem={(r, { selected }) => {
            const used = context[r.loop]
            const pct = typeof used === 'number' ? Math.min(100, Math.round(used / r.effective * 100)) : null
            const filled = pct === null ? 0 : Math.round(pct / 100 * barWidth)
            const bar = pct === null ? '' : `${'#'.repeat(filled)}${'.'.repeat(barWidth - filled)}`
            return (
              <Text wrap="truncate-end" inverse={theme.mono && selected}>
                <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
                <Text bold={selected} color={theme.color.text}>{truncate(r.loop, 15).padEnd(16)}</Text>
                <Text color={r.own != null ? theme.color.text : theme.color.muted}>{`${formatTokens(r.effective)} ${r.own != null ? '' : `(${r.source})`}`.padEnd(22)}</Text>
                <Text color={pct !== null && pct >= 80 ? theme.color.warn : theme.color.muted}>{pct === null ? 'no usage yet' : `${bar} ${formatTokens(used as number)} ${pct}%`}</Text>
              </Text>
            )
          }}
        />
      </Box>
      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.color.text} wrap="wrap">New threshold for {editing} (now {formatTokens(rows.find(r => r.loop === editing)?.effective ?? 0)}): tokens like 80000 or 80k, or {editing === MAIN_LOOP ? 'default' : 'inherit'}. Empty keeps it.</Text>
          <TextInput value={draft} onChange={v => { setDraft(v); setError(null) }} onSubmit={v => { void submit(v); return false }} focused keyLayer="overlay" maxRows={1} />
          {error ? <Text color={theme.color.error}>{error}</Text> : null}
        </Box>
      ) : null}
    </Modal>
  )
}

/** Pick mesh visibility or send mode (Enter applies; public / LAN ask first). */
export function SettingChoiceOverlay({ overlay, close, width }: OverlayProps) {
  const theme = useTheme()
  const store = useStore()
  const { actions } = store
  const agentId = String(overlay.props?.agentId ?? '')
  const setting = overlay.props?.setting === 'send' ? 'send' : 'visibility'
  const agent = useAgent(agentId)
  const m = agent?.config?.messaging
  const options: Array<{ value: string; hint: string }> = setting === 'send'
    ? SEND_MODES.map(v => ({ value: v, hint: SEND_MODE_HINTS[v] }))
    : VISIBILITY_TIERS.map(v => ({ value: v, hint: VISIBILITY_HINTS[v] }))
  const current = setting === 'send' ? (m?.mode ?? 'respond_only') : (m?.visibility ?? 'localhost')
  const [index, setIndex] = useState(Math.max(0, options.findIndex(o => o.value === current)))

  const apply = async (value: string) => {
    close()
    if (value === current) return
    if (setting === 'visibility' && (value === 'lan' || value === 'public')) {
      const ok = await actions.confirm({
        title: `Make the agent reachable ${value === 'public' ? 'from the internet' : 'on the local network'}?`,
        message: `Visibility ${value}: ${VISIBILITY_HINTS[value as VisibilityTier]}. Other agents there can send it messages.`,
        confirmLabel: 'Change visibility',
        danger: true,
      })
      if (!ok) return
    }
    await applyChange(actions, agentId, cfg => (setting === 'send' ? setSendMode(cfg, value as SendMode) : setVisibility(cfg, value as VisibilityTier)), 'Messaging')
  }

  useKeys((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) { close(); return true }
    return false
  }, { layer: 'overlay' })

  const dialogWidth = Math.max(36, Math.min(width - 4, 80))
  return (
    <Modal title={setting === 'send' ? 'Send mode' : 'Mesh visibility'} width={dialogWidth} hints={[{ keys: 'enter', label: 'apply' }, { keys: 'esc', label: 'cancel' }]}>
      <List
        items={options}
        getKey={o => o.value}
        height={options.length}
        width={dialogWidth - 4}
        keyLayer="overlay"
        selectedIndex={index}
        onSelectedIndexChange={setIndex}
        onSubmit={o => { void apply(o.value) }}
        renderItem={(o, { selected }) => (
          <Text wrap="truncate-end" inverse={theme.mono && selected}>
            <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
            <Text bold={selected} color={theme.color.text}>{o.value.padEnd(14)}</Text>
            <Text color={theme.color.muted}>{o.hint}</Text>
            {o.value === current ? <Text color={theme.color.accent}>  (current)</Text> : null}
          </Text>
        )}
      />
    </Modal>
  )
}
