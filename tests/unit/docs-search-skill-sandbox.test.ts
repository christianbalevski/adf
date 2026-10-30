import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodeSandboxService, transformExports, transformImports } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import { parseSkillsCatalogDocument } from '../../src/shared/schemas/skills-catalog.schema'

/**
 * Runs skills/docs-search/scripts/docs-search.js the way sys_lambda does —
 * same import/export transforms and wrapper, inside the real sandbox worker.
 * sys_fetch is answered from the repository's own index files with the tool's
 * JSON payload shape ({ status, statusText, headers, body }), so this proves
 * the lambda parses the shipped indexes and handles the sandbox's response
 * delivery without touching the network.
 */

const repoRoot = resolve(import.meta.dirname, '../..')
const lambdaSource = readFileSync(resolve(repoRoot, 'skills/docs-search/scripts/docs-search.js'), 'utf8')
const ORIGIN = 'https://raw.githubusercontent.com/christianbalevski/adf/main/'

function runner(failing = new Set<string>()) {
  const urls: string[] = []
  const onAdfCall = async (method: string, args: unknown): Promise<AdfCallResult> => {
    if (method !== 'sys_fetch') return { error: `tool ${method} not available`, errorCode: 'TOOL_ERROR' }
    const url = (args as { url: string }).url
    urls.push(url)
    if (!url.startsWith(ORIGIN)) return { error: 'off-origin', errorCode: 'TOOL_ERROR' }
    if (failing.has(url.slice(ORIGIN.length))) return { error: 'blocked by test', errorCode: 'TOOL_ERROR' }
    let body: string
    try {
      body = readFileSync(resolve(repoRoot, url.slice(ORIGIN.length)), 'utf8')
    } catch {
      return { result: JSON.stringify({ status: 404, statusText: 'Not Found', headers: {}, body: '404: Not Found' }) }
    }
    return { result: JSON.stringify({ status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain; charset=utf-8' }, body }) }
  }
  return {
    urls,
    async run(args: Record<string, unknown>) {
      const code = `${transformExports(transformImports(lambdaSource))}
return await main(${JSON.stringify(args)});`
      return sandbox.execute(`docs-search-test:${Math.random()}`, code, 10000, onAdfCall)
    }
  }
}

const sandbox = new CodeSandboxService()
afterAll(() => sandbox.destroyAll?.())

describe('docs-search skill in the real sandbox', () => {
  it('parses the shipped indexes and fetches only the top hits', async () => {
    const r = runner()
    const out = await r.run({ query: 'recurring timer', fetch_top: 1 })
    expect(out.error).toBeUndefined()
    const value = JSON.parse(out.result!)
    expect(value.ok).toBe(true)
    expect(value.partial).toBe(false)
    for (const ix of value.indexes) expect(ix.entries).toBeGreaterThan(0)
    expect(value.hits[0].path).toBe('docs/guides/timers.md')
    expect(value.hits[0].document.ok).toBe(true)
    expect(value.hits[0].document.text).toContain('# ')
    expect(r.urls).toHaveLength(4)
    expect(r.urls.every((u) => u.startsWith(ORIGIN))).toBe(true)
  })

  it('ranks KB articles and registry skills together', async () => {
    const r = runner()
    const value = JSON.parse((await r.run({ query: 'gmail setup', fetch_top: 0 })).result!)
    expect(value.hits.map((h: { path: string }) => h.path).slice(0, 3)).toEqual(
      expect.arrayContaining(['docs/knowledge/gmail-setup.md', 'skills/gmail-setup/SKILL.md'])
    )
    expect(r.urls).toHaveLength(3)
  })

  it('surfaces a tool error delivered through the sandbox as a failed index', async () => {
    const r = runner(new Set(['skills/registry.json']))
    const value = JSON.parse((await r.run({ query: 'gmail setup', fetch_top: 0 })).result!)
    expect(value.ok).toBe(true)
    expect(value.partial).toBe(true)
    const registry = value.indexes.find((i: { path: string }) => i.path === 'skills/registry.json')
    expect(registry.ok).toBe(false)
    expect(registry.error).toContain('blocked by test')
    expect(value.hits.map((h: { path: string }) => h.path)).toContain('docs/knowledge/gmail-setup.md')
  })

  it('is listed in the first-party catalog with its helper as a package resource', () => {
    const catalog = parseSkillsCatalogDocument(JSON.parse(readFileSync(resolve(repoRoot, 'skills/registry.json'), 'utf8')))
    const entry = catalog!.entries.find((e) => e.name === 'docs-search')
    expect(entry).toBeDefined()
    expect(entry!.path).toBe('skills/docs-search/SKILL.md')
    expect(entry!.files?.map((f) => f.path)).toContain('scripts/docs-search.js')
    const manifest = readFileSync(resolve(repoRoot, 'skills/docs-search/SKILL.md'), 'utf8')
    expect(manifest).toContain(`description: ${entry!.description}`)
  })
})
