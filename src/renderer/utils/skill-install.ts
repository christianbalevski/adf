/**
 * Installing a skill package from the catalog browser (SkillsPanel), as two
 * steps the panel drives:
 *
 *   prepareSkillInstall — the shared read protocol (skill-install-plan.ts):
 *     fetch every byte, read the revision of every path that exists, plan ONE
 *     batch. Nothing is written. When skills/<name>/ already has files it
 *     stops here and is handed back for an explicit replacement.
 *   commitSkillInstall — send that batch, once, to the agent it was planned
 *     for (DOC_WRITE_INTERNAL_FILES), and say it was written there.
 *
 * Identity: the view (file, runtime, view generation) is captured by the
 * caller at the click, before its first await (installFromCard), and travels
 * with the request; the runtime's API is apiFor(view.runtimeId). Every await
 * before the write is followed by a check of that view and of `active`
 * (the dialog that started it is still the one open); the batch is sent in
 * the same turn as the last check and names the file it means, and the backend
 * compares that with its open file in the turn it commits. A commit that
 * succeeded is reported as written whatever happens after it: navigation or
 * a failed refresh never turns it into "nothing was written".
 */

import type { AdfApi } from '../../preload/api'
import type { InternalFileBatchInput } from '../../shared/types/file-batch.types'
import { RUNTIME_OUTDATED_CODE, RUNTIME_PREDATES_ATOMIC_INSTALLS } from '../../shared/utils/file-batch'
import { importAs, type ManifestImport } from '../../shared/utils/skill-import'
import { preparePackageWrite, type PackageWritePlan } from '../../shared/utils/skill-install-plan'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { isCurrentAgentView, type AgentView } from './agent-view'
import { apiFor } from './runtime-api'
import { syncOpenTab } from './skills-state'

/** A SKILL.md as the browser has it: its text and how it imports (main-side decision). */
export interface LoadedManifest {
  content: string
  import: ManifestImport
}

/** What Install is asked to write: the manifest the preview showed, and the files beside it. */
export interface InstallRequest {
  /** Card key: busy state and errors are per card, not per (maybe unknown) name. */
  key: string
  manifestUrl: string
  manifest: LoadedManifest
  files: Array<{ path: string; raw_url: string }>
  /** A catalog entry's validated name, which the manifest must agree with. */
  expectedName?: string
  /** The view the install was started in, captured before the first await. */
  view: AgentView
  /** False once whatever started the install (the catalog dialog) is gone. */
  active?: () => boolean
}

/** A prepared install: the exact batch, and what it replaces. */
export interface PreparedInstall {
  key: string
  name: string
  files: InternalFileBatchInput[]
  replaces: string[]
  keeps: string[]
  occupied: boolean
  view: AgentView
  api: AdfApi
  active?: () => boolean
}

/**
 * What one install step did. `error` non-null: nothing was written (or, for
 * a write whose answer was lost, it says so). `confirm`: `skills/<name>/`
 * already has files and the install waits for an explicit replacement.
 * `notice`: what was written, and where.
 */
export interface InstallOutcome {
  error: string | null
  confirm?: PreparedInstall
  notice?: string
}

const AGENT_CHANGED = 'The open agent changed — nothing was written.'

/** The install may go on: the view it started in is still showing, and its starter is still there. */
function stillHere(view: AgentView, active?: () => boolean): boolean {
  return isCurrentAgentView(view) && (active ? active() : true)
}

/**
 * Fetch, read and plan (skill-install-plan.ts); then commit at once unless
 * `skills/<name>/` already has files, in which case the prepared batch comes
 * back as `confirm`. `refresh` is the panel's reload, for after a commit.
 */
export async function prepareSkillInstall(request: InstallRequest, refresh: () => Promise<unknown>): Promise<InstallOutcome> {
  const { view, active } = request
  if (!view.filePath) return { error: 'No agent is open.' }
  if (!stillHere(view, active)) return { error: AGENT_CHANGED }
  const api = apiFor(view.runtimeId)
  const imported = importAs(request.manifest.import, request.expectedName)
  if (!imported.ok) return { error: `Cannot install: ${imported.error}` }
  let plan: PackageWritePlan
  try {
    plan = await preparePackageWrite({
      fetchBytes: (url) => api.getSkillPackageBytes(url),
      listFiles: async () => (await api.getInternalFiles()).files,
      readRevision: async (path) => (await api.readInternalFile(path, { binaryContent: true }))?.revision,
      checkpoint: () => (stillHere(view, active) ? null : AGENT_CHANGED),
    }, imported.name, imported.manifest, request.files)
  } catch (err) {
    // Only reads happened: this failure wrote nothing.
    return { error: `${err instanceof Error ? err.message : String(err)} Nothing was written.` }
  }
  if (!plan.ok) return { error: plan.error }
  const prepared: PreparedInstall = { key: request.key, name: plan.name, files: plan.files, replaces: plan.replaces, keeps: plan.keeps, occupied: plan.occupied, view, api, ...(active ? { active } : {}) }
  // An occupied slot is the human's decision, after seeing what is replaced and what is kept.
  if (prepared.occupied) return { error: null, confirm: prepared }
  return commitSkillInstall(prepared, refresh)
}

