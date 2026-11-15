/**
 * Skill packages in a public GitHub repository, discovered from a URL someone
 * pasted: the repository, a folder (`tree/<ref>/<path>`), one SKILL.md
 * (`blob/…` or raw), or a Claude / Codex `marketplace.json`.
 *
 * Everything resolves to ONE commit first, then reads ONE complete tree of
 * that commit, and every byte URL it hands out names that commit
 * (`raw.githubusercontent.com/<o>/<r>/<sha>/…`). Discovery, preview and
 * install therefore read the same bytes, and nothing is mixed from a branch
 * that moved in between. A marketplace document is re-read at the pinned
 * commit for the same reason.
 *
 * It only lists: no SKILL.md is fetched here (the browser loads manifests on
 * demand), no script, hook, MCP config or plugin manifest is read or run, and
 * an external marketplace member (another repository, a URL) is reported in
 * `problems`, never followed and never silently left out.
 *
 * Every request goes through guardedFetch (https only on every hop, egress
 * guard, redirect cap, size cap while streaming), unauthenticated, with only
 * `accept` and `user-agent` headers. GitHub's anonymous limit is 60 API
 * requests an hour per address; a refusal for it says so and when it resets.
 */

import { guardedFetch, type GuardedFetchFailure } from '../utils/guarded-fetch'
import { batchBoundsProblem } from '../../shared/utils/file-batch'
import {
  MAX_DISCOVERED_PACKAGES,
  MAX_GITHUB_TREE_BYTES,
  MAX_SKILL_FILE_BYTES,
  isSafePackageRelativePath,
} from '../../shared/schemas/skills-catalog.schema'
import type { DiscoveredSkillPackage, DiscoveredSkillSource } from '../../shared/schemas/skills-catalog.schema'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_RAW = 'https://raw.githubusercontent.com'
export const GITHUB_USER_AGENT = 'ADF-Studio'
const API_TIMEOUT_MS = 15_000
const SMALL_API_BYTES = 1024 * 1024
/** A SHA answer is 40 bytes; anything much longer is not one. */
const HEAD_SHA_BYTES = 256

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const SHA = /^[0-9a-f]{40}$/
const MARKETPLACE_SUFFIXES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'] as const
const LICENSE_FILE = /^(?:LICEN[CS]E|NOTICE|COPYING)(?:[.-][A-Za-z0-9._-]*)?$/i

/** What a pasted URL names, before any request. */
export interface GithubTarget {
  owner: string
  repo: string
  /** `tree` / `blob` / `raw`: the segments after the repository (ref and path, not yet told apart). */
  kind: 'repo' | 'tree' | 'blob' | 'raw'
  segments: string[]
}

export class GithubDiscoveryError extends Error {}

/** Decode one URL path segment; refuse encoded separators, traversal and controls. */
function segment(raw: string): string {
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    throw new GithubDiscoveryError(`The URL has an undecodable segment "${raw.slice(0, 80)}".`)
  }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001F\u007F]/.test(value)) {
    throw new GithubDiscoveryError(`The URL has an unusable path segment "${raw.slice(0, 80)}".`)
  }
  return value
}

/**
 * Parse a github.com or raw.githubusercontent.com URL into owner, repository
 * and the remaining segments. Null for any other host.
 */
