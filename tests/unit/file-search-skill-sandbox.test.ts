import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodeSandboxService, transformExports, transformImports } from '../../src/main/runtime/code-sandbox'
import type { AdfCallResult } from '../../src/main/runtime/code-sandbox'
import { FsListTool } from '../../src/main/tools/built-in/fs-list.tool'
import { FsReadTool } from '../../src/main/tools/built-in/fs-read.tool'
import type { AdfWorkspace } from '../../src/main/adf/adf-workspace'

/**
 * Runs skills/file-search/scripts/file-search.js the way sys_lambda does —
 * same import/export transforms and wrapper, inside the real sandbox worker —
 * against the real fs_list/fs_read tools over a minimal in-memory workspace.
 * Proves the lambda's assumptions about the tool response shapes and sandbox
 * globals, and that only the sandbox timeout stops a catastrophic regex.
 * Scope: tool code and sandbox are real; the AdfWorkspace (SQLite, README.md /
 * mind.md synthesis, HIL gating) is a stub. `listed_size` makes the stub's
 * listing row disagree with the stored bytes, as a write between fs_list and
 * fs_read would.
 */

const repoRoot = resolve(import.meta.dirname, '../..')
const lambdaSource = readFileSync(resolve(repoRoot, 'skills/file-search/scripts/file-search.js'), 'utf8')

type StubFile = { content: Buffer; mime_type: string | null; listed_size?: number }

function stubWorkspace(files: Record<string, StubFile>): AdfWorkspace {
  const row = (path: string, f: StubFile) => ({
    path, content: f.content, mime_type: f.mime_type ?? undefined, size: f.content.length,
    protection: 'none', authorized: false, created_at: '2026-01-01', updated_at: '2026-01-01'
  })
  return {
    listFiles: () => Object.entries(files).map(([path, f]) => ({ ...row(path, f), size: f.listed_size ?? f.content.length, content: undefined })),
    readDocument: () => null,
    readMind: () => null,
    getDatabase: () => ({ readFile: (path: string) => (files[path] ? row(path, files[path]) : null) })
  } as unknown as AdfWorkspace
}

function runner(files: Record<string, StubFile>) {
  const workspace = stubWorkspace(files)
  const tools = { fs_list: new FsListTool(), fs_read: new FsReadTool() }
  const calls: Array<{ method: string; args: unknown }> = []
  const onAdfCall = async (method: string, args: unknown): Promise<AdfCallResult> => {
    calls.push({ method, args })
    const tool = tools[method as keyof typeof tools]
    if (!tool) return { error: `tool ${method} not available`, errorCode: 'TOOL_ERROR' }
    const result = await tool.execute(args, workspace)
    return result.isError ? { error: String(result.content), errorCode: 'TOOL_ERROR' } : { result: String(result.content) }
  }
  return {
    calls,
    async run(args: Record<string, unknown>, timeoutMs = 10000) {
      const code = `${transformExports(transformImports(lambdaSource))}
return await main(${JSON.stringify(args)});`
      return sandbox.execute(`file-search-test:${Math.random()}`, code, timeoutMs, onAdfCall)
    }
  }
}

const sandbox = new CodeSandboxService()
afterAll(() => sandbox.destroyAll?.())

const text = (s: string) => ({ content: Buffer.from(s, 'utf8'), mime_type: 'text/markdown' })

describe('file-search skill in the real sandbox', () => {
  const files = {
    'notes/deploy.md': text('# Deploy\nRun the rollback procedure if deploy fails.\n'),
    'notes/misc.md': text('deploy deploy deploy\n'),
    'notes/données.md': text('Résumé du déploiement\n'),
    'img/logo.png': { content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), mime_type: 'image/png' },
    'src/a.ts': { content: Buffer.from('export const TODO_7 = 1\n'), mime_type: 'application/typescript' }
  }

  it('bm25 ranks, locates lines, and skips binary via the real tools', async () => {
    const r = runner(files)
    const out = await r.run({ query: 'rollback deploy', mode: 'bm25' })
    expect(out.error).toBeUndefined()
    const value = JSON.parse(out.result!)
    expect(value.results[0].path).toBe('notes/deploy.md')
    expect(value.results[0].matches[0]).toEqual({ line: 2, column: 9, snippet: 'Run the rollback procedure if deploy fails.' })
    expect(value.coverage.skipped.binary).toBe(1)
    expect(value.coverage.complete).toBe(true)
    // Only read tools were used, and the listing asked for the full set.
    expect(new Set(r.calls.map(c => c.method))).toEqual(new Set(['fs_list', 'fs_read']))
    expect(r.calls[0].args).toEqual({ _full: true })
    expect(r.calls.some(c => (c.args as { path?: string }).path === 'img/logo.png')).toBe(false)
  })

  it('unicode tokens work in the sandbox realm; exact and regex modes honour prefix', async () => {
    const r = runner(files)
    const uni = JSON.parse((await r.run({ query: 'DÉPLOIEMENT', mode: 'bm25' })).result!)
    expect(uni.results.map((x: { path: string }) => x.path)).toEqual(['notes/données.md'])
    const exact = JSON.parse((await r.run({ query: 'Deploy', prefix: 'notes/', case_sensitive: true })).result!)
    expect(exact.results.map((x: { path: string }) => x.path)).toEqual(['notes/deploy.md'])
    const re = JSON.parse((await r.run({ query: 'TODO_\\d+', mode: 'regex', prefix: 'src/' })).result!)
    expect(re.results[0].matches[0]).toEqual({ line: 1, column: 14, snippet: 'export const TODO_7 = 1' })
  })

  it('enforces caps on the UTF-8 bytes fs_read returned, not the stale fs_list size', async () => {
    // Listed as 1 byte; 300 'é' are 600 UTF-8 bytes in storage.
    const r = runner({ 'a.md': { ...text('é'.repeat(300)), listed_size: 1 }, 'b.md': text('é') })
    const perFile = JSON.parse((await r.run({ query: 'é', max_file_bytes: 10, max_total_bytes: 10 })).result!)
    expect(perFile.results.map((x: { path: string }) => x.path)).toEqual(['b.md'])
    expect(perFile.coverage.skipped.too_large).toBe(1)
    expect(perFile.coverage.skipped_examples).toEqual([{ path: 'a.md', reason: 'too_large', detail: '600 bytes read (listed 1)' }])
    expect(perFile.coverage.bytes_scanned).toBe(2)
    expect(perFile.coverage.changed_since_listing).toBe(1)
    expect(perFile.coverage.complete).toBe(false)
    const total = JSON.parse((await r.run({ query: 'é', max_total_bytes: 10 })).result!)
    expect(total.results).toEqual([])
    expect(total.coverage.skipped.over_byte_budget).toBe(2)
    expect(total.coverage.bytes_scanned).toBe(0)
    expect(total.coverage.complete).toBe(false)
  })

  it('rejects a catastrophic regex by default; with the opt-in only the sandbox timeout stops it', async () => {
    const r = runner({ 'evil.txt': text('a'.repeat(40) + '!') })
    const rejected = await r.run({ query: '(a+)+$', mode: 'regex' })
    expect(rejected.error).toMatch(/Regex rejected \(nested quantifier\)/)
    const started = Date.now()
    const timedOut = await r.run({ query: '(a+)+$', mode: 'regex', allow_unsafe_regex: true, time_budget_ms: 100 }, 1500)
    expect(timedOut.errorCode).toBe('TIMEOUT')
    // The in-lambda time budget could not interrupt the single exec call.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
  }, 20000)
})
