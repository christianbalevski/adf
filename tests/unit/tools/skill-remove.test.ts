import { describe, expect, it, vi } from 'vitest'
import { SkillRemoveTool } from '../../../src/main/tools/built-in/skill-remove.tool'

const MANIFEST = '---\nname: alpha\ndescription: Does alpha things.\n---\n'

function makeWorkspace(seed: Record<string, { content: string; protection?: string }>) {
  const files = new Map(
    Object.entries(seed).map(([path, value]) => [path, { content: value.content, protection: value.protection ?? 'none' }])
  )
  const deletes: string[] = []
  const writes: Array<{ path: string; content: string }> = []
  return {
    files,
    deletes,
    writes,
    setAgentConfig: vi.fn(),
    getAgentConfig: () => ({ skills: { enabled: true }, tools: [] }) as never,
    listFiles: () => [...files.entries()].map(([path, value]) => ({
      path, size: value.content.length, protection: value.protection, authorized: false,
    })),
    readFile: (path: string) => files.get(path)?.content ?? null,
    writeFile: (path: string, content: string) => {
      files.set(path, { content, protection: files.get(path)?.protection ?? 'none' })
      writes.push({ path, content })
    },
    getFileProtection: (path: string) => files.get(path)?.protection ?? null,
    deleteFile: (path: string) => {
      const entry = files.get(path)
      // Mirrors the DB's guarded DELETE: protected rows are invisible to it.
      if (!entry || entry.protection !== 'none') return false
      files.delete(path)
      deletes.push(path)
      return true
    },
  }
}

describe('SkillRemoveTool', () => {
  it('deletes the whole package with SKILL.md first so it de-indexes immediately', async () => {
    const workspace = makeWorkspace({
      'skills/alpha/SKILL.md': { content: MANIFEST },
      'skills/alpha/scripts/run.js': { content: 'x' },
      'skills/alpha/references/notes.md': { content: 'y' },
      'skills/beta/SKILL.md': { content: MANIFEST },
      'mind.md': { content: 'untouched' },
    })

    const result = await new SkillRemoveTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(result.isError).toBe(false)
    expect(content.success).toBe(true)
    expect(content.deleted[0]).toBe('skills/alpha/SKILL.md')
    expect(content.deleted).toHaveLength(3)
    expect(workspace.deletes[0]).toBe('skills/alpha/SKILL.md')
    // A sibling package and unrelated files are untouched.
    expect(workspace.files.has('skills/beta/SKILL.md')).toBe(true)
    expect(workspace.files.has('mind.md')).toBe(true)
    expect(content.message).toMatch(/SKILL\.md first/)
  })

  it('clears a stale disabled entry from skills-state.json and keeps the other names', async () => {
    const workspace = makeWorkspace({
      'skills/alpha/SKILL.md': { content: MANIFEST },
      'skills-state.json': { content: JSON.stringify({ schema: 1, disabled: ['alpha', 'beta'] }) },
    })

    const result = await new SkillRemoveTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(content.state_updated).toBe(true)
    expect(JSON.parse(workspace.files.get('skills-state.json')!.content)).toEqual({ schema: 1, disabled: ['beta'] })
    expect(content.message).toMatch(/disabled list/)
  })

  it('leaves a malformed state file alone and says so', async () => {
    const workspace = makeWorkspace({
      'skills/alpha/SKILL.md': { content: MANIFEST },
      'skills-state.json': { content: '{ not json' },
    })

    const result = await new SkillRemoveTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(content.success).toBe(true)
    expect(content.state_updated).toBeUndefined()
    expect(workspace.files.get('skills-state.json')!.content).toBe('{ not json')
    expect(content.rejected).toEqual([{ path: 'skills-state.json', reason: 'not valid JSON — mute list left alone' }])
  })

  it('does not rewrite the state file when the skill was never muted', async () => {
    const workspace = makeWorkspace({
      'skills/alpha/SKILL.md': { content: MANIFEST },
      'skills-state.json': { content: JSON.stringify({ schema: 1, disabled: ['beta'] }) },
    })

    await new SkillRemoveTool().execute({ name: 'alpha' }, workspace as never)

    expect(workspace.writes).toEqual([])
  })

  it('reports a protected file instead of forcing it', async () => {
    const workspace = makeWorkspace({
      'skills/alpha/SKILL.md': { content: MANIFEST },
      'skills/alpha/scripts/run.js': { content: 'x', protection: 'read_only' },
    })

    const result = await new SkillRemoveTool().execute({ name: 'alpha' }, workspace as never)
    const content = JSON.parse(result.content)

    expect(content.deleted).toEqual(['skills/alpha/SKILL.md'])
    expect(content.rejected).toEqual([{ path: 'skills/alpha/scripts/run.js', reason: 'file is protected (read_only)' }])
    expect(workspace.files.has('skills/alpha/scripts/run.js')).toBe(true)
  })

  it('errors plainly when nothing is installed under that name', async () => {
    const workspace = makeWorkspace({ 'skills/beta/SKILL.md': { content: MANIFEST } })

    const result = await new SkillRemoveTool().execute({ name: 'alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/No skill package at skills\/alpha\//)
    expect(workspace.deletes).toEqual([])
  })

  it('refuses a name that is not a skill identifier', async () => {
    const workspace = makeWorkspace({ 'skills/alpha/SKILL.md': { content: MANIFEST } })

    const result = await new SkillRemoveTool().execute({ name: '../alpha' }, workspace as never)

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content).error).toMatch(/not a usable skill name/)
    expect(workspace.deletes).toEqual([])
  })
})
