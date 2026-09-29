// Daemon + disk operations behind /skills. Every write goes through the
// daemon's file routes (PUT/DELETE /agents/:id/files/content), whose workspace
// write path reindexes skills on its own; nothing here writes the registry.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import * as panelNs from '../../../shared/utils/skills-panel'
import * as schemaNs from '../../../shared/schemas/skills-catalog.schema'
import type { DaemonClient } from '../api/client'
import type { FileListEntry } from '../api/types'
import type { TuiStore } from '../state/store'
import { cjs } from '../interop'
import { fetchText } from './catalog'
import {
  SKILLS_OVERLAY,
  hostLabel,
  manifestProblem,
  packageIdentity,
  urlFolderName,
  type PackageSource,
  type SkillPackage,
  type SkillsOverlayProps,
} from './model'

const { SKILLS_REGISTRY_PATH, SKILLS_STATE_PATH, mergeDisabledList, parseSkillsRegistry } = cjs(panelNs)
const { MAX_PACKAGE_FILES, MAX_SKILL_PACKAGE_BYTES, resolvePackageFilePath } = cjs(schemaNs)

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isNotFound = (err: unknown) => (err as { status?: number | null })?.status === 404

/** The file routes answer `{ success: false }` for a refused write/delete (protection). */
async function must(result: Promise<{ success: boolean }>, what: string): Promise<void> {
  const outcome = await result
  if (outcome && outcome.success === false) throw new Error(`${what} was refused (protected file?)`)
}

// --- open -------------------------------------------------------------------------

type Store = Pick<TuiStore, 'actions' | 'getState'>

export function openSkills(store: Store, props: SkillsOverlayProps = {}): void {
  const state = store.getState()
  const agentId = props.agentId ?? state.selectedAgentId
  if (!agentId || !state.agents[agentId]) {
    store.actions.toast('Select an agent first (sidebar or /agent), or create one with /new', 'warn')
    return
  }
  store.actions.pushOverlay({ kind: SKILLS_OVERLAY, props: { ...props, agentId } })
}

// --- read -------------------------------------------------------------------------

export interface InstalledData {
  files: FileListEntry[]
  registryText: string | null
}

