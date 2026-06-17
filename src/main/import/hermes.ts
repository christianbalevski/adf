import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { CreateAgentOptions, McpConfig } from '../../shared/types/adf-v02.types'
import { emptyResult, type ImportResult, type ImportSourceOptions } from './types'
import { parseFrontmatter, parseYaml, get, asString, asNumber, type YamlValue } from './yaml-lite'
import { buildModel } from './model-map'
import { buildPersona } from './persona'

/**
 * Import a Hermes agent from an exported profile directory
 * (`hermes profile export <name>` → archive, unpacked). It contains
 * config.yaml, SOUL.md, memories/ (MEMORY.md, USER.md), skills/, and .env.
 * Per the Hermes docs the export deliberately omits session history, so the
 * loop comes out empty.
 */
export function importHermes(opts: ImportSourceOptions): ImportResult {
  const dir = opts.srcPath
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Hermes source must be an exported profile directory: ${dir}`)
  }

  const warnings: string[] = []
  const cfgRaw = readNamed(dir, 'config.yaml') ?? readNamed(dir, 'cli-config.yaml')
  const cfg: YamlValue = cfgRaw ? parseYaml(cfgRaw) : {}

  const name = opts.name || basename(dir.replace(/\/+$/, ''))

  // Persona from SOUL.md (body). By default it stays an editable
  // imported/SOUL.md referenced via {{path}} injection; --inline flattens it.
  const soulRaw = readNamed(dir, 'SOUL.md')
  const persona = buildPersona({
    name,
    soulBody: soulRaw ? parseFrontmatter(soulRaw).body : '',
    inline: opts.inline ?? false,
  })
  warnings.push(...persona.warnings)

  // model: default + provider + token cap from config.yaml's `model` block.
  const model = buildModel(
    {
      ref: asString(get(cfg, 'model', 'default')),
      provider: asString(get(cfg, 'model', 'provider')),
      maxTokens: asNumber(get(cfg, 'model', 'max_tokens'))
        ?? asNumber(get(cfg, 'model', 'max_output_tokens')),
    },
    warnings,
  )

  const options: CreateAgentOptions = {
    name,
    description: asString(get(cfg, 'agent', 'description')) || `Imported Hermes agent: ${name}`,
    instructions: persona.instructions,
    ...(model ? { model } : {}),
    metadata: { tags: ['imported', 'hermes'] },
  }

  // mcp_servers map structurally onto ADF's mcp.servers.
  const mcp = mapMcpServers(get(cfg, 'mcp_servers'), warnings)
  if (mcp) options.mcp = mcp

  const result = emptyResult('hermes', options)
  result.warnings = warnings
  result.files.push(...persona.files)

  // memories/MEMORY.md → mind; USER.md → reference file.
  const memDir = subdir(dir, 'memories')
  const memoryMd = readNamed(dir, 'MEMORY.md') ?? (memDir ? readNamed(memDir, 'MEMORY.md') : null)
  if (memoryMd) result.mind = memoryMd
  const userMd = readNamed(dir, 'USER.md') ?? (memDir ? readNamed(memDir, 'USER.md') : null)
  if (userMd) result.files.push({ path: 'imported/USER.md', content: userMd })

  // skills/ travel as reference files (semantics don't map 1:1 to ADF tools).
  const skillsDir = subdir(dir, 'skills')
  if (skillsDir) {
    for (const f of collectMarkdown(skillsDir)) {
      result.files.push({ path: `imported/skills/${f.name}`, content: f.content })
    }
  }
  if (result.files.some(f => f.path.startsWith('imported/skills/'))) {
    warnings.push('Hermes skills copied to imported/skills/ for reference; enable matching ADF tools manually.')
  }

  // Never import secrets.
  if (existsSync(join(dir, '.env'))) {
    warnings.push('.env was skipped — re-enter API keys and credentials in Studio (secrets never travel in a .adf).')
  }
  if (subdir(dir, 'sessions') || existsSync(join(dir, 'state.db'))) {
    warnings.push('Session history / state.db are not imported (Hermes exports omit them); the loop starts empty.')
  }

  return result
}

function mapMcpServers(value: YamlValue | undefined, warnings: string[]): McpConfig | undefined {
  const servers: McpConfig['servers'] = []
  const entries = toEntries(value)
  for (const [key, def] of entries) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue
    const url = asString(get(def, 'url'))
    const command = asString(get(def, 'command'))
    const serverName = asString(get(def, 'name')) ?? key
    const args = get(def, 'args')
    if (url) {
      servers.push({ name: serverName, transport: 'http', url })
    } else if (command) {
      servers.push({
        name: serverName,
        transport: 'stdio',
        command,
        args: Array.isArray(args) ? args.map(a => String(a)) : undefined,
      })
    } else {
      warnings.push(`MCP server "${serverName}" had neither url nor command; skipped.`)
      continue
    }
  }
  if (servers.length === 0) return undefined
  warnings.push(`${servers.length} MCP server(s) imported; re-supply any required env/credentials in Studio.`)
  return { servers }
}

/** mcp_servers may be a list of objects or a map keyed by server name. */
function toEntries(value: YamlValue | undefined): [string, YamlValue][] {
  if (Array.isArray(value)) {
    return value.map((v, i) => [asString(get(v, 'name')) ?? `server-${i + 1}`, v])
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, YamlValue>)
  }
  return []
}

function readNamed(dir: string, name: string): string | null {
  const hit = safeReaddir(dir).find(e => e.toLowerCase() === name.toLowerCase())
  if (!hit) return null
  try { return readFileSync(join(dir, hit), 'utf-8') } catch { return null }
}

function subdir(dir: string, name: string): string | null {
  const hit = safeReaddir(dir).find(e => e.toLowerCase() === name.toLowerCase())
  if (!hit) return null
  const full = join(dir, hit)
  try { return statSync(full).isDirectory() ? full : null } catch { return null }
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function collectMarkdown(dir: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = []
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) {
        const md = safeReaddir(full).find(e => e.toLowerCase().endsWith('.md'))
        if (md) out.push({ name: `${entry}/${md}`, content: readFileSync(join(full, md), 'utf-8') })
      } else if (entry.toLowerCase().endsWith('.md')) {
        out.push({ name: entry, content: readFileSync(full, 'utf-8') })
      }
    } catch { /* skip */ }
  }
  return out
}
