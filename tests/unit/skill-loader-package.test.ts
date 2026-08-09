import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const repoRoot = resolve(import.meta.dirname, '../..')

function loadIndexer(): (adf: Record<string, (...args: never[]) => Promise<unknown>>) => Promise<Record<string, unknown>> {
  // Normalize CRLF so the fence regex works on Windows checkouts (autocrlf).
  const skill = readFileSync(resolve(repoRoot, 'skills/skill-loader/SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
  const block = /\n   ```ts\n([\s\S]*?)\n   ```/.exec(skill)
  if (!block) throw new Error('skill-loader is missing its TypeScript indexer block')
  const source = block[1].replace(/^   /gm, '')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  })
  const errors = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => '\n',
  }))

  const exports: { refresh?: () => Promise<Record<string, unknown>> } = {}
  const bind = new Function('adf', 'Buffer', 'exports', compiled.outputText)
  return async (adf) => {
    bind(adf, Buffer, exports)
    if (!exports.refresh) throw new Error('indexer block does not export refresh')
    return exports.refresh()
  }
}

describe('repository skills catalog', () => {
  it('matches every listed SKILL.md frontmatter record', () => {
    const catalog = JSON.parse(readFileSync(resolve(repoRoot, 'skills/registry.json'), 'utf8')) as {
      schema: number
      skills: Array<{ name: string; description: string; path: string; raw_url: string }>
    }
    expect(catalog.schema).toBe(1)
    for (const entry of catalog.skills) {
      const source = readFileSync(resolve(repoRoot, entry.path), 'utf8')
      expect(/^name: (.+)$/m.exec(source)?.[1]).toBe(entry.name)
      expect(/^description: (.+)$/m.exec(source)?.[1]).toBe(entry.description)
      expect(entry.raw_url).toBe(`https://raw.githubusercontent.com/christianbalevski/adf/main/${entry.path}`)
    }
  })

  it('runs the documented agent-space indexer deterministically', async () => {
    const files = new Map<string, string>([
      ['skills/example/SKILL.md', '---\nname: example\ndescription: Example installed skill.\n---\n\n# Example\n'],
      ['skills/bad/SKILL.md', 'not frontmatter'],
    ])
    const injections: Array<Record<string, unknown>> = []
    const adf = {
      fs_list: async () => JSON.stringify([...files].map(([path, content]) => ({
        path,
        size: Buffer.byteLength(content),
      }))),
      fs_read: async ({ path }: { path: string }) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('not found')
        return JSON.stringify({ path, content })
      },
      fs_write: async ({ path, content }: { path: string; content: string }) => {
        files.set(path, content)
        return 'written'
      },
      loop_inject: async (args: Record<string, unknown>) => {
        injections.push(args)
        return 'queued'
      },
    }

    const refresh = loadIndexer()
    const first = await refresh(adf as never)
    expect(first).toMatchObject({ changed: true, skill_count: 1 })
    expect(first.rejected).toEqual([{ path: 'skills/bad/SKILL.md', reason: 'missing YAML frontmatter' }])
    expect(JSON.parse(files.get('skills-registry.json') ?? '{}').skills.example).toMatchObject({ enabled: true })
    expect(injections).toHaveLength(1)
    expect(injections[0]).toMatchObject({ category: 'skills_registry', key: 'skills_registry' })

    const second = await refresh(adf as never)
    expect(second).toMatchObject({ changed: false, skill_count: 1 })
    expect(injections).toHaveLength(1)

    files.set('skills-state.json', JSON.stringify({ schema: 1, disabled: ['example'] }))
    const disabled = await refresh(adf as never)
    expect(disabled).toMatchObject({ changed: true, skill_count: 1 })
    expect(JSON.parse(files.get('skills-registry.json') ?? '{}').skills.example).toMatchObject({ enabled: false })
    expect(injections).toHaveLength(2)
  })
})
