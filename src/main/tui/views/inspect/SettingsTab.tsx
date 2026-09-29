// Inspect › Settings: the settings owners change most, without raw JSON.
// Instructions, tools and compaction open dialogs; the switches flip in place
// (autonomous and host access ask first, with Studio's warnings). Every write
// re-reads the config and changes only its own fields (settings-ops.ts).

import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { useActions, useClient } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { List } from '../../ui/List'
import { truncate } from '../../ui/text'
import { MAIN_LOOP } from '../../api/types'
import type { AgentConfig } from '../../api/types'
import type { TuiActions } from '../../state/store'
import type { DaemonClient } from '../../api/client'
import { useInspectState } from './state'
import {
  contextTokens, setAutonomous, setAutostart, setHostAccess, setInboxMode, setNewMcpToolsRestricted, setReceive,
  settingRows, toggleSectionLock, type SettingRow, type SettingsExtras,
} from './settings-model'
import { applyChange } from './settings-ops'

export const TOOLS_OVERLAY = 'inspect.tools'
export const INSTRUCTIONS_OVERLAY = 'inspect.instructions'
export const COMPACTION_OVERLAY = 'inspect.compaction'
export const CHOICE_OVERLAY = 'inspect.setting-choice'

/** Context in use per loop, from the newest entries with token usage (best effort). */
export async function loadContextUsage(client: DaemonClient, agentId: string, loops: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  await Promise.all(loops.map(async loop => {
    try {
      const page = await client.loopHistory(agentId, { loop, limit: 20 })
      out[loop] = contextTokens(page.entries)
    } catch {
      out[loop] = null
    }
  }))
  return out
}

/** Enter / Space on a row: dialogs open, switches flip (the risky ones ask). */
export async function actOnSetting(actions: TuiActions, agentId: string, row: SettingRow, config: AgentConfig): Promise<void> {
  switch (row.id) {
    case 'instructions': actions.pushOverlay({ kind: INSTRUCTIONS_OVERLAY, props: { agentId } }); return
    case 'tools': actions.pushOverlay({ kind: TOOLS_OVERLAY, props: { agentId } }); return
    case 'compaction': actions.pushOverlay({ kind: COMPACTION_OVERLAY, props: { agentId } }); return
    case 'visibility':
    case 'send': actions.pushOverlay({ kind: CHOICE_OVERLAY, props: { agentId, setting: row.id } }); return
    case 'autonomous': {
      const on = !config.autonomous
      if (on && !await actions.confirm({
        title: 'Turn on autonomous mode?',
        message: 'An autonomous agent keeps making LLM calls without pausing between turns. That uses tokens and costs money; if it loops, costs escalate quickly. Make sure its instructions have clear stopping conditions and sys_set_state is enabled so it can idle or stop itself.',
        confirmLabel: 'Turn on',
        danger: true,
      })) return
      await applyChange(actions, agentId, cfg => setAutonomous(cfg, on))
      return
    }
    case 'autostart': await applyChange(actions, agentId, cfg => setAutostart(cfg, !cfg.autostart)); return
    case 'receive': await applyChange(actions, agentId, cfg => setReceive(cfg, !cfg.messaging?.receive)); return
    case 'inbox': await applyChange(actions, agentId, cfg => setInboxMode(cfg, !cfg.messaging?.inbox_mode)); return
    case 'mcp-approval': await applyChange(actions, agentId, cfg => setNewMcpToolsRestricted(cfg, cfg.mcp?.new_tools_restricted === false)); return
    case 'host': {
      const on = !row.on
      if (on && !await actions.confirm({
        title: 'Give the agent host access?',
        message: 'Host access lets the agent run MCP servers and compute_exec directly on this machine, outside container isolation: it can read and change your files and run programs as you. The daemon’s own host access setting (Settings › Compute) must be on too. Restart the agent afterwards so its tools see the change.',
        confirmLabel: 'Allow host access',
        danger: true,
      })) return
      await applyChange(actions, agentId, cfg => setHostAccess(cfg, on))
      return
    }
  }
}

