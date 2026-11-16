// Catalog + package fetches for /skills. The TUI runs in node, so it fetches
// directly, through the same reader Studio's main process uses for its
// SKILLS_CATALOG_GET / SKILLS_PACKAGE_GET handlers
// (src/main/services/skills-catalog-fetch.ts, over utils/guarded-fetch.ts:
// https only on every hop, SSRF/egress guard incl. the daemon port, redirect
// cap, size cap while streaming). A GitHub source's packages are counted on
// its source row; browsing and installing them is Studio's. The source list is the
// same app preference Studio reads (`skillCatalogSources`), read through the
// daemon's settings route.

import * as fetchNs from '../../services/skills-catalog-fetch'
import * as panelNs from '../../../shared/utils/skills-panel'
import type { SkillPackageBytesResult, SkillPackageResult, SkillsCatalogResult } from '../../services/skills-catalog-fetch'
import type { CatalogSourceResult } from '../../../shared/utils/skills-panel'
import type { DaemonClient } from '../api/client'
import { cjs } from '../interop'

const { fetchSkillsCatalog, fetchSkillPackage, fetchSkillPackageBytes } = cjs(fetchNs)
const { normalizeCatalogSources, toCatalogSourceResult } = cjs(panelNs)

export const CATALOG_SOURCES_SETTING = 'skillCatalogSources'

/** The network the dialog uses: the shared reader Studio's handlers use, swappable by tests. */
export interface SkillsFetchSeams {
  catalog: (url: string) => Promise<SkillsCatalogResult>
  text: (url: string) => Promise<SkillPackageResult>
  bytes: (url: string) => Promise<SkillPackageBytesResult>
}

const DEFAULT_SEAMS: SkillsFetchSeams = { catalog: fetchSkillsCatalog, text: fetchSkillPackage, bytes: fetchSkillPackageBytes }
let seams: SkillsFetchSeams = DEFAULT_SEAMS

/** Tests swap the network; `null` restores it. */
export function setSkillsFetchSeams(next: Partial<SkillsFetchSeams> | null): void {
  seams = next ? { ...DEFAULT_SEAMS, ...next } : DEFAULT_SEAMS
}

export const fetchCatalog = (url: string) => seams.catalog(url)
export const fetchText = (url: string) => seams.text(url)
export const fetchBytes = (url: string) => seams.bytes(url)

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
      return toCatalogSourceResult(url, await fetchCatalog(url))
    } catch (err) {
      return { url, ok: false, entries: [], error: err instanceof Error ? err.message : String(err) }
    }
  }))
}
