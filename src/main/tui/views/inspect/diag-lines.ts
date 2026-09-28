// Diagnostics → display lines, one builder per inspector tab. Pure, so the
// shapes can be tested without rendering. Raw mode (/json) bypasses these.

import type {
  AgentAdaptersDiagnostics,
  AgentMcpDiagnostics,
  AgentRuntimeDiagnostics,
  AgentUsage,
  IdentityListResult,
} from '../../api/types'
import type { LoopState, TokenTally } from '../../state/types'
import { blank, formatNumber, heading, plain, tableLines, treeLines, redactSecrets, type Line } from './format'
import { formatClock } from '../../ui/text'

function stamp(at: number | undefined): string {
  return at ? formatClock(at) : '-'
}

export function runtimeLines(diag: AgentRuntimeDiagnostics, loops: LoopState[] | undefined): Line[] {
  const out: Line[] = []
  out.push(heading('Status'))
  out.push(...(diag.status ? treeLines(redactSecrets(diag.status), 2) : [plain('  not running in the daemon', 'muted')]))
  out.push(blank(), heading('Loops (parallel chat sessions of this agent)'))
  if (!loops) out.push(plain('  loading…', 'muted'))
  else {
    out.push(...tableLines(
      ['loop', 'status', 'enabled', 'entries', 'tools', 'goal'],
      loops.map(l => [
        l.info.name,
        l.executorState ?? l.info.status,
        l.info.enabled ? 'yes' : 'no',
        String(l.info.entryCount ?? '-'),
        l.info.isMain ? 'all' : String(l.info.effectiveTools?.length ?? 0),
        (l.info.goal ?? '').replace(/\s+/g, ' '),
      ]),
      { align: ['left', 'left', 'left', 'right', 'right', 'left'], maxWidth: 48 },
    ).map(indent))
  }
  out.push(blank(), heading('Triggers'))
  const triggers = diag.triggers?.configured ?? []
  out.push(...tableLines(
    ['type', 'enabled', 'targets', 'target loops'],
    triggers.map(t => [
      t.type,
      t.enabled ? 'yes' : 'no',
      String(t.targetCount),
      [...new Set((t.targets ?? []).map(target => (target as { loop?: string }).loop ?? 'main'))].join(', ') || '-',
    ]),
  ).map(indent))
  if (diag.triggers?.displayState) out.push(plain(`  display state: ${diag.triggers.displayState}`, 'muted'))
  out.push(blank(), heading('WebSocket'))
  out.push(plain(`  configured ${diag.ws?.configured?.length ?? 0} ${'·'} active ${diag.ws?.active?.length ?? 0}`))
  for (const conn of diag.ws?.active ?? []) out.push(...treeLines(redactSecrets(conn), 4))
  out.push(blank(), heading('Services'))
  out.push(plain(`  MCP servers ${diag.mcp?.states?.length ?? 0} live / ${diag.mcp?.configured?.length ?? 0} configured ${'·'} adapters ${diag.adapters?.states?.length ?? 0} live / ${diag.adapters?.configured?.length ?? 0} configured`, 'muted'))
  return out
}

export function usageLines(usage: AgentUsage, session: TokenTally | undefined, lastModel: string | undefined): Line[] {
  const out: Line[] = [heading('This TUI session (live, from llm.completed)')]
  out.push(...tableLines(
    ['input', 'output', 'cache read', 'cache write', 'last model'],
    [[formatNumber(session?.input ?? 0), formatNumber(session?.output ?? 0), formatNumber(session?.cacheRead ?? 0), formatNumber(session?.cacheWrite ?? 0), lastModel ?? '-']],
    { align: ['right', 'right', 'right', 'right', 'left'] },
  ).map(indent))
  out.push(blank(), heading('By model (all loops, from the agent’s adf_loop)'))
  const rows = usage.byModel.map(m => [m.model, formatNumber(m.rows), formatNumber(m.input), formatNumber(m.output), formatNumber(m.cacheRead), formatNumber(m.cacheWrite), formatNumber(m.total)])
  rows.push(['total', formatNumber(usage.usageRows), formatNumber(usage.totals.input), formatNumber(usage.totals.output), formatNumber(usage.totals.cacheRead), formatNumber(usage.totals.cacheWrite), formatNumber(usage.totals.total)])
  out.push(...tableLines(['model', 'turns', 'input', 'output', 'cache read', 'cache write', 'total'], rows, { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] }).map(indent))
  out.push(plain(`  ${usage.loopRows} loop rows, ${usage.usageRows} with usage.${usage.note ? ` ${usage.note}` : ''}`, 'muted'))
  return out
}