async function readText(client: DaemonClient, agentId: string, path: string): Promise<string | null> {
  try {
    const file = await client.file(agentId, path)
    if (file.encoding === 'base64') return null
    return file.content ?? ''
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** Names seen per agent, for slash completion (synchronous). */
const namesCache = new Map<string, string[]>()
export const cachedSkillNames = (agentId: string | null): string[] => (agentId ? namesCache.get(agentId) ?? [] : [])

export async function loadInstalled(client: DaemonClient, agentId: string): Promise<InstalledData> {
  const { files } = await client.files(agentId)
  const registryText = files.some(f => f.path === SKILLS_REGISTRY_PATH) ? await readText(client, agentId, SKILLS_REGISTRY_PATH) : null
  namesCache.set(agentId, (parseSkillsRegistry(registryText)?.entries ?? []).map(e => e.name))
  return { files, registryText }
}

export async function readSkillFile(client: DaemonClient, agentId: string, path: string): Promise<string | null> {
  return readText(client, agentId, path)
}

// --- mute ---------------------------------------------------------------------------

/** skills-state.json is read-modify-write: one queue per agent so two toggles never lose one. */
const stateQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
  const run = (stateQueues.get(agentId) ?? Promise.resolve()).then(task, task)
  stateQueues.set(agentId, run.then(() => undefined, () => undefined))
  return run
}

/**
 * Mute (enabled=false) or unmute one skill by merging into skills-state.json:
 * unknown keys and names not installed survive. Resolves to an error or null.
 */
export function setSkillMuted(client: DaemonClient, agentId: string, name: string, enabled: boolean): Promise<string | null> {
  return enqueue(agentId, async () => {
    try {
      const current = await readText(client, agentId, SKILLS_STATE_PATH)
      await must(client.writeFile(agentId, SKILLS_STATE_PATH, { content: mergeDisabledList(current, name, enabled) }), 'The write')
      return null
    } catch (err) {
      return `Could not write ${SKILLS_STATE_PATH}: ${errorText(err)}`
    }
  })
}

// --- remove -------------------------------------------------------------------------

export interface RemoveOutcome { deleted: number; failed: string[] }

/** Delete skills/<name>/: SKILL.md first, so the indexer drops it before the rest goes. */
export async function removeSkill(client: DaemonClient, agentId: string, name: string): Promise<RemoveOutcome> {
  const prefix = `skills/${name}/`
  const manifest = `${prefix}SKILL.md`
  const { files } = await client.files(agentId)
  const paths = files.map(f => f.path).filter(p => p.startsWith(prefix))
  paths.sort((a, b) => (a === manifest ? -1 : b === manifest ? 1 : a.localeCompare(b)))
  const failed: string[] = []
  let deleted = 0
  for (const path of paths) {
    try {
      await must(client.deleteFile(agentId, path), 'The delete')
      deleted++
    } catch (err) {
      failed.push(`${path}: ${errorText(err)}`)
      if (path === manifest) break
    }
  }
  return { deleted, failed }
}

// --- install ------------------------------------------------------------------------

export interface InstallOutcome {
  /** Non-null: the package did not land (SKILL.md was not written). */
  error: string | null
  /** Resources that did not arrive; the skill itself installed. */
  warnings: string[]
  written: number
}

/**
 * Write a package: resources first, SKILL.md last (the indexer keys on the
 * manifest, so a half-arrived package is never indexed). Catalog resources are
 * fetched first, all of them, before anything is written. A resource that will
 * not fetch or write is reported and skipped; the manifest failing is the error.
 */
export async function installPackage(client: DaemonClient, agentId: string, pkg: SkillPackage): Promise<InstallOutcome> {
  const problem = manifestProblem(pkg.manifest)
  if (problem) return { error: problem, warnings: [], written: 0 }
  const directory = `skills/${pkg.name}`
  const warnings: string[] = []
  const ready: Array<{ path: string; content?: string; contentBase64?: string }> = []
  for (const resource of pkg.resources) {
    if (resource.rawUrl) {
      const fetched = await fetchText(resource.rawUrl).catch((err: unknown) => ({ ok: false as const, error: errorText(err) }))
      if (!fetched.ok) { warnings.push(`${resource.path}: ${fetched.error || 'Fetch failed'}`); continue }
      ready.push({ path: `${directory}/${resource.path}`, content: fetched.content })
    } else {
      ready.push({ path: `${directory}/${resource.path}`, content: resource.content, contentBase64: resource.contentBase64 })
    }
  }
  let written = 0
  for (const file of ready) {
    try {
      await must(client.writeFile(agentId, file.path, file.contentBase64 !== undefined ? { contentBase64: file.contentBase64 } : { content: file.content ?? '' }), 'The write')
      written++
    } catch (err) {
      warnings.push(`${file.path}: could not write (${errorText(err)})`)
    }
  }
  const manifestPath = `${directory}/SKILL.md`
  try {
    await must(client.writeFile(agentId, manifestPath, { content: pkg.manifest }), 'The write')
  } catch (err) {
    return { error: `Could not write ${manifestPath}: ${errorText(err)}`, warnings, written }
  }
  return { error: null, warnings, written: written + 1 }
}

// --- load a package for preview -------------------------------------------------------

export type LoadedPackage = { ok: true; pkg: SkillPackage } | { ok: false; error: string }

export async function loadPackage(source: PackageSource, cwd = process.cwd()): Promise<LoadedPackage> {
  if (source.type === 'disk') return readLocalPackage(source.path, cwd)
  const url = source.type === 'catalog' ? source.entry.raw_url : source.url
  const fetched = await fetchText(url).catch((err: unknown) => ({ ok: false as const, error: errorText(err) }))
  if (!fetched.ok) return { ok: false, error: fetched.error || 'Fetch failed' }
  const problem = manifestProblem(fetched.content)
  if (source.type === 'catalog') {
    const entry = source.entry
    return {
      ok: true,
      pkg: {
        name: entry.name,
        description: entry.description,
        source: 'catalog',
        origin: entry.raw_url,
        label: entry.sourceLabel,
        manifest: fetched.content,
        resources: (entry.files ?? []).map(f => ({ path: f.path, rawUrl: f.raw_url })),
        warnings: problem ? [problem] : [],
      },
    }
  }
  if (problem) return { ok: false, error: problem }
  const identity = packageIdentity(fetched.content, urlFolderName(url))
  if ('error' in identity) return { ok: false, error: identity.error }
  return {
    ok: true,
    pkg: { ...identity, source: 'url', origin: url, label: hostLabel(url), manifest: fetched.content, resources: [] },
  }
}

const MAX_WALK_DEPTH = 6
const MAX_WALK_ENTRIES = 2000
const SKIP_DIRS = new Set(['node_modules', '__pycache__'])

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : path)

