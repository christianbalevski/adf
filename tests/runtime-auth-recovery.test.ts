import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-runtime-auth-recovery-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-runtime-auth-recovery-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { RuntimeService } from '../src/main/runtime/runtime-service'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import type { LLMProvider } from '../src/main/providers/provider.interface'
import type { ProviderType } from '../src/shared/constants/adf-defaults'

/** A provider whose every call fails with `message` (validateConfig passes, so the turn reaches the call). */
function failingProvider(providerType: ProviderType, message: string): LLMProvider {
  return {
    name: 'Stub',
    providerId: 'custom:stub',
    providerType,
    modelId: 'stub-model',
    createMessage: async () => { throw new Error(message) },
    validateConfig: async () => ({ valid: true }),
  }
}

describe('RuntimeService.recoverAuthErroredAgents', () => {
  const runtimes: RuntimeService[] = []
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
    }
    RuntimeGate._resetForTests()
  })

  it('recovers only loops bricked on auth for the signed-in provider type; other errors stay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-auth-recovery-'))
    const runtime = new RuntimeService({ enforceReviewGate: false })
    runtimes.push(runtime)
    const make = (name: string, provider: LLMProvider) =>
      runtime.createAgent({ filePath: join(dir, `${name}.adf`), name, provider })

    const authChatgpt = make('agent-1', failingProvider('chatgpt-subscription', 'Not authenticated — sign in first'))
    const structural = make('agent-2', failingProvider('chatgpt-subscription', 'malformed tool schema'))
    const authGrok = make('agent-3', failingProvider('grok-subscription', 'Not authenticated — sign in first'))

    for (const ref of [authChatgpt, structural, authGrok]) {
      await runtime.sendChat(ref.id, 'hello').catch(() => {})
      expect(runtime.getAgentStatus(ref.id)?.runtimeState).toBe('error')
    }

    // The recorded turn error names the fix for a subscription provider.
    const errorEntries = runtime.getAgentLoop(authChatgpt.id, { limit: 50 }).entries
    expect(JSON.stringify(errorEntries)).toContain('adf auth login chatgpt')

    const recovered = runtime.recoverAuthErroredAgents('chatgpt-subscription', 'ChatGPT')
    expect(recovered).toEqual([
      { agentId: authChatgpt.id, filePath: expect.any(String), loop: 'main', notice: 'agent-1 recovered after ChatGPT sign-in' },
    ])
    expect(runtime.getAgentStatus(authChatgpt.id)?.runtimeState).toBe('idle')
    expect(runtime.getAgentLogs(authChatgpt.id, { event: 'auth_recovered' })[0]?.message).toContain('recovered after ChatGPT sign-in')

    // Non-auth error and an auth error from another provider type are untouched.
    expect(runtime.getAgentStatus(structural.id)?.runtimeState).toBe('error')
    expect(runtime.getAgentStatus(authGrok.id)?.runtimeState).toBe('error')

    // Idempotent: nothing left to recover.
    expect(runtime.recoverAuthErroredAgents('chatgpt-subscription', 'ChatGPT')).toEqual([])
  })
})
