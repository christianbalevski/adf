// Catalog + package fetches for /skills. The TUI runs in node, so it fetches
// directly, through the same guard Studio's main process uses for its
// SKILLS_CATALOG_GET / SKILLS_PACKAGE_GET handlers (src/main/utils/
// guarded-fetch.ts: https only on every hop, SSRF/egress guard incl. the
// daemon port, redirect cap, size cap while streaming) and the same parser and
// limits (src/shared/schemas/skills-catalog.schema.ts). The source list is the
// same app preference Studio reads (`skillCatalogSources`), read through the
// daemon's settings route.

import * as guardNs from '../../utils/guarded-fetch'
import * as schemaNs from '../../../shared/schemas/skills-catalog.schema'
import * as panelNs from '../../../shared/utils/skills-panel'
import type { SkillCatalogEntry } from '../../../shared/schemas/skills-catalog.schema'
import type { CatalogSourceResult } from '../../../shared/utils/skills-panel'
import type { DaemonClient } from '../api/client'
import { cjs } from '../interop'

const { guardedFetch } = cjs(guardNs)
const { parseSkillsCatalogDocument, MAX_CATALOG_BYTES, MAX_SKILL_PACKAGE_BYTES } = cjs(schemaNs)
const { normalizeCatalogSources } = cjs(panelNs)

export const SKILLS_FETCH_TIMEOUT_MS = 10_000
export const CATALOG_SOURCES_SETTING = 'skillCatalogSources'

export type CatalogFetchResult =
  | { ok: true; entries: SkillCatalogEntry[]; publisher?: string; dropped: number }
  | { ok: false; error: string }

export type TextFetchResult = { ok: true; content: string } | { ok: false; error: string }

/** One catalog document, exactly as Studio's SKILLS_CATALOG_GET handler reads it. */
export async function fetchCatalogDocument(url: string): Promise<CatalogFetchResult> {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return { ok: false, error: 'Catalog URL must be https' }
  const body = await guardedFetch(url, { maxBytes: MAX_CATALOG_BYTES, timeoutMs: SKILLS_FETCH_TIMEOUT_MS })
  if ('error' in body) return { ok: false, error: body.error }
  let json: unknown
  try {
    json = JSON.parse(body.bytes.toString('utf8'))
  } catch {
    return { ok: false, error: 'Catalog is not valid JSON' }
  }
  const parsed = parseSkillsCatalogDocument(json)
  if (!parsed) return { ok: false, error: 'Unrecognized catalog schema' }
  return { ok: true, entries: parsed.entries, publisher: parsed.publisher, dropped: parsed.dropped }
}

/** One SKILL.md or package resource, as Studio's SKILLS_PACKAGE_GET handler reads it. */
export async function fetchSkillText(url: string): Promise<TextFetchResult> {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return { ok: false, error: 'Package URL must be https' }
  const body = await guardedFetch(url, { maxBytes: MAX_SKILL_PACKAGE_BYTES, timeoutMs: SKILLS_FETCH_TIMEOUT_MS })
  if ('error' in body) return { ok: false, error: body.error }
  if (body.bytes.subarray(0, 8192).includes(0)) return { ok: false, error: 'SKILL.md is not text' }
  return { ok: true, content: body.bytes.toString('utf8') }
}

export interface SkillsFetchSeams {
  catalog: (url: string) => Promise<CatalogFetchResult>
  text: (url: string) => Promise<TextFetchResult>
}

const DEFAULT_SEAMS: SkillsFetchSeams = { catalog: fetchCatalogDocument, text: fetchSkillText }
let seams: SkillsFetchSeams = DEFAULT_SEAMS

/** Tests swap the network; `null` restores it. */
export function setSkillsFetchSeams(next: Partial<SkillsFetchSeams> | null): void {
  seams = next ? { ...DEFAULT_SEAMS, ...next } : DEFAULT_SEAMS
}

export const fetchCatalog = (url: string) => seams.catalog(url)
export const fetchText = (url: string) => seams.text(url)

/**
 * The configured source list (Settings -> Skills in Studio). Unreadable (a
 * daemon without a settings store, an old daemon) falls back to the default,
 * with the reason, so the browser still works.
 */
export async function readCatalogSources(client: DaemonClient): Promise<{ sources: string[]; note?: string }> {
  try {
    const { value } = await client.setting(CATALOG_SOURCES_SETTING)
    return { sources: normalizeCatalogSources(value ?? undefined) }
  } catch (err) {
    return { sources: normalizeCatalogSources(undefined), note: `Catalog sources not readable from the daemon (${err instanceof Error ? err.message : String(err)}); using the default.` }
  }
}

/** Fetch every source concurrently; one failing costs its own row and nothing else. */
export async function loadCatalogSources(sources: string[]): Promise<CatalogSourceResult[]> {
  return Promise.all(sources.map(async (url): Promise<CatalogSourceResult> => {
    try {
      const result = await fetchCatalog(url)
      if (!result.ok) return { url, ok: false, entries: [], error: result.error || 'Unavailable' }
      return { url, ok: true, entries: result.entries, publisher: result.publisher, dropped: result.dropped }
    } catch (err) {
      return { url, ok: false, entries: [], error: err instanceof Error ? err.message : String(err) }
    }
  }))
}