/**
 * Write a prepared install as ONE batch to the agent it was prepared for, and
 * say exactly what is known: the files were written there. Whether the index
 * lists the skill is the Skills panel's to show (its refresh and Problems
 * list), not this outcome's. Nothing after a successful write can turn the
 * answer into a failure to write.
 */
export async function commitSkillInstall(prepared: PreparedInstall, refresh: () => Promise<unknown>): Promise<InstallOutcome> {
  if (!prepared.view.filePath || !stillHere(prepared.view, prepared.active)) return { error: AGENT_CHANGED }
  let result: Awaited<ReturnType<AdfApi['writeInternalFiles']>>
  try {
    // Checked just above, in this same turn: nothing can retarget the write in between.
    result = await prepared.api.writeInternalFiles(prepared.view.filePath, prepared.files)
  } catch (err) {
    return { error: `${(err instanceof Error ? err.message : String(err)).replace(/\.?$/, '.')} The write may have happened; check skills/${prepared.name}/ before retrying.` }
  }
  if (!result?.success) {
    if (result?.code === RUNTIME_OUTDATED_CODE) return { error: RUNTIME_PREDATES_ATOMIC_INSTALLS }
    const reason = result?.error ?? 'The write was refused.'
    return { error: result?.code === 'stale_revision' ? `${reason} Nothing was written; install again to see the current files.` : `${reason} Nothing was written.` }
  }
  const written: InstallOutcome = { error: null, notice: `Written to skills/${prepared.name}/ in ${prepared.view.filePath.split(/[\\/]/).pop()}.` }
  if (!isCurrentAgentView(prepared.view)) return written
  for (const file of prepared.files) {
    const revision = result.revisions[file.path]
    if (file.content !== undefined) syncOpenTab(file.path, file.content, revision)
    else if (file.contentBase64 !== undefined && useEditorTabsStore.getState().tabs.some((t) => t.path === file.path)) {
      const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0))
      syncOpenTab(file.path, new TextDecoder().decode(bytes), revision)
    }
  }
  await refresh().catch(() => {})
  return written
}

/** One SKILL.md as the browser holds it. */
export type ManifestState =
  | { status: 'loading' }
  | { status: 'ready'; content: string; import: ManifestImport }
  | { status: 'error'; error: string }

/**
 * The package IPC's answer as the browser's manifest state. A runtime that
 * predates import decisions answers `{ ok, content }` with no `import`: that is
 * a refusal to install from it, never a crash and never an unvalidated install.
 */
export function toManifestState(pkg: { ok: boolean; content?: string; import?: unknown; error?: string } | null | undefined): ManifestState {
  if (!pkg?.ok) return { status: 'error', error: pkg?.error ?? 'Fetch failed' }
  const imported = pkg.import as ManifestImport | undefined
  if (typeof pkg.content !== 'string' || !imported || typeof imported !== 'object' || typeof imported.ok !== 'boolean') {
    return { status: 'error', error: RUNTIME_PREDATES_ATOMIC_INSTALLS }
  }
  return { status: 'ready', content: pkg.content, import: imported }
}

/** A loaded manifest's name and description, when it imports. */
export function manifestName(state: ManifestState | undefined): { name: string; description: string } | null {
  return state?.status === 'ready' && state.import.ok ? { name: state.import.name, description: state.import.description } : null
}

/** What a card's Install click led to. */
export type CardInstallResult = { kind: 'preview' } | { kind: 'done'; outcome: InstallOutcome }

/**
 * The catalog dialog's Install click, start to finish. `view` is captured by
 * the click handler BEFORE anything is awaited; the manifest is loaded if it
 * is not cached; then the view and the dialog (`active`) are checked again,
 * and the install is prepared for that captured view only. A manifest that
 * Install would adjust or refuse opens its preview instead (unless this click
 * came from the preview).
 */
export async function installFromCard(
  input: {
    view: AgentView
    active: () => boolean
    key: string
    manifestUrl: string
    files: Array<{ path: string; raw_url: string }>
    expectedName?: string
    fromPreview: boolean
    cached: ManifestState | undefined
    load: () => Promise<ManifestState>
  },
  prepare: (request: InstallRequest) => Promise<InstallOutcome>,
): Promise<CardInstallResult> {
  let state = input.cached
  if (!state || state.status !== 'ready') state = await input.load()
  if (!stillHere(input.view, input.active)) return { kind: 'done', outcome: { error: AGENT_CHANGED } }
  if (state.status !== 'ready') {
    return { kind: 'done', outcome: { error: state.status === 'error' ? `Could not read SKILL.md: ${state.error}` : 'SKILL.md is still loading.' } }
  }
  if (!input.fromPreview && (!state.import.ok || state.import.changes.length > 0)) return { kind: 'preview' }
  const request: InstallRequest = {
    key: input.key,
    manifestUrl: input.manifestUrl,
    manifest: { content: state.content, import: state.import },
    files: input.files,
    ...(input.expectedName ? { expectedName: input.expectedName } : {}),
    view: input.view,
    active: input.active,
  }
  return { kind: 'done', outcome: await prepare(request) }
}
