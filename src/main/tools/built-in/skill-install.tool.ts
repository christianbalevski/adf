/**
 * skill_install — install a SKILL.md package from a configured catalog.
 *
 * The mechanics move into the runtime; the authority model does not. This tool
 * fetches text and writes ordinary VFS rows at protection `none` with
 * `authorized` left at 0. It never enables a tool, edits config, grants an
 * approval, or authorizes a file — a package's `requires` block is checked
 * against the live config and REPORTED, never acted on.
 *
 * Two orderings matter:
 *
 * 1. Validation before any write. Frontmatter is parsed and matched against the
 *    requested name (which is also the directory) before the first byte lands,
 *    so a malformed package never half-exists.
 * 2. Resource files first, the manifest last. The indexer keys on the manifest
 *    path, so a package whose resources are still arriving never gets indexed
 *    and advertised to the model.
 *
 * Catalogs are an allowlist, not a parameter: only a URL already in
 * `skills.catalogs` (or the first-party default when none are configured) may
 * be fetched. Extending that list is a config change, and config changes are
 * HIL-gated — which is exactly the point.
 *
 * Headless-safe: no Electron imports, plain global fetch.
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from '../tool.interface'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolResult, ToolProviderFormat } from '../../../shared/types/tool.types'
import type { AgentConfig } from '../../../shared/types/adf-v02.types'
import { ADF_SKILLS_REGISTRY_URL, DOCS_GUIDES_URL } from '../../../shared/constants/adf-defaults'
import { MAX_SKILL_FILE_BYTES, SKILLS_ROOT, parseSkillFrontmatter } from '../../adf/skill-indexer'
import { checkFetchTarget } from '../../utils/ssrf-guard'

/** Same identifier rule the indexer enforces — a name that fails here can never index. */
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Path segments a package may carry. Deliberately narrow: no spaces, no dotfiles-as-traversal. */
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

/** A catalog is metadata; a package that needs more than this is not a skill. */
const MAX_CATALOG_BYTES = 512 * 1024
/** Whole-package ceiling across SKILL.md plus every resource file. */
const MAX_PACKAGE_BYTES = 1024 * 1024
/** Resource files per package (SKILL.md excluded — it is always written). */
const MAX_PACKAGE_FILES = 32
/** Redirect hops, each re-checked by the egress guard. */
const MAX_REDIRECTS = 3

const CATALOG_TIMEOUT_MS = 15000
const FILE_TIMEOUT_MS = 20000

const InputSchema = z.object({
  name: z.string().describe('Skill name exactly as the catalog lists it (lowercase kebab-case). Installs to skills/<name>/.'),
  catalog_url: z.string().url().optional().describe(
    'Catalog to install from. Must already be listed in skills.catalogs (or be the first-party default when none are configured) — an arbitrary URL is refused. Omit to search every configured catalog in order.'
  ),
  overwrite: z.boolean().optional().describe('Reinstall over an already-installed skill of the same name. Default false: an existing package is reported and left untouched.'),
})

/** One catalog entry as this tool reads it. Unknown fields are ignored. */
interface CatalogEntry {
  name: string
  description?: string
  path?: string
  raw_url: string
  /** Optional package resources. Absent in the schema-1 first-party catalog, which lists SKILL.md only. */
  files?: Array<{ path: string; raw_url: string }>
}

export interface SkillRejection {
  path: string
  reason: string
}

/** Preconditions a package declares. A checklist that is verified, never a grant. */
export interface SkillRequires {
  tools: string[]
  config: string[]
}

/**
 * The catalogs this agent may fetch from: whatever config lists, else the
 * first-party default. Never the union — an agent that curates its own list
 * should not silently keep the default as a back door.
 */
export function resolveCatalogAllowlist(config: AgentConfig): string[] {
  const configured = (config.skills?.catalogs ?? []).filter(
    (url): url is string => typeof url === 'string' && url.trim().length > 0
  )
  return configured.length ? configured : [ADF_SKILLS_REGISTRY_URL]
}

/** Compare two URLs as URLs, so a trailing-slash or case difference in the host is not a bypass. */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).toString() === new URL(b).toString()
  } catch {
    return a === b
  }
}

