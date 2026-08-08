/**
 * AdfCallHandler protection→HIL flow + forged-flag stripping.
 *
 * 1. Unauthorized sandbox code hitting a protection denial must block on
 *    requestProtectionApproval: approve → re-execute with the one-time
 *    bypass; deny → PROTECTION_DENIED with feedback; no callback → plain
 *    TOOL_ERROR (serving runtimes without an executor).
 * 2. Security regression: unauthorized code could previously forge
 *    `_authorized: true` in its args — the registry re-attaches it after
 *    validation, silently bypassing file protection. Both privilege flags
 *    must be stripped from unauthorized calls before dispatch.
 */

import { describe, expect, it, vi } from 'vitest'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import { withAuthorization } from '../../../src/main/runtime/authorization-context'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

function makeHandler() {
  const executed: Array<{ tool: string; args: Record<string, unknown> }> = []
  const toolRegistry = {
    get: (name: string) => (name === 'fs_delete' ? { name } : null),
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      executed.push({ tool: name, args })
      const bypass = args?._authorized === true || args?._protection_override === true
      if (name === 'fs_delete' && !bypass) {
        return {
          content: `Cannot delete "${args.path}": file is protected (no-delete).`,
          isError: true,
          protection: { kind: 'file_protection', target: args.path, level: 'no_delete' }
        }
      }
      return { content: 'Deleted.', isError: false }
    }),
  }
  const workspace = {
    getTask: () => null,
    updateTaskStatus: () => {},
    insertLog: () => {},
    isFileAuthorized: () => false,
  }
  const config = {
    name: 'test-agent',
    id: 'test-agent',
    tools: [{ name: 'fs_delete', enabled: true, visible: true, restricted: false }],
    code_execution: {} as AgentConfig['code_execution'],
  } as unknown as AgentConfig

  const handler = new AdfCallHandler({
    toolRegistry: toolRegistry as never,
    workspace: workspace as never,
    config,
    provider: {} as never,
  })
  return { handler, executed }
}

describe('AdfCallHandler protection HIL', () => {
  it('approve → re-executes with _protection_override and returns the result', async () => {
    const { handler, executed } = makeHandler()
    handler.requestProtectionApproval = vi.fn(async () => ({ approved: true }))
    const result = await handler.handleCall('fs_delete', { path: 'mind.md' })
    expect(result.error).toBeUndefined()
    expect(result.result).toBe('Deleted.')
    expect(handler.requestProtectionApproval).toHaveBeenCalledOnce()
    expect(executed.some(e => e.args?._protection_override === true)).toBe(true)
  })

  it('deny → PROTECTION_DENIED with feedback, no override execution', async () => {
    const { handler, executed } = makeHandler()
    handler.requestProtectionApproval = vi.fn(async () => ({ approved: false, feedback: 'not that file' }))
    const result = await handler.handleCall('fs_delete', { path: 'mind.md' })
    expect(result.errorCode).toBe('PROTECTION_DENIED')
    expect(result.error).toContain('not that file')
    expect(executed.some(e => e.args?._protection_override === true)).toBe(false)
  })

  it('no callback → plain TOOL_ERROR (current behavior preserved)', async () => {
    const { handler } = makeHandler()
    const result = await handler.handleCall('fs_delete', { path: 'mind.md' })
    expect(result.errorCode).toBe('TOOL_ERROR')
  })

  it('authorized code never consults the protection callback', async () => {
    const { handler } = makeHandler()
    const spy = vi.fn(async () => ({ approved: true }))
    handler.requestProtectionApproval = spy
    const result = await withAuthorization(true, () => handler.handleCall('fs_delete', { path: 'mind.md' }))
    expect(result.error).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('AdfCallHandler forged privilege-flag stripping', () => {
  it('strips forged _authorized from unauthorized args (security regression)', async () => {
    const { handler, executed } = makeHandler()
    // Pre-fix this deleted the protected file: the registry re-attached the
    // forged flag after validation and fs_delete skipped its protection check.
    const result = await handler.handleCall('fs_delete', { path: 'mind.md', _authorized: true })
    expect(result.errorCode).toBe('TOOL_ERROR')
    expect(executed.every(e => e.args?._authorized !== true)).toBe(true)
  })

  it('strips forged _protection_override from unauthorized args', async () => {
    const { handler, executed } = makeHandler()
    const result = await handler.handleCall('fs_delete', { path: 'mind.md', _protection_override: true })
    expect(result.errorCode).toBe('TOOL_ERROR')
    expect(executed.every(e => e.args?._protection_override !== true)).toBe(true)
  })

  it('authorized code keeps its injected _authorized', async () => {
    const { handler, executed } = makeHandler()
    const result = await withAuthorization(true, () => handler.handleCall('fs_delete', { path: 'mind.md' }))
    expect(result.error).toBeUndefined()
    expect(executed.some(e => e.args?._authorized === true)).toBe(true)
  })
})