export function SettingsTab({ agentId, width, height, focused }: { agentId: string; label?: string; width: number; height: number; focused: boolean }) {
  const theme = useTheme()
  const actions = useActions()
  const client = useClient()
  const agent = useAgent(agentId)
  const [inspect, update] = useInspectState()
  const [extras, setExtras] = useState<SettingsExtras>({})
  const config = agent?.config
  const loopNames = [MAIN_LOOP, ...(config?.loops ?? []).map(l => l.name)]

  const reload = async (announce = false) => {
    const cfg = await actions.loadConfig(agentId)
    const names = [MAIN_LOOP, ...(cfg?.loops ?? []).map(l => l.name)]
    const [context, host] = await Promise.all([
      loadContextUsage(client, agentId, names),
      client.setting('compute').then(r => !!(r.value as { hostAccessEnabled?: boolean } | null)?.hostAccessEnabled, () => null),
    ])
    setExtras({ context, daemonHostAccess: host })
    if (announce && cfg) actions.toast('Settings reloaded', 'info', 1500)
  }

  useEffect(() => { void reload() }, [agentId])
  // Context use moves with every turn; refresh it when the config or the loop set changes.
  useEffect(() => {
    if (!config) return
    void loadContextUsage(client, agentId, loopNames).then(context => setExtras(e => ({ ...e, context })))
  }, [loopNames.join(',')])

  const rows = config ? settingRows(config, extras) : []
  const index = Math.min(inspect.settingsIndex ?? 0, Math.max(0, rows.length - 1))

  useKeys((input, key) => {
    if (key.ctrl || key.meta || !config) return false
    const row = rows[index]
    if (input === ' ' && row) { void actOnSetting(actions, agentId, row, config); return true }
    if (input === 'e') { actions.pushOverlay({ kind: INSTRUCTIONS_OVERLAY, props: { agentId, editor: true } }); return true }
    if (input === 'l' && row) {
      if (!row.lockKeys) { actions.toast(`${row.label.trim()} has no section lock`, 'info', 2000); return true }
      void applyChange(actions, agentId, cfg => toggleSectionLock(cfg, row.lockKeys!, row.label.trim()))
      return true
    }
    if (input === 'r') { void reload(true); return true }
    return false
  }, { layer: 'main', active: focused })

  if (!config) return <Text color={theme.color.muted}>Loading config…</Text>

  const labelWidth = Math.max(18, Math.min(30, Math.floor(width * 0.34)))
  const listHeight = Math.max(2, height - 1)
  return (
    <Box flexDirection="column" width={width} height={height}>
      <List
        items={rows}
        getKey={r => r.id}
        height={listHeight}
        width={width}
        itemHeight={2}
        active={focused}
        selectedIndex={index}
        onSelectedIndexChange={i => update({ settingsIndex: i })}
        onSubmit={row => { void actOnSetting(actions, agentId, row, config) }}
        renderItem={(row, { selected }) => {
          const valueColor = row.warn ? theme.color.warn : row.kind === 'bool' ? (row.on ? theme.color.success : theme.color.muted) : theme.color.text
          const lock = row.locked ? ' [locked]' : ''
          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end" inverse={theme.mono && selected}>
                <Text color={selected ? theme.color.accent : theme.color.dim}>{selected ? theme.glyph.pointer : ' '} </Text>
                <Text bold={selected} color={theme.color.text}>{truncate(row.label, labelWidth - 3).padEnd(labelWidth - 2)}</Text>
                <Text color={valueColor} bold={row.kind === 'bool'}>{row.kind === 'bool' ? (row.on ? '[x] on' : '[ ] off') : row.value}</Text>
                <Text color={theme.color.warn}>{lock}</Text>
              </Text>
              <Text wrap="truncate-end" color={row.warn && row.kind === 'bool' ? theme.color.warn : theme.color.dim}>{'  '}{' '.repeat(labelWidth - 2)}{row.hint ?? ''}</Text>
            </Box>
          )
        }}
      />
      <Text color={theme.color.dim} wrap="truncate-end">enter open/toggle {theme.glyph.sep} space toggle {theme.glyph.sep} e instructions in $EDITOR {theme.glyph.sep} l lock for the agent {theme.glyph.sep} r reload {theme.glyph.sep} raw JSON: Config tab</Text>
    </Box>
  )
}
