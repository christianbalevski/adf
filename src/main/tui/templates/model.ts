// /templates: pure helpers for the templates dialog. Mirrors Studio's
// Settings > Agent templates (src/renderer/components/settings/
// AgentTemplatesTab.tsx) and its template review (AgentReviewDialog's
// ReviewContent in template mode) over the daemon's /templates routes.

import type { AgentConfig } from '../api/types'
import type { AgentConfigSummary, AgentTemplateContents, AgentTemplateSummary } from '../../../shared/types/ipc.types'
import type { Line, Segment } from '../views/inspect/format'

/** Overlay kind (registered by the shell's overlay host). */
export const TEMPLATES_OVERLAY = 'templates'

export type TemplateSummary = AgentTemplateSummary
export type TemplateContents = AgentTemplateContents

/** Props of the templates overlay. `id` opens that template's details. */
export interface TemplatesOverlayProps {
  id?: string
}

/** `GET /templates/:id`. */
export interface TemplateDetail {
  template: TemplateSummary | null
  isDefault: boolean
  defaultId: string
  contents: TemplateContents
}

/** Create / rename / notes / reset / accept: the (possibly new) id and its summary. */
export interface TemplateWriteResult {
  id: string
  template: TemplateSummary | null
}

/** `GET /templates/:id/review`. */
export interface TemplateReview {
  id: string
  needsReview: boolean
  reviewed: boolean
  summary: AgentConfigSummary
}

/** Shown first, in this order (Studio's SHIPPED_ORDER). */
export const SHIPPED_ORDER = ['standard', 'sandboxed', 'full-access'] as const

/** The rule instantiate follows, printed verbatim (Studio). */
export const INSTANTIATE_RULE = 'New agents get everything in a template except its identity and history.'

export const NAME_HINT = 'Use letters, digits, dashes, underscores and spaces.'
const NAME_RULE = /^[A-Za-z0-9 _-]+$/
export const NOTE_MAX = 500

/** Seed files the contents editor owns (Studio's SEED_FILES), in order. */
export const SEED_FILES = [
  { key: 'readme', path: 'README.md' },
  { key: 'mind', path: 'mind.md' },
  { key: 'soul', path: 'soul.md' },
] as const
export type SeedKey = (typeof SEED_FILES)[number]['key']

/** Shipped first in SHIPPED_ORDER, then the rest by name. */
export function sortTemplates(list: TemplateSummary[]): TemplateSummary[] {
  const shipped = SHIPPED_ORDER
    .map(id => list.find(t => t.shipped === id))
    .filter((t): t is TemplateSummary => !!t)
  const rest = list.filter(t => !t.shipped).sort((a, b) => a.name.localeCompare(b.name))
  return [...shipped, ...rest]
}

/** A duplicate's proposed name, trimmed to what a file stem accepts. */
export function copyName(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9 _-]/g, '').trim()
  return `${stem || 'template'} copy`
}

/** Studio's name check; the daemon checks again. null = fine. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Give the template a name.'
  if (trimmed.length > 64) return 'Name is longer than 64 characters.'
  if (!NAME_RULE.test(trimmed)) return NAME_HINT
  return null
}

export function noteProblem(text: string): string | null {
  return text.trim().length > NOTE_MAX ? `At most ${NOTE_MAX} characters.` : null
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Tags after a template's name in the list: Shipped, Default, Not reviewed, Has run. */
export function templateTags(t: TemplateSummary, defaultId: string | undefined): Array<{ text: string; tone: 'muted' | 'accent' | 'warn' | 'dim' }> {
  const tags: Array<{ text: string; tone: 'muted' | 'accent' | 'warn' | 'dim' }> = []
  if (t.id === defaultId) tags.push({ text: 'default', tone: 'accent' })
  if (t.shipped) tags.push({ text: 'shipped', tone: 'muted' })
  if (!t.reviewed) tags.push({ text: 'not reviewed', tone: 'warn' })
  if (t.hasHistory) tags.push({ text: 'has run', tone: 'dim' })
  return tags
}

/** What the template is for: its notes, else the agent's own description (Studio). */
export function blurb(t: TemplateSummary): string {
  return t.templateDescription ?? t.description ?? ''
}

/** Studio wording for a failed call, by the daemon's `code`. */
export function templateErrorText(code: string | undefined, message: string): string {
  switch (code) {
    case 'identity_not_ready': return `${message.replace(/\s+$/, '')} Press i to set up or unlock the owner identity.`
    case 'password_required': return 'This template is password-protected. Enter its password to accept it.'
    case 'wrong_password': return 'Wrong password.'
    default: return message
  }
}

