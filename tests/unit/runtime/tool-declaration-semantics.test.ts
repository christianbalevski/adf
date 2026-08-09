import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolDeclarationSchema } from '../../../src/main/adf/adf-schema'
import { evaluateToolNames } from '../../../src/main/tools/shell/executor/preflight'
import { ToolRegistry } from '../../../src/main/tools/tool-registry'
import type { AgentConfig, ToolDeclaration } from '../../../src/shared/types/adf-v02.types'
import type { Tool } from '../../../src/main/tools/tool.interface'

/**
 * One semantic for a MISSING `enabled`/`visible` flag, agreed on by every
 * layer: undefined = disabled/hidden (the safe default).
 *
 * - shell gate (evaluateToolNames): `!decl.enabled` → disabled
 * - LLM schema exposure (getToolsForAgent): `enabled && visible` → hidden
 * - validation schema (ToolDeclarationSchema): defaults to false, so a parsed
 *   config can never claim more capability than the runtime will honor
 *
 * `visible` must NEVER gate execution: {enabled: true, visible: false} is the
 * intended shell-absorption state — hidden from the LLM tool list but fully
 * executable via shell, lambdas, and adf.* calls.
 */

function cfg(tools: Partial<ToolDeclaration>[]): AgentConfig {
  return { name: 'a', tools } as unknown as AgentConfig
}

describe('undefined enabled/visible — one semantic everywhere', () => {
  it('shell gate: declaration without an enabled flag is DISABLED', () => {
    const result = evaluateToolNames(['fs_delete'], cfg([{ name: 'fs_delete' }]))
    expect(result.disabled).toEqual(['fs_delete'])
  })

  it('shell gate: enabled:true + visible:false EXECUTES (visibility never gates execution)', () => {
    const result = evaluateToolNames(['fs_delete'], cfg([{ name: 'fs_delete', enabled: true, visible: false }]))
    expect(result.disabled).toEqual([])
    expect(result.approvalRequired).toEqual([])
  })

  it('shell gate: enabled:false is disabled even when restricted:true (restricted is not a second enable)', () => {
    const result = evaluateToolNames(['fs_delete'], cfg([{ name: 'fs_delete', enabled: false, restricted: true }]))
    expect(result.disabled).toEqual(['fs_delete'])
  })

  it('validation schema: missing flags parse to disabled/hidden, not enabled/visible', () => {
    const parsed = ToolDeclarationSchema.parse({ name: 'fs_delete' })
    expect(parsed.enabled).toBe(false)
    expect(parsed.visible).toBe(false)
  })

  it('validation schema: explicit flags pass through unchanged', () => {
    const parsed = ToolDeclarationSchema.parse({ name: 'fs_delete', enabled: true, visible: false })
    expect(parsed.enabled).toBe(true)
    expect(parsed.visible).toBe(false)
  })

  it('LLM schema exposure: undefined flags and visible:false are hidden; execution stays possible', async () => {
    const registry = new ToolRegistry()
    const fake: Tool = {
      name: 'fs_delete',
      description: 'd',
      inputSchema: z.object({}),
      category: 'file',
      execute: async () => ({ content: 'ran', isError: false }),
      toProviderFormat: () => ({ name: 'fs_delete', description: 'd', input_schema: {} }),
    } as unknown as Tool
    registry.register(fake)

    expect(registry.getToolsForAgent([{ name: 'fs_delete' } as ToolDeclaration])).toHaveLength(0)
    expect(registry.getToolsForAgent([{ name: 'fs_delete', enabled: true, visible: false } as ToolDeclaration])).toHaveLength(0)
    expect(registry.getToolsForAgent([{ name: 'fs_delete', enabled: true, visible: true } as ToolDeclaration])).toHaveLength(1)

    // executeTool has no visibility (or enabled) check — gating happens in the
    // callers (shell gate, adf-call-handler); hidden tools stay executable.
    const result = await registry.executeTool('fs_delete', {}, {} as any)
    expect(result.isError).toBe(false)
  })
})