/**
 * A SKILL.md file (manifest only) or a package folder (SKILL.md plus its
 * resources) on this machine. Same bounds as a catalog package: at most
 * MAX_PACKAGE_FILES resources, each under MAX_SKILL_PACKAGE_BYTES, paths that
 * stay inside skills/<name>/; dotfiles and node_modules are skipped.
 */
export async function readLocalPackage(input: string, cwd = process.cwd()): Promise<LoadedPackage> {
  const target = resolve(cwd, expandHome(input.trim()))
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { ok: false, error: `Nothing at ${target}` }
  }
  const folder = stat.isDirectory() ? target : dirname(target)
  const manifestPath = stat.isDirectory() ? join(target, 'SKILL.md') : target
  let manifestBytes: Buffer
  try {
    const manifestStat = await fs.stat(manifestPath)
    if (!manifestStat.isFile()) return { ok: false, error: `${manifestPath} is not a file` }
    if (manifestStat.size > MAX_SKILL_PACKAGE_BYTES) return { ok: false, error: `SKILL.md is over ${Math.round(MAX_SKILL_PACKAGE_BYTES / 1024)} KB` }
    manifestBytes = await fs.readFile(manifestPath)
  } catch {
    return { ok: false, error: stat.isDirectory() ? `No SKILL.md in ${target}` : `Cannot read ${target}` }
  }
  if (manifestBytes.subarray(0, 8192).includes(0)) return { ok: false, error: 'SKILL.md is not text' }
  const manifest = manifestBytes.toString('utf-8')
  const problem = manifestProblem(manifest)
  if (problem) return { ok: false, error: problem }
  const identity = packageIdentity(manifest, basename(folder))
  if ('error' in identity) return { ok: false, error: identity.error }

  const warnings = [...identity.warnings]
  const resources: SkillPackage['resources'] = []
  if (stat.isDirectory()) {
    let seen = 0
    let skippedOver = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_WALK_DEPTH || seen > MAX_WALK_ENTRIES) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (++seen > MAX_WALK_ENTRIES) return
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const rel = relative(target, full).split(sep).join('/')
        if (rel === 'SKILL.md') continue
        const path = resolvePackageFilePath(identity.name, rel)
        if (!path) { warnings.push(`${rel}: skipped (not a package path)`); continue }
        if (resources.length >= MAX_PACKAGE_FILES) { skippedOver++; continue }
        const size = (await fs.stat(full)).size
        if (size > MAX_SKILL_PACKAGE_BYTES) { warnings.push(`${rel}: skipped (over ${Math.round(MAX_SKILL_PACKAGE_BYTES / 1024)} KB)`); continue }
        const bytes = await fs.readFile(full)
        resources.push(bytes.subarray(0, 8192).includes(0) ? { path, contentBase64: bytes.toString('base64') } : { path, content: bytes.toString('utf-8') })
      }
    }
    await walk(target, 0)
    if (skippedOver) warnings.push(`${skippedOver} more file${skippedOver === 1 ? '' : 's'} skipped (a package ships at most ${MAX_PACKAGE_FILES} beside SKILL.md)`)
  }
  return {
    ok: true,
    pkg: { name: identity.name, description: identity.description, source: 'disk', origin: stat.isDirectory() ? target : manifestPath, label: 'local', manifest, resources, warnings },
  }
}