// --- detail -----------------------------------------------------------------

const seg = (text: string, tone?: Segment['tone'], bold?: boolean): Segment => ({ text, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}) })
const row = (label: string, value: string, tone?: Segment['tone']): Line => [seg(label.padEnd(12), 'muted'), seg(value, tone)]

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    let line = raw
    if (line.length === 0) { out.push(''); continue }
    while (line.length > width) {
      const cut = line.lastIndexOf(' ', width)
      const at = cut > width / 3 ? cut : width
      out.push(line.slice(0, at))
      line = line.slice(at).replace(/^ /, '')
    }
    out.push(line)
  }
  return out
}

/** The details page: notes, model, instructions, tools, loops, files (Studio's editor, read-only). */
export function detailLines(detail: TemplateDetail, width: number, instructionLines = 8): Line[] {
  const t = detail.template
  const config = detail.contents.config as AgentConfig
  const lines: Line[] = []
  const w = Math.max(20, width)
  if (t?.templateDescription) for (const l of wrap(t.templateDescription, w)) lines.push([seg(l)])
  else if (config.description) for (const l of wrap(config.description, w)) lines.push([seg(l, 'muted')])
  if (t?.warning) wrap(`! ${t.warning}`, w).forEach(l => lines.push([seg(l, 'warn')]))
  lines.push([])
  const model = [config.model?.provider || 'no provider set', config.model?.model_id].filter(Boolean).join(' / ')
  lines.push(row('model', model, config.model?.provider ? undefined : 'dim'))
  const tools = config.tools ?? []
  const enabled = tools.filter(tool => tool.enabled)
  lines.push(row('tools', `${enabled.length} on / ${tools.length}${enabled.length ? `: ${enabled.map(tool => tool.name).join(', ')}` : ''}`))
  const loops = (config as { loops?: Array<{ name: string; enabled?: boolean }> }).loops ?? []
  if (loops.length) lines.push(row('loops', loops.map(l => `${l.name}${l.enabled === false ? ' (off)' : ''}`).join(', ')))
  const mcp = config.mcp?.servers ?? []
  if (mcp.length) lines.push(row('mcp', mcp.map(s => s.name).join(', ')))
  const compute = config.compute?.enabled ? (config.compute.host_access ? 'host access' : 'isolated container') : 'shared container'
  lines.push(row('compute', compute, config.compute?.host_access ? 'warn' : undefined))
  if (config.autostart) lines.push(row('autostart', 'yes'))
  if (t) lines.push(row('file', t.filePath, 'dim'))
  lines.push([])
  lines.push([seg('Instructions', 'heading', true), seg('  e edits', 'dim')])
  const instructions = (config.instructions ?? '').trim()
  if (!instructions) lines.push([seg('(none)', 'dim')])
  else {
    const wrapped = wrap(instructions, w)
    for (const l of wrapped.slice(0, instructionLines)) lines.push([seg(l)])
    if (wrapped.length > instructionLines) lines.push([seg(`… ${wrapped.length - instructionLines} more lines`, 'dim')])
  }
  lines.push([])
  lines.push([seg('Files', 'heading', true), seg('  f edits the starting content', 'dim')])
  for (const f of SEED_FILES) {
    const text = detail.contents.files[f.key] ?? ''
    const first = text.split('\n').find(l => l.trim()) ?? ''
    lines.push([seg(f.path.padEnd(12), 'key'), seg(text ? `${formatSize(Buffer.byteLength(text, 'utf-8')).padEnd(9)}` : 'empty    ', text ? undefined : 'dim'), seg(first, 'dim')])
  }
  for (const f of detail.contents.extra) lines.push([seg(f.path.padEnd(12), 'key'), seg(formatSize(f.size).padEnd(9)), seg('extra, copied into every new agent', 'dim')])
  lines.push([])
  lines.push([seg(INSTANTIATE_RULE, 'dim')])
  return lines
}

// --- review -----------------------------------------------------------------

const SCENARIO_LABEL: Record<AgentConfigSummary['identity']['scenario'], string> = {
  mine: 'Yours',
  recognized: 'Yours, another install',
  foreign: 'From another owner',
  unclaimed: 'No identity',
}

const TIER: Record<AgentConfigSummary['computeTier'], { label: string; description: string }> = {
  shared: { label: 'Shared', description: 'Runs in shared container with other agents' },
  isolated: { label: 'Isolated', description: 'Runs in its own isolated container' },
  host: { label: 'Host Access', description: 'Can run processes on your host machine' },
}

