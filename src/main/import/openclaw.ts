import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { CreateAgentOptions } from '../../shared/types/adf-v02.types'
import { emptyResult, type ImportResult, type ImportSourceOptions } from './types'
import { parseFrontmatter, get, asString, type YamlValue } from './yaml-lite'
import { buildModel } from './model-map'
import { buildPersona } from './persona'
import { buildAdapters, channelsFromValue } from './channels'

/**
 * Import an OpenClaw agent. The source is a workspace directory
 * (`~/.openclaw/workspaces/<agent>/`) holding SOUL.md (persona), AGENTS.md
 * (operating rules), optional skills, and MEMORY.md. An openclaw.json may sit
 * in the directory (or its parent's parent) and carry model routing.
 */
export function importOpenClaw(opts: ImportSourceOptions): ImportResult {
  const dir = opts.srcPath
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`OpenClaw source must be a workspace directory: ${dir}`)
  }

  const soulRaw = readNamed(dir, 'SOUL.md')
  if (soulRaw === null) {
    throw new Error(`No SOUL.md found in ${dir} — is this an OpenClaw workspace?`)
  }
  const soul = parseFrontmatter(soulRaw)
  const warnings: string[] = []

  const name = opts.name || asString(soul.data.name) || basename(dir.replace(/\/+$/, ''))

  // Persona (SOUL.md body) is the spine of the system prompt; AGENTS.md rules
  // append under a header. By default these stay editable files referenced via
  // {{path}} injection — faithful to OpenClaw, which injects SOUL.md every
  // session — unless --inline was requested.
  const agents = readNamed(dir, 'AGENTS.md')
  const persona = buildPersona({
    name,
    soulBody: soul.body,
    rules: agents ? { label: 'Operating rules', body: agents } : undefined,
    inline: opts.inline ?? false,
  })
  warnings.push(...persona.warnings)

  // openclaw.json (gateway config) carries model routing and channels.
  const gateway = readOpenClawJson(dir)
  const agentEntry = findOpenClawAgent(gateway, name)

  // Model: SOUL.md frontmatter wins, else the agent's entry in openclaw.json.
  const model = buildModel(
    { ref: asString(soul.data.model) ?? asString(get(agentEntry, 'model')) ?? asString(get(gateway, 'model')) },
    warnings,
  )

  const options: CreateAgentOptions = {
    name,
    description: asString(soul.data.description) || '',
    instructions: persona.instructions,
    ...(model ? { model } : {}),
    metadata: { author: asString(soul.data.author), tags: ['imported', 'openclaw'] },
  }

  // Channels (telegram/discord/email) → disabled adapter stubs the user
  // re-credentials. Gateway-level channels and any per-agent channels both count.
  const channels = [
    ...channelsFromValue(get(gateway, 'channels')),
    ...channelsFromValue(get(agentEntry, 'channels')),
  ]
  const mapping = buildAdapters(channels)
  if (Object.keys(mapping.adapters).length > 0) options.adapters = mapping.adapters
  if (mapping.allowList.length > 0) options.messaging = { allow_list: mapping.allowList }
  warnings.push(...mapping.warnings)

  const result = emptyResult('openclaw', options)
  result.warnings = warnings
  result.files.push(...persona.files)

  // Host bindings that are not agent identity — reported, not carried.
  if (hasOpenClawServing(gateway)) {
    result.notTransferred.push(
      'OpenClaw gateway HTTP serving — recreate as lambda-backed serving.api routes if needed.',
    )
  }
  result.notTransferred.push('Conversation history (OpenClaw keeps it host-side; the loop starts empty).')

  // MEMORY.md → long-term memory.
  const memory = readNamed(dir, 'MEMORY.md')
  if (memory) result.mind = memory

  // Skills / tool docs travel as reference files; ADF's own tools stay on
  // their defaults because OpenClaw skill semantics don't map 1:1.
  let skillFiles = 0
  for (const skill of collectSkills(dir)) {
    result.files.push({ path: `imported/skills/${skill.name}`, content: skill.content })
    skillFiles++
  }
  for (const extra of ['TOOLS.md', 'HEARTBEAT.md']) {
    const content = readNamed(dir, extra)
    if (content) { result.files.push({ path: `imported/${extra}`, content }); skillFiles++ }
  }
  if (skillFiles > 0) {
    warnings.push(
      `${skillFiles} OpenClaw skill/tool file(s) copied to imported/ for reference; ` +
      `enable matching ADF tools manually.`,
    )
  }

  return result
}

/** Read a file by case-insensitive name from a directory; null if absent. */
function readNamed(dir: string, name: string): string | null {
  const entries = safeReaddir(dir)
  const hit = entries.find(e => e.toLowerCase() === name.toLowerCase())
  if (!hit) return null
  try { return readFileSync(join(dir, hit), 'utf-8') } catch { return null }
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

/** Collect skill markdown from a `skills/` subdirectory, if present. */
function collectSkills(dir: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = []
  const skillsDir = safeReaddir(dir).find(e => e.toLowerCase() === 'skills')
  if (!skillsDir) {
    const flat = readNamed(dir, 'SKILL.md')
    if (flat) out.push({ name: 'SKILL.md', content: flat })
    return out
  }
  const root = join(dir, skillsDir)
  for (const entry of safeReaddir(root)) {
    const full = join(root, entry)
    try {
      if (statSync(full).isDirectory()) {
        const md = safeReaddir(full).find(e => e.toLowerCase().endsWith('.md'))
        if (md) out.push({ name: `${entry}/${md}`, content: readFileSync(join(full, md), 'utf-8') })
      } else if (entry.toLowerCase().endsWith('.md')) {
        out.push({ name: entry, content: readFileSync(full, 'utf-8') })
      }
    } catch { /* skip unreadable */ }
  }
  return out
}

/** Read the openclaw.json gateway config nearest the workspace, if any. */
function readOpenClawJson(dir: string): YamlValue | null {
  for (const candidate of [join(dir, 'openclaw.json'), join(dir, '..', '..', 'openclaw.json')]) {
    if (!existsSync(candidate)) continue
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as YamlValue
    } catch { /* ignore malformed config, try next */ }
  }
  return null
}

/** Find this agent's entry in the gateway's `agents` list (by id/name, else first). */
function findOpenClawAgent(cfg: YamlValue | null, name: string): YamlValue | undefined {
  const agents = get(cfg ?? undefined, 'agents')
  if (!Array.isArray(agents)) return undefined
  return agents.find(a =>
    a && typeof a === 'object' && !Array.isArray(a) &&
    (asString(get(a, 'id')) === name || asString(get(a, 'name')) === name),
  ) ?? agents[0]
}

/** Whether the gateway config exposes any HTTP serving surface. */
function hasOpenClawServing(cfg: YamlValue | null): boolean {
  if (!cfg) return false
  return ['server', 'http', 'api', 'routes', 'port', 'serving'].some(k => get(cfg, k) !== undefined)
}
