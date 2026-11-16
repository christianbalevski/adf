/**
 * What the Skills panel reads on every refresh, for ONE agent view.
 *
 * The view (file, runtime, view generation) is captured by the caller and
 * every read goes through that runtime's API (apiFor(view.runtimeId)). After
 * each await the view is checked again; a refresh whose agent stopped being
 * the one on screen answers null, so no file list, registry, label or editor
 * sync from one agent is ever painted over another, including the same path
 * on another runtime and a switch away and back (A→B→A).
 *
 * Labels are read for exactly the rows the panel shows: the registry's
 * entries (the index publishes at most 48). Nothing is skipped by a cap. A
 * label is kept while its SKILL.md's entry in the file list just fetched
 * (path, size, updated_at) is unchanged, so a refresh rereads only the
 * manifests that changed.
 */

import type { AdfApi } from '../../preload/api'
import { readAdfCompat, type AdfCompat } from '../../shared/utils/skill-import'
import {
  SKILLS_REGISTRY_PATH,
  SKILLS_STATE_PATH,
  parseSkillsRegistry,
  type ParsedRegistry,
} from '../../shared/utils/skills-panel'
import { isCurrentAgentView, type AgentView } from './agent-view'

export interface SkillsPanelSnapshot {
  files: Array<{ path: string; size: number; protection?: 'read_only' | 'no_delete' | 'none' }>
  registry: ParsedRegistry | null
  registryFile: { content: string | null; binary: boolean } | null
  stateFile: { content: string | null; binary: boolean } | null
  /** The `adf` declaration of every listed skill, by name, read from its own SKILL.md. */
  compat: Record<string, AdfCompat>
}

/** Labels of the last agent read, by SKILL.md path + size + updated_at. */
let labels: { agent: string; byKey: Map<string, AdfCompat> } = { agent: '', byKey: new Map() }

export async function readSkillsPanel(view: AgentView, api: AdfApi): Promise<SkillsPanelSnapshot | null> {
  if (!view.filePath || !isCurrentAgentView(view)) return null
  const listed = await api.getInternalFiles()
  if (!isCurrentAgentView(view)) return null
  const [registryFile, stateFile] = await Promise.all([
    api.readInternalFile(SKILLS_REGISTRY_PATH),
    api.readInternalFile(SKILLS_STATE_PATH),
  ])
  if (!isCurrentAgentView(view)) return null
  const registry = parseSkillsRegistry(registryFile?.content)
  const agent = `${view.runtimeId}\n${view.filePath}`
  const known = labels.agent === agent ? labels.byKey : new Map<string, AdfCompat>()
  const listedAt = new Map((listed?.files ?? []).map((f) => [f.path, `${f.path}\n${f.size}\n${f.updated_at}`]))
  const read = await Promise.all((registry?.entries ?? []).map(async (entry) => {
    const key = listedAt.get(entry.path)
    const cached = key === undefined ? undefined : known.get(key)
    if (cached) return [entry.name, cached, key] as const
    const file = await api.readInternalFile(entry.path).catch(() => null)
    const content = file && !file.binary ? file.content : null
    // A failed read says nothing about unchanged bytes: retry next refresh.
    return [entry.name, readAdfCompat(content), typeof content === 'string' ? key : undefined] as const
  }))
  if (!isCurrentAgentView(view)) return null
  labels = { agent, byKey: new Map(read.flatMap(([, compat, key]) => (key === undefined ? [] : [[key, compat] as const]))) }
  return {
    files: listed?.files ?? [],
    registry,
    registryFile: registryFile ?? null,
    stateFile: stateFile ?? null,
    compat: Object.fromEntries(read.map(([name, compat]) => [name, compat])),
  }
}