export function parseGithubUrl(url: string): GithubTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return null
  const host = parsed.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com' && host !== 'raw.githubusercontent.com') return null
  const parts = parsed.pathname.split('/').filter((p) => p !== '')
  if (parts.length < 2) throw new GithubDiscoveryError('Paste a repository URL such as https://github.com/<owner>/<repo>.')
  const owner = segment(parts[0])
  const repo = segment(parts[1]).replace(/\.git$/, '')
  if (!OWNER.test(owner) || !REPO.test(repo)) throw new GithubDiscoveryError(`"${owner}/${repo}" is not a GitHub repository name.`)
  const rest = parts.slice(2).map(segment)
  if (host === 'raw.githubusercontent.com') {
    if (rest.length < 2) throw new GithubDiscoveryError('A raw URL names a ref and a file.')
    return { owner, repo, kind: 'raw', segments: rest }
  }
  if (rest.length === 0) return { owner, repo, kind: 'repo', segments: [] }
  const [mode, ...tail] = rest
  if ((mode === 'tree' || mode === 'blob') && tail.length > 0) return { owner, repo, kind: mode, segments: tail }
  throw new GithubDiscoveryError('Paste a repository, folder (tree/…), SKILL.md or marketplace.json URL.')
}

/** A Claude or Codex marketplace document path. */
export function isMarketplacePath(path: string): boolean {
  return MARKETPLACE_SUFFIXES.some((suffix) => path === suffix || path.endsWith(`/${suffix}`))
}

/**
 * How a source URL is read, by its path alone. Discovered from their URL: a
 * github.com repository (`/<o>/<r>`), a folder (`/tree/…`), a `blob/…` page
 * of a SKILL.md or marketplace.json, and a raw.githubusercontent.com SKILL.md
 * or marketplace.json. Everything else answers `null`, meaning "fetch it once
 * as a catalog document": github.com `raw/…` and `?raw=` forms (which redirect
 * to the file), other blob pages, other raw files (the first-party registry),
 * and every other host. Deciding this costs no request, and a URL that is not
 * one of these spends no API quota.
 */
