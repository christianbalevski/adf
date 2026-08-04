import { createHash } from 'node:crypto'
import type { AdfWorkspace } from './adf-workspace'

/**
 * The file-backed skills convention deliberately has a very small runtime
 * surface. Skills remain ordinary adf_files; this module only discovers their
 * metadata and maintains a compact catalog. It never evaluates skill text,
 * enables tools, or authorizes code.
 */
export const DEFAULT_SKILLS_ROOT = 'skills'
export const DEFAULT_SKILLS_REGISTRY_PATH = 'skills-registry.json'
export const DEFAULT_SKILLS_STATE_PATH = 'skills-state.json'
export const MAX_SKILL_FILE_BYTES = 256 * 1024
export const MAX_SKILL_DESCRIPTION_CHARS = 500
export const MAX_REGISTERED_SKILLS = 48
export const MAX_SKILLS_REGISTRY_BYTES = 32 * 1024

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const REGISTRY_SCHEMA = 1

export interface SkillRegistryConfig {
  /** Discover skills under this VFS path. Defaults to "skills". */
  root?: string
  /** Generated compact catalog path. Defaults to "skills-registry.json". */
  registry?: string
  /** Generated enabled/disabled state path. Defaults to "skills-state.json". */
  state?: string
}

export interface RegisteredSkill {
  name: string
  description: string
  path: string
  enabled: boolean
  digest: string
}

export interface SkillRegistry {
  schema: 1
  skills: Record<string, RegisteredSkill>
}

interface SkillState {
  schema: 1
  disabled: string[]
}

export interface SkillReconciliationResult {
  registry: SkillRegistry
  changed: boolean
  rejected: Array<{ path: string; reason: string }>
}

function normalizeRelativePath(path: string | undefined, fallback: string): string {
  const value = (path ?? fallback).trim().replace(/\\/g, '/')
  if (!value || value.startsWith('/') || value.includes('..') || value.includes('//')) {
    throw new Error(`Invalid skill registry path: ${path ?? fallback}`)
  }
  return value.replace(/\/$/, '')
}

function unquoteYamlScalar(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) return null
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  // This intentionally accepts only a one-line plain scalar. Block scalars,
  // aliases, tags and nested YAML make a catalog parser ambiguous and are not
  // needed for the two pieces of skill metadata.
  if (/[:#\[\]{}&,*!|>@`]/.test(trimmed)) return null
  return trimmed
}

/**
 * Parse the intentionally strict two-field YAML frontmatter used by ADF skills.
 * Returning a reason (rather than throwing) lets reconciliation skip a partial
 * write while still making the failure inspectable in logs/UI.
 */
export function parseSkillFrontmatter(source: string):
  | { ok: true; name: string; description: string }
  | { ok: false; reason: string } {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { ok: false, reason: 'SKILL.md must begin with YAML frontmatter (---).' }
  }
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const close = lines.indexOf('---', 1)
  if (close === -1) return { ok: false, reason: 'SKILL.md frontmatter is missing its closing ---.' }
  if (close === 1) return { ok: false, reason: 'SKILL.md frontmatter is empty.' }

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const match = /^([a-z_]+):\s*(.+)$/.exec(line)
    if (!match) return { ok: false, reason: `Unsupported frontmatter line: ${line}` }
    const [, key, raw] = match
    if (key !== 'name' && key !== 'description') {
      return { ok: false, reason: `Unsupported frontmatter key: ${key}` }
    }
    if (fields.has(key)) return { ok: false, reason: `Duplicate frontmatter key: ${key}` }
    const value = unquoteYamlScalar(raw)
    if (value === null) return { ok: false, reason: `Invalid ${key} frontmatter value.` }
    fields.set(key, value)
  }

  const name = fields.get('name')
  const description = fields.get('description')
  if (!name || !SKILL_NAME_RE.test(name)) {
    return { ok: false, reason: 'name must be lowercase kebab-case (1-64 chars).' }
  }
  if (!description || description.length > MAX_SKILL_DESCRIPTION_CHARS || /[\r\n\u0000]/.test(description)) {
    return { ok: false, reason: `description must be one line and at most ${MAX_SKILL_DESCRIPTION_CHARS} chars.` }
  }
  return { ok: true, name, description }
}

function getConfig(config?: SkillRegistryConfig): Required<SkillRegistryConfig> {
  const root = normalizeRelativePath(config?.root, DEFAULT_SKILLS_ROOT)
  return {
    root,
    registry: normalizeRelativePath(config?.registry, DEFAULT_SKILLS_REGISTRY_PATH),
    state: normalizeRelativePath(config?.state, DEFAULT_SKILLS_STATE_PATH),
  }
}

function parseState(raw: string | null): SkillState {
  if (!raw) return { schema: REGISTRY_SCHEMA, disabled: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<SkillState>
    if (parsed.schema !== REGISTRY_SCHEMA || !Array.isArray(parsed.disabled)) throw new Error('invalid')
    return {
      schema: REGISTRY_SCHEMA,
      disabled: [...new Set(parsed.disabled.filter((name): name is string => typeof name === 'string' && SKILL_NAME_RE.test(name)))].sort(),
    }
  } catch {
    // A corrupt state file must never silently disable skills. Reconciliation
    // will overwrite it only after an explicit enable/disable operation.
    return { schema: REGISTRY_SCHEMA, disabled: [] }
  }
}

