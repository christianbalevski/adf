import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { CreateAgentOptions } from '../../shared/types/adf-v02.types'
import { emptyResult, type ImportResult, type ImportSourceOptions } from './types'
import { parseFrontmatter, get, asString } from './yaml-lite'
import { buildModel } from './model-map'
import { buildPersona } from './persona'

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

  // Model: SOUL.md frontmatter wins, else the agent's entry in openclaw.json.
  const model = buildModel(
    { ref: asString(soul.data.model) ?? findOpenClawModel(dir, name) },
    warnings,
  )

  const options: CreateAgentOptions = {
    name,
    description: asString(soul.data.description) || '',
    instructions: persona.instructions,
    ...(model ? { model } : {}),
    metadata: { author: asString(soul.data.author), tags: ['imported', 'openclaw'] },
  }

  const result = emptyResult('openclaw', options)
  result.warnings = warnings
  result.files.push(...persona.files)

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

/** Pull this agent's model id out of an openclaw.json near the workspace. */
function findOpenClawModel(dir: string, name: string): string | undefined {
  for (const candidate of [join(dir, 'openclaw.json'), join(dir, '..', '..', 'openclaw.json')]) {
    if (!existsSync(candidate)) continue
    try {
      const cfg = JSON.parse(readFileSync(candidate, 'utf-8'))
      const agents = get(cfg, 'agents')
      if (Array.isArray(agents)) {
        const match = agents.find(a =>
          a && typeof a === 'object' && !Array.isArray(a) &&
          (asString(get(a, 'id')) === name || asString(get(a, 'name')) === name),
        ) ?? agents[0]
        const m = asString(get(match, 'model'))
        if (m) return m
      }
      const top = asString(get(cfg, 'model'))
      if (top) return top
    } catch { /* ignore malformed config */ }
  }
  return undefined
}
