/**
 * Skill catalog reads: a catalog document and one SKILL.md package. Pure
 * network reads that touch no workspace; installing is the client writing
 * the fetched body to skills/<name>/SKILL.md through the ordinary file-write
 * path. Shared by Studio's SKILLS_CATALOG_GET / SKILLS_PACKAGE_GET handlers
 * (main process: the renderer's CSP forbids remote origins) and the
 * daemon's /catalog/skills routes.
 *
 * Both fetch through the shared catalog guard (utils/guarded-fetch.ts)
 * rather than a bare fetch(): a catalog URL is remote data, so https-only,
 * the SSRF/egress guard (with the daemon port, so a redirect can never reach
 * the local control API), the redirect hop cap, and the size ceiling all have
 * to hold on every hop — not just the one the user typed.
 */

import { guardedFetch } from '../utils/guarded-fetch'
import { MAX_CATALOG_BYTES, MAX_SKILL_PACKAGE_BYTES, parseSkillsCatalogDocument } from '../../shared/schemas/skills-catalog.schema'

export const SKILLS_FETCH_TIMEOUT_MS = 10_000

export async function fetchSkillsCatalog(url: unknown) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { ok: false as const, error: 'Catalog URL must be https' }
  }
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
  if (!parsed) return { ok: false as const, error: 'Unrecognized catalog schema' }
  return {
    ok: true as const,
    entries: parsed.entries,
    publisher: parsed.publisher,
    dropped: parsed.dropped
  }
}

export async function fetchSkillPackage(url: unknown) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    return { ok: false as const, error: 'Package URL must be https' }
  }
  // The indexer rejects anything past this bound anyway — the guard aborts the
  // stream at the cap rather than installing a package that could never index.
  const body = await guardedFetch(url, {
    maxBytes: MAX_SKILL_PACKAGE_BYTES,
    timeoutMs: SKILLS_FETCH_TIMEOUT_MS
  })
  if ('error' in body) return { ok: false as const, error: body.error }
  if (body.bytes.subarray(0, 8192).includes(0)) {
    return { ok: false as const, error: 'SKILL.md is not text' }
  }
  return { ok: true as const, content: body.bytes.toString('utf8') }
}
