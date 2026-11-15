/**
 * Skill catalog reads: a catalog source and one package file. Pure network
 * reads that touch no workspace; installing is the client writing the
 * fetched bytes under skills/<name>/ in one atomic batch. Shared by Studio's
 * SKILLS_CATALOG_GET / SKILLS_PACKAGE_GET handlers (main process: the
 * renderer's CSP forbids remote origins), the daemon's /catalog/skills
 * routes, and the terminal app.
 *
 * Everything fetches through the shared catalog guard (utils/guarded-fetch.ts)
 * rather than a bare fetch(): a catalog URL is remote data, so https-only,
 * the SSRF/egress guard (with the daemon port, so a redirect can never reach
 * the local control API), the redirect hop cap, and the size ceiling all have
 * to hold on every hop — not just the one the user typed.
 *
 * A source URL is dispatched by what it is, decided without guessing
 * (classifyGithubSource in services/skills-github.ts):
 *
 * - A github.com repository page, `tree/…` folder page, or `blob/…` page of a
 *   SKILL.md or marketplace.json, and a raw.githubusercontent.com SKILL.md or
 *   marketplace.json → GitHub discovery, pinned to one commit. Nothing is
 *   fetched from the URL itself.
 * - Any other https URL — github.com `raw/…` and `?raw=` forms (redirects to
 *   the file) and every other github.com page included — is fetched ONCE as a
 *   catalog document (no GitHub API request: the first-party registry on
 *   raw.githubusercontent.com stays one request).
 */

import { guardedFetch } from '../utils/guarded-fetch'
import { FILE_BATCH_MAX_BYTES } from '../../shared/types/file-batch.types'
import {
  MAX_CATALOG_BYTES,
  MAX_SKILL_FILE_BYTES,
  parseSkillsCatalogDocument,
  type DiscoveredSkillSource,
  type SkillCatalogEntry,
} from '../../shared/schemas/skills-catalog.schema'
import { importSkillManifest, type ManifestImport } from '../../shared/utils/skill-import'
import { parseSkillFrontmatter } from '../adf/skill-indexer'
import { classifyGithubSource, discoverGithubSkills, type GithubTarget } from './skills-github'

export const SKILLS_FETCH_TIMEOUT_MS = 10_000

export type SkillsCatalogResult =
  | { ok: true; entries: SkillCatalogEntry[]; publisher?: string; dropped: number; discovered?: DiscoveredSkillSource }
  | { ok: false; error: string }

/** GitHub discovery of a URL classifyGithubSource already classified. */
async function discover(url: string, target: GithubTarget): Promise<SkillsCatalogResult> {
  try {
    const discovered = await discoverGithubSkills(target, url)
    return { ok: true, entries: [], dropped: 0, publisher: discovered.repository, discovered }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchSkillsCatalog(url: unknown): Promise<SkillsCatalogResult> {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { ok: false as const, error: 'Catalog URL must be https' }
  }
  const page = classifyGithubSource(url)
  if (page) return 'error' in page ? { ok: false, error: page.error } : discover(url, page.target)

  const body = await guardedFetch(url, {
    maxBytes: MAX_CATALOG_BYTES,
    timeoutMs: SKILLS_FETCH_TIMEOUT_MS
  })
  if ('error' in body) return { ok: false as const, error: body.error }
  let json: unknown
  try {
    json = JSON.parse(body.bytes.toString('utf8'))
  } catch {
    return { ok: false as const, error: 'Catalog is not valid JSON' }
  }
  const parsed = parseSkillsCatalogDocument(json)
  if (parsed) {
    return {
      ok: true as const,
      entries: parsed.entries,
      publisher: parsed.publisher,
      dropped: parsed.dropped
    }
  }
  return { ok: false as const, error: 'Unrecognized catalog schema' }
}

export type SkillPackageResult =
  | { ok: true; content: string; import: ManifestImport }
  | { ok: false; error: string }

export type SkillPackageBytesResult =
  | { ok: true; contentBase64: string; size: number }
  | { ok: false; error: string }

/**
 * One SKILL.md as text, with how it would import (skill-import.ts): the
 * name it installs under, its `adf` label, and any previewed adjustment.
 */
export async function fetchSkillPackage(url: unknown): Promise<SkillPackageResult> {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { ok: false as const, error: 'Package URL must be https' }
  }
  // The indexer rejects anything past this bound anyway — the guard aborts the
  // stream at the cap rather than installing a package that could never index.
  const body = await guardedFetch(url, {
    maxBytes: MAX_SKILL_FILE_BYTES,
    timeoutMs: SKILLS_FETCH_TIMEOUT_MS
  })
  if ('error' in body) return { ok: false as const, error: body.error }
  const content = body.bytes.toString('utf8')
  return { ok: true as const, content, import: importSkillManifest(content, url, parseSkillFrontmatter) }
}

/**
 * One package resource as exact bytes (scripts, references, fonts, images):
 * never decoded as text, capped at the batch's whole bound (FILE_BATCH_MAX_BYTES).
 */
export async function fetchSkillPackageBytes(url: unknown): Promise<SkillPackageBytesResult> {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { ok: false as const, error: 'Package URL must be https' }
  }
  const body = await guardedFetch(url, {
    maxBytes: FILE_BATCH_MAX_BYTES,
    timeoutMs: SKILLS_FETCH_TIMEOUT_MS
  })
  if ('error' in body) return { ok: false as const, error: body.error }
  return { ok: true as const, contentBase64: body.bytes.toString('base64'), size: body.bytes.length }
}
