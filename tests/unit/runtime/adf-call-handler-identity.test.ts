/**
 * set_identity / get_identity round trip from code.
 *
 * Keys the agent creates via set_identity get code_access enabled, so the
 * agent can read them back with get_identity. Overwriting an existing key
 * preserves its code_access flag — code can't re-enable access on a key the
 * user has hidden, and other setIdentity callers (UI, crypto internals)
 * still create hidden-from-code rows by default.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AdfCallHandler } from '../../../src/main/runtime/adf-call-handler'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

describe('AdfCallHandler identity code access', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function makeFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'adf-identity-code-access-'))
    const workspace = AdfWorkspace.create(join(dir, 'agent.adf'), { name: 'identity-test' })
    cleanups.push(() => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    })

    const config = {
      name: 'identity-test',
      id: 'identity-test',
      tools: [],
      code_execution: { get_identity: true, set_identity: true },
    } as unknown as AgentConfig

    const handler = new AdfCallHandler({
      toolRegistry: { get: () => null } as never,
      workspace: workspace as never,
      config,
      provider: {} as never,
      // Mirrors the production resolveIdentity wiring: reads are gated on
      // the row's code_access flag, no fallback to app-level settings.
      resolveIdentity: (purpose: string) => {
        const row = workspace.getIdentityRow(purpose)
        if (!row?.code_access) return null
        return workspace.getIdentityDecrypted(purpose, null)
      },
    })

    return { workspace, handler }
  }

  it('a key created via set_identity can be read back with get_identity', async () => {
    const { workspace, handler } = makeFixture()

    const setResult = await handler.handleCall('set_identity', {
      purpose: 'mcp:garmin:GARMIN_EMAIL',
      value: 'user@example.com',
    })
    expect(setResult.error).toBeUndefined()
    expect(workspace.getIdentityRow('mcp:garmin:GARMIN_EMAIL')?.code_access).toBe(true)

    const getResult = await handler.handleCall('get_identity', { purpose: 'mcp:garmin:GARMIN_EMAIL' })
    expect(getResult.error).toBeUndefined()
    expect(getResult.result).toBe('user@example.com')
  })

  it('overwriting an existing hidden key does not grant code access', async () => {
    const { workspace, handler } = makeFixture()

    // Key created outside code execution (UI / IPC path) — hidden by default.
    workspace.setIdentity('provider:openai:apiKey', 'user-secret')
    expect(workspace.getIdentityRow('provider:openai:apiKey')?.code_access).toBe(false)

    const setResult = await handler.handleCall('set_identity', {
      purpose: 'provider:openai:apiKey',
      value: 'agent-overwrite',
    })
    expect(setResult.error).toBeUndefined()

    // Value updated, but the key stays hidden from code.
    expect(workspace.getIdentity('provider:openai:apiKey')).toBe('agent-overwrite')
    expect(workspace.getIdentityRow('provider:openai:apiKey')?.code_access).toBe(false)
    const getResult = await handler.handleCall('get_identity', { purpose: 'provider:openai:apiKey' })
    expect(getResult.errorCode).toBe('NOT_FOUND')
  })

  it('a user revoke sticks even when code overwrites the key afterwards', async () => {
    const { workspace, handler } = makeFixture()

    await handler.handleCall('set_identity', { purpose: 'api:token', value: 'v1' })
    expect(workspace.getIdentityRow('api:token')?.code_access).toBe(true)

    // User hides the key from code (IdentityPanel toggle).
    workspace.setIdentityCodeAccess('api:token', false)

    await handler.handleCall('set_identity', { purpose: 'api:token', value: 'v2' })
    expect(workspace.getIdentity('api:token')).toBe('v2')
    expect(workspace.getIdentityRow('api:token')?.code_access).toBe(false)
  })

  it('workspace.setIdentity still creates hidden-from-code keys by default', () => {
    const { workspace } = makeFixture()
    workspace.setIdentity('telegram:bot_token', 'secret-token')
    expect(workspace.getIdentityRow('telegram:bot_token')?.code_access).toBe(false)
  })
})
