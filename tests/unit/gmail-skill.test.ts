import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseSkillsCatalogDocument, resolvePackageFilePath } from '../../src/shared/schemas/skills-catalog.schema'
import { parseSkillFrontmatter } from '../../src/main/adf/skill-indexer'
import { installPackage } from '../../src/main/tui/skills/ops'
import { setSkillsFetchSeams } from '../../src/main/tui/skills/catalog'
import { CodeSandboxService, transformExports, transformImports } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import type { DaemonClient } from '../../src/main/tui/api/client'

/**
 * skills/gmail as a first-party package: discovered through the shipped
 * catalog, installed with the TUI's existing install routine (resources first,
 * SKILL.md last), indexed by the runtime's frontmatter parser, and its lambda
 * run inside the real sandbox worker with the same transforms sys_lambda uses.
 * Google is never contacted: get_identity and sys_fetch are answered by a stub
 * with synthetic values.
 */

const repoRoot = resolve(import.meta.dirname, '../..')
const RAW_PREFIX = 'https://raw.githubusercontent.com/christianbalevski/adf/main/'
const sandbox = new CodeSandboxService()
afterAll(() => sandbox.destroyAll())

const SYNTHETIC: Record<string, string> = {
  'gmail:client_id': 'synthetic-client.apps.googleusercontent.test',
  'gmail:client_secret': 'SYNTHETIC-client-secret-0000',
  'gmail:refresh_token': '1//SYNTHETIC-refresh-token-aaaaaaaaaaaa',
}

function catalogEntry() {
  const parsed = parseSkillsCatalogDocument(JSON.parse(readFileSync(resolve(repoRoot, 'skills/registry.json'), 'utf8')))
  const entry = parsed!.entries.find(e => e.name === 'gmail')
  expect(entry).toBeDefined()
  return entry!
}

async function installFromCatalog() {
  const entry = catalogEntry()
  const files = new Map<string, string>()
  const writes: string[] = []
  const client = {
    writeFile: async (_id: string, path: string, input: { content?: string }) => { writes.push(path); files.set(path, input.content ?? ''); return { success: true } },
  } as unknown as DaemonClient
  // Serve raw_url from this checkout instead of GitHub.
  setSkillsFetchSeams({ text: async (url: string) => ({ ok: true, content: readFileSync(resolve(repoRoot, url.slice(RAW_PREFIX.length)), 'utf8') }) })
  try {
    const outcome = await installPackage(client, 'agent', {
      name: entry.name, description: entry.description, source: 'catalog', origin: entry.raw_url, label: 'adf', warnings: [],
      manifest: readFileSync(resolve(repoRoot, entry.raw_url.slice(RAW_PREFIX.length)), 'utf8'),
      resources: (entry.files ?? []).map(f => ({ path: f.path, rawUrl: f.raw_url })),
    })
    expect(outcome).toMatchObject({ error: null, warnings: [] })
  } finally {
    setSkillsFetchSeams(null)
  }
  return { entry, files, writes }
}

function runLambda(source: string, fn: string, args: unknown, fetches: Array<{ url: string; method?: string; body?: string }>) {
  const onAdfCall = async (method: string, input: unknown): Promise<AdfCallResult> => {
    const a = input as Record<string, string>
    if (method === 'get_identity') return a.purpose in SYNTHETIC ? { result: SYNTHETIC[a.purpose], raw: true } : { error: 'not found', errorCode: 'NOT_FOUND' }
    if (method === 'sys_fetch') {
      fetches.push({ url: a.url, method: a.method, body: a.body })
      const body = a.url === 'https://oauth2.googleapis.com/token'
        ? { access_token: 'ya29.SYNTHETIC-access' }
        : { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] }
      return { result: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: JSON.stringify(body) }) }
    }
    return { error: `tool ${method} not available`, errorCode: 'TOOL_ERROR' }
  }
  const code = `${transformExports(transformImports(source))}\nreturn await ${fn}(${JSON.stringify(args)});`
  return sandbox.execute(`gmail-skill-test:${Math.random()}`, code, 10000, onAdfCall)
}

describe('gmail skill package', () => {
  it('catalog entry matches the manifest and ships confined resources', () => {
    const entry = catalogEntry()
    const manifest = parseSkillFrontmatter(readFileSync(resolve(repoRoot, 'skills/gmail/SKILL.md'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'gmail', description: entry.description })
    expect(entry.description.length).toBeLessThanOrEqual(500)
    for (const f of entry.files ?? []) expect(resolvePackageFilePath('gmail', f.path)).toBe(f.path)
  })

  it('installs from the catalog with resources first and SKILL.md last', async () => {
    const { writes, files } = await installFromCatalog()
    expect(writes).toEqual(['skills/gmail/scripts/gmail.js', 'skills/gmail/tests/gmail.test.mjs', 'skills/gmail/SKILL.md'])
    expect(parseSkillFrontmatter(files.get('skills/gmail/SKILL.md')!)).toMatchObject({ name: 'gmail' })
  })

  it('runs the installed lambda in the sandbox against fixed endpoints without returning credentials', async () => {
    const { files } = await installFromCatalog()
    const fetches: Array<{ url: string; method?: string; body?: string }> = []
    const r = await runLambda(files.get('skills/gmail/scripts/gmail.js')!, 'listLabels', {}, fetches)
    expect(r.error).toBeUndefined()
    expect(JSON.parse(String(r.result))).toEqual({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] })
    expect(fetches.map(f => `${f.method} ${f.url}`)).toEqual([
      'POST https://oauth2.googleapis.com/token',
      'GET https://gmail.googleapis.com/gmail/v1/users/me/labels',
    ])
    const out = JSON.stringify(r)
    for (const secret of [...Object.values(SYNTHETIC), 'ya29.SYNTHETIC-access']) expect(out).not.toContain(secret)

    const bad = await runLambda(files.get('skills/gmail/scripts/gmail.js')!, 'read', { id: 'x', url: 'https://evil.test/' }, fetches)
    expect(bad.error).toMatch(/INVALID_INPUT: unknown argument "url"/)
  })
})