export function classifyGithubSource(url: string): { target: GithubTarget } | { error: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const parts = parsed.pathname.split('/').filter((p) => p !== '')
  const file = parts[parts.length - 1] === 'SKILL.md' || isMarketplacePath(parts.join('/'))
  const discovered = host === 'raw.githubusercontent.com'
    ? parts.length > 3 && file
    : (host === 'github.com' || host === 'www.github.com') && !parsed.searchParams.has('raw') && (parts.length === 2
      || (parts.length > 3 && parts[2] === 'tree')
      || (parts.length > 3 && parts[2] === 'blob' && file))
  if (!discovered) return null
  try {
    const target = parseGithubUrl(url)
    return target ? { target } : null
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The repository a discovery talks to. */
interface Ctx {
  owner: string
  repo: string
}

/** GitHub's rate-limit answer headers, read here (guardedFetch copies only what it is asked for). */
const RATE_LIMIT_HEADERS = ['x-ratelimit-remaining', 'x-ratelimit-reset'] as const

function apiFailure(failure: GuardedFetchFailure, what: string): GithubDiscoveryError {
  const remaining = failure.headers?.['x-ratelimit-remaining']
  const reset = Number(failure.headers?.['x-ratelimit-reset'])
  const limited = (failure.status === 403 || failure.status === 429) && remaining === '0'
  if (limited) {
    const resetAt = Number.isFinite(reset) ? new Date(reset * 1000).toISOString().slice(11, 16) : 'the top of the hour'
    return new GithubDiscoveryError(`GitHub's unauthenticated API limit (60 requests an hour) is used up; it resets at ${resetAt} UTC. Nothing was listed.`)
  }
  if (failure.status === 404) return new GithubDiscoveryError(`${what}: not found (a private repository, a typo, or a ref that does not exist).`)
  return new GithubDiscoveryError(`${what}: ${failure.error}`)
}

async function apiGet(path: string, what: string, accept: string, maxBytes: number): Promise<Buffer> {
  const body = await guardedFetch(`${GITHUB_API}${path}`, {
    maxBytes,
    timeoutMs: API_TIMEOUT_MS,
    headers: { accept, 'user-agent': GITHUB_USER_AGENT },
    keepHeaders: RATE_LIMIT_HEADERS,
  })
  if ('error' in body) throw apiFailure(body, what)
  return body.bytes
}

async function apiJson<T>(path: string, what: string, maxBytes = SMALL_API_BYTES): Promise<T> {
  const bytes = await apiGet(path, what, 'application/vnd.github+json', maxBytes)
  try {
    return JSON.parse(bytes.toString('utf8')) as T
  } catch {
    throw new GithubDiscoveryError(`${what}: GitHub answered something that is not JSON.`)
  }
}

const repoPath = (ctx: Ctx) => `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** The pinned raw URL of a repository path at `sha`. */
export function pinnedRawUrl(owner: string, repo: string, sha: string, path: string): string {
  return `${GITHUB_RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${encodePath(path)}`
}

interface RefObject { ref?: string; object?: { type?: string; sha?: string } }

/** A ref's commit: a branch points at one; an annotated tag is peeled (at most 4 levels). */
async function peel(ctx: Ctx, object: { type?: string; sha?: string } | undefined, what: string): Promise<string> {
  let current = object
  for (let depth = 0; depth < 4; depth++) {
    if (!current?.sha || !SHA.test(current.sha)) break
    if (current.type === 'commit') return current.sha
    if (current.type !== 'tag') break
    const tag = await apiJson<{ object?: { type?: string; sha?: string } }>(`${repoPath(ctx)}/git/tags/${current.sha}`, what)
    current = tag.object
  }
  throw new GithubDiscoveryError(`${what}: it does not name a commit.`)
}

/**
 * Split `segments` into a ref and a path, and resolve the ref to a commit.
 * A 40-hex first segment is the commit. Otherwise the LONGEST branch or tag
 * whose segments are a prefix wins (a branch beats a tag of the same name),
 * so `feature/x/skills/a` resolves to branch `feature/x` when it exists.
 */
async function resolveRef(ctx: Ctx, segments: string[]): Promise<{ sha: string; ref: string; path: string[] }> {
  let parts = segments
  // raw.githubusercontent.com also serves refs/heads/<b>/… and refs/tags/<t>/…
  let only: 'heads' | 'tags' | null = null
  if (parts[0] === 'refs' && (parts[1] === 'heads' || parts[1] === 'tags')) {
    only = parts[1]
    parts = parts.slice(2)
  }
  if (parts.length === 0) throw new GithubDiscoveryError('The URL names no ref.')
  if (!only && SHA.test(parts[0])) return { sha: parts[0], ref: parts[0], path: parts.slice(1) }
  const what = `Resolving "${parts[0]}…" in ${ctx.owner}/${ctx.repo}`
  const lookups: Array<'heads' | 'tags'> = only ? [only] : ['heads', 'tags']
  let best: { name: string; kind: 'heads' | 'tags'; object?: RefObject['object'] } | null = null
  for (const kind of lookups) {
    const refs = await apiJson<RefObject[]>(`${repoPath(ctx)}/git/matching-refs/${kind}/${encodeURIComponent(parts[0])}`, what)
    if (!Array.isArray(refs)) continue
    for (const ref of refs) {
      const name = typeof ref.ref === 'string' && ref.ref.startsWith(`refs/${kind}/`) ? ref.ref.slice(`refs/${kind}/`.length) : null
      if (!name) continue
      const nameParts = name.split('/')
      if (nameParts.length > parts.length || nameParts.some((p, i) => p !== parts[i])) continue
      if (!best || name.length > best.name.length) best = { name, kind, object: ref.object }
    }
  }
  if (!best) throw new GithubDiscoveryError(`${ctx.owner}/${ctx.repo} has no branch or tag "${parts[0]}…".`)
  const sha = await peel(ctx, best.object, `Resolving ${best.kind === 'heads' ? 'branch' : 'tag'} "${best.name}"`)
  return { sha, ref: best.name, path: parts.slice(best.name.split('/').length) }
}

/**
 * The default branch's commit, as the bare 40-character SHA
 * (`application/vnd.github.sha`): never the commit document, whose file
 * list and patches can be megabytes.
 */
async function resolveHead(ctx: Ctx): Promise<string> {
  const bytes = await apiGet(`${repoPath(ctx)}/commits/HEAD`, `Reading ${ctx.owner}/${ctx.repo}`, 'application/vnd.github.sha', HEAD_SHA_BYTES)
  const sha = bytes.toString('utf8').trim()
  if (!SHA.test(sha)) throw new GithubDiscoveryError(`${ctx.owner}/${ctx.repo}: GitHub did not answer a commit for its default branch.`)
  return sha
}

/** One blob or tree of a commit, as git/trees lists it. */
export interface TreeItem {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

/** Immutable: a commit's tree never changes, so a parsed listing is kept per tree sha (LRU, 8). */
const treeCache = new Map<string, TreeItem[]>()
const TREE_CACHE_SIZE = 8

export function clearGithubTreeCache(): void {
  treeCache.clear()
}

async function listTree(ctx: Ctx, treeSha: string, recursive: boolean): Promise<{ items: TreeItem[]; truncated: boolean }> {
  const key = `${ctx.owner}/${ctx.repo}@${treeSha}:${recursive ? 'r' : '1'}`
  const cached = treeCache.get(key)
  if (cached) {
    treeCache.delete(key)
    treeCache.set(key, cached)
    return { items: cached, truncated: false }
  }
  const doc = await apiJson<{ tree?: unknown; truncated?: unknown }>(
    `${repoPath(ctx)}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`,
    `Listing ${ctx.owner}/${ctx.repo}`,
    MAX_GITHUB_TREE_BYTES,
  )
  if (!Array.isArray(doc.tree)) throw new GithubDiscoveryError(`Listing ${ctx.owner}/${ctx.repo}: GitHub answered no tree.`)
  const items: TreeItem[] = []
  for (const raw of doc.tree as Array<Partial<TreeItem>>) {
    if (typeof raw?.path !== 'string' || typeof raw.mode !== 'string' || typeof raw.sha !== 'string') continue
    if (raw.type !== 'blob' && raw.type !== 'tree' && raw.type !== 'commit') continue
    items.push({ path: raw.path, mode: raw.mode, type: raw.type, sha: raw.sha, ...(typeof raw.size === 'number' ? { size: raw.size } : {}) })
  }
  const truncated = doc.truncated === true
  if (!truncated) {
    treeCache.set(key, items)
    while (treeCache.size > TREE_CACHE_SIZE) treeCache.delete(treeCache.keys().next().value as string)
  }
  return { items, truncated }
}

/**
 * Every item under `scope` (repository paths, recursive), plus at least the
 * items of each ancestor directory of `scope` (for license files). Complete or an
 * error: a truncated listing of the whole repository is retried as the
 * scope's own subtree, and a truncated subtree is refused.
 */
async function listScope(ctx: Ctx, sha: string, scope: string): Promise<TreeItem[]> {
  const full = await listTree(ctx, sha, true)
  if (!full.truncated) return full.items
  if (!scope) {
    throw new GithubDiscoveryError(`${ctx.owner}/${ctx.repo} is too large for GitHub to list in one answer; nothing was listed. Paste the URL of the folder that holds the skills.`)
  }
  // Walk down to the scope one directory at a time, keeping each level's listing.
  const ancestors: TreeItem[] = []
  let treeSha = sha
  let prefix = ''
  for (const part of scope.split('/')) {
    const level = await listTree(ctx, treeSha, false)
    if (level.truncated) throw new GithubDiscoveryError(`A folder on the way to ${scope} is too large to list; nothing was listed.`)
    for (const item of level.items) ancestors.push({ ...item, path: prefix + item.path })
    const next = level.items.find((item) => item.path === part && item.type === 'tree')
    if (!next) throw new GithubDiscoveryError(`${scope} is not a folder at this commit.`)
    treeSha = next.sha
    prefix = `${prefix}${part}/`
  }
  const sub = await listTree(ctx, treeSha, true)
  if (sub.truncated) throw new GithubDiscoveryError(`${scope} is too large for GitHub to list in one answer; nothing was listed. Paste the URL of a smaller folder.`)
  return [...ancestors, ...sub.items.map((item) => ({ ...item, path: prefix + item.path }))]
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const within = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(`${dir}/`)

/** Normalize `root` + `relative` (a marketplace path) into a repository path; null when it escapes. */
function joinRepoPath(root: string, relative: string): string | null {
  const out = root ? root.split('/') : []
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** The package folders a marketplace document names, plus what it names that is not followed. */
function marketplaceScopes(doc: unknown, root: string, items: TreeItem[]): { dirs: string[]; problems: string[] } {
  const problems: string[] = []
  const dirs: string[] = []
  const plugins = (doc as { plugins?: unknown })?.plugins
  if (!Array.isArray(plugins)) throw new GithubDiscoveryError('The marketplace document has no plugins list.')
  const pluginRoot = typeof (doc as { metadata?: { pluginRoot?: unknown } }).metadata?.pluginRoot === 'string'
    ? (doc as { metadata: { pluginRoot: string } }).metadata.pluginRoot
    : ''
  const manifests = items.filter((item) => item.type === 'blob' && /(^|\/)SKILL\.md$/.test(item.path)).map((item) => dirOf(item.path))
  for (const raw of plugins) {
    const plugin = raw as { name?: unknown; source?: unknown; skills?: unknown }
    const label = typeof plugin.name === 'string' ? plugin.name : '(unnamed plugin)'
    let local: string | null = null
    if (typeof plugin.source === 'string') {
      local = plugin.source
    } else if (plugin.source && typeof plugin.source === 'object') {
      const source = plugin.source as { source?: unknown; path?: unknown; repo?: unknown; url?: unknown }
      if (source.source === 'local' && typeof source.path === 'string') local = source.path
      else {
        const where = typeof source.repo === 'string' ? source.repo : typeof source.url === 'string' ? source.url : ''
        problems.push(`${label}: lives outside this repository (${String(source.source ?? 'unknown')}${where ? ` ${where}` : ''}); not followed. Paste its own URL to browse it.`)
        continue
      }
    }
    if (local === null) {
      problems.push(`${label}: has no source this browser reads; skipped.`)
      continue
    }
    const base = typeof plugin.source === 'string' && pluginRoot && !local.startsWith('./') && !local.startsWith('/') ? `${pluginRoot}/${local}` : local
    const pluginDir = joinRepoPath(root, base)
    if (pluginDir === null) {
      problems.push(`${label}: its source path leaves the repository; skipped.`)
      continue
    }
    if (Array.isArray(plugin.skills)) {
      for (const entry of plugin.skills) {
        const dir = typeof entry === 'string' ? joinRepoPath(pluginDir, entry) : null
        if (dir === null) problems.push(`${label}: skill path ${JSON.stringify(entry)} is unusable; skipped.`)
        else if (!manifests.includes(dir)) problems.push(`${label}: ${dir}/SKILL.md does not exist at this commit.`)
        else dirs.push(dir)
      }
      continue
    }
    const found = manifests.filter((dir) => within(dir, pluginDir))
    if (found.length === 0) problems.push(`${label}: no SKILL.md under ${pluginDir || 'the repository root'}.`)
    dirs.push(...found)
  }
  return { dirs: [...new Set(dirs)], problems }
}

/**
 * One package's install inventory from tree metadata alone: every blob under
 * its folder (nested packages included, as resources), plus license and
 * notice files of each ancestor folder under `LICENSES/<ancestor>/`. Bounds,
 * symlinks, submodules and unusable paths make the package not installable,
 * with the reason; nothing is fetched to decide.
 */
function inventory(owner: string, repo: string, sha: string, dir: string, items: TreeItem[], sourceUrl: string): DiscoveredSkillPackage {
  const problems: string[] = []
  const files: DiscoveredSkillPackage['files'] = []
  let total = 0
  for (const item of items) {
    if (!within(item.path, dir) || item.path === dir) continue
    const rel = dir ? item.path.slice(dir.length + 1) : item.path
    if (item.type === 'commit') { problems.push(`${rel} is a git submodule`); continue }
    if (item.type !== 'blob') continue
    if (item.mode === '120000') { problems.push(`${rel} is a symbolic link`); continue }
    const size = item.size ?? 0
    if (rel === 'SKILL.md') {
      if (size > MAX_SKILL_FILE_BYTES) problems.push(`SKILL.md is ${size} bytes (the ADF index reads at most ${MAX_SKILL_FILE_BYTES})`)
      total += size
      continue
    }
    if (!isSafePackageRelativePath(rel)) { problems.push(`${rel}: path has characters ADF package paths do not allow`); continue }
    total += size
    files.push({ path: rel, raw_url: pinnedRawUrl(owner, repo, sha, item.path), size })
  }
  // Ancestor license / notice files: kept beside the package so its terms travel with it.
  const own = new Set(files.map((file) => file.path))
  let ancestor = dir
  while (ancestor !== '') {
    ancestor = dirOf(ancestor)
    for (const item of items) {
      if (item.type !== 'blob' || dirOf(item.path) !== ancestor) continue
      const name = item.path.slice(ancestor ? ancestor.length + 1 : 0)
      if (!LICENSE_FILE.test(name)) continue
      const target = `LICENSES/${ancestor || '_root'}/${name}`
      if (!isSafePackageRelativePath(target)) { problems.push(`${item.path}: license file path cannot be kept beside the package`); continue }
      if (own.has(target)) { problems.push(`${target} already exists in the package; the license ${item.path} would collide`); continue }
      if (item.mode === '120000') { problems.push(`${item.path} is a symbolic link`); continue }
      const size = item.size ?? 0
      total += size
      own.add(target)
      files.push({ path: target, raw_url: pinnedRawUrl(owner, repo, sha, item.path), size, license: true })
    }
  }
  const bounds = batchBoundsProblem(files.length + 1, total)
  if (bounds) problems.push(bounds)
  return {
    id: `${sourceUrl}#${dir}`,
    dir,
    raw_url: pinnedRawUrl(owner, repo, sha, dir ? `${dir}/SKILL.md` : 'SKILL.md'),
    totalBytes: total,
    files,
    ...(problems.length ? { problem: problems.join('; ') } : {}),
  }
}

/** What the scope of a URL is, once its ref is resolved. */
type Scope = { kind: 'folder'; path: string } | { kind: 'skill'; dir: string } | { kind: 'marketplace'; path: string }

function scopeOf(path: string[], kind: GithubTarget['kind']): Scope {
  const joined = path.join('/')
  if (isMarketplacePath(joined)) return { kind: 'marketplace', path: joined }
  if (path[path.length - 1] === 'SKILL.md') return { kind: 'skill', dir: path.slice(0, -1).join('/') }
  if (kind === 'blob' || kind === 'raw') throw new GithubDiscoveryError('Paste a repository, folder, SKILL.md or marketplace.json URL; this file is neither.')
  return { kind: 'folder', path: joined }
}

/**
 * Discover the packages a GitHub URL names. `sourceUrl` is the URL as the
 * user gave it (package identity); the result's `url` is the pinned web URL.
 */
export async function discoverGithubSkills(target: GithubTarget, sourceUrl: string): Promise<DiscoveredSkillSource> {
  const ctx: Ctx = { owner: target.owner, repo: target.repo }
  let sha: string
  let ref: string
  let path: string[]
  if (target.kind === 'repo') {
    sha = await resolveHead(ctx)
    ref = 'HEAD'
    path = []
  } else {
    ;({ sha, ref, path } = await resolveRef(ctx, target.segments))
  }
  const scope = scopeOf(path, target.kind)
  const scopeDir = scope.kind === 'folder' ? scope.path : scope.kind === 'skill' ? scope.dir : marketplaceRoot(scope.path)
  const items = await listScope(ctx, sha, scopeDir)
  if (scope.kind === 'folder' && scope.path && !items.some((item) => item.path === scope.path && item.type === 'tree')) {
    throw new GithubDiscoveryError(`${scope.path} is not a folder at this commit.`)
  }

  let dirs: string[]
  const problems: string[] = []
  if (scope.kind === 'marketplace') {
    // Re-read the marketplace AT the pinned commit, never the bytes of a moving ref.
    const raw = await guardedFetch(pinnedRawUrl(ctx.owner, ctx.repo, sha, scope.path), {
      maxBytes: SMALL_API_BYTES,
      timeoutMs: API_TIMEOUT_MS,
      headers: { accept: 'application/json', 'user-agent': GITHUB_USER_AGENT },
    })
    if ('error' in raw) throw new GithubDiscoveryError(`Reading ${scope.path} at ${sha.slice(0, 7)}: ${raw.error}`)
    let doc: unknown
    try {
      doc = JSON.parse(raw.bytes.toString('utf8'))
    } catch {
      throw new GithubDiscoveryError(`${scope.path} is not valid JSON.`)
    }
    const found = marketplaceScopes(doc, marketplaceRoot(scope.path), items)
    dirs = found.dirs
    problems.push(...found.problems)
  } else if (scope.kind === 'skill') {
    if (!items.some((item) => item.type === 'blob' && item.path === (scope.dir ? `${scope.dir}/SKILL.md` : 'SKILL.md'))) {
      throw new GithubDiscoveryError(`${scope.dir ? `${scope.dir}/` : ''}SKILL.md does not exist at ${sha.slice(0, 7)}.`)
    }
    dirs = [scope.dir]
  } else {
    dirs = items
      .filter((item) => item.type === 'blob' && (item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md')) && within(dirOf(item.path), scope.path))
      .map((item) => dirOf(item.path))
  }
  if (dirs.length > MAX_DISCOVERED_PACKAGES) {
    throw new GithubDiscoveryError(`${dirs.length} packages found; this browser lists at most ${MAX_DISCOVERED_PACKAGES} from one URL. Paste the URL of a folder that holds fewer.`)
  }
  dirs.sort((a, b) => a.localeCompare(b))
  const packages = dirs.map((dir) => inventory(ctx.owner, ctx.repo, sha, dir, items, sourceUrl))
  if (!packages.some((pkg) => pkg.files.some((f) => f.license || LICENSE_FILE.test(f.path.split('/').pop() ?? '')))) {
    if (packages.length > 0) problems.push(`No license file found for these packages in ${ctx.owner}/${ctx.repo} at ${sha.slice(0, 7)}. Check the repository's terms before installing.`)
  }
  const scopePath = scope.kind === 'marketplace' ? scope.path : scopeDir
  return {
    kind: 'github',
    repository: `${ctx.owner}/${ctx.repo}`,
    sha,
    ref,
    scope: scopePath,
    url: `https://github.com/${ctx.owner}/${ctx.repo}/tree/${sha}${scopePath ? `/${encodePath(scopePath)}` : ''}`,
    packages,
    problems,
  }
}

/** The folder a marketplace's relative paths start from: the one holding `.claude-plugin/` or `.agents/`. */
function marketplaceRoot(path: string): string {
  for (const suffix of MARKETPLACE_SUFFIXES) {
    if (path === suffix) return ''
    if (path.endsWith(`/${suffix}`)) return path.slice(0, -suffix.length - 1)
  }
  return dirOf(path)
}
