// Skills in the terminal app: pure decisions behind the /skills dialog.
//
// Skills are file-backed (same design as Studio's Skills panel):
//   install / remove  ->  write or delete skills/<name>/ (SKILL.md last on install, first on remove)
//   mute / unmute     ->  merge the `disabled` list in skills-state.json
// The daemon's workspace write path reindexes and rewrites skills-registry.json;
// nothing here writes the registry, config, tools or approvals. Rows carry no
// authority. Registry parsing, catalog merge/filter, sanitizing and the
// preview split are the shared modules Studio uses (src/shared/utils).

import * as panelNs from '../../../shared/utils/skills-panel'
import * as previewNs from '../../../shared/utils/skill-preview'
import * as schemaNs from '../../../shared/schemas/skills-catalog.schema'
import * as githubNs from '../../services/skills-github'
import type { CatalogSourceResult, MergedCatalogEntry, ParsedRegistry, SkillProblem } from '../../../shared/utils/skills-panel'
import type { FileListEntry } from '../api/types'
import { cjs } from '../interop'

const {
  SKILLS_REGISTRY_PATH, estimateTokens, installedSkillNames, isCatalogUrl,
  parseSkillsRegistry, sanitizeDisplayText, skillProblems,
} = cjs(panelNs)
const { splitSkillDocument } = cjs(previewNs)
const { SKILL_NAME } = cjs(schemaNs)
const { classifyGithubSource } = cjs(githubNs)

export const SKILLS_OVERLAY = 'skills'

export interface SkillsOverlayProps {
  agentId?: string
  /** Open "add": '' = browse the catalog; a name searches it; an https URL or a local path previews that package. */
  add?: string
  /** Open the preview of an installed skill. */
  skill?: string
}

// --- add targets --------------------------------------------------------------

export type AddTarget =
  | { kind: 'catalog'; query: string }
  /** An https catalog document, browsed alongside the configured sources. */
  | { kind: 'catalog-url'; url: string }
  /** An https SKILL.md. */
  | { kind: 'package-url'; url: string }
  /** A SKILL.md file or a package folder on this machine. */
  | { kind: 'local'; path: string }
  | { kind: 'invalid'; error: string }

const looksLikePath = (value: string) =>
  /^(\.{1,2}([\\/]|$)|[\\/]|~([\\/]|$)|[A-Za-z]:[\\/])/.test(value) || /[\\/]/.test(value) || /\.md$/i.test(value)

/** What `/skills add <arg>` names: a catalog search, a catalog URL, a SKILL.md URL, or a local path. */
export function parseAddTarget(raw: string | undefined): AddTarget {
  const value = (raw ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')
  if (!value) return { kind: 'catalog', query: '' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!isCatalogUrl(value)) return { kind: 'invalid', error: 'Only https:// URLs can be fetched.' }
    let pathname = ''
    try { pathname = new URL(value).pathname } catch { /* isCatalogUrl already parsed it */ }
    // A raw SKILL.md installs as one file, as before; every other GitHub source is Studio's.
    const github = classifyGithubSource(value)
    if (github && !(github.kind === 'raw' && github.skillFile)) return { kind: 'invalid', error: 'GitHub packages are browsed and installed in Studio.' }
    return /\.md$/i.test(pathname) ? { kind: 'package-url', url: value } : { kind: 'catalog-url', url: value }
  }
  if (looksLikePath(value)) return { kind: 'local', path: value }
  return { kind: 'catalog', query: value }
}

// --- installed ------------------------------------------------------------------

export interface InstalledSkill {
  name: string
  description: string
  path: string
  enabled: boolean
  /** SKILL.md size, when the file list has it. */
  bytes: number | null
  /** Rough cost of reading SKILL.md (bytes / 4). */
  tokens: number | null
}

export type RegistryStatus = 'ok' | 'none' | 'not-generated' | 'unreadable'

export interface InstalledModel {
  skills: InstalledSkill[]
  problems: SkillProblem[]
  installed: Set<string>
  registry: ParsedRegistry | null
  registryBytes: number
  /** Prompt cost of the injected catalog (skills-registry.json bytes / 4). */
  registryTokens: number
  muted: number
  status: RegistryStatus
}

/**
 * The installed list as the Skills panel shows it: registry entries (with any
 * pending mute toggle applied), problems, and exactly one empty state.
 */
export function buildInstalled(files: FileListEntry[], registryText: string | null, overrides: Record<string, boolean> = {}): InstalledModel {
  const registry = parseSkillsRegistry(registryText)
  const sizes = new Map(files.map(f => [f.path, f.size]))
  const registryBytes = sizes.get(SKILLS_REGISTRY_PATH) ?? 0
  const installed = installedSkillNames(files)
  const skills: InstalledSkill[] = (registry?.entries ?? []).map(entry => {
    const bytes = sizes.get(entry.path) ?? null
    return {
      name: entry.name,
      description: entry.description ?? '',
      path: entry.path,
      enabled: entry.name in overrides ? overrides[entry.name] : entry.enabled,
      bytes,
      tokens: bytes === null ? null : estimateTokens(bytes),
    }
  })
  const problems = skillProblems(installed, registry)
  const status: RegistryStatus =
    registry === null && registryBytes > 0 ? 'unreadable'
      : registry === null && installed.size > 0 ? 'not-generated'
        : skills.length === 0 && problems.length === 0 ? 'none'
          : 'ok'
  return {
    skills,
    problems,
    installed,
    registry,
    registryBytes,
    registryTokens: registryBytes > 0 ? estimateTokens(registryBytes) : 0,
    muted: skills.filter(s => !s.enabled).length,
    status,
  }
}

