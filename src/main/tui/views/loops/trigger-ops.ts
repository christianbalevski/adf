// Trigger config writes. Triggers live in the agent config, so every change is
// read-fresh → patch one trigger → show the diff → confirm → PUT config. A
// trigger that changed on the daemon since the diff was shown is not
// overwritten.

import type { TuiActions } from '../../state/store'
import type { AgentConfig } from '../../api/types'
import { compactDiff, jsonLineDiff, type TriggerConfig, type TriggerTypeV3 } from './model'

export function diffText(before: unknown, after: unknown, maxLines = 24): string {
  const lines = compactDiff(jsonLineDiff(before, after))
  const shown = lines.slice(0, maxLines).map(l => (l.sign === '…' ? '  …' : `${l.sign} ${l.text}`))
  if (lines.length > maxLines) shown.push(`  … ${lines.length - maxLines} more lines`)
  return shown.join('\n')
}

export function withTrigger(config: AgentConfig, type: TriggerTypeV3, next: TriggerConfig | undefined): AgentConfig {
  const triggers = { ...(config.triggers ?? {}) }
  if (next) triggers[type] = next
  else delete triggers[type]
  return { ...config, triggers }
}

/** Write `next` as trigger `type`, provided the daemon still has `expected`. Reports visibly. */
export async function writeTrigger(actions: TuiActions, agentId: string, type: TriggerTypeV3, expected: TriggerConfig | undefined, next: TriggerConfig): Promise<{ ok: boolean; message: string }> {
  const fresh = await actions.run('Config', c => c.config(agentId))
  if (!fresh) return { ok: false, message: 'Could not read the agent config' }
  const current = fresh.config.triggers?.[type]
  if (JSON.stringify(current ?? null) !== JSON.stringify(expected ?? null)) {
    const message = `${type} changed on the daemon since you opened it; reopen to see the new version. Nothing written.`
    actions.toast(message, 'warn', 8000)
    return { ok: false, message }
  }
  const saved = await actions.run('Save triggers', c => c.putConfig(agentId, withTrigger(fresh.config, type, next)))
  if (!saved) return { ok: false, message: 'The daemon rejected the config (see the error toast)' }
  await actions.loadConfig(agentId)
  const message = `${type} saved (${next.enabled ? 'enabled' : 'disabled'}, ${next.targets.length} target${next.targets.length === 1 ? '' : 's'})`
  actions.toast(message, 'success')
  return { ok: true, message }
}

/** Enable/disable one trigger with a diff confirm. */
export async function toggleTrigger(actions: TuiActions, agentId: string, type: TriggerTypeV3): Promise<boolean> {
  const fresh = await actions.run('Config', c => c.config(agentId))
  if (!fresh) return false
  const before = fresh.config.triggers?.[type]
  const next: TriggerConfig = before ? { ...before, enabled: !before.enabled } : { enabled: true, targets: [] }
  const extra = next.enabled && next.targets.length === 0 ? '\n\nIt has no targets yet, so it will not wake anything. Add a target with e.' : ''
  const ok = await actions.confirm({
    title: `${next.enabled ? 'Enable' : 'Disable'} ${type}`,
    message: `${diffText({ [type]: before ?? null }, { [type]: next })}${extra}`,
    confirmLabel: 'Write config',
    danger: !next.enabled,
  })
  if (!ok) return false
  return (await writeTrigger(actions, agentId, type, before, next)).ok
}
