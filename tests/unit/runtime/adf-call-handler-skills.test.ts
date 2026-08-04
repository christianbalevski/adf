import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

const SKILL = `---
name: catalog-test
description: Exercise deterministic skill registry reconciliation.
---

# Catalog test
`

describe('AdfCallHandler skills_reconcile', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function makeFixture(enabled = true) {
    const dir = mkdtempSync(join(tmpdir(), 'adf-skills-reconcile-'))
    const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'skills-test' })
    cleanups.push(() => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    const handler = new AdfCallHandler({
      toolRegistry: { get: () => null } as never,
      workspace,
      config: {
        name: 'skills-test',
        id: 'skills-test',
        tools: [],
        skills: { enabled },
        code_execution: { skills_reconcile: true },
      } as unknown as AgentConfig,
      provider: {} as never,
    })
    return { workspace, handler }
  }

  it('reconciles the deterministic catalog without executing or authorizing a skill', async () => {
    const { workspace, handler } = makeFixture()
    workspace.writeFile('skills/catalog-test/SKILL.md', SKILL)

    const result = await handler.handleCall('skills_reconcile', {})

    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({
      changed: true,
      registry: {
        skills: {
          'catalog-test': expect.objectContaining({ enabled: true, path: 'skills/catalog-test/SKILL.md' })
        }
      }
    })
    expect(workspace.readFile('skills-registry.json')).toContain('catalog-test')
  })

  it('requires explicit skill-catalog enablement', async () => {
    const { handler } = makeFixture(false)
    const result = await handler.handleCall('skills_reconcile', {})
    expect(result.errorCode).toBe('DISABLED')
  })
})