/**
 * Map a catalog-declared resource path into this package's directory, or null
 * when it escapes. Accepts both a package-relative path ("scripts/run.js") and
 * the fully-qualified form the catalog uses for SKILL.md.
 */
export function resolvePackagePath(name: string, raw: string): string | null {
  const dir = `${SKILLS_ROOT}${name}/`
  let candidate = String(raw ?? '').trim().replace(/\\/g, '/')
  if (!candidate) return null
  while (candidate.startsWith('./')) candidate = candidate.slice(2)
  if (candidate.startsWith('/')) return null
  const relative = candidate.startsWith(dir) ? candidate.slice(dir.length) : candidate
  if (!relative) return null
  const segments = relative.split('/')
  if (segments.some((segment) => !PATH_SEGMENT.test(segment) || segment === '.' || segment === '..')) return null
  // The manifest is fetched from raw_url and written last, by us — never as a resource.
  if (relative === 'SKILL.md') return null
  return dir + relative
}

/**
 * Read the optional `requires` block. The indexer's frontmatter parser ignores
 * indented lines by design, so this is a separate, equally forgiving pass:
 * both `tools: [a, b]` and a `- a` block list are understood, anything else is
 * skipped rather than treated as an error.
 */
export function parseSkillRequires(source: string): SkillRequires {
  const result: SkillRequires = { tools: [], config: [] }
  const normalized = source.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match) return result
  const lines = match[1].split('\n')
  let inRequires = false
  let listKey: 'tools' | 'config' | null = null
  const add = (key: 'tools' | 'config', raw: string): void => {
    const value = raw.trim().replace(/^["']|["']$/g, '').trim()
    if (value && !result[key].includes(value)) result[key].push(value)
  }
  for (const line of lines) {
    if (/^requires:\s*$/.test(line)) { inRequires = true; listKey = null; continue }
    if (!inRequires) continue
    if (!/^\s/.test(line)) { if (line.trim()) break; continue }
    const inline = /^\s+(tools|config):\s*\[(.*)\]\s*$/.exec(line)
    if (inline) {
      listKey = null
      for (const item of inline[2].split(',')) add(inline[1] as 'tools' | 'config', item)
      continue
    }
    const blockStart = /^\s+(tools|config):\s*$/.exec(line)
    if (blockStart) { listKey = blockStart[1] as 'tools' | 'config'; continue }
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) { add(listKey, item[1]); continue }
    if (/^\s+[a-z_]+:/.test(line)) listKey = null
  }
  return result
}

/** Resolve a dotted config path, e.g. "compute.enabled". */
function configValue(config: AgentConfig, path: string): unknown {
  let cursor: unknown = config
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/**
 * Which declared preconditions this agent does not currently meet. Reporting
 * only: nothing here is ever repaired by this tool.
 */
export function evaluateRequires(config: AgentConfig, requires: SkillRequires): string[] {
  const unmet: string[] = []
  const declarations = config.tools ?? []
  for (const tool of requires.tools) {
    const declaration = declarations.find((t) => t.name === tool)
    if (!declaration) unmet.push(`tool ${tool} is not available in this runtime`)
    else if (declaration.enabled !== true) unmet.push(`tool ${tool} is disabled`)
  }
  for (const path of requires.config) {
    const value = configValue(config, path)
    if (value === undefined || value === null || value === false || value === '') {
      unmet.push(`config ${path} is not set`)
    }
  }
  return unmet
}

interface FetchedBody {
  bytes: Buffer
  contentType: string
}

/** Content types that survive a UTF-8 round trip; everything else is stored as binary. */
function isTextContentType(contentType: string): boolean {
  const type = contentType.toLowerCase().split(';')[0].trim()
  if (!type) return true
  if (type.startsWith('text/')) return true
  if (type === 'application/json' || type === 'application/xml' || type === 'application/yaml') return true
  return type.endsWith('+json') || type.endsWith('+xml') || type.endsWith('+yaml')
}

/**
 * Fetch with the egress guard applied to every hop. Redirects are followed
 * manually because a catalog is remote data: a public URL that 302s to
 * loopback or link-local must be stopped, not followed.
 */
async function guardedFetch(url: string, maxBytes: number, timeoutMs: number): Promise<FetchedBody | { error: string }> {
  let current: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return { error: `only https URLs may be fetched (got "${parsed.protocol}")` }
    current = parsed.toString()
  } catch {
    return { error: `invalid URL: ${String(url).slice(0, 200)}` }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let hop = 0; ; hop++) {
      const blocked = await checkFetchTarget(current)
      if (blocked) return { error: blocked }
      const response = await fetch(current, { signal: controller.signal, redirect: 'manual' })
      if (response.status >= 300 && response.status <= 399) {
        const location = response.headers.get('location')
        if (!location) return { error: `redirect without a location header (HTTP ${response.status})` }
        if (hop >= MAX_REDIRECTS) return { error: `too many redirects (>${MAX_REDIRECTS})` }
        try { await response.body?.cancel() } catch { /* best effort */ }
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) return { error: `HTTP ${response.status} ${response.statusText}`.trim() }
      const lengthHeader = response.headers.get('content-length')
      const declared = lengthHeader === null ? NaN : Number(lengthHeader)
      if (Number.isFinite(declared) && declared > maxBytes) {
        try { await response.body?.cancel() } catch { /* best effort */ }
        return { error: `exceeds ${maxBytes} bytes` }
      }
      const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()))
      if (bytes.length > maxBytes) return { error: `exceeds ${maxBytes} bytes` }
      return { bytes, contentType: response.headers.get('content-type') ?? '' }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return { error: timedOut ? `request timed out after ${timeoutMs}ms` : message }
  } finally {
    clearTimeout(timer)
  }
}

