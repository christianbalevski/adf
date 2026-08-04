import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_REGISTERED_SKILLS,
  MAX_SKILLS_REGISTRY_BYTES,
  parseSkillFrontmatter,
  reconcileSkillRegistry,
  setSkillEnabled,
  uninstallSkill,
} from '../../src/main/adf/skill-registry'
import { AdfWorkspace } from '../../src/main/adf/adf-workspace'
import { mergeTemplateWithOverrides } from '../../src/main/adf/adf-template'

type File = { content: Buffer; protection: 'none' | 'no_delete' | 'authorized' }

function makeWorkspace(initial: Record<string, string | File>) {
  const files = new Map<string, File>(Object.entries(initial).map(([path, value]) => [
    path,
    typeof value === 'string' ? { content: Buffer.from(value), protection: 'none' as const } : value,
  ]))
  const workspace = {
    listFiles: () => [...files.entries()].map(([path, value]) => ({
      path,
      size: value.content.length,
      protection: value.protection,
      authorized: false,
      created_at: '',
      updated_at: '',
    })),
    readFileBuffer: (path: string) => files.get(path)?.content ?? null,
    readFile: (path: string) => files.get(path)?.content.toString('utf8') ?? null,
    writeFile: (path: string, content: string) => files.set(path, { content: Buffer.from(content), protection: 'none' }),
    deleteFile: (path: string) => files.delete(path),
  }
  return { workspace, files }
}

const VALID_SKILL = `---
name: browser-profile-portability
description: Securely checkpoint and restore browser profiles.
---

# Browser profile portability
`

describe('ADF skill registry', () => {
  it('persists skill configuration during creation and template merging', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-skills-config-'))
    try {
      const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), {
        name: 'skills-config',
        skills: { enabled: true, root: 'agent-skills' },
      })
      const template = workspace.getAgentConfig()
      expect(template.skills).toEqual({ enabled: true, root: 'agent-skills' })

      const merged = mergeTemplateWithOverrides(template, {
        name: 'skills-copy',
        skills: { registry: 'catalog.json' },
      })
      expect(merged).toMatchObject({
        ok: true,
        options: { skills: { enabled: true, root: 'agent-skills', registry: 'catalog.json' } },
      })

      template.locked_fields = ['skills']
      expect(mergeTemplateWithOverrides(template, {
        name: 'skills-copy',
        skills: { enabled: false },
      })).toMatchObject({ ok: false, error: expect.stringContaining("locked field 'skills'") })
      workspace.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts only the required strict frontmatter shape', () => {
    expect(parseSkillFrontmatter(VALID_SKILL)).toEqual({
      ok: true,
      name: 'browser-profile-portability',
      description: 'Securely checkpoint and restore browser profiles.',
    })
    expect(parseSkillFrontmatter('name: no-boundary')).toMatchObject({ ok: false })
    expect(parseSkillFrontmatter(`---\nname: no_caps\ndescription: test\n---`)).toMatchObject({ ok: false })
    expect(parseSkillFrontmatter(`---\nname: valid\ndescription: test\nextra: nope\n---`)).toMatchObject({ ok: false })
    expect(parseSkillFrontmatter(`---\nname: valid\ndescription: |\n  multiline\n---`)).toMatchObject({ ok: false })
  })

  it('discovers only skills/<name>/SKILL.md and atomically writes a compact deterministic catalog', () => {
    const { workspace } = makeWorkspace({
      'skills/browser-profile-portability/SKILL.md': VALID_SKILL,
      'skills/not-a-skill/notes.md': 'ignored',
      'skills/nested/extra/SKILL.md': VALID_SKILL,
      'skills/mismatch/SKILL.md': VALID_SKILL,
    })
    const result = reconcileSkillRegistry(workspace as never)
    expect(result.changed).toBe(true)
    expect(Object.keys(result.registry.skills)).toEqual(['browser-profile-portability'])
    expect(result.registry.skills['browser-profile-portability']).toMatchObject({
      path: 'skills/browser-profile-portability/SKILL.md',
      enabled: true,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(result.rejected).toContainEqual(expect.objectContaining({ path: 'skills/mismatch/SKILL.md' }))
    expect(reconcileSkillRegistry(workspace as never).changed).toBe(false)
  })

  it('bounds catalog count and generated size deterministically', () => {
    const initial: Record<string, string> = {}
    for (let i = 0; i < MAX_REGISTERED_SKILLS + 4; i++) {
      const name = `skill-${String(i).padStart(3, '0')}`
      initial[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: ${'x'.repeat(500)}\n---\n`
    }
    const { workspace } = makeWorkspace(initial)
    const result = reconcileSkillRegistry(workspace as never)
    expect(Object.keys(result.registry.skills).length).toBeLessThanOrEqual(MAX_REGISTERED_SKILLS)
    expect(Buffer.byteLength(JSON.stringify(result.registry, null, 2) + '\n')).toBeLessThanOrEqual(MAX_SKILLS_REGISTRY_BYTES)
    expect(result.rejected.length).toBeGreaterThan(0)
  })

  it('keeps disabled state separate from installed source and preserves it during reconciliation', () => {
    const { workspace, files } = makeWorkspace({ 'skills/browser-profile-portability/SKILL.md': VALID_SKILL })
    setSkillEnabled(workspace as never, 'browser-profile-portability', false)
    const result = reconcileSkillRegistry(workspace as never)
    expect(result.registry.skills['browser-profile-portability'].enabled).toBe(false)
    expect(files.has('skills/browser-profile-portability/SKILL.md')).toBe(true)
    setSkillEnabled(workspace as never, 'browser-profile-portability', true)
    expect(reconcileSkillRegistry(workspace as never).registry.skills['browser-profile-portability'].enabled).toBe(true)
  })

  it('uninstalls only an unprotected package and retains unrelated skills', () => {
    const { workspace, files } = makeWorkspace({
      'skills/browser-profile-portability/SKILL.md': VALID_SKILL,
      'skills/browser-profile-portability/references/notes.md': 'notes',
      'skills/other/SKILL.md': `---\nname: other\ndescription: Other skill.\n---\n`,
    })
    expect(uninstallSkill(workspace as never, 'browser-profile-portability')).toBe(2)
    expect(files.has('skills/browser-profile-portability/SKILL.md')).toBe(false)
    expect(files.has('skills/other/SKILL.md')).toBe(true)
  })

  it('refuses a partial uninstall when any package file is protected', () => {
    const { workspace, files } = makeWorkspace({
      'skills/browser-profile-portability/SKILL.md': VALID_SKILL,
      'skills/browser-profile-portability/references/locked.md': { content: Buffer.from('x'), protection: 'no_delete' },
    })
    expect(() => uninstallSkill(workspace as never, 'browser-profile-portability')).toThrow(/protected/)
    expect(files.has('skills/browser-profile-portability/SKILL.md')).toBe(true)
  })
})
