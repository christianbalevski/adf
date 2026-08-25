import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// BackgroundAgentManager (the module under test) reaches into electron on
// import (safeStorage / app paths). The gate helper itself is Electron-free;
// this minimal mock only satisfies the module-load side effects.
vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-bg-oauth-gate-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-bg-oauth-gate', getVersion: () => '0.0.0-test' },
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

import {
  maybeGateBackgroundOAuthSignIn,
  type McpHttpOAuthSignInRunner,
} from '../../../src/main/runtime/background-agent-manager'
import type { AgentKeystoreOAuthStore } from '../../../src/main/services/mcp-oauth-store'
import type { McpOAuthRecord } from '../../../src/main/services/mcp-oauth.types'

const HTTP_URL = 'https://mcp.example.com/sse'

/** Agent-store stub: `get` yields the configured record (or throws to model a locked envelope). */
function makeAgentStore(get: () => Promise<McpOAuthRecord | undefined>): AgentKeystoreOAuthStore {
  return { get } as unknown as AgentKeystoreOAuthStore
}

/** Executor stub whose requestApproval resolves to the given decision. */
function makeExecutor(approved: boolean) {
  return { requestApproval: vi.fn(async () => approved) }
}

describe('maybeGateBackgroundOAuthSignIn', () => {
  const httpOAuthBase = { serverName: 'remote-y', url: HTTP_URL, oauth: true, transport: 'http' as const }

  it('approved gate runs the injected runner and passes the sign-in context through', async () => {
    const executor = makeExecutor(true)
    const agentStore = makeAgentStore(async () => undefined)
    const signIn = vi.fn<McpHttpOAuthSignInRunner>(async () => true)

    await maybeGateBackgroundOAuthSignIn({
      ...httpOAuthBase,
      executor,
      agentStore,
      signIn,
      oauthClientId: 'client-123',
      oauthScopes: ['read', 'write'],
    })

    expect(executor.requestApproval).toHaveBeenCalledWith('mcp_oauth_signin', { server: 'remote-y', url: HTTP_URL })
    expect(signIn).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledWith({
      serverName: 'remote-y',
      url: HTTP_URL,
      oauthClientId: 'client-123',
      oauthScopes: ['read', 'write'],
      agentStore,
    })
  })

  it('denied gate does NOT run the runner', async () => {
    const executor = makeExecutor(false)
    const signIn = vi.fn<McpHttpOAuthSignInRunner>(async () => true)

    await maybeGateBackgroundOAuthSignIn({
      ...httpOAuthBase,
      executor,
      agentStore: makeAgentStore(async () => undefined),
      signIn,
    })

    expect(executor.requestApproval).toHaveBeenCalledTimes(1)
    expect(signIn).not.toHaveBeenCalled()
  })

  it('no live executor → no prompt and no runner (initial-startup connect)', async () => {
    const signIn = vi.fn<McpHttpOAuthSignInRunner>(async () => true)

    await maybeGateBackgroundOAuthSignIn({
      ...httpOAuthBase,
      executor: null,
      agentStore: makeAgentStore(async () => {
        throw new Error('agentStore.get must not be consulted without a live executor')
      }),
      signIn,
    })

    expect(signIn).not.toHaveBeenCalled()
  })

  it('non-oauth / non-http server → gate skipped entirely', async () => {
    const executor = makeExecutor(true)
    const signIn = vi.fn<McpHttpOAuthSignInRunner>(async () => true)
    const agentStore = makeAgentStore(async () => {
      throw new Error('agentStore.get must not be consulted for a non-oauth server')
    })

    // stdio transport
    await maybeGateBackgroundOAuthSignIn({
      serverName: 's', url: undefined, oauth: false, transport: 'stdio',
      executor, agentStore, signIn,
    })
    // http but no oauth flag
    await maybeGateBackgroundOAuthSignIn({
      serverName: 's', url: HTTP_URL, oauth: false, transport: 'http',
      executor, agentStore, signIn,
    })

    expect(executor.requestApproval).not.toHaveBeenCalled()
    expect(signIn).not.toHaveBeenCalled()
  })

  it('already-stored token → skipped without prompting', async () => {
    const executor = makeExecutor(true)
    const signIn = vi.fn<McpHttpOAuthSignInRunner>(async () => true)

    await maybeGateBackgroundOAuthSignIn({
      ...httpOAuthBase,
      executor,
      agentStore: makeAgentStore(async () => ({ tokens: { access_token: 'x' } } as unknown as McpOAuthRecord)),
      signIn,
    })

    expect(executor.requestApproval).not.toHaveBeenCalled()
    expect(signIn).not.toHaveBeenCalled()
  })

  it('no injected runner → silent (today\'s behavior), no prompt', async () => {
    const executor = makeExecutor(true)

    await maybeGateBackgroundOAuthSignIn({
      ...httpOAuthBase,
      executor,
      agentStore: makeAgentStore(async () => undefined),
      signIn: undefined,
    })

    expect(executor.requestApproval).not.toHaveBeenCalled()
  })

  it('locked envelope (agentStore.get throws) → gate skipped, connect fails plainly', async () => {
    const executor = makeExecutor(true)
    const signIn = vi.fn<McpHttpOAuthSignInRunner>(async () => true)

    await maybeGateBackgroundOAuthSignIn({
      ...httpOAuthBase,
      executor,
      agentStore: makeAgentStore(async () => { throw new Error('credentials envelope is locked') }),
      signIn,
    })

    expect(executor.requestApproval).not.toHaveBeenCalled()
    expect(signIn).not.toHaveBeenCalled()
  })
})