export function mcpLines(diag: AgentMcpDiagnostics): Line[] {
  const out: Line[] = [heading('Live servers')]
  out.push(...tableLines(
    ['server', 'status', 'tools', 'restarts', 'connected', 'error'],
    diag.states.map(s => [s.name, s.status, String(s.toolCount), String(s.restartCount), stamp(s.connectedAt), s.error ?? '']),
    { align: ['left', 'left', 'right', 'right', 'left', 'left'], maxWidth: 50 },
  ).map(indent))
  out.push(blank(), heading('Configured'))
  out.push(...tableLines(
    ['server', 'transport', 'command', 'tools'],
    diag.configured.map(c => [c.name, c.transport ?? '-', [c.command, ...(c.args ?? [])].filter(Boolean).join(' ') || '-', String(c.toolCount)]),
    { maxWidth: 50 },
  ).map(indent))
  for (const s of diag.states) {
    const logs = (s.logs ?? []).slice(-5)
    if (logs.length === 0) continue
    out.push(blank(), heading(`Recent logs: ${s.name}`))
    for (const log of logs) out.push(logLine(log))
  }
  return out
}

export function adapterLines(diag: AgentAdaptersDiagnostics): Line[] {
  const out: Line[] = [heading('Live adapters')]
  out.push(...tableLines(
    ['adapter', 'status', 'restarts', 'connected', 'error'],
    diag.states.map(s => [s.type, s.status, String(s.restartCount), stamp(s.connectedAt), s.error ?? '']),
    { align: ['left', 'left', 'right', 'left', 'left'], maxWidth: 50 },
  ).map(indent))
  out.push(blank(), heading('Configured'))
  if (diag.configured.length === 0) out.push(plain('  (none)', 'muted'))
  for (const c of diag.configured) {
    out.push([{ text: `  ${c.type} `, tone: 'key' }, { text: c.enabled ? 'enabled' : 'disabled', tone: c.enabled ? 'success' : 'dim' }])
    out.push(...treeLines(redactSecrets(c.config), 4))
  }
  for (const s of diag.states) {
    const logs = (s.logs ?? []).slice(-5)
    if (logs.length === 0) continue
    out.push(blank(), heading(`Recent logs: ${s.type}`))
    for (const log of logs) out.push(logLine(log))
  }
  return out
}

/** Identity metadata only. The API never returns values and this never asks for them. */
export function identityLines(result: IdentityListResult): Line[] {
  const out: Line[] = [heading('Identity entries')]
  out.push(...tableLines(
    ['purpose', 'encrypted', 'code access'],
    result.identities.map(i => [i.purpose, i.encrypted ? 'yes' : 'no', i.code_access ? 'yes' : 'no']),
    { maxWidth: 60 },
  ).map(indent))
  out.push(blank(), plain('Values are never shown here. Manage secrets in Studio or with the agent’s own identity tools.', 'muted'))
  return out
}

function logLine(log: { timestamp?: number; message?: string; level?: string; stream?: string }): Line {
  const level = log.level ?? log.stream ?? ''
  return [{ text: `  ${stamp(log.timestamp)} `, tone: 'dim' }, { text: `${level} `, tone: level === 'error' || level === 'stderr' ? 'error' : 'muted' }, { text: log.message ?? JSON.stringify(log) }]
}

function indent(line: Line): Line {
  return [{ text: '  ' }, ...line]
}