function registryJson(registry: SkillRegistry): string {
  return JSON.stringify(registry, null, 2) + '\n'
}

/** Rebuild the catalog from installed source files, preserving disable state. */
export function reconcileSkillRegistry(
  workspace: Pick<AdfWorkspace, 'listFiles' | 'readFileBuffer' | 'readFile' | 'writeFile'>,
  config?: SkillRegistryConfig,
): SkillReconciliationResult {
  const paths = getConfig(config)
  const state = parseState(workspace.readFile(paths.state))
  const disabled = new Set(state.disabled)
  const skills: Record<string, RegisteredSkill> = {}
  const rejected: Array<{ path: string; reason: string }> = []
  const prefix = `${paths.root}/`

  for (const file of workspace.listFiles().sort((a, b) => a.path.localeCompare(b.path))) {
    if (!file.path.startsWith(prefix)) continue
    // Exactly one directory below the root. This prevents a nested package
    // from impersonating a top-level skill and makes name → path deterministic.
    const relative = file.path.slice(prefix.length)
    const segments = relative.split('/')
    if (segments.length !== 2 || segments[1] !== 'SKILL.md' || !SKILL_NAME_RE.test(segments[0])) continue
    if (file.size > MAX_SKILL_FILE_BYTES) {
      rejected.push({ path: file.path, reason: `SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes.` })
      continue
    }
    const content = workspace.readFileBuffer(file.path)
    if (!content) {
      rejected.push({ path: file.path, reason: 'SKILL.md disappeared while reconciling.' })
      continue
    }
    const parsed = parseSkillFrontmatter(content.toString('utf-8'))
    if (!parsed.ok) {
      rejected.push({ path: file.path, reason: parsed.reason })
      continue
    }
    if (parsed.name !== segments[0]) {
      rejected.push({ path: file.path, reason: `frontmatter name "${parsed.name}" must match directory "${segments[0]}".` })
      continue
    }
    if (skills[parsed.name]) {
      rejected.push({ path: file.path, reason: `Duplicate skill name "${parsed.name}".` })
      continue
    }
    if (Object.keys(skills).length >= MAX_REGISTERED_SKILLS) {
      rejected.push({ path: file.path, reason: `Skill registry is limited to ${MAX_REGISTERED_SKILLS} entries.` })
      continue
    }
    const candidate = {
      name: parsed.name,
      description: parsed.description,
      path: file.path,
      enabled: !disabled.has(parsed.name),
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    }
    const tentative = { ...skills, [parsed.name]: candidate }
    if (Buffer.byteLength(registryJson({ schema: REGISTRY_SCHEMA, skills: tentative })) > MAX_SKILLS_REGISTRY_BYTES) {
      rejected.push({ path: file.path, reason: `Skill registry would exceed ${MAX_SKILLS_REGISTRY_BYTES} bytes.` })
      continue
    }
    skills[parsed.name] = candidate
  }

  const orderedSkills = Object.fromEntries(Object.entries(skills).sort(([a], [b]) => a.localeCompare(b)))
  const registry: SkillRegistry = { schema: REGISTRY_SCHEMA, skills: orderedSkills }
  const next = registryJson(registry)
  const changed = workspace.readFile(paths.registry) !== next
  // A single SQLite row update is atomic. Do not use a temporary VFS filename:
  // workspace rename intentionally refuses overwrites, while writeFile is one
  // atomic database transaction and cannot expose a partially-written catalog.
  if (changed) workspace.writeFile(paths.registry, next)
  return { registry, changed, rejected }
}

/** Disable/enable an installed skill without removing its source package. */
export function setSkillEnabled(
  workspace: Pick<AdfWorkspace, 'readFile' | 'writeFile'>,
  name: string,
  enabled: boolean,
  config?: SkillRegistryConfig,
): void {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Invalid skill name: ${name}`)
  const paths = getConfig(config)
  const state = parseState(workspace.readFile(paths.state))
  const disabled = new Set(state.disabled)
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  workspace.writeFile(paths.state, JSON.stringify({ schema: REGISTRY_SCHEMA, disabled: [...disabled].sort() }, null, 2) + '\n')
}

/**
 * Remove the complete installed package. The caller remains responsible for
 * authorization: this helper intentionally respects ordinary VFS deletion
 * protection and never provides a privilege bypass.
 */
export function uninstallSkill(
  workspace: Pick<AdfWorkspace, 'listFiles' | 'readFileBuffer' | 'deleteFile' | 'readFile' | 'writeFile'>,
  name: string,
  config?: SkillRegistryConfig,
): number {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Invalid skill name: ${name}`)
  const paths = getConfig(config)
  const prefix = `${paths.root}/${name}/`
  const files = workspace.listFiles().filter(file => file.path.startsWith(prefix))
  const protectedPaths = files.filter(file => file.protection !== 'none').map(file => file.path)
  if (protectedPaths.length) throw new Error(`Cannot uninstall protected skill files: ${protectedPaths.join(', ')}`)
  for (const file of files) {
    if (!workspace.deleteFile(file.path)) throw new Error(`Skill file disappeared while uninstalling: ${file.path}`)
  }
  setSkillEnabled(workspace, name, true, config)
  reconcileSkillRegistry(workspace, config)
  return files.length
}
