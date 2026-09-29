// Triggers tab: every trigger type with its configured state and targets
// (and each target's loop) next to what the running agent reports.

import { useEffect } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useActions } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { List } from '../../ui/List'
import { truncate } from '../../ui/text'
import { MAIN_LOOP } from '../../api/types'
import type { Key } from '../../app/keys'
import { TabBar, row } from './common'
import { useRuntimeTriggers } from './hooks'
import { TRIGGER_TYPES, describeTarget, type TriggerTypeV3 } from './model'
import { openTriggerDialog } from './ops'
import { toggleTrigger } from './trigger-ops'
import type { TabProps } from './LoopsTab'

export function TriggersTab({ agentId, width, height, focused, view, setView, tabKeys }: TabProps) {
  const theme = useTheme()
  const actions = useActions()
  const agent = useAgent(agentId)
  const runtime = useRuntimeTriggers(agentId)
  const config = agent?.config
  useEffect(() => { if (!config) void actions.loadConfig(agentId) }, [agentId, !!config])
  const label = agent?.summary.handle || agent?.summary.name || agentId
  const index = Math.min(view.triggerIndex, TRIGGER_TYPES.length - 1)
  const selectedType = TRIGGER_TYPES[index]
  const selectedCfg = config?.triggers?.[selectedType]
  const w = width
  const detailRows = Math.max(0, Math.min(8, height - TRIGGER_TYPES.length - 5))
  const listRows = Math.max(1, height - 4 - detailRows - (runtime.error ? 1 : 0))

  const runtimeOf = (type: TriggerTypeV3) => runtime.data?.configured.find(c => c.type === type)
  const cols = (type: TriggerTypeV3 | null): Array<[string, number, ('left' | 'right')?]> => {
    if (!type) return [['TRIGGER', 17], ['CONFIG', 7], ['RUNTIME', 8], ['TARGETS', Math.max(10, w - 17 - 7 - 8 - 5)]]
    const cfg = config?.triggers?.[type]
    const rt = runtimeOf(type)
    const loops = cfg ? [...new Set(cfg.targets.filter(t => t.scope === 'agent').map(t => t.loop ?? MAIN_LOOP))] : []
    const system = cfg ? cfg.targets.filter(t => t.scope === 'system').length : 0
    const targets = cfg
      ? [loops.length ? `${theme.glyph.arrow} ${loops.join(', ')}` : '', system ? `${system} system` : ''].filter(Boolean).join(' · ') || 'no targets'
      : 'not configured'
    return [
      [type, 17],
      [cfg ? (cfg.enabled ? 'on' : 'off') + (cfg.locked ? ' lock' : '') : '-', 7],
      [rt ? `${rt.enabled ? 'on' : 'off'} ${rt.targetCount}t` : runtime.data ? '-' : '…', 8],
      [targets, Math.max(10, w - 17 - 7 - 8 - 5)],
    ]
  }

  const onKey = (input: string, key: Key, type: TriggerTypeV3 | undefined): boolean => {
    if (tabKeys(input, key)) return true
    if (input === 'r') { runtime.reload(); void actions.loadConfig(agentId); return true }
    if (!type) return false
    if (input === 'x' || input === ' ') { void toggleTrigger(actions, agentId, type); return true }
    if (input === 'e') { openTriggerDialog(actions, { agentId, type }); return true }
    return false
  }

  return (
    <Box flexDirection="column" width={w} height={height}>
      <Text bold color={theme.color.loop} wrap="truncate-end">
        {theme.glyph.loop} Triggers of {label}
        <Text color={theme.color.muted}>  agent state {runtime.data?.displayState ?? '?'} · a target's loop is the loop it wakes</Text>
      </Text>
      <TabBar tab="triggers" width={w} hints={TRIGGERS_TAB_HINTS} />
      {runtime.error ? <Text color={theme.color.error}>{truncate(`Runtime triggers: ${runtime.error}`, w)}</Text> : null}
      <Text color={theme.color.muted} bold>{'  '}{row(cols(null), w - 2)}</Text>
      <List
        items={[...TRIGGER_TYPES]}
        getKey={t => t}
        height={listRows}
        width={w}
        active={focused}
        selectedIndex={index}
        onSelectedIndexChange={i => setView({ triggerIndex: i })}
        onSubmit={type => openTriggerDialog(actions, { agentId, type })}
        onKey={onKey}
        renderItem={(type, { selected, width: rw }) => {
          const cfg = config?.triggers?.[type]
          return (
            <Text
              wrap="truncate-end"
              backgroundColor={selected ? theme.color.selectionBg : undefined}
              inverse={theme.mono && selected}
              bold={selected}
              color={selected ? theme.color.selectionFg : cfg?.enabled ? theme.color.text : theme.color.dim}
            >
              {selected ? `${theme.glyph.pointer} ` : '  '}{row(cols(type), rw - 2)}
            </Text>
          )
        }}
      />
      {detailRows > 1 ? (
        <Box flexDirection="column" height={detailRows} borderStyle={theme.ascii ? 'classic' : 'single'} borderColor={theme.color.border} borderLeft={false} borderRight={false} borderBottom={false}>
          {!config ? <Text color={theme.color.muted}>Loading config…</Text> : !selectedCfg ? (
            <Text color={theme.color.muted}>{selectedType} is not configured. x enables it (with no targets), e adds targets.</Text>
          ) : selectedCfg.targets.length === 0 ? (
            <Text color={theme.color.muted}>{selectedType} has no targets: it wakes nothing. e to add one.</Text>
          ) : (
            selectedCfg.targets.slice(0, detailRows - 1).map((t, i) => (
              <Text key={i} wrap="truncate-end" color={t.scope === 'agent' ? theme.color.loop : theme.color.text}>{truncate(`${i + 1}. ${describeTarget(t)}`, w)}</Text>
            ))
          )}
        </Box>
      ) : null}
    </Box>
  )
}

export const TRIGGERS_TAB_HINTS = [
  { keys: 'x', label: 'enable/disable' },
  { keys: 'enter e', label: 'edit targets' },
  { keys: 'r', label: 'refresh' },
]