function fail(payload: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ success: false, ...payload }), isError: true }
}

export class SkillInstallTool implements Tool {
  readonly name = 'skill_install'
  readonly description =
    'Install a skill package from a configured catalog into skills/<name>/. ' +
    'Fetches the catalog, validates the SKILL.md frontmatter against the requested name BEFORE writing anything, ' +
    'then writes resource files first and SKILL.md last so a half-arrived package is never indexed. ' +
    'Files land at protection "none" and stay unauthorized — installing is copying text, nothing more. ' +
    'Only catalogs listed in skills.catalogs (or the first-party default when none are configured) may be fetched; ' +
    'to add one, change config via sys_update_config — your principal approves it. ' +
    'A package\'s "requires" block is checked against your live config and reported back as requires_unmet: ' +
    'this tool never enables a tool, changes config, authorizes a file, or relaxes an approval to satisfy it. ' +
    'Requires skills.enabled. Use skill_remove to uninstall.'
  readonly inputSchema = InputSchema
  readonly category = 'filesystem' as const

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const parsed = input as z.infer<typeof InputSchema>
    const name = String(parsed.name ?? '').trim()
    const config = workspace.getAgentConfig()

    if (config.skills?.enabled !== true) {
      return fail({
        error: 'Skills are turned off for this agent (skills.enabled is false), so nothing would index or reach your prompt. ' +
          'Turn the subsystem on with sys_update_config (section "skills", set enabled to true) — your principal sees an approval prompt — then retry. ' +
          `Guide: ${DOCS_GUIDES_URL}/skills.md`,
      })
    }

    if (!SKILL_NAME.test(name)) {
      return fail({
        error: `"${name}" is not a usable skill name. Names are lowercase kebab-case, 1-64 characters (a-z, 0-9, hyphen), and become the directory under skills/.`,
      })
    }

    const directory = `${SKILLS_ROOT}${name}/`
    const manifestPath = `${directory}SKILL.md`

    if (workspace.readFile(manifestPath) !== null && parsed.overwrite !== true) {
      return {
        content: JSON.stringify({
          success: true,
          already_installed: true,
          name,
          installed: [],
          rejected: [],
          message: `"${name}" is already installed at ${manifestPath} — nothing changed. Pass overwrite:true to reinstall it from the catalog, or fs_read the manifest to see what you have.`,
        }),
        isError: false,
      }
    }