/** Drop optimistic toggles the registry now agrees with (or that name a skill it no longer has). */
export function settleOverrides(overrides: Record<string, boolean>, registryText: string | null): Record<string, boolean> {
  const keys = Object.keys(overrides)
  if (keys.length === 0) return overrides
  const parsed = parseSkillsRegistry(registryText)
  if (!parsed) return overrides
  const byName = new Map(parsed.entries.map(entry => [entry.name, entry.enabled]))
  const next: Record<string, boolean> = {}
  for (const name of keys) {
    if (!byName.has(name) || byName.get(name) === overrides[name]) continue
    next[name] = overrides[name]
  }
  return Object.keys(next).length === keys.length ? overrides : next
}

/** `~1.2k tok` style label; empty for unknown. */
export function tokenLabel(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return ''
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `~${tokens} tok`
}

/** One render-safe line (remote / agent-written text: controls and bidi marks removed). */
export const safe = (value: string | null | undefined): string => sanitizeDisplayText(value)

// --- packages -------------------------------------------------------------------

/** One resource a package ships beside SKILL.md (package-relative path). */
export interface PackageResource {
  path: string
  /** A local resource's exact bytes. */
  contentBase64?: string
  /** Catalog resources are fetched at install time, like Studio. */
  rawUrl?: string
}

export type PackageSource =
  | { type: 'catalog'; entry: MergedCatalogEntry }
  | { type: 'url'; url: string }
  | { type: 'disk'; path: string }

export interface SkillPackage {
  name: string
  description: string
  source: PackageSource['type']
  /** Where it comes from: the URL or the absolute path. */
  origin: string
  /** Badge: catalog source label, host, or "local". */
  label: string
  manifest: string
  resources: PackageResource[]
  /** What will not arrive, or will not index, said before Install. */
  warnings: string[]
}

export const packageKey = (source: PackageSource): string =>
  source.type === 'catalog' ? `catalog:${source.entry.sourceUrl}#${source.entry.name}` : source.type === 'url' ? `url:${source.url}` : `disk:${source.path}`

export const isSkillName = (value: string | undefined | null): value is string => !!value && SKILL_NAME.test(value)

export function hostLabel(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** Frontmatter rows + body, render-safe (the shared preview split). */
export function previewParts(manifest: string): { fields: Array<{ key: string; value: string }>; body: string } {
  const parsed = splitSkillDocument(manifest)
  return { fields: parsed.fields.map(f => ({ key: safe(f.key), value: safe(f.value) })), body: parsed.body }
}

// --- dialog state (kept in the store: a confirm dialog unmounts this one) ------------

export type SkillsStep =
  | { kind: 'list' }
  | { kind: 'view'; name: string; path: string }
  | { kind: 'catalog'; autoPreview?: boolean }
  | { kind: 'package'; source: PackageSource; back: 'catalog' | 'list' | 'close' }

export type PackageState =
  | { status: 'loading' }
  | { status: 'ready'; pkg: SkillPackage }
  | { status: 'error'; error: string }

export type InstallState =
  | { status: 'installing' }
  | { status: 'done' }
  | { status: 'error'; error: string }

export interface CatalogSession {
  loading: boolean
  sources: string[]
  results: CatalogSourceResult[]
  /** Why the configured sources could not be read (defaults were used). */
  sourcesNote?: string
}

export interface SkillsViewState {
  overlayId: string | null
  step: SkillsStep
  cursor: number
  catalogCursor: number
  query: string
  /** Catalog URLs given to /skills add: browsed first, this dialog only. */
  extra: string[]
  /** Bumped after every write, so a remounted dialog refetches. */
  rev: number
  overrides: Record<string, boolean>
  catalog?: CatalogSession
  packages: Record<string, PackageState>
  installs: Record<string, InstallState>
}

export const EMPTY_VIEW_STATE: SkillsViewState = {
  overlayId: null, step: { kind: 'list' }, cursor: 0, catalogCursor: 0, query: '', extra: [], rev: 0, overrides: {}, packages: {}, installs: {},
}

/** The first step for a fresh dialog, from its props. */
export function initialStep(props: SkillsOverlayProps): { step: SkillsStep; query: string; extra: string[] } {
  if (props.skill) return { step: { kind: 'view', name: props.skill, path: `skills/${props.skill}/SKILL.md` }, query: '', extra: [] }
  if (props.add === undefined) return { step: { kind: 'list' }, query: '', extra: [] }
  const target = parseAddTarget(props.add)
  switch (target.kind) {
    case 'catalog': return { step: { kind: 'catalog', autoPreview: !!target.query }, query: target.query, extra: [] }
    case 'catalog-url': return { step: { kind: 'catalog' }, query: '', extra: [target.url] }
    case 'package-url': return { step: { kind: 'package', source: { type: 'url', url: target.url }, back: 'close' }, query: '', extra: [] }
    case 'local': return { step: { kind: 'package', source: { type: 'disk', path: target.path }, back: 'close' }, query: '', extra: [] }
    case 'invalid': return { step: { kind: 'catalog' }, query: '', extra: [] }
  }
}

/** Catalog entries in merge order, skipping what the list can't paint; exact-name match first. */
export function exactEntry(entries: MergedCatalogEntry[], query: string): MergedCatalogEntry | undefined {
  const wanted = query.trim().toLowerCase()
  return wanted ? entries.find(e => e.name === wanted) : undefined
}
