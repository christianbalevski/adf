import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { parseSkillFrontmatter } from '../../src/main/adf/skill-indexer'
import { AgentSession } from '../../src/main/runtime/agent-session'
import { AdfCallHandler } from '../../src/main/runtime/adf-call-handler'
import { CodeSandboxService, transformExports, transformImports } from '../../src/main/runtime/code-sandbox'
import { ToolRegistry } from '../../src/main/tools/tool-registry'
import { FsReadTool } from '../../src/main/tools/built-in/fs-read.tool'
import { FsWriteTool } from '../../src/main/tools/built-in/fs-write.tool'

const skillRoot = resolve(import.meta.dirname, '../../skills/persistent-investigations')
const source = readFileSync(join(skillRoot, 'scripts/refresh.js'), 'utf8')
const sandbox = new CodeSandboxService()
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
afterAll(() => sandbox.destroyAll())

// Real VFS, existing tool implementations, RPC handler and sandbox transforms.
// No model is involved: these tests check composition, not research judgment.
function fixture(options: { inject?: boolean; resultTokens?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-investigation-skill-'))
  const filePath = join(dir, 'agent.adf')
  let workspace = AdfWorkspace.create(filePath, { name: 'research' })
  const registry = new ToolRegistry()
  registry.register(new FsReadTool())
  registry.register(new FsWriteTool())
  const config = {
    ...workspace.getAgentConfig(),
    tools: ['fs_read', 'fs_write'].map(name => ({ name, enabled: true, visible: true })),
    code_execution: { loop_inject: options.inject ?? true },
    limits: { ...workspace.getAgentConfig().limits, max_tool_result_tokens: options.resultTokens ?? 16000 },
  }
  let session: AgentSession
  let handler: AdfCallHandler
  const bind = () => {
    session = new AgentSession(workspace)
    handler = new AdfCallHandler({ workspace, config, toolRegistry: registry, provider: {} as never })
    handler.attachSession(session)
  }
  bind()
  cleanups.push(() => { workspace.dispose(); rmSync(dir, { recursive: true, force: true }) })
  return {
    get workspace() { return workspace },
    get session() { return session },
    async write(path: string, content: string) {
      const result = await registry.executeTool('fs_write', { path, content, mode: 'write' }, workspace)
      expect(result.isError, String(result.content)).toBe(false)
    },
    reopen() { workspace.dispose(); workspace = AdfWorkspace.open(filePath); bind() },
    run(path: string) {
      const code = `${transformExports(transformImports(source))}\nreturn await refresh(${JSON.stringify({ path })});`
      return sandbox.execute(`investigation-skill:${Math.random()}`, code, 10000, (method, args) => handler.handleCall(method, args))
    },
  }
}

const journalPath = 'investigations/control/state.json'
const initial = { goal: 'Explain failures', status: 'active', questions: [{ question: 'Is timing causal?', status: 'open' }], experiments: [{ result: 'Delay did not fix it', status: 'completed' }] }

describe('persistent investigations composed from existing capabilities', () => {
  it('is discoverable using the existing skill frontmatter parser', () => {
    expect(parseSkillFrontmatter(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'))).toMatchObject({ name: 'persistent-investigations' })
  })

  it('publishes fresh evidence with a valid stable key, leaving state unchanged', async () => {
    const f = fixture()
    await f.write(journalPath, JSON.stringify(initial))
    expect((await f.run(journalPath)).error).toBeUndefined()
    const updated = { ...initial, next_experiment: 'Hold delay fixed and vary order' }
    await f.write(journalPath, JSON.stringify(updated))
    expect((await f.run(journalPath)).error).toBeUndefined()
    const delivered = f.session.drainContextInjections()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain(updated.next_experiment)
    expect(delivered[0].text).toContain('Is timing causal?')
    expect(JSON.parse(f.workspace.readFile(journalPath)!)).toEqual(updated)
  })

  it('reads unresolved questions after clearing history and reopening the ADF', async () => {
    const f = fixture()
    await f.write(journalPath, JSON.stringify(initial))
    expect((await f.run(journalPath)).error).toBeUndefined()
    await f.workspace.clearLoop()
    f.reopen()
    expect(f.workspace.getLoop()).toHaveLength(0)
    expect((await f.run(journalPath)).error).toBeUndefined()
    expect(f.session.drainContextInjections()[0].text).toContain('Is timing causal?')
    expect(JSON.parse(f.workspace.readFile(journalPath)!)).toEqual(initial)
  })

  it('preserves malformed journals and missing files without publishing success', async () => {
    const f = fixture()
    await f.write(journalPath, '{broken')
    expect((await f.run(journalPath)).error).toBeTruthy()
    expect((await f.run('missing.json')).error).toBeTruthy()
    expect(f.workspace.readFile(journalPath)).toBe('{broken')
    expect(f.session.drainContextInjections()).toEqual([])
  })

  it('respects existing injection permissions', async () => {
    const f = fixture({ inject: false })
    await f.write(journalPath, JSON.stringify(initial))
    expect((await f.run(journalPath)).error).toBeTruthy()
    expect(f.session.drainContextInjections()).toEqual([])
    expect(JSON.parse(f.workspace.readFile(journalPath)!)).toEqual(initial)
  })

  it('surfaces the configured injection size limit without clipping or overwriting', async () => {
    const f = fixture({ resultTokens: 200 })
    const content = JSON.stringify({ ...initial, evidence: 'x'.repeat(2000) })
    await f.write(journalPath, content)
    expect((await f.run(journalPath)).error).toContain('character limit')
    expect(f.session.drainContextInjections()).toEqual([])
    expect(f.workspace.readFile(journalPath)).toBe(content)
  })
})