    // --- Catalog allowlist. An arbitrary URL is refused: extending the list is
    // a config change, which is where the human decision belongs.
    const allowlist = resolveCatalogAllowlist(config)
    let catalogs = allowlist
    if (parsed.catalog_url) {
      if (!allowlist.some((url) => sameUrl(url, parsed.catalog_url!))) {
        return fail({
          error: `Catalog "${parsed.catalog_url}" is not configured for this agent. Allowed: ${allowlist.join(', ')}. ` +
            'Add a catalog by setting skills.catalogs via sys_update_config (your principal approves it) — this tool will not fetch an unlisted URL.',
          allowed_catalogs: allowlist,
        })
      }
      catalogs = [parsed.catalog_url]
    }

    // --- Find the entry.
    const catalogErrors: SkillRejection[] = []
    let entry: CatalogEntry | undefined
    let sourceCatalog = ''
    for (const url of catalogs) {
      const body = await guardedFetch(url, MAX_CATALOG_BYTES, CATALOG_TIMEOUT_MS)
      if ('error' in body) { catalogErrors.push({ path: url, reason: body.error }); continue }
      let payload: { schema?: unknown; skills?: unknown }
      try {
        payload = JSON.parse(body.bytes.toString('utf-8')) as { schema?: unknown; skills?: unknown }
      } catch (err) {
        catalogErrors.push({ path: url, reason: `catalog is not valid JSON: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }
      if (payload.schema !== undefined && payload.schema !== 1) {
        catalogErrors.push({ path: url, reason: `unsupported catalog schema ${String(payload.schema)}` })
        continue
      }
      if (!Array.isArray(payload.skills)) {
        catalogErrors.push({ path: url, reason: 'catalog has no "skills" array' })
        continue
      }
      const found = (payload.skills as CatalogEntry[]).find((item) => item && item.name === name)
      if (found) { entry = found; sourceCatalog = url; break }
    }

    if (!entry) {
      return fail({
        error: `No skill named "${name}" in ${catalogs.length > 1 ? 'any configured catalog' : catalogs[0]}.` +
          (catalogErrors.length ? ` Catalog problems: ${catalogErrors.map((e) => `${e.path} — ${e.reason}`).join('; ')}.` : ' Check the name against the catalog listing.'),
        ...(catalogErrors.length ? { rejected: catalogErrors } : {}),
        searched_catalogs: catalogs,
      })
    }
    if (typeof entry.raw_url !== 'string' || !entry.raw_url) {
      return fail({ error: `Catalog entry "${name}" (${sourceCatalog}) has no raw_url — nothing to fetch.` })
    }

    // --- Fetch and validate the manifest BEFORE any write.
    const manifest = await guardedFetch(entry.raw_url, MAX_SKILL_FILE_BYTES, FILE_TIMEOUT_MS)
    if ('error' in manifest) {
      return fail({ error: `Could not fetch ${entry.raw_url}: ${manifest.error}`, catalog: sourceCatalog })
    }
    const manifestText = manifest.bytes.toString('utf-8')
    const frontmatter = parseSkillFrontmatter(manifestText)
    if ('error' in frontmatter) {
      return fail({
        error: `${entry.raw_url} is not a valid skill package: ${frontmatter.error}. Nothing was written.`,
        catalog: sourceCatalog,
        rejected: [{ path: manifestPath, reason: frontmatter.error }],
      })
    }
    if (frontmatter.name !== name) {
      return fail({
        error: `Frontmatter name "${frontmatter.name}" does not match the requested name "${name}", which is also the directory — the package could never index. Nothing was written.`,
        catalog: sourceCatalog,
        rejected: [{ path: manifestPath, reason: 'frontmatter name must match the directory' }],
      })
    }

    // --- Resources. The schema-1 catalog lists SKILL.md only; `files` is the
    // forward-compatible hook for packages that carry scripts/references/assets.
    const rejected: SkillRejection[] = []
    const pending: Array<{ path: string; body: FetchedBody }> = []
    let totalBytes = manifest.bytes.length
    const declaredFiles = Array.isArray(entry.files) ? entry.files : []
    for (const [index, file] of declaredFiles.entries()) {
      const declaredPath = String(file?.path ?? '')
      if (index >= MAX_PACKAGE_FILES) {
        rejected.push({ path: declaredPath || `files[${index}]`, reason: `package is limited to ${MAX_PACKAGE_FILES} resource files` })
        continue
      }
      const target = resolvePackagePath(name, declaredPath)
      if (!target) {
        rejected.push({ path: declaredPath || `files[${index}]`, reason: `path must stay inside ${directory} and cannot be the manifest` })
        continue
      }
      if (typeof file?.raw_url !== 'string' || !file.raw_url) {
        rejected.push({ path: target, reason: 'catalog entry has no raw_url' })
        continue
      }
      const remaining = Math.min(MAX_SKILL_FILE_BYTES, MAX_PACKAGE_BYTES - totalBytes)
      if (remaining <= 0) {
        rejected.push({ path: target, reason: `package exceeds ${MAX_PACKAGE_BYTES} bytes` })
        continue
      }
      const body = await guardedFetch(file.raw_url, remaining, FILE_TIMEOUT_MS)
      if ('error' in body) { rejected.push({ path: target, reason: body.error }); continue }
      totalBytes += body.bytes.length
      pending.push({ path: target, body })
    }

    // --- Protection preflight across every target, so a refusal never leaves a
    // partial package behind.
    const blocked = [...pending.map((file) => file.path), manifestPath]
      .filter((path) => workspace.getFileProtection(path) === 'read_only')
    if (blocked.length) {
      return fail({
        error: `Cannot install "${name}": ${blocked.join(', ')} ${blocked.length > 1 ? 'are' : 'is'} read-only. Nothing was written.`,
        catalog: sourceCatalog,
        rejected: blocked.map((path) => ({ path, reason: 'file is read-only' })),
      })
    }

    // --- Write: resources first, manifest last. The indexer keys on the
    // manifest path, so the catalog only ever advertises a complete package.
    const installed: string[] = []
    try {
      for (const file of pending) {
        if (isTextContentType(file.body.contentType)) {
          workspace.writeFile(file.path, file.body.bytes.toString('utf-8'), 'none')
        } else {
          workspace.writeFileBuffer(file.path, file.body.bytes, file.body.contentType.split(';')[0].trim() || undefined)
        }
        installed.push(file.path)
      }
      workspace.writeFile(manifestPath, manifestText, 'none')
      installed.push(manifestPath)
    } catch (err) {
      return fail({
        error: `Write failed after ${installed.length} file(s): ${err instanceof Error ? err.message : String(err)}`,
        catalog: sourceCatalog,
        installed,
        rejected,
      })
    }

    // --- Reported, never granted.
    const requiresUnmet = evaluateRequires(config, parseSkillRequires(manifestText))

    // A reinstall writes the new package over the old one but deletes nothing —
    // removal is skill_remove's job. Name what survived rather than leaving a
    // silently mixed package behind.
    const installedSet = new Set(installed)
    const stale = workspace.listFiles()
      .map((file) => file.path)
      .filter((path) => path.startsWith(directory) && !installedSet.has(path))
      .sort()

    const summary = [
      `Installed "${name}" from ${sourceCatalog} — ${installed.length} file(s), manifest last at ${manifestPath}.`,
      'Files are unprotected and unauthorized; read the complete SKILL.md before acting on it.',
      rejected.length ? `Skipped ${rejected.length}: ${rejected.map((r) => `${r.path} (${r.reason})`).join('; ')}.` : '',
      stale.length
        ? `Left over from a previous install and not part of this package: ${stale.join(', ')} — delete them yourself if the new version does not use them.`
        : '',
      requiresUnmet.length
        ? `This skill lists requirements you do not currently meet — ${requiresUnmet.join(', ')}. Nothing was enabled or changed to satisfy them: ` +
          'verify each one yourself (sys_update_config for config you own, otherwise ask your principal) before following the procedure.'
        : '',
    ].filter(Boolean).join(' ')

    return {
      content: JSON.stringify({
        success: true,
        name,
        catalog: sourceCatalog,
        installed,
        rejected,
        ...(stale.length ? { stale_files: stale } : {}),
        ...(requiresUnmet.length ? { requires_unmet: requiresUnmet } : {}),
        message: summary,
      }),
      isError: false,
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema) as Record<string, unknown>
    }
  }
}
