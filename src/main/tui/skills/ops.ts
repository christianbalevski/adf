// Daemon + disk operations behind /skills. Every write goes through the
// daemon's file routes (PUT/DELETE /agents/:id/files/content), whose workspace
// write path reindexes skills on its own; nothing here writes the registry.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as panelNs from '../../../shared/utils/skills-panel'
import * as schemaNs from '../../../shared/schemas/skills-catalog.schema'
import type { DaemonClient } from '../api/client'
import type { FileListEntry } from '../api/types'
import type { TuiStore } from '../state/store'
import { cjs } from '../interop'
import { fetchBytes, fetchText } from './catalog'
import * as planNs from '../../../shared/utils/skill-install-plan'
import * as importNs from '../../../shared/utils/skill-import'
import * as indexerNs from '../../adf/skill-indexer'
import * as batchNs from '../../../shared/utils/file-batch'
import type { ManifestImport } from '../../../shared/utils/skill-import'
import type { PackageWritePlan } from '../../../shared/utils/skill-install-plan'
import {
  SKILLS_OVERLAY,
  hostLabel,
  type PackageSource,
  type SkillPackage,
  type SkillsOverlayProps,
} from './model'

const { SKILLS_REGISTRY_PATH, SKILLS_STATE_PATH, mergeDisabledList, parseSkillsRegistry } = cjs(panelNs)
const { MAX_PACKAGE_FILES, MAX_SKILL_FILE_BYTES, resolvePackageFilePath } = cjs(schemaNs)
const { preparePackageWrite } = cjs(planNs)
const { importAs, importSkillManifest } = cjs(importNs)
const { parseSkillFrontmatter } = cjs(indexerNs)
const { batchBoundsProblem, isMissingBatchRoute, RUNTIME_PREDATES_ATOMIC_INSTALLS } = cjs(batchNs)

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
  /** Non-null: nothing was written. */
  error: string | null
  written: number
  /** The human declined to write into an occupied skills/<name>/: nothing was written. */
  declined?: boolean
}

/** A plan whose slot already has files: what the human is asked before it is written. */
export type OccupiedPlan = Extract<PackageWritePlan, { ok: true }>

/**
 * Write a package as ONE atomic batch (POST /agents/:id/files/batch), read
 * and planned by the same protocol as Studio (shared/utils/skill-install-plan):
 * every resource fetched first as exact bytes (any failure ends the install
 * with nothing written), a path the agent already has goes over the revision
 * just read, every other path must not exist yet, files the package does not
 * ship are left alone. The daemon's batch decides the bounds. When
 * skills/<name>/ already has any file, nothing is sent unless `confirm`
 * (shown the files replaced and kept) answers yes.
 *
 * Only an answer from the daemon that refused the batch means nothing was
 * written. A timeout or a lost connection after the batch was sent does not:
 * the daemon may still commit it, and the outcome says so.
 */
export async function installPackage(client: DaemonClient, agentId: string, pkg: SkillPackage, confirm: (plan: OccupiedPlan) => Promise<boolean>): Promise<InstallOutcome> {
  const refuse = (error: string): InstallOutcome => ({ error, written: 0 })
  const resources = pkg.resources.map((r) => {
    if (r.rawUrl) return { path: r.path, raw_url: r.rawUrl }
    return { path: r.path, contentBase64: r.contentBase64 ?? '', size: Buffer.from(r.contentBase64 ?? '', 'base64').length }
  })
  let plan
  try {
    plan = await preparePackageWrite({
      fetchBytes: (url) => fetchBytes(url).catch((err: unknown) => ({ ok: false as const, error: errorText(err) })),
      listFiles: async () => (await client.files(agentId)).files,
      readRevision: async (path) => (await client.file(agentId, path)).revision,
    }, pkg.name, pkg.manifest, resources)
  } catch (err) {
    // Reads only: nothing has been sent.
    return refuse(`Could not read the agent's files: ${errorText(err)}. Nothing was written.`)
  }
  if (!plan.ok) return refuse(plan.error)
  if (plan.occupied && !(await confirm(plan))) return { error: null, written: 0, declined: true }
  try {
    // Up to 8 MiB as base64: the daemon-mode Studio handler's budget, not the client's default 15 s.
    await client.withTimeout(BATCH_TIMEOUT_MS).writeFiles(agentId, plan.files)
    return { error: null, written: plan.files.length }
  } catch (err) {
    if (isMissingBatchRoute(err)) return refuse(RUNTIME_PREDATES_ATOMIC_INSTALLS)
    const status = (err as { status?: number | null })?.status
    if (typeof status === 'number' && status >= 400 && status < 500) return refuse(`${errorText(err)} Nothing was written.`)
    return refuse(`${errorText(err).replace(/\.?$/, '.')} The daemon may still have written the package; check skills/${pkg.name}/ before retrying.`)
  }
}

/** How long a batch write may take before the outcome is reported as unknown. */
export const BATCH_TIMEOUT_MS = 120_000