/** Studio's ReviewContent for a template, as lines. Amber rows carry `!`. */
export function reviewLines(summary: AgentConfigSummary, width: number): Line[] {
  const w = Math.max(20, width)
  const identity = summary.identity
  const lines: Line[] = []
  lines.push([seg(summary.name, 'text', true), seg(`  ${SCENARIO_LABEL[identity.scenario]}`, identity.needsClaim ? 'warn' : 'success')])
  if (summary.description) wrap(summary.description, w).forEach(l => lines.push([seg(l, 'muted')]))
  if (identity.fileOwnerDid && !identity.ownerIsYou) lines.push([seg('From: another owner ', 'muted'), seg(identity.fileOwnerDid, 'dim')])
  if (identity.agentDid) lines.push([seg('Agent: ', 'muted'), seg(identity.agentDid, 'dim')])
  if (identity.scenario === 'unclaimed') {
    wrap('This agent has no identity, so its origin can\'t be verified: anyone could have made it. Give its capabilities a careful look before accepting.', w).forEach(l => lines.push([seg(l, 'warn')]))
  }
  if (identity.seedUnavailable) {
    wrap('This file is yours, but its keys can\'t be unlocked here: restore your seed phrase (/identity) to use it on this machine.', w).forEach(l => lines.push([seg(l, 'warn')]))
  }
  lines.push([])
  const tier = TIER[summary.computeTier]
  lines.push([seg('Compute    ', 'muted'), seg(tier.label, summary.computeTier === 'host' ? 'warn' : 'text', true), seg(`  ${tier.description}`, 'muted')])
  lines.push([])
  lines.push([seg('Capabilities', 'heading', true)])
  const cap = (label: string, value: string, amber = false) => {
    if (!value) return
    lines.push([seg(`${amber ? '! ' : '  '}${label.padEnd(10)}`, amber ? 'warn' : 'muted'), seg(value, amber ? 'warn' : 'text')])
  }
  const enabledTools = summary.tools.filter(t => t.enabled)
  const notable = enabledTools.filter(t => t.notable)
  cap('Tools', notable.length ? `${enabledTools.length} enabled: ${notable.map(t => t.name).join(', ')}` : `${enabledTools.length} enabled`, notable.length > 0)
  cap('MCP', summary.mcpServers.map(s => `${s.name} (${s.transport === 'http' ? 'remote' : s.runLocation === 'host' ? 'host' : 'container'})`).join(', '))
  cap('Triggers', summary.triggers.filter(t => t.enabled).map(t => t.type).join(', '))
  if (summary.codeExecution) cap('Code', 'Code execution enabled', true)
  cap('Messaging', summary.messaging.mode)
  const provider = summary.provider
  if (provider) {
    const label = [provider.configuredId || 'no provider set', provider.modelId].filter(Boolean).join(' / ')
    const gap = provider.status === 'missing' ? ': no matching provider on this daemon' : provider.status === 'unchecked' ? ': credentials not checked' : provider.status === 'ok' ? '' : `: ${provider.status}`
    cap('Provider', `${label}${gap}`, provider.status === 'missing' || provider.status === 'failed')
  }
  const ws = summary.network.wsConnections
  const net: Array<[string, string, boolean]> = [
    ['WebSocket', ws.length ? `${ws.length} outbound: ${ws.map(c => c.did ?? c.url).join(', ')}` : '', ws.length > 0],
    ['Channels', summary.network.adapters.join(', '), summary.network.adapters.length > 0],
    ['Serving', summary.network.serving ? `${summary.network.serving.routeCount} API route${summary.network.serving.routeCount > 1 ? 's' : ''}` : '', false],
    ['Autostart', summary.autostart ? (ws.length || summary.network.adapters.length ? 'Yes, connects on boot' : 'Yes') : '', summary.autostart && (ws.length > 0 || summary.network.adapters.length > 0)],
  ]
  if (net.some(([, v]) => v)) {
    lines.push([])
    lines.push([seg('Network', 'heading', true)])
    for (const [label, value, amber] of net) cap(label, value, amber)
  }
  if (summary.security.tableProtections.length) {
    lines.push([])
    lines.push([seg('Security', 'heading', true)])
    cap('Tables', summary.security.tableProtections.map(p => `${p.table}: ${p.protection === 'append_only' ? 'append-only' : 'authorized only'}`).join(', '), true)
  }
  lines.push([])
  wrap('Claiming gives this template a fresh identity under your ownership. Agents you create from it never carry its identity or history.', w).forEach(l => lines.push([seg(l, 'muted')]))
  return lines
}