// --- load a package for preview -------------------------------------------------------

export type LoadedPackage = { ok: true; pkg: SkillPackage } | { ok: false; error: string }

/**
 * The shared import decision (shared/utils/skill-import), for every source:
 * the name, the bytes to install (the source's, or the previewed adjustment)
 * and what was adjusted. A catalog entry whose SKILL.md names another skill is
 * refused, as in Studio.
 */
function decided(imp: ManifestImport | undefined, expectedName?: string): { ok: true; imp: Extract<ManifestImport, { ok: true }> } | { ok: false; error: string } {
  if (!imp) return { ok: false, error: RUNTIME_PREDATES_ATOMIC_INSTALLS }
  const named = importAs(imp, expectedName)
  return named.ok ? { ok: true, imp: named } : { ok: false, error: named.error }
}

export async function loadPackage(source: PackageSource, cwd = process.cwd()): Promise<LoadedPackage> {
  if (source.type === 'disk') return readLocalPackage(source.path, cwd)
  const url = source.type === 'catalog' ? source.entry.raw_url : source.url
  const fetched = await fetchText(url).catch((err: unknown) => ({ ok: false as const, error: errorText(err) }))
  if (!fetched.ok) return { ok: false, error: fetched.error || 'Fetch failed' }
  const result = decided(fetched.import, source.type === 'catalog' ? source.entry.name : undefined)
  if (!result.ok) return result
  const { imp } = result
  return {
    ok: true,
    pkg: {
      name: imp.name,
      description: imp.description,
      source: source.type,
      origin: url,
      label: source.type === 'catalog' ? source.entry.sourceLabel : hostLabel(url),
      manifest: imp.manifest,
      resources: source.type === 'catalog' ? (source.entry.files ?? []).map(f => ({ path: f.path, rawUrl: f.raw_url })) : [],
      warnings: imp.changes,
    },
  }
}

const MAX_WALK_DEPTH = 6
const MAX_WALK_ENTRIES = 2000
const SKIP_DIRS = new Set(['node_modules', '__pycache__'])

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : path)

/**
 * A SKILL.md file (manifest only) or a package folder (SKILL.md plus its
 * resources, as exact bytes) on this machine, decided by the shared import
 * decision. Past the batch's bounds (files or bytes, SKILL.md included) the
 * package is refused before the file that crosses them is read; paths must
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
  const manifestPath = stat.isDirectory() ? join(target, 'SKILL.md') : target
  let manifestBytes: Buffer
  try {
    const manifestStat = await fs.stat(manifestPath)
    if (!manifestStat.isFile()) return { ok: false, error: `${manifestPath} is not a file` }
    // The import decision's own bound, before the file is read.
    if (manifestStat.size > MAX_SKILL_FILE_BYTES) return { ok: false, error: `SKILL.md is over ${MAX_SKILL_FILE_BYTES / 1024} KB, the ADF index reads at most that` }
    manifestBytes = await fs.readFile(manifestPath)
  } catch {
    return { ok: false, error: stat.isDirectory() ? `No SKILL.md in ${target}` : `Cannot read ${target}` }
  }
  const result = decided(importSkillManifest(manifestBytes.toString('utf-8'), manifestPath, parseSkillFrontmatter))
  if (!result.ok) return result
  const { imp } = result

  const warnings = [...imp.changes]
  const resources: SkillPackage['resources'] = []
  let refused: string | null = null
  if (stat.isDirectory()) {
    let total = manifestBytes.length
    let seen = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (refused || depth > MAX_WALK_DEPTH || seen > MAX_WALK_ENTRIES) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (++seen > MAX_WALK_ENTRIES) return
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1)
          if (refused) return
          continue
        }
        if (!entry.isFile()) continue
        const rel = relative(target, full).split(sep).join('/')
        if (rel === 'SKILL.md') continue
        const path = resolvePackageFilePath(imp.name, rel)
        if (!path) { warnings.push(`${rel}: skipped (not a package path)`); continue }
        // As a GitHub package: past the bounds the package is refused, never installed in part.
        if (resources.length >= MAX_PACKAGE_FILES) { refused = `The package has more than ${MAX_PACKAGE_FILES} files beside SKILL.md; it cannot be installed.`; return }
        // Checked before the read: a file past the batch's bytes is never read into memory.
        const over = batchBoundsProblem(resources.length + 2, total + (await fs.stat(full)).size)
        if (over) { refused = `The package is past what one install writes: ${over}. It cannot be installed.`; return }
        const bytes = await fs.readFile(full)
        total += bytes.length
        resources.push({ path, contentBase64: bytes.toString('base64') })
      }
    }
    await walk(target, 0)
    if (refused) return { ok: false, error: refused }
  }
  return {
    ok: true,
    pkg: { name: imp.name, description: imp.description, source: 'disk', origin: stat.isDirectory() ? target : manifestPath, label: 'local', manifest: imp.manifest, resources, warnings },
  }
}
